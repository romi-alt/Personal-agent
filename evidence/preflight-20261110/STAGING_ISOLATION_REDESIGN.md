# Staging isolation redesign (owner correction: zero production changes)

## What changed and why
The previous S2 added a worker-DENY ACE to `E:\Agent\Personal-agent`. Even backed up and content-preserving, **that is a production ACL change** and is unacceptable for a first pilot. The scripts are redesigned so the pilot touches **only newly created, dedicated staging objects**.

## New scope: one root, guarded
- **Everything** the pilot creates lives under **`C:\ElevariqStaging\`**: `work\`, `broker\`, `home\`, `decoys\`.
- Staging account renamed **`elv-stg-worker`** (clearly staging; cannot be confused with a future production worker).
- Staging task **`ElevariqStagingWorker`**; firewall prefix **`ELEVARIQ-STG-Worker`**.
- A hard guard, `Assert-StagingPath`, runs **before any privileged action** and **throws** if a target is not under `C:\ElevariqStaging` — and always throws on a known production path, even outside StagingOnly mode.

## The 10 required properties — how each is met
1. **`-StagingOnly` switch (default `$true`)** on all five scripts; non-staging mode throws ("separate, later, authorized stage").
2. **Reject production paths before any privileged action** — `Assert-StagingPath` guards every target; verified by `safety-tests/guard-test.ps1` (11/11, incl. prod rejected in both modes).
3. **Exact, canonical target paths and SIDs** — `Get-ElvCanonicalPath` normalizes; `Resolve-ElvLocalSid` resolves exactly one local SID.
4. **Reject ambiguous/inherited/unexpected identities** — `Resolve-ElvLocalSid` throws on >1 match or a non-`S-1-5-21` SID; 02 aborts if owner SID == worker SID.
5. **Individually reversible** — each stage maps to a discrete creation; `05` removes exactly the staging tree + account + task + rules.
6. **Rollback cannot remove/overwrite pre-existing unrelated ACLs** — the pilot never sets an ACL on a pre-existing object, so there is nothing foreign to restore or clobber; `05` deletes only the staging tree (guarded) and named staging objects.
7. **Unavoidable system-wide changes documented** — a local account exists machine-wide (inherently); the SID-scoped firewall rules are new (no global default change). Both are listed in the report and below.
8. **Complete dry-run validation** — all five scripts dry-run clean; logs in `safety-tests/dryrun-logs/`; 0 system objects created.
9. **Independent command review** — see `INDEPENDENT_SCRIPT_REVIEW.md` (side effects of account creation, firewall, task, user-right).
10. **Production unchanged** — verified after every dry-run: prod `e60278f`, PID 8992 Running, checkout ACL has no `elv-stg-worker` entry.

## Isolation is proven against SYNTHETIC decoys, not production
`02` creates `decoys\fake-claude\.credentials.json` and `decoys\fake-prod-checkout\.env` (synthetic markers) with a worker DENY. The acceptance matrix proves the worker is blocked from **those**, so enforcement is demonstrated **without touching real production or owner files**.

## The real-production exposure the pilot deliberately does NOT fix
Creating an enabled standard account means it is an **Authenticated User**, and `E:\` grants `Authenticated Users: Modify`, inherited by the production checkout. So the staging worker *could* reach real production via that pre-existing grant. The pilot **does not change this** (owner constraint) and does not claim OS-level production isolation. Mitigations during the pilot:
- The staging worker runs only **supervised, synthetic** tasks; the account can be created and left **disabled** except during a supervised run.
- The app-level broker/policy still cover production paths.
- Closing the exposure (the `E:\` grant or a production-checkout DENY) is the separate **PRODUCTION_ISOLATION_STAGE**, authorized only after the staging pilot passes acceptance and an independent review. It is explicitly **out of this pilot**.
