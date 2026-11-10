# Staging isolation installation plan (disposable pilot)

The first authorized installation uses **only synthetic staging resources**. Production is never exposed to the test worker. Nothing here is executed in this preflight; it is the plan the owner runs after review.

## Disposable resources (all synthetic)

| Resource | Staging value | Never touched |
|---|---|---|
| Worker account | `elevariq-worker` (standard, local) | the owner account `Roman` |
| Worker tree | `C:\ElevariqWork` | owner profile, `E:\Agent\*` |
| Broker root | `C:\ElevariqBroker` (staging approvals, audit, synthetic signing key) | production agent home |
| Agent home (staging) | `C:\ElevariqWork\staging-home` with a **synthetic** SQLite DB | `%LOCALAPPDATA%\ElevariqAgent` (production) |
| Credentials | synthetic markers only (e.g. `SYNTHETIC-…`), never real tokens | owner `~/.claude`, `.ssh`, `.aws` |
| Task workspace | `C:\ElevariqWork\staging-home\workspaces\<task>` | real project directories |
| Broker | staging broker process under the owner identity, reading `C:\ElevariqBroker` | production supervisor PID 8992 |
| Audit store | `C:\ElevariqBroker\audit\staging.chain.jsonl` + synthetic HMAC key | production logs |
| IPC endpoint | named pipe `\\.\pipe\elevariq-broker-staging` | any production pipe |

## Stages (each individually reversible)

- **S0 — Dry-run review (no elevation).** Run all five scripts in dry-run; read `reports/*.json`. Gate: proposed changes match this plan.
- **S1 — Account + broker root (`01 -Apply`).** Creates `elevariq-worker`, secures `C:\ElevariqBroker` (owner+SYSTEM), writes the worker credential DPAPI-protected. Reversible by `05 -Apply` (removes account + tree).
- **S2 — ACLs (`02 -Apply`).** Worker tree, broker-root DENY for the worker, DENY ACEs on owner/production paths (ACLs backed up first). Reversible by `05` (SDDL restore).
- **S3 — Firewall (`03 -Apply`).** SID-scoped egress allow/block. Reversible by `05` (rule removal).
- **S4 — Batch-logon right.** Grant `elevariq-worker` "Log on as a batch job" (D9). Reversible by removing the right.
- **S5 — Worker task (`04 -Mode register -Apply`).** Registers `ElevariqWorker` under the worker identity. Reversible by `04 -Mode rollback` or `05`.
- **S6 — Staging agent home + synthetic DB.** Create `C:\ElevariqWork\staging-home`, seed a synthetic SQLite DB (copy of a schema-only snapshot, no real rows), point a staging supervisor/broker at it.
- **S7 — Acceptance.** Run `ADVERSARIAL_ACCEPTANCE_MATRIX.md` as the worker and `WINDOWS_IDENTITY_AND_ACL_VALIDATION.md` checks. Gate: every boundary enforced by Windows/broker.
- **S8 — Real Claude CLI under the worker (if B5 unblocked).** Tests A/B/C from the mandate.

## Production isolation is NOT configured until staging passes
Only after S7 (and S8 where possible) passes an **independent** review does production isolation get planned. The production supervisor stays on `e60278f`, PID 8992, untouched throughout the pilot. Staging and production never share a DB, home, port, pipe or account.

## Separation guarantees
- Staging broker root, DB, pipe and port are distinct names; the staging supervisor is a separate process the owner starts and stops.
- `Assert-NotProduction` in the scripts throws before any production path is modified.
- The synthetic DB is seeded from a schema snapshot, never a production copy with real rows.
