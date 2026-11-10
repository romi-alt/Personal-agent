# Staging final verdict

## Verdict: STAGING INSTALLATION READY FOR OWNER AUTHORIZATION

The first Windows isolation pilot is demonstrably safe for the existing production agent: every pilot resource is newly created under `C:\ElevariqStaging`, a hard guard rejects any production/owner path before any privileged action, and all five scripts dry-run with zero system changes while production stays `e60278f` / PID 8992 Running.

## The owner correction is resolved
- **Removed** the worker-DENY ACE on `E:\Agent\Personal-agent`. The pilot now touches **no** production path, task, DB, env, owner credential store, pre-existing ACL, or global firewall default.
- Isolation is proven against **synthetic decoys** (`C:\ElevariqStaging\decoys`), not production.
- The real-production exposure (`E:\ Authenticated Users: Modify`) is documented and deferred to a separate, later, explicitly-authorized production-isolation stage.

## Exact branch and commit
- Code branch: `feat/v21-trusted-execution` @ `5f07b85` (worktree `E:\Agent\v2-staging\v21-trusted-20261110-0223\repo`), 4 commits ahead of `github/main`, **not pushed**. No code change was needed for this safety-gate task; the change was in the admin scripts (design artifacts, not committed to the app repo).
- Admin scripts: `E:\Agent\v2-staging\trusted-execution-20261110-0249\admin-scripts\` (01–05 + `_common.ps1`), redesigned StagingOnly.

## Exact staging paths
- Root: `C:\ElevariqStaging` → `work\`, `broker\` (approvals/audit/signing key), `home\` (synthetic DB), `decoys\` (synthetic look-alikes).
- Account: `elv-stg-worker` (standard). Task: `ElevariqStagingWorker`. Firewall: `ELEVARIQ-STG-Worker-*`.

## Account identity design
- Worker `elv-stg-worker`: standard user, `Users` group only, no sensitive privileges, random password (DPAPI under owner).
- Broker/owner: granted by **user SID** on the broker root (Administrators is deny-only in a filtered token — preflight D3).
- Identity resolution is exact (`Resolve-ElvLocalSid`): rejects ambiguous, non-local, or owner==worker.

## Expected changes (all reversible, none production)
- **ACL:** only `C:\ElevariqStaging\*` (worker Modify on work/home; worker DENY on broker/decoys; owner+SYSTEM Full).
- **Firewall:** three new SID-scoped outbound rules; global default unchanged.
- **Scheduled task:** one new `ElevariqStagingWorker`; production task untouched (name-collision guarded).
- **User right:** add worker SID to `SeBatchLogonRight` (merge; manual Checkpoint 4).

## Rollback
`.\05-rollback.ps1 -Apply`: unregister staging task → remove staging firewall rules → delete `C:\ElevariqStaging` (guarded) → remove `elv-stg-worker`. Restores nothing on production because nothing on production was changed. Emergency stop always available.

## Remaining administrator operations
Checkpoints 1–5 (account, ACLs, firewall, batch-logon right, task) + 6 (staging home/DB) + 7 (acceptance as worker) + 8 (real CLI, BLOCKED on worker login). See `OWNER_AUTHORIZATION_CHECKPOINTS.md`.

## Confirmation of zero production changes (verified this session)
After all dry-runs: `elv-stg-worker` absent, `C:\ElevariqStaging` absent, staging task absent, staging firewall rules absent; production `e60278f`, PID 8992 alive, task Running, **production checkout ACL has no `elv-stg-worker` entry**.

## Independent script-review result
`INDEPENDENT_SCRIPT_REVIEW.md`: no reviewed command writes/deletes/re-ACLs any production or owner object; residual machine-wide footprints (one account, three SID-scoped rules, one task, one user-right SID) are named, scoped and reversible, none touching the V2 supervisor.

## Safety-gate test result
`safety-tests/guard-test.ps1`: **11/11** — production and owner paths rejected (including in production-scope mode), the `C:\ElevariqStagingEvil` prefix-collision trap rejected, real staging paths accepted.

## Code vs. demonstrated OS security
- **Code readiness:** application broker/capability/audit tested (572/572); scripts audited, redesigned, dry-run-clean, guarded. **Met.**
- **Demonstrated OS security:** still not shown — no account/ACL/rule/task exists; the same-user baseline remains 27/27. Proving enforcement needs Checkpoints 1–7 run **as the worker**, then an independent review. **Not yet.**

## One line
**The staging pilot is safe to authorize: it cannot modify production, it proves isolation against synthetic decoys, and every step is reversible. Authorize the checkpoints to turn the application-level controls into OS-enforced ones; production isolation remains a separate, later decision.**
