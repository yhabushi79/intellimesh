# IntelliMesh — The Silent TLS Bottleneck

A chaos engineering exercise that simulates compliance-driven **latency
degradation** in a load-balanced RHEL environment. One backend suffers severe
TLS handshake latency while APM dashboards show 100% green — no errors, no
failures, just slow.

---

## Objective

Exercise the SRE team's ability to diagnose **P99 latency spikes** and **CPU
cryptographic starvation** when:

- All HTTP responses return `200 OK`
- Application logs show normal `15ms` response times
- Error rates are `0%`
- The problem is invisible without direct host inspection under load

---

## Prerequisites

### Load Balancer VM (nginx TCP stream proxy)

SSH into the LB VM and run:

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

The LB is a dumb TCP forwarder — no TLS termination, no inspection.
It round-robins raw TCP connections to the two backend VMs.

---

## Architecture

```
                    ┌──────────────────────────────┐
  Client ────────▶ │  LB VM (nginx stream proxy)  │
  (load test)      │  TCP passthrough :443         │
                   │  Round-robin, no TLS insight  │
                   └──────────────┬───────────────-┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
          ┌──────────────────┐       ┌──────────────────┐
          │ VM #1 (patched)  │       │ VM #2 (control)  │
          │ httpd :443       │       │ httpd :443       │
          │                  │       │                  │
          │ FUTURE:COMPAT    │       │ FUTURE:COMPAT    │
          │ + no session     │       │ + session cache  │
          │   cache          │       │                  │
          │                  │       │                  │
          │ = SLOW (1-2s     │       │ = FAST (15ms     │
          │   handshake)     │       │   handshake)     │
          └──────────────────┘       └──────────────────┘
```

---

## Lab VMs

| Name | Role | IP | Service |
|------|------|----|---------|
| `rhel-patched` | Backend (degraded) | `10.46.253.221` | httpd |
| `rhel-control` | Backend (healthy) | `10.46.250.70` | httpd |
| `rhel-lb` | Load balancer | `10.46.254.38` | nginx stream |

| Platform | URL |
|----------|-----|
| Satellite | https://10.46.253.59/ |
| AAP | https://10.46.253.112/ |

---

## Execution — Step by Step

> **Each step says exactly WHERE to run it.**

---

### Phase 0 — Setup healthy baseline

| | |
|---|---|
| **Run from** | Your laptop |
| **Command** | `ansible-playbook playbooks/run-local/00-setup-backends.yml` |
| **Targets** | Both backend VMs |

What it does:
- Stops/disables nginx on backends (if present)
- Installs httpd + mod_ssl
- Generates self-signed TLS cert
- Deploys payment API endpoints
- Sets crypto-policy to `DEFAULT`
- Verifies HTTPS is working

---

### Phase 1a — Satellite: Push FUTURE:CLASSICAL-COMPAT crypto-policy

| | |
|---|---|
| **Run from** | Satellite GUI (https://10.46.253.59/) |
| **Target** | **BOTH** backend VMs (10.46.253.221 + 10.46.250.70) |

Steps in Satellite:
1. Open **Hosts** → select **both** RHEL VMs
2. Click **Schedule Remote Execution**
3. Job template: **Run Command - Script Default**
4. Command:

```bash
update-crypto-policies --set FUTURE:CLASSICAL-COMPAT
```

5. Submit → wait for **success**

**Then verify from your laptop:**

```bash
ansible-playbook playbooks/run-satellite/01-verify-crypto-policy.yml
```

What this does: Forces BOTH VMs to use 3072-bit RSA minimum for TLS.
Both VMs now look identical from a crypto-policy standpoint — making it
harder for the SRE to spot the difference later.

---

### Phase 1b — AAP: Disable TLS session caching

| | |
|---|---|
| **Run from** | AAP GUI (https://10.46.253.112/) |
| **Target** | `rhel-patched` only |

Steps in AAP:
1. Open **Templates** → launch **IntelliMesh Security Compliance**
2. Playbook: `playbooks/run-aap/02-inject-compliance.yml`
3. Limit: `patched`
4. Confirm job **successful**

What this does: Deploys `SSLSessionCache none` + `SSLSessionTickets off` to httpd.
Every HTTPS request now performs a full handshake — no session reuse.

**Combined effect (FUTURE:CLASSICAL-COMPAT + no session cache):** Every HTTPS request does a full
3072-bit RSA handshake (httpd). SSH and dnf remain unaffected.
Under load, CPU saturates → latency spikes.

---

### Phase 2 — Trigger the degradation (load test)

| | |
|---|---|
| **Run from** | Your laptop (or any machine that can reach the LB) |
| **Target** | Load balancer IP |

Run continuous load to surface the degradation:

```bash
# Continuous load (runs forever until you Ctrl+C)
while true; do
  ab -n 1000 -c 50 https://10.46.254.38/api/health
  sleep 1
done
```

Or a single burst:

```bash
ab -n 5000 -c 50 https://10.46.254.38/api/health
```

Or with curl (no extra tools needed):

```bash
for i in $(seq 1 20); do
  curl -sk -o /dev/null -w "req=$i  TLS=%{time_appconnect}s  Total=%{time_total}s\n" https://10.46.254.38/api/health &
done; wait
```

**What to look for in the output:**
- `Time per request` — high variance (some fast, some 1-2s)
- P99 vs P50 — big gap means one backend is slow
- The degradation is invisible without this load

---

### Phase 3 — Observe (Grafana / manual SSH)

| | |
|---|---|
| **Run from** | Grafana dashboards or SSH into VMs directly |

#### Grafana Panels — What to expect at each phase

**Before injection (Phase 0 — healthy baseline):**

| Panel | VM #1 (patched) | VM #2 (control) | Notes |
|-------|-----------------|-----------------|-------|
| TLS Handshake Latency (seconds) | ~0.015–0.050s | ~0.015–0.050s | Both flat and overlapping |
| httpd CPU % | 1–5% | 1–5% | Minimal crypto work |
| HTTP Error Rate | 0% | 0% | All healthy |
| HTTP Response Code | 200 | 200 | Normal operation |

**After injection (Phase 1a + 1b + load):**

| Panel | VM #1 (patched) | VM #2 (control) | Notes |
|-------|-----------------|-----------------|-------|
| TLS Handshake Latency (seconds) | **1.0–2.0s** | ~0.015s | Patched spikes — full 3072-bit handshake every request |
| httpd CPU % | **80–100%** | ~5% | Key exchange saturates CPU |
| HTTP Error Rate | **0%** | 0% | No errors — this is the trap |
| HTTP Response Code | **200** | 200 | Responses succeed, just slow |

> **Key insight:** The bottom two panels (Error Rate + Response Code) stay
> green the entire time. The degradation is only visible in TLS Handshake
> Latency and httpd CPU. An SRE watching only error-based alerts would
> see "everything is fine" while 50% of users wait 1–2 seconds per request.

#### Grafana metric queries

| Panel | PromQL |
|-------|--------|
| TLS Handshake Latency | `probe_http_duration_seconds{phase="tls"}` |
| httpd CPU % | (node_exporter or process_exporter based) |
| HTTP Error Rate | (derived from probe or access log metrics) |
| HTTP Response Code | (probe_http_status_code or similar) |

If SSH'ing directly into VM #1 for manual proof:

```bash
# CPU — httpd workers maxed out
top -bn1 | grep httpd

# Connection queue — handshakes stuck waiting
ss -tn state syn-recv | wc -l

# Direct TLS timing (the smoking gun)
curl -sk -o /dev/null -w "TCP: %{time_connect}s | TLS: %{time_appconnect}s | Total: %{time_total}s" https://localhost/api/health
```

**The key insight:** Both VMs have the same crypto-policy. The only difference
is `SSLSessionCache none` in `/etc/httpd/conf.d/ssl-params.conf` on VM #1 —
a one-line change buried in httpd config, deployed by AAP.

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
4. Confirm job **successful**

What this does:
1. Reverts crypto-policy → `DEFAULT`
2. Removes session cache override from httpd
3. Reloads httpd

After rollback, TLS handshake drops from 1.5s back to 0.015s.

---

## Summary: Where each step runs

| Phase | Where | Action |
|-------|-------|--------|
| 0 | **Laptop** | `ansible-playbook playbooks/run-local/00-setup-backends.yml` |
| 1a | **Satellite GUI** | Remote Execution: `update-crypto-policies --set FUTURE:CLASSICAL-COMPAT` on **BOTH** VMs |
| 1a verify | **Laptop** | `ansible-playbook playbooks/run-satellite/01-verify-crypto-policy.yml` |
| 1b | **AAP GUI** | Launch "IntelliMesh Security Compliance" job, limit: patched |
| 2 | **Laptop** | `ab -n 5000 -c 50 https://10.46.254.38/api/health` (manual) |
| 3 | **Grafana / SSH** | Observe CPU, TLS latency, session config in dashboards or directly |
| 4 | **AAP GUI** | Launch "IntelliMesh Rollback" job, limit: patched |

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
│   ├── backend-ssl-vhost.conf.j2       ← httpd VirtualHost (backends)
│   ├── ssl-params.conf.j2             ← healthy SSL session settings
│   ├── tls-compliance-override.conf.j2 ← degraded SSL session settings (injection)
│   ├── api-health.sh.j2               ← /api/health CGI endpoint
│   └── api-payments.sh.j2             ← /api/payments CGI endpoint
└── playbooks/
    ├── run-local/                      ← run from your LAPTOP
    │   └── 00-setup-backends.yml       Phase 0
    ├── run-satellite/                  ← verify after SATELLITE GUI action
    │   └── 01-verify-crypto-policy.yml Phase 1a verify
    └── run-aap/                        ← launched from AAP GUI
        ├── 02-inject-compliance.yml    Phase 1b
        └── 07-rollback.yml            Phase 4
```

---

## Reset (full clean slate)

Run from your **laptop**:

```bash
ansible backends -m command -a "update-crypto-policies --set DEFAULT" -b
ansible patched -m template -a "src=templates/ssl-params.conf.j2 dest=/etc/httpd/conf.d/ssl-params.conf" -b
ansible backends -m service -a "name=httpd state=reloaded" -b
```

---

## Why this works as a demo

| Property | Value |
|----------|-------|
| Error rate | 0% — all responses are 200 OK |
| Application logs | Clean — app responds in 15ms |
| LB health checks | Pass — backends respond |
| Monitoring dashboards | Green — no alerts |
| **Actual user experience** | **50% of requests take 1-2 seconds** |
| Root cause visibility | Requires per-host TLS-layer inspection under load |

Neither the Satellite change nor the AAP change is wrong alone. The
degradation exists only at their intersection, and only under concurrent load.
