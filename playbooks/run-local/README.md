# Local playbooks

Run these from your laptop with `ansible-playbook`.

| Playbook | Phase |
|----------|-------|
| `00-setup-hosts.yml` | 0 — bootstrap both VMs |
| `03-verify-quiet.yml` | 3 — health snapshot |
| `04-trigger-failure.yml` | 4 — client TLS/API probes |
| `05-investigate.yml` | 5–6 — compare patched vs control |
