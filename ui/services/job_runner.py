"""Generic background job tracking.

Both Ansible playbook runs and UnifAI workflow triggers are "start now, poll
for progress/result later" operations, so they share this small in-memory job
registry instead of blocking the HTTP request thread.
"""
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_SUCCESS = "success"
STATUS_FAILED = "failed"


@dataclass
class Job:
    id: str
    kind: str
    label: str
    status: str = STATUS_PENDING
    session_id: Optional[str] = None
    log: list[str] = field(default_factory=list)
    stream_steps: list[dict] = field(default_factory=list)
    result: Optional[Any] = None
    error: Optional[str] = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    lock: threading.Lock = field(default_factory=threading.Lock)

    def append_log(self, line: str) -> None:
        with self.lock:
            self.log.append(line)

    def set_stream_steps(self, steps: list[dict]) -> None:
        with self.lock:
            self.stream_steps = steps

    def to_dict(self, since: int = 0) -> dict:
        with self.lock:
            log_slice = self.log[since:]
            total = len(self.log)
            stream_steps = list(self.stream_steps)
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "status": self.status,
            "session_id": self.session_id,
            "log": log_slice,
            "log_total": total,
            "stream_steps": stream_steps,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
        }


class JobRegistry:
    """Thread-safe in-memory store of jobs, keyed by id."""

    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self, kind: str, label: str) -> Job:
        job = Job(id=str(uuid.uuid4()), kind=kind, label=label)
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def run_async(self, job: Job, target: Callable[[Job], None]) -> None:
        def _wrapper():
            job.status = STATUS_RUNNING
            try:
                target(job)
                if job.status == STATUS_RUNNING:
                    job.status = STATUS_SUCCESS
            except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
                job.error = str(exc)
                job.status = STATUS_FAILED
                job.append_log(f"[ui] Job failed: {exc}")

        thread = threading.Thread(target=_wrapper, daemon=True)
        thread.start()


registry = JobRegistry()
