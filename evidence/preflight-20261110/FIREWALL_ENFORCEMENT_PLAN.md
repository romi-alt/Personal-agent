# Firewall enforcement plan

## Question the mandate poses
Can the proposed rules restrict **every** process launched under the worker identity? **Not by image-based rules alone.** Honest answer below.

## Measured baseline
All three firewall profiles enabled; default outbound = `NotConfigured` (Allow). No per-user egress restriction exists today.

## What SID-scoped rules CAN do
Windows Firewall rules can filter by **local user** (an SDDL with the worker SID via `-LocalUser`). A rule scoped to the worker SID applies to **any** process running as that SID, regardless of image — so it *does* cover arbitrary child processes the worker spawns, as long as they run under the worker identity (which, post-isolation, they do). This is stronger than image-path rules.

## What SID-scoped rules CANNOT do
- **Host allow-listing is address-based.** `-RemoteAddress api.anthropic.com` resolves to IPs at rule-creation time; if the service's IPs change, the allow-list drifts. Windows Firewall does not do hostname/SNI filtering.
- **A blanket SID block + narrow IP allow** is coarse: it either over-blocks (breaks the provider when IPs rotate) or is maintained by hand.

## The enforceable design
1. **SID-scoped outbound rules** (script 03): allow worker→provider IPs and worker→proxy; **block worker→everything else**. Because they are SID-scoped, they bind every worker child process.
2. **Authenticated egress proxy** (owner-run) for anything that needs hostname allow-listing: the block rule denies direct egress, so the only working path is through the proxy, which does the hostname policy. The worker is configured to use the proxy, but — crucially — enforcement does not rely on the worker honoring `HTTPS_PROXY`; direct connections simply fail at the firewall.

## Verification (post-apply, AS the worker)
```
# MUST succeed (allow-listed):
Invoke-WebRequest https://api.anthropic.com -Method Head
# MUST fail (blocked), including from a child process and a raw socket:
Invoke-WebRequest https://example.com
node -e "require('net').connect(443,'93.184.216.34').on('error',e=>console.log('blocked',e.code))"
powershell -Command "(New-Object Net.Sockets.TcpClient).Connect('1.1.1.1',53)"   # direct IP, must fail
nslookup example.com 8.8.8.8     # external DNS path, confirm policy
```
Pass: only allow-listed destinations reachable, from the worker **and** its children, over HTTP, raw TCP and direct-IP.

## Residual gaps to state plainly
- Without the proxy, hostname-level control is approximate (IP drift). Rated **acceptable for staging**, **recommended-to-close for production** via the proxy.
- Loopback: the broker pipe is not TCP, so loopback TCP can be blocked for the worker except where a documented local service is needed.
- DNS: if the worker can reach an external resolver, it can exfiltrate via DNS; force DNS through the allowed path or block external 53.

## Scripts
`03-firewall-rules.ps1` (dry-run verified) creates the three SID-scoped rules idempotently (`Remove-NetFirewallRule` before create). `05-rollback.ps1` removes them. Full egress verification is an **OS-level test requiring the worker account and elevation — BLOCKED** until S1/S3 are applied.
