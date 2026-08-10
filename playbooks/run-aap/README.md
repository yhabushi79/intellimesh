# AAP playbooks

Import this repo into an AAP project. Create job templates that point here and
**launch from the AAP UI**.

| Playbook | Phase | Limit |
|----------|-------|-------|
| `02-post-patch.yml` | 2 — apply legacy SSL pin | `patched` |
| `07-remediate.yml` | 7 — remove legacy SSL pin | `patched` |

Do **not** run these with local `ansible-playbook` for the demo path — AAP must
create the job history.
