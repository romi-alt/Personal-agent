# 8. Prioritised V2.1 release roadmap

**Legend:**
- **Done (branch):** implemented and tested on `feat/v2.1-hardening`, not released.
- **Proposed:** designed, not implemented.
- **Owner:** needs the owner's action or authorization.

## Release V2.1a: "guardrail hardening" (ready for review now)
**Goal:** close every text-decidable bypass and two logic defects. **No** change to the security model claim: approvals remain advisory against a hostile worker.

| # | Item | Status | Exit criterion |
|---|---|---|---|
| 1 | F1–F10 command/content policy hardening | **Done (branch)** | 69-probe re-run: 0 text bypasses (achieved) |
| 2 | F11 approval short-circuit fix | **Done (branch)** | Unit test + V2 comparison (achieved) |
| 3 | F12 policy integrity hash + inline settings | **Done (branch)** | Unit tests (achieved). **Pending:** one real CLI session in staging confirming `--settings <json>` with the hook works in Claude Code 2.1.319 (needs authorization to use a real worker session) |
| 4 | F13 supervisor-side tool audit | **Done (branch)** | Event recorded with redacted input |
| 5 | F14 verification env flag | **Done (branch)** | Unit test (achieved) |
| 6 | Code review, push, PR, merge-commit regression | **Owner** | Full Windows regression on the merge SHA |
| 7 | Deploy with the existing runbook (no schema change) | **Owner** | Postdeployment checks; rollback = checkout `e60278f` |

## Release V2.1b: "operational safety" (small, mostly owner actions)

| # | Item | Status | Priority |
|---|---|---|---|
| 8 | `.env` ACL fix (M6), and removal of the inherited `Authenticated Users: Modify` under `E:\Agent` | **Owner** (command in doc 4 §4.2) | P1 |
| 9 | Memory practice M-3 (close the desktop app and unused browser windows during autonomous work) | **Owner** | P1 |
| 10 | Commit-charge check in the memory gate (M-4) + alert when the gate stays closed > 1 h (M-6) | Proposed | P1 |
| 11 | Reboot acceptance run (doc 6) for restart and shutdown/power-on | **Owner** | P1 |
| 12 | Renew the Claude login before **2026-12-04** | **Owner** | P1 |
| 13 | Hook-timeout fail-closed verification (P1-HOOKTO) | Proposed | P2 |
| 14 | Value-based redaction of configured secrets (P1-REDACT) | Proposed | P2 |

## Release V2.2: "real authorization boundary" (P0)

| # | Item | Status | Exit criterion |
|---|---|---|---|
| 15 | Owner authorizes provisioning: local account `elevariq-worker`, workspace root `C:\ElevariqWork`, ACL changes, worker scheduled task | **Owner** (admin) | Provisioning record |
| 16 | Worker runner + file-spool broker (job spec in, events/requests out); the supervisor validates and records | Proposed | Unit + integration tests |
| 17 | Approval-gated capabilities (push, publish, deploy) executed **by the supervisor** after the owner's decision; worker holds no such credentials | Proposed | Broker tests |
| 18 | Separate revocable inference token for the worker account (`claude setup-token`), stored only in the worker profile | **Owner** | Token works non-interactively (**unverified today**) |
| 19 | Single-use, fingerprinted approvals (M3) | Proposed | Unit tests |
| 20 | Owner-only CLI requires a DPAPI-protected owner secret | Proposed (after 15–17) | Unit tests |
| 21 | **Adversarial acceptance:** `run-isolation-tests.ps1` in `worker-user` mode. Every attack BLOCKED, baseline control SUCCEEDED in the same run, functional probes WORK, fingerprints unchanged | The probes and harness exist (baseline and AppContainer modes); the `worker-user` launch mode still has to be added (small) | **Gate for any "secure" claim** |
| 22 | Fence untrusted content in prompts (M5) | Proposed | QA re-baseline |

## V3 and later
- Disposable VM / Windows Sandbox per project (needs RAM, see doc 5).
- Egress allow-listing.
- A signed AppContainer launcher with a pipe-capable runtime.
- Linux worker host (currently out of scope; **Linux remains unverified**).

## Explicitly not claimed
- That V2.1a makes approvals enforceable. **It does not.** Class S (script indirection) remains.
- That AppContainer isolation works for the agent. The prototype showed deny-by-default, but Node child processes fail inside it, and Smart App Control blocks the unsigned launcher.
- That the dedicated-account design is secure. It is untested until item 21 passes.
