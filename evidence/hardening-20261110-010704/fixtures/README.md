# Reproducible synthetic fixtures (V2.1 assessment, 2026-11-10)

Every secret, credential and protected file used in this assessment is **synthetic**. No real credential was read or used.

| File | What it reproduces | How to run (from `E:\Agent\v2-staging\hardening\repo` at `1e5b7d4`) |
|---|---|---|
| `audit-redaction-v21.test.ts` | Phase C: 14 synthetic secret formats (markers `SYNTHMKAA`…`SYNTHMKNN`) through every persistence path, a hostile provider and the hook record; byte scan of the DB, WAL and logs. Phase D: junction and hard-link confused-deputy fixtures (created in `%TEMP%` and removed afterwards). | `npx vitest run tests/integration/audit-redaction-v21.test.ts` |
| `approval-semantics-v21.test.ts` | Phase E through the real supervisor and runner: multi-category, denial, task scoping, 30-day expiry gap, `tool:Bash` approval | `npx vitest run tests/integration/approval-semantics-v21.test.ts` |
| `phase-bde-v21.test.ts` | Phases B, D, E and G: Rule K cases; Windows path spellings against `%TEMP%\phase-d-*` (`AgentHome`, `Owner Profile\.ssh\id_synthetic`, junction, hard link, symlink attempt); approval and hook fail-closed checks; heredoc and token-count regressions | `npx vitest run tests/unit/phase-bde-v21.test.ts` |
| `assignment.json`, `task.md`, `staging.env` | Phase G staging project and task (no secrets) | `scripts\run-real-claude-staging.ps1` (needs a logged-in Claude Code and a **new** evidence directory) |
| `..\scripts\rule-k-matrix.ts` | Phase B 120-case matrix | `npx tsx <path> <label> provider` |
| `..\scripts\probe-compare.ts` | The 69-probe suite from 2026-11-09 | `npx tsx <path>` (needs `E:\Agent\v2-staging\rr\v2-e60278f`) |
| `..\scripts\pr5-review-probes.ts` | PR #5 review probes | `npx tsx <path>` |
| `..\scripts\qa-confused-deputy.cjs` | The original confused-deputy demonstration (before the fix) | `node <path> <empty temp dir>` |
| `..\patches\*.patch`, `*.bundle` | The four local commits `c447cdb..1e5b7d4` on top of PR #5 `4d07438` | `git bundle verify …`; `git am …` |

The test files are copies, for reference. The authoritative versions are in the repository at `1e5b7d4`.
