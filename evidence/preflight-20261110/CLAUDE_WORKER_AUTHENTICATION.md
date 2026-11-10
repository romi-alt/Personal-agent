# Claude Code authentication under the restricted worker account

## Measured now
- Claude Code CLI `2.1.321` at `C:\Users\Roman\.local\bin\claude.exe` (owner install).
- Owner login: `claude.ai` subscription (Max), expires 2026-12-04. Read via `claude auth status --json` (metadata only; no token read, copied or exported).
- Claude Code stores its login under the **user profile** (`~/.claude`). A login is therefore per-Windows-identity.

## The blocker (explicit)
The worker runs as `elevariq-worker`, a different Windows identity with its own profile. It has **no** Claude login. The only supported ways to give it one are:
1. **Interactive `/login` as the worker account** — sign in to Claude Code while logged on as (or `runas`/`PsExec -u`) `elevariq-worker`, completing the OAuth browser flow once. This creates a login in the worker's own `~/.claude`.
2. **A paid API key scoped to the worker** — requires owner approval and a billing decision; explicitly out of scope unless the owner authorizes it.

Both are **owner actions**. Neither can be done by this agent.

### Forbidden (and why)
- **Copying the owner's `~/.claude` into the worker profile** — this re-exposes the exact credential the isolation exists to protect, and defeats D6. Not done.
- **Reading/exporting the owner's existing token** — forbidden by the authorization boundaries; not done.
- **Inventing or bypassing an auth method** — not done.

## Decision: real-CLI under the worker = BLOCKED (gate D / G12)
Until the owner performs method (1), real Claude Code execution under the worker identity cannot run. The earlier benign staging task that passed ran under the **owner** identity, not under isolation, and does not satisfy this gate.

## DPAPI interaction with the broker credential (D6)
The worker's own password is stored DPAPI-encrypted (`C:\ElevariqBroker\worker-cred.xml`) under the identity that runs script 01 (the owner). This is for the **scheduled-task logon**, not for Claude auth. Constraint: the broker/task-register step must run as that same owner identity to decrypt it; if moved to SYSTEM, re-create the credential under SYSTEM.

## Subscription support under the worker
Subscription (`claude.ai`) execution **remains supported** under the worker identity once method (1) is done — Claude Code does not require the owner's profile, only *a* valid login in the running identity's profile. The watchdog env vars the provider injects are not credentials and are reproduced per worker.

## Renewal and revocation (design)
- **Renewal:** the worker login expires like any other; before expiry the owner re-runs `/login` as the worker. Track the worker login's `loginExpiresAt` via `claude auth status --json` run **as the worker** (not the owner).
- **Revocation:** owner runs `claude logout` as the worker, or deletes the worker's `~/.claude`, or disables the worker account (`Disable-LocalUser`), or revokes the session from the Anthropic console. The emergency stop (owner stops the worker task + processes) is independent of auth.

## Owner action required to unblock
Log on interactively as `elevariq-worker` (or `runas /user:elevariq-worker`), run `claude` → `/login`, complete the browser OAuth as the intended worker subscription, confirm `claude auth status` shows a subscription login. Then the real-CLI acceptance tests (A/B/C) can run under isolation.
