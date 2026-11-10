# Firewall configuration

**Status: C — requires administrator. Script `admin-scripts/03-firewall-rules.ps1`. Dry-run verified (SID-scoped rules planned, 0 applied).**

## Baseline (measured, read-only)
All three profiles enabled; default outbound = NotConfigured (Allow). The machine does not currently restrict the worker's egress.

## Design
SID-scoped outbound rules (Windows Firewall `-LocalUser` with the worker's SID in SDDL), so only the worker account is constrained and the owner's traffic is untouched:
- **Allow** worker → `api.anthropic.com` (provider API).
- **Allow** worker → the owner-run egress proxy (placeholder `127.0.0.1`).
- **Block** worker → everything else.

The machine's global default outbound is **not** flipped (too broad, would affect every process). Constraint is per-identity.

## Honest limits (documented, not worked around)
1. **Image vs identity:** a rule scoped to the worker SID covers processes running as that SID regardless of image, which is the right scope — *but* host/port allow-listing by Windows Firewall is address-based, not name-based. DNS names are resolved to addresses at apply time; a service that moves IPs can slip. Complete control needs the worker's traffic **forced through an authenticated outbound proxy** that does hostname allow-listing, with direct egress blocked.
2. **A proxy env var is not enforcement.** Setting `HTTPS_PROXY` for the worker does not stop a child process from opening a direct socket. Enforcement requires the block rule above *plus* the proxy, so direct connections fail and only the proxy path works.
3. **Loopback and local admin interfaces:** the block rule denies general egress; loopback to the broker is via the named pipe, not TCP. Access to local admin HTTP interfaces (e.g. the dashboard) should be a separate deny unless explicitly needed.

## Verification
Script 04 `G9` checks the block rule exists. Full network-isolation verification (that a worker child process cannot reach an arbitrary host) is an **OS-level test that requires the worker account and elevation — marked BLOCKED** until Apply.

## Rollback
Script 05 removes the three named rules.
