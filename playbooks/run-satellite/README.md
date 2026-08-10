# Phase 1 — Satellite GUI (not an Ansible playbook)

Do this in **Satellite**, not from AAP or local Ansible.

## Targets

Both RHEL VMs:

- `rhel-patched` — `10.46.253.221`
- `rhel-control` — `10.46.250.70`

(Select them by whatever name Satellite has registered.)

## Steps

1. Open Satellite: https://10.46.253.59/
2. **Hosts** → select both demo RHEL hosts
3. **Schedule Remote Execution** / **Run Job**
4. Template: **Run Command - Script Default**
5. Command:

```bash
update-crypto-policies --set FUTURE && update-crypto-policies --show
```

6. Submit → wait for **success**
7. Verify from your laptop:

```bash
ansible-playbook playbooks/run-satellite/01-verify-crypto-policy.yml
```

## Result

Both hosts: crypto-policy = `FUTURE`. Satellite has real job history for later investigation.
