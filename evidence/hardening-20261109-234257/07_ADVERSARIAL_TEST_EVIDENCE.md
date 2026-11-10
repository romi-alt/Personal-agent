# 7. Adversarial regression test evidence

All evidence lives under `E:\Agent\v2-staging\hardening\20261109-234257\`. **Every adversarial target was synthetic:**
- a fake credentials file with the same inherited ACL as `%USERPROFILE%\.claude`;
- a fake agent home under `%LOCALAPPDATA%`, holding a *copy* of the read-only snapshot DB plus 2 synthetic PENDING approvals;
- a fake production checkout on `E:\` with the same inherited ACL as the real one;
- test-only registry and task names.

No production file, credential, database, task or process was touched. The synthetic fixtures were deleted afterwards.

## 7.1 Command-policy probes: V2 vs V2.1 (classification only; nothing executed)
- **Script:** `scripts/probe-compare.ts`.
- **Output:** `evidence/probe-compare/probe-compare.tsv` and `summary.txt`.

| | V2 `e60278f` | V2.1 branch |
|---|---|---|
| Probes (60 single incl. 2 baselines + 9 chains) | 69 | 69 |
| Should block | 52 | 52 |
| **Text-decidable bypasses (allowed although they should block)** | **33** | **0** |
| Structural cases allowed (class S/N; not decidable from text) | 15 | 15 (residual, by design) |
| Legitimate probes broken | — | **0** |

**Unit tests added:** 83 (`tests/unit/policy-v21-hardening.test.ts`: 81, `verifier-env-v21.test.ts`: 1, `policy-normalize.test.ts`: 1). They cover every class (V, E, R, G, P, K, W, N, content, short-circuit, integrity). They also include an explicit suite asserting that class S is **still allowed**, so the suite cannot be mistaken for a sandbox proof.

**Approval short-circuit (V2 defect found during this work):** `evidence/approval-shortcircuit-check.txt`.
- With `protected_branch_push` approved, V2 **allowed** `git push origin main && rm -rf ~`; V2.1 requires `destructive_delete` too.
- With `publish_release` approved, V2 **allowed** `npm publish && rm -rf ~`; V2.1 blocks it.

## 7.2 OS-level attacks as today's worker identity: baseline control (EXECUTED)
- **Script:** `scripts/attacks.cjs` + `scripts/run-isolation-tests.ps1` (run 2, 2026-11-09 23:54).
- **Raw output:** `evidence/isolation/run2-baseline.jsonl` and `.after.json`.
- **Table:** `evidence/isolation/run2-baseline-table.md`.

The probes run as user `Roman` at medium integrity, which is exactly the identity of every V2 production worker. Results:

| Class | Probes | Attack succeeded |
|---|---|---|
| Read credentials (fs, `cmd type`, Git Bash `cat`, PowerShell `-EncodedCommand`, **worker-generated script**), read the dashboard token | C1–C6 | **6/6** |
| Write the agent DB; **self-approve by SQL**; **self-approve through the agent CLI with `ELEVARIQ_WORKER` unset**. The approval was recorded as `decided_by = owner-cli` | D1–D4 | **4/4** |
| Widen own policy file (chmod + rewrite) | P1 | **1/1** |
| Modify `.env` / wrapper equivalents on `E:\`, create `STOP-HOLD`, read the production task definition (read-only), write HKCU, widen an ACL | P2–P5, P7, P8 | **6/6** |
| Escape the workspace (write outside, into the agent home and the profile; list `E:\Agent`; recursive delete via Node and Git Bash) | W1–W6 | **6/6** |
| Forge and delete audit records | A1–A2 | **2/2** |
| Loopback to the dashboard equivalent, outbound HTTPS | N1–N2 | **2/2** |
| Detached grandchild outlives the worker | J1 | survived (`detachedGrandchildSurvived: true`). Production workers sit in libuv's kill-on-close job [CODE]; the harness did not reproduce that |
| Functional: `node --test`, git commit, Git Bash, npm, `claude --version` | F1–F5 | 5/5 work |

**Post-run fingerprints** (`run2-baseline.after.json`):
- both synthetic approvals were APPROVED, one `decided_by=attacker` and one `decided_by=owner-cli`;
- an attacker table was created;
- the policy was widened;
- the `.env` equivalent was tampered;
- `STOP-HOLD` was created;
- audit records were forged and deleted;
- the outside victims were deleted.

**Interpretation:** this **demonstrates SG-1 concretely**. Today, any worker that runs code can do all of this. The V2.1 text hardening blocks the *typed* forms. It cannot block C5 (a generated script), D3 by script, or W5/W6 by script. These results are the positive control that any isolation design must turn into BLOCKED.

## 7.3 OS-level attacks inside the AppContainer prototype (PARTIAL; NOT a pass)
**Launcher:** `scripts/sandbox-run.cs`; no admin; deny by default; optional `internetClient`; job object with kill-on-close and a memory cap.

| Run | What happened | Evidence |
|---|---|---|
| run 1 | The sandboxed node could not even `lstat E:\`: `EPERM`. The container is denied the drive root, so Node's module realpath failed before any probe ran | `run1-sandboxed.stderr.txt` |
| debug | With `--preserve-symlinks`: **C1 BLOCKED** (direct read of the synthetic credential file denied). Then the first child-process probe **spun at 100 % CPU** (2.97 s CPU in 3 s): libuv cannot create its stdio named pipes inside a plain AppContainer | `debug-stderr.txt` |
| rebuild | The rebuilt launcher (added timeout) was **blocked by Smart App Control** (enforce mode): Code Integrity events 3033/3077/3118 at 2026-11-10 00:06. **Not bypassed**, by decision | `code-integrity-events.txt` |

**Conclusion:**
- the AppContainer **is** a deny-by-default OS boundary (two observations);
- it is **not usable** for Node-based workers here, because piped children fail;
- a production launcher would need code signing;
- **no claim of isolation is made.** The adversarial acceptance of the recommended design (dedicated account, doc 3 §3.3) is **pending**.

**Leftovers (harmless, documented):**
- two per-user AppContainer profile registrations, `elevariq-iso-smoke` and `elevariq-worker-isotest`, under `HKCU\Software\Classes\Local Settings\…\AppContainer\Mappings`;
- ACEs for their SIDs on `E:\Agent\v2-staging\hardening\isotest` and `…\hardening\repo` (staging only).

**Cleanup:** run `sandbox-run.exe --name <n> --delete-profile` once a signed or allowed build exists, or remove the two mapping keys and delete `E:\Agent\v2-staging\hardening\isotest`.

## 7.4 Full regression on the hardening branch
- **Runner:** the same bounded, memory-guarded runner as the November 9 readiness audit (`release-readiness\20261109-181411\scripts\regression.ps1`).
- **Repo:** `E:\Agent\v2-staging\hardening\repo`.
- **Environment:** isolated `AGENT_HOME`; mock provider; ERP/CRM disabled.
- **Log:** `logs/regression-693058c/summary.txt`, plus per-step logs and vitest JSON.
- **Commit:** steps 00–05 ran on `693058c`. Steps 06–10 ran on a working tree identical to `4d07438`, which differs from `693058c` only by the corrected short-circuit test and a code comment.

| Step | Result | Detail | Min. available RAM |
|---|---|---|---|
| `npm ci` | PASS | | 398 MB |
| typecheck / lint / format / build | PASS ×4 | | ≥ 739 MB |
| `npm audit --omit=dev` | PASS | 0 vulnerabilities | |
| `npm audit` (incl. dev) | exit 1 | **10 moderate, dev-only**: unchanged from V2 `e60278f` (not a regression) | |
| Secret scan (tracked, excl. tests) | PASS | 0 matches in 146 files (6 synthetic fixtures under `tests/`, as in V2) | |
| Unit | **PASS 477/477** | 394 V2 + 83 new | 732 MB |
| Integration | **PASS 173/173** | | 572 MB |
| E2E | **PASS 27/27** | | 761 MB |
| Browser (Playwright + Edge) | **PASS 9/9** | | 464 MB |
| Production supervisor pid 8992 alive during every step | yes | | |

**Totals: 677/677 vitest + 9/9 browser = 686 automated tests, 0 failed, 0 skipped.**
- **V2 baseline:** 594 + 9 = 603.
- **Difference:** the 83 new tests.

## 7.5 Production non-interference (re-checked 2026-11-10 00:27)

| Check | Result |
|---|---|
| `E:\Agent\Personal-agent` HEAD and working tree | `e60278f`, clean (unchanged) |
| Supervisor pid 8992 | alive; same start time 2026-11-09 18:07:57 |
| Scheduled task | unchanged; last result `0x800710E0` (IgnoreNew keepalive) |
| Live DB, `.env`, production credentials | not opened; synthetic copies only |
| Windows restart | none |
| Push / merge | none; branch local only |
| Processes terminated | only my own hung probe runs, through the tool's task stop. One direct `Stop-Process` attempt was refused by the permission classifier and was not retried |
