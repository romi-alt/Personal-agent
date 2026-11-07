# GitHub repository setup

Repository: `romi-alt/Personal-agent` (private). Permanent default branch: **`main`**.

## What was done (Phase 1.5)

| Step | Outcome |
|---|---|
| Inspected the remote | Only one branch existed (`claude/dreamy-edison-hiyq3n`, a single commit `fff2bce`); that branch was the repository's default branch; the account has admin permission. |
| Verified the Phase 1 commit | Committed and pushed; tracked files contain no credentials (a `git grep` for key/token/private-key patterns found only the obviously fake test fixtures in `tests/`, which use placeholders like `sk-ant-api03-KEYKEY...`); no `.env`, database or log is tracked. |
| Created `main` | `git push origin fff2bce:refs/heads/main` - a **new ref at the verified commit**, no force, nothing overwritten. |
| Kept the Phase 1 branch | `claude/dreamy-edison-hiyq3n` is retained as the working/reference branch. Phase 1.5 work is a normal pull request from it into `main` (shared history, so the diff is meaningful). |
| Set `main` as default branch | **BLOCKED** - the session's GitHub proxy rejects repository-settings writes (`Repository settings writes are not permitted through this proxy`). |
| Branch protection / required checks | **BLOCKED** - same proxy restriction (`Write access to this GitHub API path is not permitted`). |
| CI | `.github/workflows/ci.yml`: job **`check`** (Ubuntu: typecheck, lint, format, build, tests, `npm audit --omit=dev`, secret scan) and job **`check-windows`** (Windows: install, build, tests). Both passed on `a98aa95`; the Windows job is no longer `continue-on-error`, so a Windows failure now fails the run. |

## What you must do (2 minutes, repository admin)

Either run the provided script with an authenticated `gh` on your machine:

```bash
gh auth login
scripts/github/protect-main.sh romi-alt/Personal-agent
```

or use the web UI:

1. **Settings -> Branches -> Default branch**: switch to `main`.
2. **Settings -> Branches -> Add branch protection rule** for `main`: require a pull request, require status checks **`check`** and **`check-windows`** (both have run, so they appear in the list), require branches to be up to date, require conversation resolution, block force pushes and deletions.
3. (Optional) After this PR merges you may delete `claude/dreamy-edison-hiyq3n`; it contains no history that is not in `main`.

Until step 1 is done the default branch is still the Phase 1 branch, so new clones check that out.

## Branching policy

* `main` is always releasable: CI green, tests passing.
* Create every future development branch **from `main`** (`git switch -c feature/<topic> origin/main`) and merge via pull request.
* Never force-push `main`. Use `--force-with-lease` only on your own unmerged feature branches.
* Secrets never go in commits; `.env*` is ignored (except `.env.example`) and CI fails on committed key patterns outside `tests/`.
