# IntelliMesh Console (UI)

A small Flask app that gives the IntelliMesh demo a two-tab UI:

- **Demo Topology** — embeds `docs/topology.html`, explains the "everything's green but it's slow"
  incident, and lets you run the demo playbooks with one click (revert to healthy / inject the
  compliance bug), plus a link to Grafana.
- **UnifAI Workflow** — lists workflows (blueprints) from the UnifAI backend and lets you trigger
  one with a prompt, then shows the final result once it completes.

## Requirements

- Python 3.10+
- `ansible-playbook` on PATH, with network/SSH access to the lab VMs (same access the repo's
  playbooks already assume — see the top-level `README.md`/`docs/README.md`).
- For Tab 2: the [`unifai` CLI](../../UnifAI/cli) installed and logged in once via
  `unifai auth login`. This app reuses that CLI's cached session
  (`~/.unifai/session.json`) to call the UnifAI backend directly — it does not implement its own
  login flow.

## Setup

```bash
cd intelliMesh/ui
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # edit as needed
python app.py
```

Open http://localhost:5050.

## Notes on Tab 1 (demo flow)

The flow mirrors how this incident actually plays out across siloed platforms — only the parts a
single operator normally runs from their laptop are automated here; the rest stays a manual portal
action on purpose, for realism:

1. **Revert to Healthy Baseline** — one click, runs two playbooks against `inventory/hosts.yml` in
   order:
   - `playbooks/run-local/00-cleanup-satellite-tasks.yml` — SSHes into the Satellite host
     (`satellite` inventory group, `10.46.253.59`) and runs
     `foreman-rake foreman_tasks:cleanup TASK_SEARCH='state = stopped' AFTER='0d'` to clear stale
     stopped tasks/orphaned job-invocation leftovers from previous demo runs. This step is
     **optional** — if it fails (e.g. Satellite creds not configured yet), a warning is logged and
     the sequence continues rather than blocking the rest of the revert.
   - `playbooks/run-local/00-setup-backends.yml` — restores the RSA-4096 cert, correct SSL params,
     and resets the crypto policy to `DEFAULT`.

   `01-verify-crypto-policy.yml` is deliberately **not** run here: it asserts the `FUTURE` crypto
   policy is active, which only becomes true after the Satellite portal step (Step 2) re-applies
   it. Running it right after Step 1 would always fail, since Step 1 just reset the policy to
   `DEFAULT`. Verification happens via the **Verify Policy Applied** button in Step 2 instead.
2. **Update Satellite Crypto Policy** — done manually from the Satellite portal (linked button):
   **Hosts** → select both RHEL VMs → **Schedule Remote Execution** →
   `update-crypto-policies --set FUTURE:CLASSICAL-COMPAT`. The **Verify Policy Applied** button then
   runs `playbooks/run-satellite/01-verify-crypto-policy.yml` on its own to confirm it stuck.
3. **Update Security Policy (AAP)** — done manually from the AAP portal (linked button): **Templates**
   → launch **IntelliMesh Security Compliance** (`playbooks/run-aap/02-inject-compliance.yml`, limit
   `patched`). This is the step that — invisible to Satellite — deploys the oversized 6144-bit RSA
   cert and disables SSL session caching on Node 2, causing the slowdown.
4. **Observe the Impact** — link to the Grafana dashboard.

The Revert and Verify actions need `ANSIBLE_PASSWORD` (used by `inventory/hosts.yml` for SSH/sudo).
Set it once in the server's own environment (or `ui/.env`) for true one-click use, or enter it in
the "Ansible SSH password" field in the UI — it's kept in the browser tab's memory only and
forwarded as a subprocess environment variable, never written to disk.

If the Satellite host login differs from the backend VMs' root/`ANSIBLE_PASSWORD` (common in
practice — Satellite is usually a named admin user that then `sudo bash`'s to root), set
`SATELLITE_SSH_USER` / `SATELLITE_PASSWORD` in the server's environment; see
`group_vars/satellite.yml`. These aren't exposed as separate UI fields yet — the single "Ansible
SSH password" field only maps to `ANSIBLE_PASSWORD`.

`playbooks/run-aap/02-inject-compliance.yml` can still be triggered locally via
`POST /api/playbooks/inject` if you want a scripted/automated run instead of the AAP portal, but no
UI button is wired to it by default.

### Is there a Satellite MCP to automate step 2 instead of the portal?

Not currently — `~/.cursor/mcp.json` only has MCP servers for Jira, UnifAI, and AAP
(`aap-demo-platform` / `aap-cnv`); there's no Red Hat Satellite MCP server configured or
generally available. Satellite (Foreman/Katello) does expose a REST API for remote execution
(`POST /api/job_invocations`) that could be wired into this app the same way the AAP inject
playbook is, if you'd rather automate step 2 than use the portal — ask if you want that added.

## Notes on Tab 2 (UnifAI workflow)

The pipeline is: browser → this Flask backend → UnifAI MAS REST API (`user.session.create` →
`user.session.submit` → poll `session.stream.status` → `session.chat.get`). This mirrors what
`unifai workflow run` does internally, but returns structured JSON instead of scraping terminal
output, so the UI can render workflow names and the final answer directly.

If you see an auth error, run `unifai auth login` in a terminal on this machine and click
"Refresh".

## Configuration

See `.env.example` / `config.py` for all overridable values (Grafana/Satellite/AAP links, UnifAI
MAS URL, poll timing, server host/port).
