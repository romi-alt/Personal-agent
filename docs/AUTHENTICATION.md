# Authentication

## What is supported

| Credential | Use | Status |
|---|---|---|
| **Anthropic Console API key** (`ANTHROPIC_API_KEY`) | Unattended runtime (`EXECUTION_PROVIDER=claude`) | Implemented; **not live-verified** (no key was available) |
| Existing Claude Code subscription login (`claude auth`) | Interactive development/diagnostics only (`doctor` runs `claude --version`) | Left untouched; never used by the unattended runtime |
| Browser automation / token scraping / undocumented endpoints | - | **Not used, not supported** |

The adapter refuses to run on any other identity: it removes `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` and the Bedrock/Vertex/Foundry switches
from the child environment, rejects `sk-ant-oat…` subscription tokens placed in `ANTHROPIC_API_KEY`, and aborts the execution if the SDK's `init`
message reports an `apiKeySource` other than `ANTHROPIC_API_KEY`.

## Three gates before any paid request

`ClaudeProvider.preflight()` is *local only* (it makes no API call) and is `ready` only if all hold:

1. `ANTHROPIC_API_KEY` is present (environment first, then the untracked `.env`).
2. `ALLOW_PAID_API=true` - explicit authorisation to use paid API billing.
3. `MAX_BUDGET_USD_PER_EXECUTION > 0` - passed to the SDK as `maxBudgetUsd`. Optionally `DAILY_BUDGET_USD` caps rolling 24 h *estimated* spend.

If not ready, pending tasks move to `WAITING_FOR_AUTHENTICATION` and the supervisor idles. The supervisor never converts a subscription
usage failure into paid API traffic and never rotates keys/accounts to evade a limit.

## Initial setup

1. Anthropic Console → create an API key in a **dedicated workspace with a monthly spend limit**.
2. Put it in an untracked file or the service environment - **never in chat, git, or logs**:
   * Local dev: `cp .env.example .env`, then set `ANTHROPIC_API_KEY=…`, `EXECUTION_PROVIDER=claude`, `ALLOW_PAID_API=true`, `MAX_BUDGET_USD_PER_EXECUTION=2`.
   * Windows: prefer a user-level environment variable (`setx` / System Properties) or `.env` with owner-only ACLs (`icacls .env /inheritance:r /grant:r "%USERNAME%:R"`).
   * Linux: `/etc/elevariq-agent/agent.env` (root:elevariq-agent, mode 0640) read by systemd's `EnvironmentFile`.
3. `npm run agent -- doctor` → "provider auth" should read `ready`.
4. Optional live check (spends real money, capped at ≤ $0.50): `EXECUTION_PROVIDER=claude npm run smoke:live`.

## Credential rotation

The key is re-read from the environment/`.env` on every preflight. A **runtime** authentication rejection records a non-reversible
fingerprint (SHA-256, 12 hex chars) of the key that failed; the supervisor does not retry with the same key. Replacing the key changes the
fingerprint and the supervisor resumes on its own (no request is made merely to "test" the key). Environment variables are fixed at process
start, so on a long-lived supervisor use the `.env` file (re-read) or restart the service after changing a process-level variable.

## Limitations

* The key is only as protected as the host: any process running as the same OS user can read the `.env`/environment.
* OS secret stores (Windows Credential Manager, libsecret) are **not** integrated in Phase 1 - protected environment injection is used instead.
* Logs, events and execution transcripts are redacted (key names and `sk-ant-…`/Bearer patterns), but redaction is best-effort: do not put secrets in task instructions.
* The Agent SDK launches the Claude Code binary as a subprocess; that subprocess inherits the supervisor's environment (so keep unrelated secrets out of it), minus the competing credential variables the adapter removes.

---

# Phase 1.5 addendum - provider readiness report

`npm run agent -- provider:status` reports **six separate levels**; nothing is inferred from another:

| Level | Meaning | How it becomes `YES` |
|---|---|---|
| `SDK_INSTALLED` | `@anthropic-ai/claude-agent-sdk` resolves, reports a version and exports `query()` | automatic (and explicitly *not* a sign the provider works) |
| `CREDENTIALS_CONFIGURED` | a Console API key is present and is not a subscription OAuth token | automatic; format only, shown as a fingerprint |
| `API_ACCESS_VERIFIED` | the API accepted the key | `provider:verify --access` (a **non-billable** `GET /v1/models?limit=1`; never run automatically); evidence is bound to the key fingerprint |
| `BUDGET_AUTHORIZED` | `ALLOW_PAID_API=true` and `MAX_BUDGET_USD_PER_EXECUTION > 0` | configuration |
| `LIVE_EXECUTION_VERIFIED` | a real SDK execution wrote a file, captured a session id and finished | `npm run smoke:live` (spends <= $0.50) |
| `LIVE_RECOVERY_VERIFIED` | a session was resumed from a **different process** and remembered its context | `npm run smoke:live-recovery` (spends a few cents). Verifies session persistence/resume only, *not* rate-limit recovery |

`operational` = first five levels `YES`. `unattended-ready` additionally needs `LIVE_RECOVERY_VERIFIED`. Evidence goes **`STALE`** when the installed SDK version or the
credential fingerprint changes. In this repository's current state the evidence table is empty, so the provider is reported **not operational**.

## SDK facts used (checked against the installed 0.3.319 type definitions; official docs for permissions/sessions/cost)

* Authentication: API key through `ANTHROPIC_API_KEY`. The SDK docs state that third-party developers may not offer claude.ai login or its rate limits in their products without prior approval and should use API-key authentication - which is how this runtime is built; subscription OAuth credentials are never extracted or reused, and the native Claude Code login is untouched.
* `system/init` reports `apiKeySource`; the adapter aborts unless it is `ANTHROPIC_API_KEY`.
* Sessions persist under `~/.claude/projects/<encoded-cwd>/*.jsonl` (`persistSession` defaults to true); `resume` needs that file on the same machine. `getSessionInfo` is used for a free local existence check.
* `total_cost_usd`/`modelUsage` are client-side **estimates**, stored as estimates only.
