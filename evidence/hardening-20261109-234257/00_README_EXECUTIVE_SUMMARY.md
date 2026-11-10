# ELEVARIQ Personal Agent V2.1: post-deployment security hardening, executive summary

**Window:** 2026-11-09 23:41 → 2026-11-10 00:30 (+05:00).
- **Production:** V2 `e60278f`, untouched.
- **Branch:** `feat/v2.1-hardening` @ `4d07438`, local only. Isolated clone: `E:\Agent\v2-staging\hardening\repo`. Patches and bundle: `patches\`.

## Bottom line
1. **V2.1a guardrail hardening is implemented, tested and ready for review. It is not a security boundary.**
   - Text-decidable command-filter bypasses fall from **33 to 0** across the 69 audit probes.
   - Two real logic defects are fixed:
     - the approval short-circuit (with push approved, V2 allowed `git push && rm -rf ~`);
     - verification commands that ran unflagged.
   - Policy-file tampering now fails closed (sha256 check).
   - The supervisor records every tool call itself.
   - **686/686** automated tests pass on the branch (677 vitest + 9 browser).
2. **Approvals remain advisory against a hostile or prompt-injected worker.**
   - In an executed control run as today's worker identity, on synthetic targets, a worker was able to:
     - read credentials (including through a generated script);
     - self-approve by SQL and through the agent CLI (recorded as `owner-cli`);
     - widen its policy, tamper with the `.env` equivalent, create `STOP-HOLD`, and forge and delete audit records;
     - escape the workspace;
     - reach loopback and the internet.
   - Only OS isolation can change this.
3. **Real isolation: designed, not demonstrated.**
   - **AppContainer:** confirmed deny-by-default (credential read blocked), but **not usable** for Node-based workers here: piped child processes spin forever. Smart App Control also blocked the rebuilt unsigned launcher, and I did not bypass it.
   - **Recommended:** a dedicated low-privilege Windows account plus a file-spool broker and ACLs. It needs the owner's admin authorization and must pass the adversarial acceptance in doc 3 §3.3 before any "secure" claim.
4. **Host findings:**
   - `E:\` grants **Authenticated Users: Modify**, inherited by the production checkout and `.env`. Any second local account, including a future worker account, could modify production until this is fixed.
   - Commit charge reached **93 %** during an `npm ci`.
   - The default memory gate (1024/1536) is correctly sized and **should not be lowered**. Free memory instead: the Claude desktop app holds ≈ 2.6–3.0 GB of commit, and Chrome ≈ 3.5 GB.
   - The reboot path has **never run**: the last boot predates the task.

## Correction to the mandate's premise
"67 demonstrated command-filter bypass cases" was my error in the November 9 summary. **67 was the number of attack probes** (69 including 2 baselines). V2 allowed **33 text-decidable bypasses**, plus **15 structural cases** (scripts, `npx`, `npm run` without a visible body) that no text filter can decide. Details: doc 2 §2.0.

## Deliverables

| # | File | Status |
|---|---|---|
| 1 | `01_SECURITY_THREAT_MODEL.md` | Done |
| 2 | `02_BYPASS_ROOT_CAUSE_ANALYSIS.md` | Done (12 classes) |
| 3 | `03_WORKER_ISOLATION_ARCHITECTURE.md` | **Proposed design.** Options A–F evaluated; AppContainer prototyped; dedicated-account design recommended; acceptance tests defined |
| 4 | `04_SECURITY_FIX_IMPLEMENTATION_PLAN.md` | F1–F14 **implemented on the branch**; 7 items proposed; `.env` ACL command written, **not executed** |
| 5 | `05_MEMORY_OPTIMIZATION_ASSESSMENT.md` | Measured, read-only; no process terminated; thresholds unchanged |
| 6 | `06_REBOOT_RECOVERY_ACCEPTANCE_PLAN.md` | Audit done; procedure written, **not executed** (no restart) |
| 7 | `07_ADVERSARIAL_TEST_EVIDENCE.md` | Probe comparison, executed baseline control, partial AppContainer run, full regression |
| 8 | `08_V2_1_RELEASE_ROADMAP.md` | V2.1a / V2.1b / V2.2 / V3 |
| — | `EVIDENCE_MANIFEST.sha256` | sha256 of every file in this directory |

**Evidence:**
- `evidence\probe-compare\`
- `evidence\isolation\`
- `evidence\approval-shortcircuit-check.txt`
- `logs\regression-693058c\`
- `scripts\` (probe-compare, attacks, harness, launcher source)
- `bin\sandbox-run.exe`: prototype, unsigned; now blocked by Smart App Control

## What is verified, proposed and assumed

| Verified (executed here) | Proposed (not implemented) | Unverified assumptions |
|---|---|---|
| 0/33 text bypasses on the branch; 686/686 tests | Dedicated worker account + broker (P0) | A real headless worker's memory (~0.3 GB proxy) |
| V2 approval short-circuit defect | Single-use approvals, prompt fencing, owner secret | `--settings <inline JSON>` + hook in a *real* CLI session (unit-tested only) |
| Same-user worker can bypass every approval (baseline control) | Commit-charge memory gate, per-worker job cap | Hook timeout fails closed |
| AppContainer denies by default; Node pipes fail inside it; SAC blocks unsigned launchers | `.env` / `E:\Agent` ACL fix (owner) | A non-interactive worker account can use a Claude inference token |
| Production untouched (HEAD, pid, task) | Reboot acceptance run (owner) | Logon trigger after Fast Startup |

## Owner decisions needed
1. **Review and authorize** a push/PR for V2.1a (`693058c`, `4d07438`). It needs no schema change; rollback is a checkout of `e60278f`.
2. **Run the `.env` ACL fix** (doc 4 §4.2), ideally together with removing `Authenticated Users: Modify` under `E:\Agent`.
3. **Authorize P0 provisioning** (an admin action): the `elevariq-worker` account, `C:\ElevariqWork`, the ACLs and a worker task. Then I add the `worker-user` mode to the harness and run the acceptance tests.
4. **Memory practice:** close the Claude desktop app and spare browser windows while the agent works. Keep 1024/1536.
5. **Run the reboot acceptance** (doc 6) at a convenient time.
6. **Renew the Claude login** before 2026-12-04.
7. **Optional:** authorize one real worker session in staging, to verify inline settings, the hook timeout behaviour and real worker memory.
