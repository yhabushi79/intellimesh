"""App configuration, resolved from environment variables / .env file."""
from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

# Repo root (one level up from ui/) — where ansible.cfg, playbooks/, docs/ live.
REPO_ROOT = Path(__file__).resolve().parent.parent

PLAYBOOK_CLEANUP_SATELLITE = REPO_ROOT / "playbooks" / "run-local" / "00-cleanup-satellite-tasks.yml"
PLAYBOOK_SETUP_BACKENDS = REPO_ROOT / "playbooks" / "run-local" / "00-setup-backends.yml"
PLAYBOOK_VERIFY_CRYPTO = REPO_ROOT / "playbooks" / "run-satellite" / "01-verify-crypto-policy.yml"
PLAYBOOK_INJECT_COMPLIANCE = REPO_ROOT / "playbooks" / "run-aap" / "02-inject-compliance.yml"

TOPOLOGY_HTML_PATH = REPO_ROOT / "docs" / "topology.html"

GRAFANA_URL = os.environ.get(
    "GRAFANA_URL",
    "http://10.46.254.38:3000/d/intellimesh-tls/intellimesh-e28094-tls-observability"
    "?orgId=1&from=now-15m&to=now&timezone=browser&var-DS_PROMETHEUS=afusqe39l92wwa&refresh=5s",
)
SATELLITE_URL = os.environ.get("SATELLITE_URL", "https://10.46.253.59/")
AAP_URL = os.environ.get("AAP_URL", "https://10.46.253.112/execution/templates?page=1&perPage=10&sort=name")

# UnifAI MAS backend — matches the default used by the `unifai` CLI (cli/unifai_cli/config/app_config.py).
# Override with UNIFAI_MAS_URL if your environment uses a different route.
UNIFAI_MAS_URL = os.environ.get(
    "UNIFAI_MAS_URL",
    "http://unifai-multiagent-be-tag-ai--pipeline.apps.stc-ai-e1-prod.rtc9.p1.openshiftapps.com",
)
UNIFAI_API_PREFIX = os.environ.get("UNIFAI_API_PREFIX", "/api")

# Where `unifai auth login` caches the session cookie (see cli/unifai_cli/auth/session.py).
UNIFAI_SESSION_FILE = Path(os.environ.get("UNIFAI_SESSION_FILE", str(Path.home() / ".unifai" / "session.json")))

# Optional: pre-set ANSIBLE_PASSWORD in the server's own environment for true one-click
# execution. If unset, the UI will ask for it once per browser session and forward it
# as an env var to the ansible-playbook subprocess only (never written to disk).
ANSIBLE_PASSWORD_ENV = os.environ.get("ANSIBLE_PASSWORD")

WORKFLOW_POLL_INTERVAL_SECONDS = float(os.environ.get("WORKFLOW_POLL_INTERVAL_SECONDS", "3"))
WORKFLOW_POLL_TIMEOUT_SECONDS = float(os.environ.get("WORKFLOW_POLL_TIMEOUT_SECONDS", "600"))

HOST = os.environ.get("UI_HOST", "0.0.0.0")
PORT = int(os.environ.get("UI_PORT", "5050"))
DEBUG = os.environ.get("UI_DEBUG", "false").lower() == "true"
