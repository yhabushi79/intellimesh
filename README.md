# IntelliMesh

Infrastructure management exercise for a load-balanced RHEL environment.

---

## Architecture

```
                    ┌──────────────────────────────┐
  Client ────────▶ │  LB VM (nginx stream proxy)  │
                   │  TCP passthrough :443         │
                   └──────────────┬────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
          ┌──────────────────┐       ┌──────────────────┐
          │ VM #1 (patched)  │       │ VM #2 (control)  │
          │ httpd :443       │       │ httpd :443       │
          └──────────────────┘       └──────────────────┘
```

---

## Lab VMs

| Name | Role | IP | Service |
|------|------|----|---------|
| `rhel-patched` | Backend | `10.46.253.221` | httpd |
| `rhel-control` | Backend | `10.46.250.70` | httpd |
| `rhel-lb` | Load balancer | `10.46.254.38` | nginx stream |

| Platform | URL |
|----------|-----|
| Satellite | https://10.46.253.59/ |
| AAP | https://10.46.253.112/ |

---

## Prerequisites

### Load Balancer VM (nginx TCP stream proxy)

```bash
dnf install -y nginx nginx-mod-stream

cat > /etc/nginx/nginx.conf <<'EOF'
worker_processes auto;
error_log /var/log/nginx/error.log;
pid /run/nginx.pid;

events {
    worker_connections 1024;
}

stream {
    upstream backend_pool {
        server 10.46.253.221:443;
        server 10.46.250.70:443;
    }

    server {
        listen 443;
        proxy_pass backend_pool;
    }
}
EOF

systemctl enable --now nginx
firewall-cmd --permanent --add-port=443/tcp && firewall-cmd --reload
```

---

## Execution

### Phase 0 — Setup backends

| | |
|---|---|
| **Run from** | Your laptop |
| **Command** | `ansible-playbook playbooks/run-local/00-setup-backends.yml` |
| **Targets** | Both backend VMs |

---

### Phase 1a — Satellite: Apply crypto-policy

| | |
|---|---|
| **Run from** | Satellite GUI (https://10.46.253.59/) |
| **Target** | Both backend VMs |

Steps in Satellite:
1. Open **Hosts** → select both RHEL VMs
2. Click **Schedule Remote Execution**
3. Job template: **Run Command - Script Default**
4. Command: `update-crypto-policies --set FUTURE:CLASSICAL-COMPAT`
5. Submit

Verify:

```bash
ansible-playbook playbooks/run-satellite/01-verify-crypto-policy.yml
```

---

### Phase 1b — AAP: Apply TLS compliance policy

| | |
|---|---|
| **Run from** | AAP GUI (https://10.46.253.112/) |
| **Target** | `rhel-patched` only |

Steps in AAP:
1. Open **Templates** → launch **IntelliMesh Security Compliance**
2. Playbook: `playbooks/run-aap/02-inject-compliance.yml`
3. Limit: `patched`

---

### Phase 2 — Load test

| | |
|---|---|
| **Run from** | Your laptop |
| **Target** | Load balancer IP |

```bash
hey -z 120s -c 200 -disable-keepalive https://10.46.254.38/api/payments
```

---

### Phase 3 — Observe

| | |
|---|---|
| **Run from** | Grafana dashboards or SSH |

---

### Phase 4 — Rollback

| | |
|---|---|
| **Run from** | AAP GUI (https://10.46.253.112/) |
| **Target** | `rhel-patched` only |

Steps in AAP:
1. Open **Templates** → launch **IntelliMesh Rollback**
2. Playbook: `playbooks/run-aap/07-rollback.yml`
3. Limit: `patched`

---

## AAP Job Templates

| Template | Playbook | Limit | Credential |
|----------|----------|-------|------------|
| IntelliMesh Security Compliance | `playbooks/run-aap/02-inject-compliance.yml` | `patched` | Machine (root + password) |
| IntelliMesh Rollback | `playbooks/run-aap/07-rollback.yml` | `patched` | Machine (root + password) |

---

## File layout

```
intelliMesh/
├── README.md
├── ansible.cfg
├── inventory/
│   └── hosts.yml
├── group_vars/
│   ├── all.yml
│   ├── patched.yml
│   └── control.yml
├── templates/
│   ├── backend-ssl-vhost.conf.j2
│   ├── ssl-params.conf.j2
│   ├── tls-compliance-override.conf.j2
│   ├── api-health.sh.j2
│   └── api-payments.sh.j2
└── playbooks/
    ├── run-local/
    │   └── 00-setup-backends.yml
    ├── run-satellite/
    │   └── 01-verify-crypto-policy.yml
    └── run-aap/
        ├── 02-inject-compliance.yml
        └── 07-rollback.yml
```

---

## Reset

```bash
ansible backends -m command -a "update-crypto-policies --set DEFAULT" -b
ansible patched -m template -a "src=templates/ssl-params.conf.j2 dest=/etc/httpd/conf.d/ssl-params.conf" -b
ansible backends -m service -a "name=httpd state=reloaded" -b
```
