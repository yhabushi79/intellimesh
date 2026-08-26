"""IntelliMesh demo UI — Flask backend.

Tab 1: topology + one-click Ansible playbook execution (fix / break the demo).
Tab 2: trigger a UnifAI workflow and show its final result.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from flask import Flask, jsonify, render_template, request, Response, stream_with_context

import config
from services import ansible_runner, unifai_client
from services.job_runner import registry
from services.unifai_client import UnifAIAuthError

app = Flask(__name__)


# ── Pages ──────────────────────────────────────────────────────────────────


@app.get("/")
def index():
    resp = Response(render_template("index.html"), mimetype="text/html")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/topology")
def topology():
    """Serve the existing demo topology page as-is (single source of truth)."""
    if not config.TOPOLOGY_HTML_PATH.exists():
        return Response("topology.html not found", status=404)
    return Response(config.TOPOLOGY_HTML_PATH.read_text(), mimetype="text/html")


# ── Shared config ────────────────────────────────────────────────────────


@app.get("/api/config")
def api_config():
    return jsonify(
        {
            "grafana_url": config.GRAFANA_URL,
            "satellite_url": config.SATELLITE_URL,
            "aap_url": config.AAP_URL,
            "ansible_password_preset": bool(config.ANSIBLE_PASSWORD_ENV),
        }
    )


# ── Tab 1: Ansible playbook execution ───────────────────────────────────


@app.post("/api/playbooks/revert")
def api_playbooks_revert():
    """Clean up Satellite leftovers and re-apply the known-good backend config.

    Deliberately does NOT run 01-verify-crypto-policy.yml here: 00-setup-backends.yml
    resets the crypto policy to DEFAULT, and the verify playbook asserts FUTURE is
    active — that only becomes true once the Satellite portal step (Step 2) has run.
    Running verify right after this would always fail. Verification is triggered
    separately via /api/playbooks/verify-crypto once the Satellite step is done.
    """
    body = request.get_json(silent=True) or {}
    job = ansible_runner.run_playbooks_job(
        kind="revert",
        label="Revert to healthy baseline",
        playbooks=[
            (config.PLAYBOOK_CLEANUP_SATELLITE, None),
            (config.PLAYBOOK_SETUP_BACKENDS, None),
        ],
        optional_playbooks={config.PLAYBOOK_CLEANUP_SATELLITE},
        ansible_password=body.get("ansible_password"),
    )
    return jsonify(job.to_dict())


@app.post("/api/playbooks/verify-crypto")
def api_playbooks_verify_crypto():
    """Confirm the crypto policy applied manually via the Satellite portal took effect."""
    body = request.get_json(silent=True) or {}
    job = ansible_runner.run_playbooks_job(
        kind="verify-crypto",
        label="Verify crypto policy",
        playbooks=[(config.PLAYBOOK_VERIFY_CRYPTO, None)],
        ansible_password=body.get("ansible_password"),
    )
    return jsonify(job.to_dict())


@app.post("/api/playbooks/inject")
def api_playbooks_inject():
    """Simulate the incident: deploy the oversized TLS cert on the patched node.

    Not wired to a UI button by default — the demo now triggers this playbook
    for real from the AAP portal (see the "Update Security Policy" step) to
    stay realistic. Kept available for scripted/automated runs.
    """
    body = request.get_json(silent=True) or {}
    job = ansible_runner.run_playbooks_job(
        kind="inject",
        label="Inject TLS compliance bug",
        playbooks=[(config.PLAYBOOK_INJECT_COMPLIANCE, None)],
        ansible_password=body.get("ansible_password"),
    )
    return jsonify(job.to_dict())


@app.get("/api/jobs/<job_id>")
def api_job_status(job_id: str):
    since = request.args.get("since", default=0, type=int)
    job = registry.get(job_id)
    if job is None:
        return jsonify({"error": "job not found"}), 404
    return jsonify(job.to_dict(since=since))


# ── UnifAI session refresh (no pod restart needed) ──────────────────────


@app.post("/api/unifai-session/refresh")
def api_unifai_session_refresh():
    """Overwrite the UnifAI session file with a new one.

    Call this when the session expires — the app reads the file on every
    request, so the next API call immediately uses the new cookie.

    Body: { "session_json": "<contents of ~/.unifai/session.json>" }
    """
    body = request.get_json(silent=True) or {}
    raw = body.get("session_json", "").strip()
    if not raw:
        return jsonify({"error": "session_json is required"}), 400
    try:
        data = json.loads(raw)          # validate it's real JSON
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"Invalid JSON: {exc}"}), 400

    session_file = config.UNIFAI_SESSION_FILE
    try:
        session_file.write_text(json.dumps(data, indent=2))
    except OSError as exc:
        return jsonify({"error": f"Could not write session file: {exc}"}), 500

    return jsonify({"ok": True, "session_file": str(session_file)})


# ── Session history store ────────────────────────────────────────────────


def _session_path(session_id: str):
    return config.SESSIONS_DIR / f"{session_id}.json"


@app.post("/api/sessions")
def api_sessions_create():
    """Create or update a session record."""
    body = request.get_json(silent=True) or {}
    session_id = body.get("session_id", "").strip()
    if not session_id:
        return jsonify({"error": "session_id is required"}), 400
    path = _session_path(session_id)
    existing = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text())
        except Exception:
            pass
    existing.update({
        "session_id": session_id,
        "job_id": body.get("job_id", existing.get("job_id", "")),
        "blueprint_id": body.get("blueprint_id", existing.get("blueprint_id", "")),
        "workflow_name": body.get("workflow_name", existing.get("workflow_name", "")),
        "status": body.get("status", existing.get("status", "running")),
        "output": body.get("output", existing.get("output", "")),
        "started_at": existing.get("started_at") or datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    if "steps" in body:
        existing["steps"] = body["steps"]
    path.write_text(json.dumps(existing, indent=2))
    return jsonify({"ok": True, "session_id": session_id})


@app.get("/api/sessions")
def api_sessions_list():
    """List all stored sessions, newest first."""
    sessions = []
    for f in config.SESSIONS_DIR.glob("*.json"):
        try:
            sessions.append(json.loads(f.read_text()))
        except Exception:
            pass
    sessions.sort(key=lambda s: s.get("started_at", ""), reverse=True)
    return jsonify({"sessions": sessions})


@app.get("/api/sessions/<session_id>")
def api_sessions_get(session_id: str):
    """Return a single stored session (steps + output)."""
    path = _session_path(session_id)
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    try:
        data = json.loads(path.read_text())
        return jsonify(data)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.delete("/api/sessions/<session_id>")
def api_sessions_delete(session_id: str):
    """Delete a session record."""
    path = _session_path(session_id)
    if path.exists():
        path.unlink()
    return jsonify({"ok": True})


# ── Tab 2: UnifAI workflows ──────────────────────────────────────────────


@app.get("/api/workflows")
def api_workflows_list():
    try:
        unifai_client.check_auth()
        workflows = unifai_client.list_workflows()
    except UnifAIAuthError as exc:
        return jsonify({"error": str(exc), "auth_error": True}), 401
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502
    return jsonify({"workflows": workflows})


@app.get("/api/workflows/<blueprint_id>/topology")
def api_workflow_topology(blueprint_id: str):
    try:
        unifai_client.check_auth()
        topology = unifai_client.get_blueprint_topology(blueprint_id)
    except UnifAIAuthError as exc:
        return jsonify({"error": str(exc), "auth_error": True}), 401
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502
    return jsonify(topology)




@app.post("/api/workflows/run")
def api_workflows_run():
    body = request.get_json(silent=True) or {}
    blueprint_id = body.get("blueprint_id")
    prompt = body.get("prompt", "").strip()
    if not blueprint_id:
        return jsonify({"error": "blueprint_id is required"}), 400
    if not prompt:
        return jsonify({"error": "prompt is required"}), 400

    try:
        unifai_client.check_auth()
    except UnifAIAuthError as exc:
        return jsonify({"error": str(exc), "auth_error": True}), 401

    job = unifai_client.run_workflow_job(blueprint_id, prompt)
    return jsonify(job.to_dict())


@app.get("/api/workflows/jobs/<job_id>/session")
def api_workflow_job_session(job_id: str):
    """Return the MAS session_id for a job so the browser can reconnect after a reload."""
    job = registry.get(job_id)
    if job is None:
        return jsonify({"error": "job not found"}), 404
    session_id = getattr(job, "session_id", None) or (job.result or {}).get("session_id")
    if not session_id:
        return jsonify({"error": "no session_id for this job"}), 404
    return jsonify({
        "job_id": job_id,
        "session_id": session_id,
        "status": job.status,
        "result_status": (job.result or {}).get("status", ""),
    })


@app.get("/api/workflows/jobs/<job_id>")
def api_workflow_job_status(job_id: str):
    since = request.args.get("since", default=0, type=int)
    job = registry.get(job_id)
    if job is None:
        return jsonify({"error": "job not found"}), 404
    unifai_client.refresh_workflow_job_from_mas(job)
    return jsonify(job.to_dict(since=since))


@app.get("/api/workflows/stream")
def api_workflow_stream():
    """Proxy MAS session.subscribe NDJSON to the browser for live agent updates."""
    session_id = request.args.get("sessionId", "").strip()
    if not session_id:
        return jsonify({"error": "sessionId is required"}), 400

    try:
        unifai_client.check_auth()
    except UnifAIAuthError as exc:
        return jsonify({"error": str(exc), "auth_error": True}), 401

    def generate():
        try:
            for event in unifai_client.iter_session_stream(session_id):
                yield json.dumps(event, default=str) + "\n"
        except Exception as exc:  # noqa: BLE001
            yield json.dumps({"type": "stream_error", "error": str(exc)}) + "\n"

    resp = Response(
        stream_with_context(generate()),
        mimetype="application/x-ndjson",
    )
    resp.headers["X-Accel-Buffering"] = "no"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/api/workflows/session/<session_id>/result")
def api_workflow_session_result(session_id: str):
    """Fetch the final answer and status for a completed workflow session from MAS."""
    try:
        unifai_client.check_auth()
        client = unifai_client.UnifAIClient()
        status = unifai_client._normalize_session_status(client.get_session_status(session_id))
        output = ""
        try:
            chat = client.get_session_chat(session_id)
            chat_status = unifai_client._normalize_session_status(chat.get("status"))
            if chat_status in unifai_client.TERMINAL_SESSION_STATUSES:
                status = chat_status
            output = unifai_client._extract_chat_output(chat)
        except Exception:  # noqa: BLE001
            pass
        return jsonify({"session_id": session_id, "status": status, "output": output})
    except UnifAIAuthError as exc:
        return jsonify({"error": str(exc), "auth_error": True}), 401
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502


if __name__ == "__main__":
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG)
