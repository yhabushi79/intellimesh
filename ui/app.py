"""IntelliMesh demo UI — Flask backend.

Tab 1: topology + one-click Ansible playbook execution (fix / break the demo).
Tab 2: trigger a UnifAI workflow and show its final result.
"""
from __future__ import annotations

import json

from flask import Flask, jsonify, render_template, request, Response, stream_with_context

import config
from services import ansible_runner, unifai_client
from services.job_runner import registry
from services.unifai_client import UnifAIAuthError

app = Flask(__name__)


# ── Pages ──────────────────────────────────────────────────────────────────


@app.get("/")
def index():
    return render_template("index.html")


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


if __name__ == "__main__":
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG)
