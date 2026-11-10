# PR #5 finding-to-fix matrix

## Branch and commit state (verified from local git; nothing pushed in this session)
**Remote PR metadata** (PR #5 title, state, review comments, checks) is **UNVERIFIED**. Reading it would need GitHub credentials, and no credential helper or token was used. The last-known remote state below comes from the local remote-tracking ref (`FETCH_HEAD` and `refs/remotes/github/*`), not a live query.

| Ref | SHA | Contents | Where |
|---|---|---|---|
| `main` (`github/main`, local ref) | `e60278f` | V2 (PR #4 merge); production runs this | Remote-tracking ref; production checkout `E:\Agent\Personal-agent` on `deploy/v2` |
| `feat/v2.1-hardening` (= PR #5 head, per `github/feat/v2.1-hardening`) | `4d07438` | `693058c` V2.1 P1 hardening + `4d07438` test correction | Local and remote-tracking ref are equal |
| `fix/pr5-review-findings` (the mandate calls it `fix/pr5-review-fixes`; **no branch with that name exists**) | **`1e5b7d4`** | `4d07438` + `c447cdb` (PR #5 review findings 1–6) + `ba87473` (Phase C/D) + `7de4d66` (Phase B/E) + `1e5b7d4` (Phase G findings) | **Local only** |
| `feat/v2.2-worker-isolation` | `c447cdb` | **No V2.2 work.** It points at the PR #5 fix commit `c447cdb` only; it was created from it and never advanced. | Local only |
| `integrate/v2-main` | `fca3cd3` | Pre-merge integration (tree equals `e60278f`) | Local and remote-tracking |

Ancestry (`git branch --contains`):
- `e60278f` → `693058c` → `4d07438` → `c447cdb` → `ba87473` → `7de4d66` → `1e5b7d4`.
- `c447cdb` is **not** in PR #5 (`feat/v2.1-hardening`).

Diff `4d07438..1e5b7d4`: 14 files, +1187/−67.

Working tree of the isolated clone (`E:\Agent\v2-staging\hardening\repo`): clean on `fix/pr5-review-findings`. Nothing was pushed, merged or deployed.

**Separation of scope.** PR #5 fixes and Phase B–E fixes are on `fix/pr5-review-findings`. No V2.2 isolation code exists on any branch. `feat/v2.2-worker-isolation` is a placeholder name at `c447cdb` and should be re-created from the accepted V2.1 commit when V2.2 starts.

## Findings → fixes → evidence

| # | Finding (PR #5 review) | Severity | Fix | Commit | Evidence |
|---|---|---|---|---|---|
| 1 | `approvalV21` returned only the **first** matching V2.1 category. This re-created the approval short-circuit for two V2.1-only categories (`rm --recursive x && git -c alias.p=push p` was allowed with delete approved). | High (logic) | `approvalsV21` returns **every** match; the policy requires all of them | `c447cdb` | `pr5-review-fixes.test.ts` "finding 1"; probes R1–R4 blocked; Phase E E1/E2/E5 |
| 2 | Computed command names: quoted `"$(…)"` in command position, and `x=$(…); $x` used as the command | High (bypass) | Class V regex allows an opening quote; variables assigned from a substitution and used as the command are hard-denied | `c447cdb` | "finding 2"; probes R5/R6 DENY |
| 3 | Protected paths containing spaces (`"/c/Users/John Smith/.cla*"`, `John\ Smith`) were split into words and missed | Medium | Tokenizer keeps quoted words and escaped spaces | `c447cdb` | "finding 3"; probes R12/R13; Phase D quoted-space fixtures |
| 4 | Only Claude's credential store was protected | Medium | All common per-user stores in Rule K; the CLI provider protects the directories | `c447cdb`, **extended in `ba87473`** (credential files, Windows Credentials/Protect, GitHub CLI; **SDK provider now protected too**) | "finding 4"; probes R16–R20; Rule K matrix |
| 5 | Audit `tool_use` input was truncated **before** redaction, so a secret at the 2000-character cut left a fragment | Medium | Redact, then truncate | `c447cdb`; **key-name redaction added in `ba87473`** | "finding 5"; AU2 redacted (AU1 is the simulated pre-fix order) |
| 6 | Rule K denied legitimate commit messages and `echo` text that mentioned credential names | Low (false positive) | K ignores quoted message data (`-m`, `--message`, `echo`, `printf`) and keeps executed forms | `c447cdb` | "finding 6"; Rule K category "commit-message/quoted" 13/13 correct |
| 7 | (found during the PR #5 probes; **not** in `c447cdb`) **QA confused deputy**: trusted QA read worker-planted junction or hard-link files into the persisted reviewer prompt | High (credential leak path) | `readUntrackedSafely` (regular, single-link, realpath inside workspace); review diff redacted | **`ba87473`** | `qa-confused-deputy.json` LEAK:true (before); Phase D test (after) |
| 8 | (Phase C) Free-text database columns and the hook decisions file persisted secrets; 10 of 14 common formats were not recognised | High (audit leak) | Extended redaction plus redaction at every free-text write | **`ba87473`** | `AUDIT_REDACTION_ASSESSMENT.md`: 15/20 failed before, 20/20 after |
| 9 | (Phase B) 14 Rule K false negatives (interpreter and nested-shell environment dumps, `gh auth token`, npm auth config, OS credential stores) | Medium | Command-only K rule | **`7de4d66`** | `RULE_K_COMPATIBILITY_RESULTS.md`: 14 → 0 FN |
| 10 | (Phase D) File tools treated `~/…` as a workspace path | Medium | `~` expands to home before the containment check | **`ba87473`** | Phase D tests |
| 11 | (Phase E) Several consequential `gh`/`npm` remote operations needed no approval | Medium | Added to the V2.1 approval rules | **`7de4d66`** | Phase E test "previously unrecognized …" |
| 12 | (Phase G, real worker) Heredoc bodies were path-checked: `import … from '../src/x.ts'` in a test file written through a heredoc was denied | Medium (false positive; V2.1 regression from `693058c`) | Heredoc bodies the analyzer classifies as data are removed before path resolution; executable heredocs keep the raw text | **`1e5b7d4`** | `REAL_CLAUDE_STAGING_ACCEPTANCE.md`; transcript replay 9/10 → 10/10 allowed; 4 unit tests |
| 13 | (Phase G) Usage token counts were stored as `[REDACTED]` (key-name rule matched "token") | Low (data loss; predates V2.1) | Numbers and booleans are not redacted by key name | **`1e5b7d4`** | Unit test |
| — | PR #5 review probe L27: `"$(npm bin)/eslint" .` is denied | Low (false positive) | **Accepted, not changed.** `npm bin` was removed in npm 9; `npx eslint` works. | — | `evidence\pr5-review-probes.tsv` |

## Remaining bypasses
None of these are fixed by any V2.1 commit.

| Class | Description | Why not fixable here |
|---|---|---|
| S | Script-file indirection: the worker writes `x.js` and runs `node x.js`, or puts code in a test or an npm script that calls a file. 15 of the 69 probes. | Not decidable from command text |
| OS | Same-user worker reads credentials, writes the agent DB (self-approval), rewrites policy, logs or `.env`, escapes the workspace, uses the network. Executed baseline: **27/27 succeeded**. | Needs a separate worker identity (V2.2) |
| E3/E4/E6 | Approvals never expire and bind a category, not a command | Design change; meaningful only after V2.2 (see Phase E) |
| E7 | Unknown consequential operations (`curl -X DELETE`, `ssh`, `scp`, SQL `DELETE` through a client) | Block-list policy |
| D-HL | Hard links into the workspace are readable through the file tools | Cannot be told apart from ordinary files without breaking pnpm |

## Compatibility risks of the fix branch
1. **Stricter Rule K (4 accepted false positives):**
   - `grep` for credential variable names;
   - `.credentials.json` fixtures;
   - `ls ~/.ssh`;
   - `git push --dry-run` (approval).
2. **Redaction may over-redact** non-numeric values of `*token*`/`*secret*`/`*password*` keys in free text, and exact values of sensitive environment variables of 8 or more characters, in summaries and outputs. JSON stays valid.
3. **New approval prompts:**
   - `gh pr merge`, `gh repo sync`;
   - `gh repo delete/edit/archive/rename`, `gh release delete/edit/upload`;
   - `gh secret/variable set`;
   - `npm unpublish/deprecate/dist-tag`.
4. **QA no longer shows untracked files** that are links or hard links; it shows `(<reason>; not read)` instead.
5. **No schema change; no migration.** Rollback is a checkout of `e60278f` plus a rebuild.

## Owner decisions
See `PR5_FINAL_REVIEW.md`.
