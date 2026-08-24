"""Thin client for the UnifAI MAS backend.

Reuses the same cached SSO session the `unifai` CLI writes to
``~/.unifai/session.json`` after ``unifai auth login`` — no separate login
flow is implemented here. Calling the JSON API directly (instead of shelling
out to the CLI and scraping its Rich-formatted terminal output) keeps
responses structured and robust, while still requiring nothing more than the
one-time CLI login the user already has.
"""
from __future__ import annotations

import json
import time
from datetime import datetime
from typing import Any, Optional

import requests

from config import (
    UNIFAI_API_PREFIX,
    UNIFAI_MAS_URL,
    UNIFAI_SESSION_FILE,
    WORKFLOW_POLL_INTERVAL_SECONDS,
    WORKFLOW_POLL_TIMEOUT_SECONDS,
)
from services.job_runner import Job, STATUS_FAILED, STATUS_SUCCESS, registry


class UnifAIAuthError(RuntimeError):
    """Raised when there's no valid cached `unifai` CLI session."""


def _load_session_cookie() -> str:
    if not UNIFAI_SESSION_FILE.exists():
        raise UnifAIAuthError(
            "No UnifAI session found. Run `unifai auth login` in a terminal once, then retry."
        )
    try:
        data = json.loads(UNIFAI_SESSION_FILE.read_text())
    except Exception as exc:  # noqa: BLE001
        raise UnifAIAuthError(f"Could not read UnifAI session file: {exc}") from exc

    expires_at = data.get("expires_at", 0)
    if datetime.now().timestamp() >= expires_at:
        raise UnifAIAuthError(
            "UnifAI session expired. Run `unifai auth login` in a terminal to refresh it."
        )

    cookie = data.get("session_cookie")
    if not cookie:
        raise UnifAIAuthError("UnifAI session file is missing a session cookie. Run `unifai auth login` again.")
    return cookie


class UnifAIClient:
    def __init__(self, base_url: str = UNIFAI_MAS_URL, api_prefix: str = UNIFAI_API_PREFIX):
        self.base_url = base_url.rstrip("/")
        self.api_prefix = api_prefix
        self._session: Optional[requests.Session] = None

    def _get_session(self) -> requests.Session:
        cookie = _load_session_cookie()
        session = requests.Session()
        session.headers.update({"Content-Type": "application/json"})
        session.cookies.set("session", cookie)
        return session

    def _url(self, parent: str, route: str) -> str:
        return f"{self.base_url}{self.api_prefix}/{parent}/{route}"

    def list_blueprints(self) -> list[dict]:
        session = self._get_session()
        resp = session.get(self._url("blueprints", "available.blueprints.summary.get"), timeout=15)
        resp.raise_for_status()
        return resp.json()

    def get_blueprint(self, blueprint_id: str) -> dict:
        session = self._get_session()
        resp = session.get(
            self._url("blueprints", "blueprint.info.get"),
            params={"blueprintId": blueprint_id},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def get_blueprint_resolved(self, blueprint_id: str) -> dict:
        """Fetch a blueprint with all $ref resources fully resolved (names populated)."""
        session = self._get_session()
        resp = session.get(
            self._url("blueprints", "available.blueprints.resolved.get"),
            params={"blueprintId": blueprint_id},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def create_session(self, blueprint_id: str) -> str:
        session = self._get_session()
        resp = session.post(
            self._url("sessions", "user.session.create"),
            json={"blueprintId": blueprint_id},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, dict):
            return data.get("sessionId") or data.get("session_id") or data.get("run_id") or str(data)
        return str(data)

    def submit_session(self, session_id: str, prompt: str) -> Any:
        session = self._get_session()
        resp = session.post(
            self._url("sessions", "user.session.submit"),
            json={
                "sessionId": session_id,
                "inputs": {"user_prompt": prompt},
                "scope": "public",
                "sessionType": "Personal",
            },
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json() if resp.content else None

    def get_stream_status(self, session_id: str) -> dict:
        session = self._get_session()
        resp = session.get(
            self._url("sessions", "session.stream.status"),
            params={"sessionId": session_id},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def get_session_status(self, session_id: str) -> Any:
        session = self._get_session()
        resp = session.get(
            self._url("sessions", "session.status.get"),
            params={"sessionId": session_id},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def get_session_chat(self, session_id: str) -> dict:
        session = self._get_session()
        resp = session.get(
            self._url("sessions", "session.chat.get"),
            params={"sessionId": session_id},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def iter_subscribe_events(self, session_id: str):
        """Yield NDJSON events from GET /session.subscribe (replay + live)."""
        http = self._get_session()
        resp = http.get(
            self._url("sessions", "session.subscribe"),
            params={"sessionId": session_id},
            stream=True,
            timeout=(15, None),
        )
        resp.raise_for_status()
        for line in resp.iter_lines(decode_unicode=True):
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def check_auth() -> dict:
    """Raises UnifAIAuthError if there's no usable session, else returns basic info."""
    _load_session_cookie()
    return {"authenticated": True}


# Node "config.type" values -> a small set of categories for rendering.
_NODE_TYPE_CATEGORY = {
    "user_question_node": "input",
    "final_answer_node": "output",
    "orchestrator_node": "orchestrator",
    "custom_agent_node": "agent",
}

_RESULT_EXCLUDED_NODE_IDS = frozenset({"user_question_node", "final_answer_node"})


def _is_workflow_result_step(node_id: str, display_name: str = "") -> bool:
    """Input/output topology nodes are shown in topology — not in Result agent list."""
    nid = (node_id or "").lower()
    name = (display_name or "").lower()
    if nid in _RESULT_EXCLUDED_NODE_IDS:
        return False
    if "user_question" in nid or "final_answer" in nid:
        return False
    if "user question" in name or "final answer" in name:
        return False
    return True


def _strip_ref(rid: Optional[str]) -> Optional[str]:
    if rid is None:
        return None
    return rid[len("$ref:"):] if rid.startswith("$ref:") else rid


def _build_resource_name_map(spec: dict, key: str) -> dict[str, str]:
    """Build {stripped_rid: name} from a top-level resource catalog list."""
    return {
        _strip_ref(r.get("rid")): r.get("name") or _strip_ref(r.get("rid")) or "?"
        for r in spec.get(key, [])
        if r.get("rid")
    }


def _resolve_refs(refs: list | str | None, name_map: dict[str, str]) -> list[str]:
    """Resolve a single ref or list of refs into display names."""
    if refs is None:
        return []
    if isinstance(refs, str):
        refs = [refs]
    return [name_map.get(_strip_ref(r), _strip_ref(r) or "?") for r in refs]


def get_blueprint_topology(blueprint_id: str) -> dict:
    """Build a node/edge graph from a blueprint's spec + execution plan.

    Uses the resolved blueprint endpoint so all $ref IDs are expanded into
    real resource objects with names. Falls back to the draft endpoint when
    the resolved one is unavailable.
    """
    client = UnifAIClient()

    try:
        data = client.get_blueprint_resolved(blueprint_id)
    except Exception:
        data = client.get_blueprint(blueprint_id)

    spec = data.get("spec_dict", data)

    llm_names = _build_resource_name_map(spec, "llms")
    provider_names = _build_resource_name_map(spec, "providers")
    tool_names = _build_resource_name_map(spec, "tools")

    nodes_by_rid = {_strip_ref(n.get("rid")): n for n in spec.get("nodes", [])}
    plan = spec.get("plan", [])

    graph_nodes = []
    for step in plan:
        node_info = nodes_by_rid.get(_strip_ref(step.get("node"))) or {}
        cfg = node_info.get("config") or {}
        node_type = cfg.get("type") or node_info.get("type")

        attachments: dict[str, list[str]] = {}
        llm_ref = cfg.get("llm")
        if llm_ref:
            attachments["llm"] = _resolve_refs(llm_ref, llm_names)
        providers_ref = cfg.get("providers")
        if providers_ref:
            attachments["mcp"] = _resolve_refs(providers_ref, provider_names)
        tools_ref = cfg.get("tools")
        if tools_ref:
            attachments["tools"] = _resolve_refs(tools_ref, tool_names)

        graph_nodes.append(
            {
                "id": step["uid"],
                "label": node_info.get("name", step["uid"]),
                "type": _NODE_TYPE_CATEGORY.get(node_type, "node"),
                "attachments": attachments,
            }
        )

    edges = set()
    for step in plan:
        uid = step["uid"]
        for dep in step.get("after") or []:
            edges.add((dep, uid))
        for target in (step.get("branches") or {}).values():
            edges.add((uid, target))

    return {
        "name": spec.get("name", "Workflow"),
        "nodes": graph_nodes,
        "edges": [{"from": a, "to": b} for a, b in edges],
    }


class StreamStepsAccumulator:
    """Build per-node execution steps from MAS NDJSON stream events."""

    def __init__(self) -> None:
        self._steps: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _unwrap_event(event: Any) -> Optional[dict[str, Any]]:
        """Normalize LangGraph / NDJSON event shapes to a plain dict."""
        if isinstance(event, list) and len(event) == 2 and event[0] == "custom":
            inner = event[1]
            return inner if isinstance(inner, dict) else None
        return event if isinstance(event, dict) else None

    def process_event(self, event: Any) -> None:
        event = self._unwrap_event(event)
        if event is None:
            return

        event_type = event.get("type", "")
        if event_type in {"heartbeat", "stream_end", "stream_error"}:
            return

        node = event.get("node") or event.get("node_uid") or "unknown"
        display_name = event.get("display_name") or node

        if not _is_workflow_result_step(node, display_name):
            return

        step = self._steps.get(node)
        if step is None:
            step = {
                "node_id": node,
                "node_name": display_name,
                "text": "",
                "status": "running",
                "tools": [],
            }
            self._steps[node] = step

        if event_type == "llm_token":
            step["text"] += event.get("chunk", "")
        elif event_type == "tool_calling":
            call_id = event.get("call_id")
            tool = event.get("tool")
            if call_id and tool:
                tools = step["tools"]
                if not any(t["id"] == call_id for t in tools):
                    tools.append(
                        {"id": call_id, "name": tool, "args": event.get("args")}
                    )
        elif event_type == "tool_result":
            call_id = event.get("call_id")
            output = event.get("output")
            if call_id:
                for tool_entry in step["tools"]:
                    if tool_entry["id"] == call_id:
                        tool_entry["output"] = output
                        break
                else:
                    step["tools"].append(
                        {
                            "id": call_id,
                            "name": event.get("tool", "tool"),
                            "output": output,
                        }
                    )
        elif event_type == "complete":
            step["status"] = "complete"
        elif event_type.startswith("agent_"):
            step["text"] += f"\n[agent {event_type.replace('agent_', '')}]\n"

    def to_list(self) -> list[dict[str, Any]]:
        return [
            step
            for step in self._steps.values()
            if _is_workflow_result_step(step.get("node_id", ""), step.get("node_name", ""))
        ]


def _normalize_session_status(status: Any) -> str:
    if isinstance(status, dict):
        status = status.get("status") or status.get("name") or ""
    return str(status).upper()


TERMINAL_SESSION_STATUSES = frozenset({"COMPLETED", "FAILED", "CANCELLED"})

_last_mas_status_refresh: dict[str, float] = {}


def _extract_chat_output(chat: dict[str, Any]) -> str:
    output = chat.get("output", "")
    if output:
        return output
    messages = chat.get("messages", [])
    if messages:
        last = messages[-1]
        if last.get("role") != "user":
            return last.get("content", "") or ""
    return ""


def refresh_workflow_job_from_mas(job: Job) -> None:
    """Poll MAS for live session status while the UI tracks a running workflow."""
    if job.kind != "workflow" or not job.session_id:
        return

    result = job.result or {}
    current = _normalize_session_status(result.get("status") or "")
    if current in TERMINAL_SESSION_STATUSES and job.status in (STATUS_SUCCESS, STATUS_FAILED):
        return

    now = time.time()
    last = _last_mas_status_refresh.get(job.id, 0)
    if now - last < WORKFLOW_POLL_INTERVAL_SECONDS:
        return
    _last_mas_status_refresh[job.id] = now

    try:
        client = UnifAIClient()
        status = _normalize_session_status(client.get_session_status(job.session_id))
        chat: dict[str, Any] = {}
        try:
            chat = client.get_session_chat(job.session_id)
            chat_status = _normalize_session_status(chat.get("status"))
            if chat_status in TERMINAL_SESSION_STATUSES:
                status = chat_status
        except requests.HTTPError:
            pass

        if status in TERMINAL_SESSION_STATUSES:
            output = _extract_chat_output(chat)
            with job.lock:
                job.result = {
                    "session_id": job.session_id,
                    "status": status,
                    "output": output or "(No output returned.)",
                }
            if status == "FAILED":
                job.status = STATUS_FAILED
                job.error = chat.get("status_message") or "Workflow failed."
            else:
                job.status = STATUS_SUCCESS
                job.error = None
            job.append_log(f"[ui] Session reached terminal status: {status}.")
        else:
            with job.lock:
                job.result = {
                    "session_id": job.session_id,
                    "status": status or "RUNNING",
                    "poll_handoff": result.get("poll_handoff", False),
                }
    except Exception as exc:  # noqa: BLE001
        job.append_log(f"[ui] Live status refresh failed: {exc}")


def _poll_until_session_complete(client: UnifAIClient, session_id: str) -> str:
    """Wait until MAS reports a terminal session status (not just stream idle)."""
    deadline = time.time() + WORKFLOW_POLL_TIMEOUT_SECONDS
    while time.time() < deadline:
        try:
            status = _normalize_session_status(client.get_session_status(session_id))
            if status in TERMINAL_SESSION_STATUSES:
                return status
        except requests.HTTPError:
            pass

        try:
            chat = client.get_session_chat(session_id)
            chat_status = _normalize_session_status(chat.get("status"))
            if chat_status in TERMINAL_SESSION_STATUSES:
                return chat_status
        except requests.HTTPError:
            pass

        time.sleep(WORKFLOW_POLL_INTERVAL_SECONDS)

    return "TIMEOUT"


def list_workflows() -> list[dict]:
    client = UnifAIClient()
    summaries = client.list_blueprints() or []
    return [
        {
            "id": s.get("blueprint_id") or s.get("id"),
            "name": s.get("name") or s.get("display_name") or "Untitled workflow",
            "description": s.get("description", ""),
        }
        for s in summaries
    ]


def iter_session_stream(session_id: str):
    """Yield NDJSON events from MAS session.subscribe (for Flask proxy)."""
    client = UnifAIClient()
    for event in client.iter_subscribe_events(session_id):
        yield event


def run_workflow_job(blueprint_id: str, prompt: str) -> Job:
    """Create and start a job that triggers a workflow and waits for its result."""
    client = UnifAIClient()
    session_id = client.create_session(blueprint_id)
    job = registry.create(kind="workflow", label=f"Workflow {blueprint_id}")
    job.session_id = session_id

    def _target(job: Job) -> None:
        job.append_log(f"Session created: {session_id}")
        job.append_log("Submitting workflow for background execution…")
        client.submit_session(session_id, prompt)
        job.result = {"session_id": session_id, "status": "RUNNING"}
        job.append_log("Waiting for agents to finish…")
        final_status = _poll_until_session_complete(client, session_id)
        if final_status == "TIMEOUT":
            job.append_log(
                "[ui] Server wait limit reached; workflow still running on MAS — UI will keep tracking."
            )
            job.result = {
                "session_id": session_id,
                "status": "RUNNING",
                "poll_handoff": True,
            }
            return

        chat = client.get_session_chat(session_id)
        status_name = _normalize_session_status(chat.get("status") or final_status)
        output = _extract_chat_output(chat)

        if status_name == "FAILED":
            job.status = STATUS_FAILED
            job.error = chat.get("status_message") or "Workflow failed."
            return

        if status_name not in TERMINAL_SESSION_STATUSES:
            job.status = STATUS_FAILED
            job.error = f"Workflow stopped in non-terminal state: {status_name or 'UNKNOWN'}."
            return

        job.result = {
            "session_id": session_id,
            "status": status_name or "COMPLETED",
            "output": output or "(No output returned.)",
        }

    registry.run_async(job, _target)
    return job
