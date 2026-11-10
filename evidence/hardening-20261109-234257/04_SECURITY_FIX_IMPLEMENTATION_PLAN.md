# 4. Immediate security-fix implementation plan (P1)

**Branch:** `feat/v2.1-hardening` in the isolated clone `E:\Agent\v2-staging\hardening\repo`.
- Base: `e60278f`.
- Commits: `693058c` (hardening) and `4d07438` (corrected short-circuit test).
- **Local only:** not pushed, not merged.
- **The production checkout `E:\Agent\Personal-agent` was not modified.**

## 4.1 IMPLEMENTED on the branch (with tests)

| ID | Fix | Files | Tests | Classification |
|---|---|---|---|---|
| F1 | Expansion of same-command variables, `echo` substitutions, string concatenation and PowerShell variables before matching; every hard check sees raw, expanded and de-escaped views | `src/security/hardening.ts` (`expandIndirection`, `stripEscapes`), `policy.ts` | class V/E suites | Guardrail |
| F2 | Hard deny (not approvable) of encoded or obfuscated execution: `-EncodedCommand` and prefixes, `FromBase64String`, `Invoke-Expression`/`iex`, `base64 -d \| sh`, `certutil -decode`, `xxd -r \| sh` | `hardening.ts` | class E | Guardrail |
| F3 | Hard deny of command substitution in command position | `hardening.ts` | class V | Guardrail |
| F4 | Recursive-delete spellings need `destructive_delete`: long flags, flags anywhere, `rd/rmdir/del/erase /s`, PowerShell `-r…` prefixes on all aliases, `rmSync`/`fs.rm`/`rmtree`/`[IO.Directory]::Delete`/`rimraf` | `hardening.ts` | class R | Guardrail |
| F5 | Git indirection: alias definitions, `git <global opts> push`, `remote add/set-url`, `send-pack` → push approval; `core.hooksPath/sshCommand/fsmonitor/gitProxy/askPass`, `credential.*`, `include.path` → system approval; `schtasks`, `Register-ScheduledTask`, `reg add/delete/import`, `setx`, `netsh`, HKCU/HKLM property writes, `-Verb RunAs` → system approval | `hardening.ts` | class G | Guardrail |
| F6 | Protected-path resolution: globs, relative paths, home and env prefixes, Git Bash drive form, `cd` tracking | `hardening.ts` (`reachesProtectedPath`) | class P | Guardrail |
| F7 | Credential and environment protection: `~/.claude` protected; `.credentials`, token and config variables, `.git-credentials`, `git credential`, `cmdkey`, `vaultcmd`, env dumps hard-denied | `hardening.ts`, `cli-provider.ts` | class K | Guardrail |
| F8 | Worker-guard tampering hard-denied (`env -u/-i`, `unset`, assignments, `$env:` writes, `ELEVARIQ_AGENT_HOME/EXECUTION_ID` references) | `hardening.ts` | class W | Guardrail |
| F9 | Package-manager script bodies (incl. pre/post) evaluated recursively, depth ≤ 3 | `hardening.ts`, `policy.ts` | class N | Guardrail |
| F10 | Write/Edit/MultiEdit **content** may not plant agent-control artefacts, credential references, guard tampering or protected paths (the workspace path is excluded) | `policy.ts`, `hardening.ts` | content suite | Guardrail |
| F11 | **Logic defect fixed:** every matching approval category must be approved (no first-match short-circuit) | `policy.ts` | short-circuit suite; V2 comparison | **Correctness fix** |
| F12 | **Policy integrity:** the hook command line carries the policy sha256; a mismatch makes the hook exit 2 (every tool call blocked). Settings are passed **inline** to `--settings`, so no settings file remains to rewrite | `cli-provider.ts`, `pretooluse-hook.ts` | integrity suite; updated provider launch test | **Enforced** against policy rewriting (the worker cannot change the hook's command line during the session) |
| F13 | **Supervisor-side audit:** each `tool_use` from the CLI stream is recorded with redacted input (≤ 2000 chars), independent of the worker-writable decisions file | `cli-provider.ts` | covered by the provider tests (event shape) | Evidence improvement (DB still writable by worker scripts until P0) |
| F14 | Verification commands: `ELEVARIQ_WORKER=1`, `ELEVARIQ_VERIFIER=1`; `ELEVARIQ_*`, `CLAUDE_CONFIG_DIR`, `CLAUDECODE` stripped | `verifiers.ts` | `verifier-env-v21.test.ts` | Guardrail (env is advisory) |

**Measured effect:**
- Re-run of all 69 audit probes: V2 had **33 text-decidable bypasses**, V2.1 has **0**.
- 0 regressions on the legitimate probes; 15 structural (class S/N) cases remain allowed by design.
- 83 new unit tests.
- Full regression on the branch: see `07_ADVERSARIAL_TEST_EVIDENCE.md` §7.4.

## 4.2 NOT implemented: proposed, ordered

| ID | Item | Why not now | Effort | Owner action needed |
|---|---|---|---|---|
| P1-ACL | **Fix production `.env` ACL** (`Authenticated Users: Modify` inherited from `E:\`) | Production change: forbidden in this assignment | 5 min | **Yes**, see the script below |
| P1-SCOPE | **Single-use / fingerprinted approvals** (M3). Today one approval unlocks the category for the rest of the task. Bind the approval to the denied command's hash and consume it on use | Touches runner, DB payload and the dashboard; needs its own migration review | 1–2 days | No |
| P1-FENCE | Fence untrusted content in reviewer and worker prompts (diffs, new files, web content, attachments) (M5) | Prompt-format change; needs QA re-baselining | 1 day | No |
| P1-OWNER | Owner-only CLI commands require a secret the worker cannot read (e.g. a DPAPI-protected owner token, prompted interactively). Only meaningful **after** P0 (same-user secrets are readable) | Depends on P0 | 0.5 day | No |
| P1-REDACT | Redact configured `.env` values (DB passwords, ERP keys) by value, not only by key name | Small | 0.5 day | No |
| P1-HOOKTO | Verify whether a 60 s hook *timeout* fails closed in Claude Code 2.1.319; if not, add a watchdog | Needs a controlled experiment with a real CLI session (credential use) | 0.5 day | Authorization to use a real worker session in staging |
| P1-JOB | Job object per worker without breakaway, plus a per-worker commit limit (`JOB_OBJECT_LIMIT_JOB_MEMORY`) | Needs a signed helper or a node addon; SAC blocks unsigned binaries | 1–2 days | Code-signing decision |
| P0 | Dedicated worker account + broker (document 3) | Needs admin and owner authorization | 5–8 days | **Yes** |

### P1-ACL: proposed owner command (NOT executed; review before running)
Run in an **elevated** PowerShell, after a backup of the ACL:
```powershell
icacls "E:\Agent\Personal-agent\.env" /save "E:\Agent\v2-staging\hardening\env-acl-backup.txt"
icacls "E:\Agent\Personal-agent\.env" /inheritance:r /grant:r "DESKTOP-QGGLG8D\Roman:(M)" "SYSTEM:(F)" "Administrators:(F)"
icacls "E:\Agent\Personal-agent\.env"       # verify: no Authenticated Users, no Users
```
**Rollback:** `icacls "E:\Agent\Personal-agent" /restore "E:\Agent\v2-staging\hardening\env-acl-backup.txt"`. The save file stores names relative to the folder of the saved file.
- **Supervisor impact:** none; it runs as Roman.
- **Broader fix (recommended with P0):** remove the inherited `Authenticated Users: Modify` on `E:\Agent` as a whole.

## 4.3 Release mechanics (when the owner authorizes)
1. Code review of `693058c..4d07438` (focus: the false-positive list in document 2 §2.4).
2. Push the branch and open a PR (needs authorization).
3. Re-run the full Windows regression on the merge commit.
4. Deploy with the existing cutover runbook. **No DB migration is needed**: V2.1 changes no schema.
5. **Rollback:** check out `e60278f`, rebuild, restart. No data conversion is needed.
