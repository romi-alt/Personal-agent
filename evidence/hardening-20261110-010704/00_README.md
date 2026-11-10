# V2.1 evidence-based security assessment: 2026-11-10 (Phases B–J)

- **Final local commit:** `fix/pr5-review-findings` @ `1e5b7d4`, in the isolated clone `E:\Agent\v2-staging\hardening\repo`. Nothing was pushed, merged or deployed.
- **PR #5 head:** `feat/v2.1-hardening` @ `4d07438`. Remote metadata is unverified; no credentials were used.
- **Production:** V2 `e60278f`, pid 8992, untouched.

| # | Deliverable | Headline |
|---|---|---|
| 1 | `PR5_FINDING_TO_FIX_MATRIX.md` | Branch and commit relationships; 13 findings → fixes → evidence |
| 2 | `RULE_K_COMPATIBILITY_RESULTS.md` | 120 cases: FN 14 → **0**, FP **4** (accepted). 69-probe suite preserved: 0 bypasses. |
| 3 | `AUDIT_REDACTION_ASSESSMENT.md` | Secrets reached disk: 15/20 checks failed → **20/20 passed**; residual paths listed |
| 4 | `CREDENTIAL_PATH_PROTECTION.md` | Windows path spellings denied. QA confused-deputy leak fixed. Hard links residual; symlinks blocked by privilege. |
| 5 | `APPROVAL_SEMANTICS_TESTS.md` | Multi-category and chaining correct. **No expiry, no argument binding, block-list.** |
| 6 | `FULL_WINDOWS_REGRESSION.md` | **779/779** tests on `1e5b7d4`; 0 runtime vulnerabilities; 0 secrets |
| 7 | `REAL_CLAUDE_STAGING_ACCEPTANCE.md` | Real Claude Code task + independent QA **PASSED**. One false positive and one accounting defect found and fixed. |
| 8 | `GOVERNANCE_CONTROL_EVALUATION.md` | 0/145 text-decidable attacks succeed; **27/27 arbitrary-code attacks succeed**. No technically enforced human control. |
| 9 | `PRODUCTION_INTEGRITY_CHECK.md` | Healthy and unmodified; the memory gate is deferring (idle) |
| 10 | `PR5_FINAL_REVIEW.md` | `4d07438`: **CHANGES REQUIRED**. `1e5b7d4`: **READY FOR REVIEW**. Owner decisions listed. |
| 11 | `EVIDENCE_MANIFEST.sha256` | sha256 of every other file in this directory |

**Directories:**

| Path | Contents |
|---|---|
| `scripts\` | Every script used |
| `fixtures\` | Synthetic fixtures and how to reproduce them |
| `logs\` | Regression logs (`regression\` = `1e5b7d4`, `regression-7de4d66\`) and the Phase C before/after logs |
| `evidence\` | Probe outputs; production read-only snapshots |
| `staging\` | Phase G driver log, read-only database inspection, denial replays, and the disposable staging agent home |
| `patches\` | Four format-patches and a git bundle (`4d07438..1e5b7d4`) |
