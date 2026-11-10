# Phase D: credential and protected-path protection (provider interface, Windows)

## Scope and boundary
- **What was tested:** the decision the providers enforce for every worker tool call, `evaluateToolUse(tool, input, workspace, { protectedPaths })`, in two ways:
  - in-process, as the SDK provider calls it;
  - through the real PreToolUse hook *process*, as the CLI provider runs it.

  All targets are **disposable fixtures** under `%TEMP%`, with synthetic content.
- **What this protection is not:** it is **not** an OS boundary. Arbitrary code that the worker runs as the owner (`node x.js`, a test file, an npm script body that calls a file) runs with the owner's full Windows privileges. It can read `~/.ssh`, the agent database, the production checkout and `.env`. The executed baseline proved this: credential reads C1–C6 and escapes W1–W6 all **succeeded**. Only a separate low-privilege worker account with ACLs (V2.2) changes that.

## Protected set (what the providers pass)

| Before | After `ba87473` |
|---|---|
| **CLI provider:** agent home, agent repository, and `~/.claude`, `.ssh`, `.aws`, `.azure`, `.kube`, `.gnupg`, `.docker`, `.config/gh` | **CLI and SDK providers:** the same agent paths and directories, plus `.npmrc`, `.yarnrc.yml`, `.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `AppData\Roaming\GitHub CLI`, `AppData\{Roaming,Local}\Microsoft\Credentials`, `AppData\Roaming\Microsoft\Protect` |
| **SDK provider:** agent home and agent repository **only**. The credential directories were missing, so they were inconsistent with the CLI provider. | Same list as the CLI provider (`ownerCredentialDirs()`) |

## Results
Tests: `tests/unit/phase-bde-v21.test.ts`, "Phase D" block.

Fixture layout:
- `AgentHome\agent.db` (protected);
- `AgentHome\workspaces\proj` (the workspace);
- `Owner Profile\.ssh\id_synthetic` (protected; the path contains a space on purpose).

### File tools (Read / Write / Edit / Grep / Glob)

| Spelling | Example | Result |
|---|---|---|
| Absolute | `…\Owner Profile\.ssh\id_synthetic` | DENY |
| Case variation | `…\OWNER PROFILE\.SSH\ID_SYNTHETIC` | DENY |
| Forward slashes | `…/Owner Profile/.ssh/id_synthetic` | DENY |
| Relative traversal | `..\..\..\Owner Profile\.ssh\id_synthetic`, `ws\..\..\agent.db` | DENY |
| Win32 device path | `\\?\C:\…\id_synthetic` | DENY |
| UNC admin share | `\\localhost\C$\…\id_synthetic` | DENY |
| Home expansion | `~/.ssh/id_rsa`, `~\.aws\credentials` | DENY. **Fixed:** before, `~` was treated as a folder inside the workspace and allowed. If the tool expands `~`, that was a bypass. |
| Junction inside the workspace (worker-creatable without admin) | `ws\jn\id_synthetic` → `Owner Profile\.ssh` | DENY. Canonical realpath containment is used for both Read and Write. |
| Symbolic link | `ws\sl\…` | **BLOCKED by privilege:** `symlink` returns `EPERM` on this host (no Developer Mode or administrator). The same realpath code path as for junctions applies, but it is not executed here. |
| Hard link inside the workspace | `ws\hl.txt` ⇔ `id_synthetic` | **ALLOW (residual).** A hard link *is* a workspace file. The file tools cannot tell it from an ordinary file without denying every multi-link file, which would break pnpm stores. Creating one needs code or `mklink /H` against the target. |

### Shell commands (Bash/PowerShell text)
All of these are DENY:
- quoted path with a space;
- upper case;
- forward slashes;
- Git Bash `/c/...` form;
- backslash-escaped space;
- NTFS alternate data stream (`::$DATA`);
- `../../..` traversal with a quoted segment;
- `cd ../../.. && cat "Owner Profile/..."`;
- globs `.ss*/id_*` and `agent.d?`;
- `sqlite3 <agent.db> .dump`.

Benign workspace commands (`cat src/index.ts`, `cat ./README.md && ls -la`) are allowed.

Credential directories by home-relative spelling (`~`, `$HOME`, `${HOME}`, `%USERPROFILE%`, `$env:USERPROFILE`, `C:\Users\<u>\…`, `/c/Users/<u>/…`) are covered by the 120-case Rule K matrix. With the provider set it has 0 false negatives (`RULE_K_COMPATIBILITY_RESULTS.md`).

### Confused deputy: trusted QA reading worker-planted links (found and fixed)
**Before:**
- The QA engine runs as the owner. It pasted every untracked file (from `git status --untracked-files=all`) into the reviewer prompt, using `readFileSync`.
- A worker-made **junction** (`ws\leakdir` → owner-only directory) or **hard link** (`ws\notes.json` ⇔ owner file) caused the owner-only content to be read and **persisted in the review task's instructions**.
- Reproduced earlier: `E:\Agent\v2-staging\worker-isolation\evidence\pr5-review\qa-confused-deputy.json`, `LEAK: true` for both. Fixture script: `scripts\qa-confused-deputy.cjs`.

**After `ba87473`:**
- `readUntrackedSafely` reads a file only when **all** of these hold:
  - it is a regular file, not a link;
  - it has a single link;
  - its real path is inside the real workspace path.
- The prompt is redacted.
- Test results:
  - junction: refused;
  - hard link: refused (`hard link`);
  - `..` traversal: refused;
  - regular new file: read.

  Test: `tests/integration/audit-redaction-v21.test.ts`, Phase D block.

### Fail-closed behaviour of the hook process
Real hook process, `node --import tsx pretooluse-hook.ts <policy> <sha256>`, from `phase-bde-v21.test.ts` and the existing `cli-provider.test.ts`:

| Situation | Result |
|---|---|
| Missing policy file | exit 2 (blocks) |
| Unparseable payload | exit 2 |
| Payload without `tool_name` | deny |
| Policy file rewritten after launch, for example to approve `protected_branch_push` | exit 2 for **every** later call, including `ls` |
| Unknown tool | deny |
| MCP tool | approval required |

## Residual (documented, not fixed)
1. **Same-user arbitrary code is outside this protection entirely** (V2.2).
2. **Hard links into the workspace** let the file tools read the target. A worker can create one with code (class S) or `mklink /H` with a non-protected spelling.
3. **Paths built at run time** by a program (`path.join(os.homedir(), '.ssh')` in a script) are invisible to command-text checks.
4. **`E:\` grants Authenticated Users: Modify** (host finding from 2026-11-09, unchanged). Any second local account could modify production files. This must be fixed before the V2.2 worker account exists.
5. **Symlink resolution is not executed on this host** because creation requires a privilege the owner has not enabled.
