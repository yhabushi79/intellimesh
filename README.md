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
          │ + RSA-6144 cert  │       │ + RSA-4096 cert  │
          │ + no session     │       │ + session cache  │
          │   cache          │       │                  │
          │ = SLOW (20-40ms  │       │ = FAST (8ms      │
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

### Phase 1b — AAP: RSA-6144 cert + disable TLS session caching

| | |
|---|---|
| **Run from** | AAP GUI (https://10.46.253.112/) |
| **Target** | `rhel-patched` only |

Steps in AAP:
1. Open **Templates** → launch **IntelliMesh Security Compliance**
2. Playbook: `playbooks/run-aap/02-inject-compliance.yml`
3. Limit: `patched`
4. Confirm job **successful**

What this does:
1. Regenerates the TLS certificate with **RSA-6144** (compliance mandate for financial data)
2. Deploys `SSLSessionCache none` + `SSLSessionTickets off`

Every HTTPS request now performs a full handshake where the server signs with
a 6144-bit RSA key (~15-20ms CPU per handshake vs ~3-5ms for RSA-4096).
Under concurrent load, the signing queue backs up → subtle CPU pressure → latency creeps up.

---

### Phase 2 — Trigger the degradation (load test)

| | |
|---|---|
| **Run from** | Your laptop (or any machine that can reach the LB) |
| **Target** | Load balancer IP |

Run continuous load to surface the degradation:

> **Important:** Use `hey` (install via `brew install hey`) — macOS `ab` uses
> LibreSSL which is incompatible with the FUTURE crypto-policy. The
> `-disable-keepalive` flag is critical: it forces a new TLS handshake per
> request, which is what triggers the session cache difference.

```bash
# 2-minute load test (recommended)
hey -z 120s -c 200 -disable-keepalive https://10.46.254.38/api/payments
```

Or continuous (Ctrl+C to stop):

```bash
while true; do
  hey -z 60s -c 200 -disable-keepalive https://10.46.254.38/api/payments
  echo "--- batch complete ---"
done
```

Or with Homebrew curl (no extra tools):

```bash
while true; do
  for i in $(seq 1 50); do
    /opt/homebrew/opt/curl/bin/curl -sk -o /dev/null -w "." https://10.46.254.38/api/payments &
  done
  wait 2>/dev/null
  echo ""
  sleep 0.5
done 2>/dev/null
```

**What to look for in the `hey` output:**
- Bimodal histogram — fast cluster (~20-30ms) and slow cluster (80-160ms)
- P50 vs P99 gap — P50 ~40ms, P99 ~150ms means one backend is slow
- All responses return 200 — zero errors despite the latency

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
| TLS Handshake Latency (seconds) | **0.020–0.040s** | ~0.008s | Patched creeps up — RSA-6144 signing every request |
| httpd CPU % | **40–60%** | ~20-30% | RSA-6144 signing adds steady CPU pressure |
| HTTP Error Rate | **0%** | 0% | No errors — this is the trap |
| HTTP Response Code | **200** | 200 | Responses succeed, just slow |

> **Key insight:** The bottom two panels (Error Rate + Response Code) stay
> green the entire time. The degradation is only visible in TLS Handshake
> Latency and httpd CPU — and the difference is subtle enough (8ms vs 25ms)
> that it's easily dismissed as normal variance unless comparing VMs directly.

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

**The key insight:** Both VMs have the same crypto-policy. The differences on VM #1
are: (1) an RSA-6144 certificate and (2) `SSLSessionCache none` — deployed by a
routine AAP compliance job. The cert change makes each TLS signing ~3-4x more expensive,
and disabling session cache ensures every connection pays that cost.

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
2. Regenerates cert with RSA-4096 (standard)
3. Restores session cache settings
4. Restarts httpd

After rollback, TLS handshake drops from 20-40ms back to ~8ms.

---

## Summary: Where each step runs

| Phase | Where | Action |
|-------|-------|--------|
| 0 | **Laptop** | `ansible-playbook playbooks/run-local/00-setup-backends.yml` |
| 1a | **Satellite GUI** | Remote Execution: `update-crypto-policies --set FUTURE:CLASSICAL-COMPAT` on **BOTH** VMs |
| 1a verify | **Laptop** | `ansible-playbook playbooks/run-satellite/01-verify-crypto-policy.yml` |
| 1b | **AAP GUI** | Launch "IntelliMesh Security Compliance" job, limit: patched |
| 2 | **Laptop** | `hey -z 120s -c 10 -disable-keepalive https://10.46.254.38/api/payments` |
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
| **Actual user experience** | **50% of requests take 20-40ms (3-4x normal)** |
| Root cause visibility | Requires per-host TLS-layer inspection under load |

Neither the Satellite change nor the AAP change is wrong alone. The
degradation exists only at their intersection, and only under concurrent load.
The RSA-6144 cert is costly only when session caching is disabled (otherwise
resumed sessions skip the signing entirely).
