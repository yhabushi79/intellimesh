"""Runs ansible-playbook as a subprocess and streams its output into a Job."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Optional

from config import ANSIBLE_PASSWORD_ENV, REPO_ROOT
from services.job_runner import Job, STATUS_FAILED, registry


def _run_one_playbook(job: Job, playbook: Path, extra_args: Optional[list[str]], env: dict) -> int:
    if not playbook.exists():
        job.append_log(f"[ui] Playbook not found: {playbook}")
        return 1

    cmd = ["ansible-playbook", str(playbook.relative_to(REPO_ROOT))]
    if extra_args:
        cmd.extend(extra_args)

    job.append_log(f"$ {' '.join(cmd)}  (cwd={REPO_ROOT})")

    proc = subprocess.Popen(
        cmd,
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        job.append_log(line.rstrip("\n"))
    proc.wait()
    job.append_log(f"[ui] Exit code: {proc.returncode}")
    return proc.returncode


def _build_env(ansible_password: Optional[str]) -> dict:
    env = os.environ.copy()
    password = ansible_password or ANSIBLE_PASSWORD_ENV
    if password:
        env["ANSIBLE_PASSWORD"] = password
    return env


def run_playbooks_job(
    kind: str,
    label: str,
    playbooks: list[tuple[Path, Optional[list[str]]]],
    ansible_password: Optional[str] = None,
    optional_playbooks: Optional[set] = None,
) -> Job:
    """Create and start a job that runs one or more playbooks in sequence.

    Stops at the first non-zero exit code so, e.g., a failed setup doesn't
    proceed to the verification step and report a misleading result — unless
    the failing playbook's path is listed in `optional_playbooks`, in which
    case a warning is logged and the sequence continues (used for auxiliary
    cleanup steps that shouldn't block the core revert action).
    """
    job = registry.create(kind=kind, label=label)
    env = _build_env(ansible_password)
    optional_playbooks = optional_playbooks or set()

    def _target(job: Job) -> None:
        for playbook, extra_args in playbooks:
            rc = _run_one_playbook(job, playbook, extra_args, env)
            if rc != 0:
                if playbook in optional_playbooks:
                    job.append_log(
                        f"[ui] {playbook.name} failed (exit {rc}) but is optional — continuing."
                    )
                    continue
                job.status = STATUS_FAILED
                job.error = f"{playbook.name} exited with code {rc}"
                return
        job.result = {"message": "All playbooks completed successfully."}

    registry.run_async(job, _target)
    return job
