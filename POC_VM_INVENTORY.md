# PoC VM Inventory

> **Warning:** This file contains lab credentials. Do not commit to a public repository.

All VMs and endpoints used for the PoC.

| Component | Role / Notes | URL / Host | Username | Password / Token |
| --- | --- | --- | --- | --- |
| **AAP** | Ansible Automation Platform | https://10.46.253.112/ | `admin` | `Mc10vin!!` |
| **AAP MCP** | AAP MCP endpoint | https://10.46.253.112:8448/mcp | — | `2Wbw8u04g0JQAHcSh7Zti0heHcyPpy` |
| **AAP host SSH** | AAP server SSH | `10.46.253.112` | `root` | `Mc10vin!!` |
| **Satellite** | Red Hat Satellite | https://10.46.253.59/users/login | `admin` | `Mc10vin!!` |
| **Satellite MCP** | Satellite MCP endpoint | http://10.46.253.59:8080/mcp/sse | `admin` | `n0HJPtSWvRW89ydhJm1Ojg` |
| **Satellite host SSH** | Satellite server SSH | `10.46.253.59` | `root` | `Mc10vin!!` |
| **RHEL — Control VM** | Control node | `10.46.250.70` | `root` | `Mc10vin!!` |
| **RHEL — Patched VM** | Patched target | `10.46.253.221` | `root` | `Mc10vin!!` |

## Quick reference

```text
AAP            10.46.253.112      :443    (UI)
AAP MCP        10.46.253.112      :8448   (/mcp)
AAP SSH        10.46.253.112              (root / Mc10vin!!)
Satellite      10.46.253.59       :443    (/users/login)
Satellite MCP  10.46.253.59       :8080   (/mcp/sse)  admin / n0HJPtSWvRW89ydhJm1Ojg
Satellite SSH  10.46.253.59               (root / Mc10vin!!)
Control        10.46.250.70               (SSH root / Mc10vin!!)
Patched        10.46.253.221              (SSH root / Mc10vin!!)
```

## MCP auth notes

| MCP | Headers / auth |
| --- | --- |
| AAP MCP | Bearer token `2Wbw8u04g0JQAHcSh7Zti0heHcyPpy` |
| Satellite MCP | `FOREMAN_USERNAME=admin`, `FOREMAN_TOKEN=n0HJPtSWvRW89ydhJm1Ojg` |
