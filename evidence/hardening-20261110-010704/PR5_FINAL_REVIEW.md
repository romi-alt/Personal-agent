# Phase J: final PR #5 review

**This verdict covers the V2.1 hardening changes only.** It says nothing in favour of unrestricted autonomous operation: approvals and the command policy remain advisory against a worker that runs code as the owner (`GOVERNANCE_CONTROL_EVALUATION.md`).

## Verdict

| Subject | Verdict |
|---|---|
| **PR #5 as last pushed:** `feat/v2.1-hardening` @ `4d07438` (remote PR state not live-verified; no credentials used) | **CHANGES REQUIRED** |
| **Proposed replacement head:** `fix/pr5-review-findings` @ **`1e5b7d4`** (local, not pushed) | **READY FOR REVIEW** |

### Why `4d07438` needs changes
`4d07438` contains:
- review findings 1–6, including the re-created approval short-circuit and the computed-command bypass;
- the QA confused-deputy credential leak;
- the redaction gaps that persisted secrets to the database and JSONL;
- 14 Rule K false negatives;
- the heredoc false positive that a real worker hit in staging.

All of these are fixed on top of it in four local commits:
- `c447cdb` (review findings 1–6);
- `ba87473` (Phases C and D);
- `7de4d66` (Phases B and E);
- `1e5b7d4` (Phase G).

### Why `1e5b7d4` is ready for review
- Full Windows regression on the exact commit (`FULL_WINDOWS_REGRESSION.md`):
  - typecheck, lint, format and build clean;
  - **779 tests passed** (unit 545, integration 198, e2e 27, browser 9);
  - 0 runtime vulnerabilities;
  - 0 secrets;
  - 0/145 text-decidable bypasses;
  - 0 legitimate regressions in the 69-probe suite;
  - production untouched.
- One genuine Claude Code task and its independent QA review passed in staging.

## Every PR finding fixed, with evidence
See `PR5_FINDING_TO_FIX_MATRIX.md` for the full table. In short:

| # | Finding | Fixed in | Evidence |
|---|---|---|---|
| 1 | First-match approval short-circuit (V2.1-only categories) | `c447cdb` | unit "finding 1"; probes R1–R4; Phase E E1/E2/E5 |
| 2 | Computed command names (`"$(…)"`, `x=$(…); $x`) | `c447cdb` | R5/R6 |
| 3 | Protected paths with spaces | `c447cdb` | R12/R13; Phase D |
| 4 | Only Claude's credential store was protected | `c447cdb` + `ba87473` (files, Windows stores, **SDK provider**) | R16–R20; Rule K 0 FN |
| 5 | Truncate-before-redact in the audit | `c447cdb` + `ba87473` (key names) | AU2; Phase C |
| 6 | Rule K false positives on commit messages and `echo` | `c447cdb` | Rule K "commit-message" 13/13 |
| 7 | QA confused deputy (junction or hard link leak) | `ba87473` | Phase D |
| 8 | Persisted secrets (10 of 14 formats unrecognised; free-text columns, hook record) | `ba87473` | Phase C: 15/20 failed → 20/20 passed |
| 9 | 14 Rule K false negatives | `7de4d66` | Rule K 14 → 0 |
| 10 | File-tool `~` treated as a workspace path | `ba87473` | Phase D |
| 11 | Unrecognized `gh`/`npm` remote operations | `7de4d66` | Phase E |
| 12 | Heredoc-body false positive (real worker) | `1e5b7d4` | Phase G replay 10/10 allowed |
| 13 | Token counts redacted in usage accounting | `1e5b7d4` | unit test |

## Remaining bypasses and limitations (not regressions; most predate V2.1)
1. **Class S script indirection:** 15/15 structural probes allowed by design.
2. **Same-user arbitrary code:** 27/27 unauthorized actions succeed. This includes self-approval, policy rewrite and audit forgery. There is no OS isolation.
3. **Approvals:** never expire (E3); bound to a category, not a command (E6); a block-list misses unknown consequential operations (E7, 0/5).
4. **Hard links** into the workspace can be read through the file tools.
5. **Redaction:** opaque secrets that are neither formatted nor in the environment; owner-authored planning text; Claude Code's own transcripts in `~/.claude/projects`; the wrapper's pre-logger stderr.
6. **`E:\` grants Authenticated Users: Modify** (host). This must be fixed before any second account exists.
7. **Not verified:**
   - Linux (skipped by owner decision);
   - symlink handling (no privilege to create symlinks);
   - the `1e5b7d4` fixes under a live CLI (verified by transcript replay only);
   - remote PR #5 metadata (no credentials).

## Compatibility risks
1. **Four accepted Rule K false positives:**
   - `grep` for credential variable names;
   - `.credentials.json` fixtures;
   - `ls ~/.ssh`;
   - `git push --dry-run` (approval).
2. **New approval prompts:** `gh pr merge`, `gh repo sync/delete/edit/archive/rename`, `gh release delete/edit/upload`, `gh secret/variable set`, `npm unpublish/deprecate/dist-tag`.
3. **Redaction over-matching:** non-numeric values of `*token*`/`*secret*`/`*password*`/`*credential*` keys in free text, and exact values (8 or more characters) of sensitive environment variables, become `[REDACTED]` in summaries, outputs and error columns.
4. **QA reviewer prompt:** link and hard-link untracked files are listed as "not read".
5. **SDK provider:** now denies commands that reference owner credential stores (previously only the CLI provider did).
6. **No schema change and no migration.** Deployment is a checkout and rebuild of the existing V2 install. Rollback is a checkout of `e60278f` and a rebuild (the procedure in `docs/OPERATIONS.md`).

## Owner decisions required (I did not take any of these)
1. **Push and PR update.** Choose either:
   - (a) push `c447cdb..1e5b7d4` onto `feat/v2.1-hardening`, which updates PR #5; or
   - (b) push `fix/pr5-review-findings` as a new branch and PR.

   Either needs your authorization. Nothing was pushed.
2. **Review and merge** into `main`. That decision is yours.
3. **Deploy V2.1 to production:** stop, build, start under the scheduled task (`docs/OPERATIONS.md`). It needs your authorization; production stays on `e60278f`.
4. **Accept the residual risk in writing:** approvals are advisory against same-user code (SG-1). Or require V2.2 before any unattended work involving credentials or production.
5. **Authorize V2.2 provisioning** (administrator): the dedicated `elevariq-worker` account, ACLs, the approval broker, and **removing `Authenticated Users: Modify` from `E:\`** first.
6. **Approval semantics:** whether to bind approvals to a command fingerprint plus a TTL (with V2.2), and whether to default-deny network-mutating verbs (`curl -X POST/PUT/PATCH/DELETE`, `ssh`, `scp`).
7. **Optional:** set a git identity for managed workspaces (it saves a worker turn per commit), and run one live confirmation of the heredoc fix.
8. **Housekeeping:**
   - `feat/v2.2-worker-isolation` is a placeholder at `c447cdb` with no V2.2 content. Delete it, or re-create it from the accepted V2.1 commit.
   - The staging home `20261110-010704\staging\agent-home` can be deleted after review.
