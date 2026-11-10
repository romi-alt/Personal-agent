# Owner authorization checklist

Tick each item before authorizing the next stage. Every administrator action is yours; the agent performs none of them.

## Before any Apply
- [ ] I reviewed `ADMIN_SCRIPT_SECURITY_AUDIT.md` and accept the fixed scripts (D1–D5, D7 fixed; D6, D9 are my manual steps).
- [ ] I ran Stage 0 dry-runs and read every `reports\*.json`; the proposed changes match `STAGING_ISOLATION_INSTALLATION_PLAN.md`.
- [ ] I confirm the first run targets **staging/synthetic** resources only; production stays on `e60278f`, PID 8992.
- [ ] I have an elevated PowerShell and will run the stages in order.

## Stage authorizations (staging)
- [ ] **S1** account + broker root (`01 -Apply`). Risk: a new local account + one new directory. Rollback: `05`.
- [ ] **S2** ACLs (`02 -Apply`). Risk: a worker DENY ACE is added to the production checkout (content unchanged; ACL backed up). Rollback: SDDL restore via `05`.
- [ ] **S3** firewall (`03 -Apply`). Risk: worker egress restricted. Rollback: rule removal via `05`.
- [ ] **S4** grant `SeBatchLogonRight` to the worker (D9). Risk: a user-right change; merge, do not overwrite. Rollback: remove the right.
- [ ] **S5** worker task (`04 register -Apply`). Risk: a new scheduled task (not the production one). Rollback: `04 rollback` / `05`.

## Manual items only I can do
- [ ] **D6/auth (B5):** log on as `elevariq-worker` and complete `claude /login` for the worker's own subscription. I will **not** copy the owner's `~/.claude`. Until done, real-CLI under isolation is BLOCKED.
- [ ] **Broker identity:** the broker runs as **me (owner)**, matching the DPAPI credential identity; if I move it to SYSTEM I will re-provision the credential and broker-root ACL.
- [ ] **E:\ broad grant:** I decide whether to apply the targeted `E:\Agent\Personal-agent` inheritance/`Authenticated Users` fix (recommended) or rely on the worker DENY ACE.

## Acceptance gates before I call anything "secure"
- [ ] **S7** adversarial matrix run **as the worker**: A1–A25 all enforced by Windows/broker; L1–L2 succeed.
- [ ] **S8** real Claude CLI legitimate + adversarial + recovery tests under isolation (needs B5).
- [ ] Independent security review (G16) by a separate read-only pass, not sharing the implementer's assumptions.

## Hard stops (I will NOT authorize as part of this pilot)
- [ ] Any change to production V2, its supervisor, task, DB, `.env`, memory thresholds.
- [ ] A Windows reboot.
- [ ] Pushing, merging or deploying any branch.
- [ ] Using production or owner credentials as test fixtures.

## Record
- Authorizing owner: ______________________  Date/time: ______________________
- Stages authorized this session: ______________________
- Deviations from the plan: ______________________
