# IntelliMesh Demo — Cascading Configuration Conflict

Satellite hardens crypto on **both** VMs. AAP applies a legacy SSL pin on
**patched only**. TLS breaks only on patched — the control host proves the
failure is at the intersection of the two systems.

Lab secrets: `POC_VM_INVENTORY.md` (private).

---

## Lab VMs (2 RHEL)

| Name | Group | IP | Satellite | AAP legacy pin | Result |
|------|-------|-----|-----------|----------------|--------|
| `rhel-patched` | `patched` | `10.46.253.221` | yes | yes | **breaks** |
| `rhel-control` | `control` | `10.46.250.70` | yes | no | **healthy** |

| Platform | URL |
|----------|-----|
| Satellite | https://10.46.253.59/ |
| AAP | https://10.46.253.112/ |

---

## Playbook layout

```
playbooks/
├── run-local/          # laptop Ansible
│   ├── 00-setup-hosts.yml
│   ├── 03-verify-quiet.yml
│   ├── 04-trigger-failure.yml
│   └── 05-investigate.yml
├── run-satellite/      # Satellite GUI + local verify
│   ├── README.md       # GUI steps (Phase 1)
│   └── 01-verify-crypto-policy.yml
└── run-aap/            # imported into AAP; launch from AAP UI
    ├── 02-post-patch.yml
    └── 07-remediate.yml
```

| Folder | Who runs it |
|--------|-------------|
| `run-local/` | You, with `ansible-playbook` |
| `run-satellite/` | You do the change in **Satellite GUI**; verify playbook is local |
| `run-aap/` | **AAP** job templates (UI launch) |

---

## Phase flow

### Phase 0 — Setup (`run-local`)

| | |
|--|--|
| **System** | Laptop |
| **Targets** | both VMs |
| **Command** | `ansible-playbook playbooks/run-local/00-setup-hosts.yml` |
| **Result** | nginx + TLS; crypto-policy `DEFAULT` |

---

### Phase 1 — Crypto change (`run-satellite`)

| | |
|--|--|
| **System** | **Satellite GUI** |
| **Targets** | both VMs |
| **Action** | Follow `playbooks/run-satellite/README.md` |
| **Verify** | `ansible-playbook playbooks/run-satellite/01-verify-crypto-policy.yml` |
| **Result** | both hosts = `FUTURE` |

Satellite GUI command:

```bash
update-crypto-policies --set FUTURE && update-crypto-policies --show
```

---

### Phase 2 — Legacy SSL pin (`run-aap`)

| | |
|--|--|
| **System** | **AAP UI** |
| **Targets** | `rhel-patched` only |
| **Action** | Job template → `playbooks/run-aap/02-post-patch.yml`, limit `patched` |
| **Result** | legacy cipher pin on patched; control untouched |

---

### Phase 3 — Quiet check (`run-local`)

```bash
ansible-playbook playbooks/run-local/03-verify-quiet.yml
```

Targets: both. Looks fine; conflict is latent on patched.

---

### Phase 4 — Failure surfaces (`run-local`)

```bash
ansible-playbook playbooks/run-local/04-trigger-failure.yml
```

Probes both. Patched TLS fails; control OK.

---

### Phase 5–6 — Investigate (`run-local` or UnifAI)

```bash
ansible-playbook playbooks/run-local/05-investigate.yml
```

Compares patched vs control. Prefer UnifAI + Satellite/AAP MCP for the agent story.

---

### Phase 7 — Remediate (`run-aap`)

| | |
|--|--|
| **System** | **AAP UI** |
| **Targets** | `rhel-patched` only |
| **Action** | Job template → `playbooks/run-aap/07-remediate.yml`, limit `patched` |
| **Result** | pin removed; TLS restored |

---

## Quick reference

| Phase | Folder | System | Targets | Outcome |
|-------|--------|--------|---------|---------|
| 0 | `run-local` | Laptop | both | Baseline |
| 1 | `run-satellite` | Satellite GUI | both | `FUTURE` |
| 2 | `run-aap` | AAP UI | patched | Legacy pin |
| 3 | `run-local` | Laptop | both | Looks quiet |
| 4 | `run-local` | Laptop | probe both | Patched fails |
| 5–6 | `run-local` | Laptop / UnifAI | both | Root cause |
| 7 | `run-aap` | AAP UI | patched | Fixed |

---

## AAP job templates

| Template name | Playbook | Limit |
|---------------|----------|-------|
| IntelliMesh Post-Patch | `playbooks/run-aap/02-post-patch.yml` | `patched` |
| IntelliMesh Remediate | `playbooks/run-aap/07-remediate.yml` | `patched` |

---

## Reset

```bash
ansible app_hosts -m command -a "update-crypto-policies --set DEFAULT" -b
ansible patched -m file -a "path=/etc/nginx/conf.d/ssl-hardening.conf state=absent" -b
ansible app_hosts -m service -a "name=nginx state=reloaded" -b
```

---

## Key insight

Neither Satellite nor AAP is wrong alone. The outage exists only on **`rhel-patched`**, where both changes landed.
