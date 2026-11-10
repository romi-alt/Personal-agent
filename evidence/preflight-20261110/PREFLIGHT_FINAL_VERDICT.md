# Preflight final verdict

## Verdict: CODE READY (application level) — OS SECURITY NOT YET DEMONSTRATED. Do not configure production isolation.

The distinction the mandate demands:
- **Code readiness:** the trusted-execution application layer is implemented, unit-tested, and its admin scripts are audited and fixed. **Met.**
- **Demonstrated operating-system security:** requires a separate worker identity, ACLs, firewall, job limits and a real-CLI run under isolation — all needing administrator authorization and not performed. **Not met.**

## What this preflight did
1. **Audited all five admin scripts line by line** and found 7 real defects (not parse issues). Fixed 5 in place (D1 unchecked icacls exit codes, D2 non-idempotency, D3 broker locked out by the filtered-token Administrators ACE, D4 ambient-env owner paths, D5/D7 no ACL backup + credential written before lock). Documented 2 (D6 DPAPI identity, D9 batch-logon right) as owner/manual steps. Re-dry-ran: 0 system changes.
2. **Confirmed the D3 root cause empirically** (`Administrators` is deny-only in the owner token), which would otherwise have locked the broker out of its own signing key on first apply.
3. **Reviewed the broker for cross-identity operation** and fixed one code defect (D10 unbounded request set, commit `5f07b85`). 572/572 unit tests pass.
4. **Designed the disposable staging pilot** (synthetic account, DB, broker, audit store, pipe) that never exposes production or owner credentials.
5. **Produced verification, firewall, acceptance, resource/recovery, exact-command, rollback and authorization documents**, each separating app-level from OS-enforced.
6. **Recorded the Claude-auth blocker** (B5/G12) without copying or reading any owner token.

## Code state
- Branch `feat/v21-trusted-execution` @ `5f07b85`, 4 commits ahead of `github/main` (`4d25c0a`), **not pushed**.
- Admin scripts in `trusted-execution-20261110-0249\admin-scripts\` (hardened, dry-run only).

## Demonstrated OS security
- **None yet.** Same-user baseline reproduced: **27/27 attacks still succeed**. No worker account, ACL, firewall rule or task exists. The acceptance matrix that would prove enforcement is written but **not run** (requires the worker account).

## Exact administrator actions required next (with risk + rollback)
| Stage | Action | Privilege | Risk | Rollback |
|---|---|---|---|---|
| S1 | `01 -Apply`: create `elevariq-worker`, secure broker root | Admin | new local account + dir | `05` removes both |
| S2 | `02 -Apply`: ACLs incl. worker DENY on production checkout | Admin | one ACE on production checkout (content unchanged, ACL backed up) | SDDL restore via `05` |
| S3 | `03 -Apply`: SID-scoped egress rules | Admin | worker egress restricted | rule removal via `05` |
| S4 | grant `SeBatchLogonRight` to the worker | Admin | user-right change (merge) | remove the right |
| S5 | `04 register -Apply`: worker task | Admin | new task (not production) | `04 rollback` / `05` |
| S6–S8 | staging home + synthetic DB; acceptance as the worker; real-CLI (needs B5) | mixed | staging only | delete staging tree |

Emergency stop (always): `Stop-ScheduledTask ElevariqWorker` + stop worker-tree processes + optionally `Disable-LocalUser`.

## Blockers to a READY verdict
- **B-admin:** S1–S5 require administrator authorization (not given).
- **B5/G12:** real Claude CLI under the worker needs an interactive worker login; copying owner creds is forbidden → BLOCKED.
- **G13:** OS-level adversarial acceptance must be run **as the worker** after S1–S5; per current authorization the agent does not run the harness.
- **G16:** independent security review after the OS controls are applied.

## Production
Untouched: `e60278f`, PID 8992 running, task Running. Nothing pushed, merged, deployed or restarted. No Windows security object created. Memory thresholds unchanged.

## One-line verdict
**The software is ready to be isolated; it is not yet isolated. Authorize the staged, reversible admin installation against staging resources to turn the application-level controls into OS-enforced ones, then prove it with the adversarial matrix before any production isolation.**
