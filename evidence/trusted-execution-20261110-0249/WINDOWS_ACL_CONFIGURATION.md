# Windows ACL configuration

**Status: C — requires administrator. Script `admin-scripts/02-configure-acls.ps1`. Dry-run verified (14 planned changes, 0 applied).**

## Target ACL layout (by the worker's real SID)

| Path | Owner / SYSTEM | `elevariq-worker` | Users / Authenticated Users |
|---|---|---|---|
| `C:\ElevariqWork` (worker tree) | Full | **Modify** (OI)(CI) | removed (inheritance reset) |
| `C:\ElevariqBroker` (approvals, audit, signing key) | Full | **DENY all** (OI)(CI) | removed |
| `%USERPROFILE%\.ssh`, `.aws`, `.claude`, `.config`, `.git-credentials` | unchanged | **DENY** added | unchanged |
| `%APPDATA%\GitHub CLI` | unchanged | **DENY** added | unchanged |
| `E:\Agent\Personal-agent` (production checkout) | unchanged | **DENY** added | unchanged |
| `%LOCALAPPDATA%\ElevariqAgent` (production agent home) | unchanged | **DENY** added | unchanged |

Reset inheritance (`icacls /inheritance:r`) only on the two agent-created trees; existing paths get an added DENY ACE, leaving every other ACE intact. Rollback removes exactly those DENY ACEs.

## Why DENY on owner/production paths
Defense in depth. A standard user already cannot read another user's profile, but an explicit DENY:
- makes the boundary auditable and obvious,
- covers the `E:\` case where `Authenticated Users: Modify` would otherwise let the worker write the production checkout,
- is verified by script 04 (`G3`, `G4`).

## The `E:\` broad-grant finding (reported, not changed here)
`E:\` grants `Authenticated Users: Modify` (inherited by production). Script 02 **reports** this and does **not** alter the broad grant (a drive-wide ACL change is risky). The recommended targeted fix, for the owner to decide:
```
icacls E:\Agent\Personal-agent /inheritance:d
icacls E:\Agent\Personal-agent /remove:g "Authenticated Users"
```
or remove `Authenticated Users: Modify` at `E:\` and re-grant the specific principals that need it. Until then, the worker-specific DENY on the production checkout is the compensating control.

## Verification (script 04, read-only)
`G2 worker NOT an administrator`, `G3 broker root denies worker`, `G4 owner .ssh denies worker`. Current dry-run: G1/G3 false (not applied yet), G2 true, G4 n/a. After Apply, all must be true before the acceptance matrix can mark these gates PASS.

## Honest limit
ACLs bind the worker's OS identity. They do nothing while the worker runs as the owner (same-user). Identity separation (script 01) is the precondition for every row above to matter.
