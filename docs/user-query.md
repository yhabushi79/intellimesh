# Incident: Customer-reported slowness on payment service

## Context
Multiple customers have reported intermittent slowness when processing payments.
Standard monitoring shows no errors — all health checks pass, error rates are 0%,
and response codes are 200.

- **Payment endpoint:** https://10.46.254.38/api/payments (Nginx Load Balancer)

## Workflow

### Step 1 — Investigation

Use IntelliMesh-AAP-Investigator and IntelliMesh-Satellite-Investigator agents
to determine the root cause of the slowness.

**Required output from each investigator (structured):**
- Root cause description
- Affected host(s) — specify WHICH nodes are affected vs healthy
- Evidence: job IDs, log excerpts, configuration states
- Verified file paths and their current state on disk
- Recommended remediation actions with specifics (not generic advice)

---

### Step 2 — Remediation Development

Pass the COMPLETE structured findings from Step 1 to the Developer Agent.
Include the root cause, all evidence, affected hosts, and verified file states.
Do not summarize or omit details.

- Repository: `intellimesh`, branch: `redesign/lb-httpd-architecture`


### Step 3 — Execution

- The Developer Agent commits the playbook and launches it via AAP.
- Confirm AAP job logs show all tasks succeeded and services are healthy
  before proceeding to Step 4.

### Step 4 — RCA Reporting

**Input to Reporter Agent:** Pass ALL of the following:
1. Full investigation findings from Step 1 (per-agent, with evidence)
2. Remediation playbook from Step 2 (playbook name, commit hash)
3. Execution results from Step 3 (AAP job ID, job logs proving success)

Upload the RCA report to Google Drive folder:
https://drive.google.com/drive/folders/1fW_EDcP5bpie9ckpURkVvnu2ihzo1EsF