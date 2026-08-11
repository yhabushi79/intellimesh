# Monitoring Setup — Prometheus + Grafana

Deploy Prometheus, Grafana, and Blackbox Exporter on the **LB VM** (nginx),
and lightweight exporters on both **backend VMs**.

---

## VM Roles

| VM | IP | Monitoring role |
|----|----|----|
| `rhel-lb` | `10.46.254.38` | Prometheus + Grafana + Blackbox Exporter (containers) |
| `rhel-patched` | `10.46.253.221` | node_exporter + process-exporter (systemd) |
| `rhel-control` | `10.46.250.70` | node_exporter + process-exporter (systemd) |

---

## Grafana Metrics Overview

| Metric | PromQL | Panel type |
|--------|--------|------------|
| CPU usage (httpd) | `rate(namedprocess_namegroup_cpu_seconds_total{groupname="httpd"}[1m]) * 100` | Time series |
| TLS handshake latency | `probe_http_duration_seconds{phase="tls"}` | Time series |
| HTTP error rate | `1 - probe_success` | Stat |
| HTTP response code | `probe_http_status_code` | Stat |

---

## Part A — Backend VMs (run on BOTH 10.46.253.221 and 10.46.250.70)

SSH into each backend VM and run all commands below as root.

### A1. Install node_exporter

```bash
dnf install -y golang-github-prometheus-node-exporter 2>/dev/null || {
  curl -LO https://github.com/prometheus/node_exporter/releases/download/v1.8.2/node_exporter-1.8.2.linux-amd64.tar.gz
  tar xzf node_exporter-1.8.2.linux-amd64.tar.gz
  cp node_exporter-1.8.2.linux-amd64/node_exporter /usr/local/bin/
  rm -rf node_exporter-1.8.2.linux-amd64*
}
```

### A2. Create node_exporter systemd unit

```bash
cat > /etc/systemd/system/node_exporter.service <<'EOF'
[Unit]
Description=Prometheus Node Exporter
After=network.target

[Service]
ExecStart=/usr/local/bin/node_exporter
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

### A3. Start node_exporter

```bash
systemctl daemon-reload
systemctl enable --now node_exporter
```

### A4. Install process-exporter

```bash
curl -LO https://github.com/ncabatoff/process-exporter/releases/download/v0.8.3/process-exporter-0.8.3.linux-amd64.tar.gz
tar xzf process-exporter-0.8.3.linux-amd64.tar.gz
cp process-exporter-0.8.3.linux-amd64/process-exporter /usr/local/bin/
rm -rf process-exporter-0.8.3.linux-amd64*
```

### A5. Create process-exporter config

```bash
mkdir -p /opt/monitoring

cat > /opt/monitoring/process-exporter.yml <<'EOF'
process_names:
  - name: "httpd"
    comm:
      - httpd
EOF
```

### A6. Create process-exporter systemd unit

```bash
cat > /etc/systemd/system/process-exporter.service <<'EOF'
[Unit]
Description=Prometheus Process Exporter
After=network.target

[Service]
ExecStart=/usr/local/bin/process-exporter -config.path=/opt/monitoring/process-exporter.yml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

### A7. Start process-exporter

```bash
systemctl daemon-reload
systemctl enable --now process-exporter
```

### A8. Open firewall ports

```bash
firewall-cmd --permanent --add-port=9100/tcp --add-port=9256/tcp
firewall-cmd --reload
```

### A9. Verify both exporters are running

```bash
curl -s http://localhost:9100/metrics | head -5
curl -s http://localhost:9256/metrics | grep httpd | head -5
```

You should see metric output from both. Repeat Part A on the second backend VM.

---

## Part B — LB VM (run on rhel-lb only)

SSH into the LB VM and run all commands below as root.

### B1. Install podman

```bash
dnf install -y podman
```

### B2. Create directory structure

```bash
mkdir -p /opt/monitoring/{prometheus,grafana,blackbox}
```

### B3. Create Blackbox Exporter config

```bash
cat > /opt/monitoring/blackbox/blackbox.yml <<'EOF'
modules:
  https_probe:
    prober: http
    timeout: 10s
    http:
      valid_http_versions: ["HTTP/1.1", "HTTP/2.0"]
      valid_status_codes: [200]
      method: GET
      tls_config:
        insecure_skip_verify: true
EOF
```

### B4. Create Prometheus config

```bash
cat > /opt/monitoring/prometheus/prometheus.yml <<'EOF'
global:
  scrape_interval: 5s
  evaluation_interval: 5s

scrape_configs:
  # --- Node Exporter (system metrics) ---
  - job_name: 'node'
    static_configs:
      - targets: ['10.46.253.221:9100']
        labels:
          instance: 'rhel-patched'
      - targets: ['10.46.250.70:9100']
        labels:
          instance: 'rhel-control'

  # --- Process Exporter (httpd CPU) ---
  - job_name: 'process'
    static_configs:
      - targets: ['10.46.253.221:9256']
        labels:
          instance: 'rhel-patched'
      - targets: ['10.46.250.70:9256']
        labels:
          instance: 'rhel-control'

  # --- Blackbox: probe rhel-patched ---
  - job_name: 'blackbox-patched'
    metrics_path: /probe
    params:
      module: [https_probe]
      target: ['https://10.46.253.221/api/health']
    static_configs:
      - targets: ['127.0.0.1:9115']
        labels:
          instance: 'rhel-patched'
    relabel_configs:
      - source_labels: [__param_target]
        target_label: target

  # --- Blackbox: probe rhel-control ---
  - job_name: 'blackbox-control'
    metrics_path: /probe
    params:
      module: [https_probe]
      target: ['https://10.46.250.70/api/health']
    static_configs:
      - targets: ['127.0.0.1:9115']
        labels:
          instance: 'rhel-control'
    relabel_configs:
      - source_labels: [__param_target]
        target_label: target
EOF
```

### B5. Run Blackbox Exporter container

```bash
podman run -d \
  --name blackbox \
  --restart always \
  -p 9115:9115 \
  -v /opt/monitoring/blackbox/blackbox.yml:/etc/blackbox_exporter/config.yml:Z \
  docker.io/prom/blackbox-exporter:latest
```

### B6. Run Prometheus container

```bash
podman run -d \
  --name prometheus \
  --restart always \
  -p 9090:9090 \
  -v /opt/monitoring/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:Z \
  docker.io/prom/prometheus:latest
```

### B7. Run Grafana container

```bash
podman run -d \
  --name grafana \
  --restart always \
  -p 3000:3000 \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  -v /opt/monitoring/grafana:/var/lib/grafana:Z \
  docker.io/grafana/grafana:latest
```

### B8. Open firewall ports

```bash
firewall-cmd --permanent --add-port=9090/tcp --add-port=9115/tcp --add-port=3000/tcp
firewall-cmd --reload
```

### B9. Verify containers are running

```bash
podman ps
```

You should see three containers: `blackbox`, `prometheus`, `grafana`.

### B10. Verify Prometheus targets

Open `http://10.46.254.38:9090/targets` in a browser. All targets should show **UP**:

- `node` — 2 targets (both backends)
- `process` — 2 targets (both backends)
- `blackbox-patched` — 1 target
- `blackbox-control` — 1 target

---

## Part C — Configure Grafana

### C1. Log in

Open `http://10.46.254.38:3000` — login with `admin` / `admin`.

### C2. Add Prometheus data source

1. Go to **Connections → Data sources → Add data source**
2. Select **Prometheus**
3. URL: `http://10.46.254.38:9090`
4. Click **Save & Test** — should say "Data source is working"

### C3. Create dashboard

Go to **Dashboards → New → New Dashboard → Add visualization**.

Create four panels:

#### Panel 1: httpd CPU Usage (%)

- Title: `httpd CPU %`
- Query:

```promql
rate(namedprocess_namegroup_cpu_seconds_total{groupname="httpd"}[1m]) * 100
```

- Legend: `{{instance}}`
- Panel type: Time series

#### Panel 2: TLS Handshake Latency

- Title: `TLS Handshake Latency (seconds)`
- Query:

```promql
probe_http_duration_seconds{phase="tls"}
```

- Legend: `{{instance}}`
- Panel type: Time series
- Unit: seconds (s)

#### Panel 3: HTTP Response Code

- Title: `HTTP Response Code`
- Query:

```promql
probe_http_status_code
```

- Legend: `{{instance}}`
- Panel type: Stat

#### Panel 4: HTTP Error Rate

- Title: `HTTP Error Rate`
- Query:

```promql
1 - probe_success
```

- Legend: `{{instance}}`
- Panel type: Stat
- Unit: percent (0-1)
- Thresholds: 0 = green, >0 = red

### C4. Save the dashboard

Name it **IntelliMesh — TLS Observability** and save.

---

## Verification Checklist

Run from your laptop after setup is complete:

```bash
# Check node_exporter on both backends
curl -s http://10.46.253.221:9100/metrics | grep node_cpu_seconds_total | head -1
curl -s http://10.46.250.70:9100/metrics | grep node_cpu_seconds_total | head -1

# Check process-exporter on both backends
curl -s http://10.46.253.221:9256/metrics | grep namedprocess | grep httpd | head -1
curl -s http://10.46.250.70:9256/metrics | grep namedprocess | grep httpd | head -1

# Check blackbox probes from LB
curl -s "http://10.46.254.38:9115/probe?module=https_probe&target=https://10.46.253.221/api/health" | grep probe_http_duration_seconds
curl -s "http://10.46.254.38:9115/probe?module=https_probe&target=https://10.46.250.70/api/health" | grep probe_http_duration_seconds
```

---

## Expected Results During Load Test

Once you run the load test (`ab -n 5000 -c 50 https://10.46.254.38/api/health`), the
Grafana dashboard will show:

| Panel | rhel-patched | rhel-control |
|-------|-------------|-------------|
| httpd CPU % | 80–100% | ~5% |
| TLS Handshake Latency | 1.0–2.0s | 0.015s |
| HTTP Response Code | 200 | 200 |
| HTTP Error Rate | 0% | 0% |

The dashboards will clearly show the degradation on `rhel-patched` while
confirming that nothing is "broken" — all responses are 200 OK.
