<#
.SYNOPSIS
  A10: worker-SID outbound egress restriction (fixes r1 F-10c).
.DESCRIPTION
  r1 defects fixed:
    - Windows Defender Firewall: BLOCK rules win over ALLOW rules, so r1's Allow-Anthropic + Block-Any blocked all.
    - -RemoteAddress does not take host names ('api.anthropic.com').
    - New-NetFirewallRule errors were not checked, so "created" could be reported falsely.
  r2 design: ONE IPv4 block rule and ONE IPv6 block rule, both scoped to the worker SID (-LocalUser), whose remote
  address set is the COMPLEMENT of { 127.0.0.0/8 + owner-supplied -AllowIPv4Cidrs } (IPv6: everything but ::1).
  No allow rules are needed (default outbound is Allow; this rule only subtracts). Global profiles are unchanged.
  Host-name allow-listing belongs to the loopback egress proxy (not implemented yet). With no -AllowIPv4Cidrs and no
  proxy, the worker has NO internet egress - safe default; the Claude CLI cannot work until one of them is provided.
  Residuals (record, do not hide): DNS goes via the Dnscache service (NETWORK SERVICE), not the worker SID; loopback is
  not filtered by Windows Firewall (verify with AT-76).
.PARAMETER AllowIPv4Cidrs  Owner-verified destination CIDRs (e.g. the provider's published ranges) to leave reachable.
#>
[CmdletBinding()]
param([switch]$Apply, [string[]]$AllowIPv4Cidrs = @())
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun '05-firewall-egress' $DryRun

$wsid = Resolve-ElvLocalSid $script:ElvWorkerAccount
if (-not $wsid -and -not $DryRun) { throw 'Worker account missing: apply 02 first.' }
$sddl = 'D:(A;;CC;;;<worker-SID>)'; if ($wsid) { $sddl = "D:(A;;CC;;;$wsid)" }
foreach ($c in $AllowIPv4Cidrs) { [void](Get-ElvIPv4Range $c) }   # validates every CIDR (throws on bad input)

$v4 = Get-ElvIPv4Complement (@('127.0.0.0/8') + $AllowIPv4Cidrs)
$v6 = @('::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
$rules = @(
    @{ Name = "$($script:ElvFirewallPrefix)-Block-IPv4"; Remote = $v4; Desc = 'staging worker: block IPv4 except loopback and owner-approved CIDRs' },
    @{ Name = "$($script:ElvFirewallPrefix)-Block-IPv6"; Remote = $v6; Desc = 'staging worker: block IPv6 except ::1' }
)

# Idempotency: remove ONLY rules carrying our prefix (r1 names included), then create.
$old = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "$($script:ElvFirewallPrefix)-*" })
foreach ($o in $old) {
    if ($DryRun) { Add-ElvChange $report 'remove-netfirewallrule' $o.DisplayName 'replace existing staging rule' $false }
    else { $o | Remove-NetFirewallRule -ErrorAction Stop; Add-ElvChange $report 'remove-netfirewallrule' $o.DisplayName 'removed' $true }
}
foreach ($r in $rules) {
    if ($DryRun) { Add-ElvChange $report 'new-netfirewallrule' $r.Name ("Outbound BLOCK LocalUser={0} Remote={1}" -f $sddl, ($r.Remote -join ',')) $false; continue }
    New-NetFirewallRule -DisplayName $r.Name -Group $script:ElvFirewallGroup -Description $r.Desc -Direction Outbound -Action Block `
        -LocalUser $sddl -RemoteAddress $r.Remote -Profile Any -Enabled True -ErrorAction Stop | Out-Null
    Add-ElvChange $report 'new-netfirewallrule' $r.Name 'created' $true
}

if (-not $DryRun) {
    foreach ($r in $rules) {
        $fw = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
        $ok = $fw -and $fw.Enabled -eq 'True' -and $fw.Action -eq 'Block' -and $fw.Direction -eq 'Outbound'
        $sec = $null; $addr = $null
        if ($fw) { $sec = ($fw | Get-NetFirewallSecurityFilter).LocalUser; $addr = @(($fw | Get-NetFirewallAddressFilter).RemoteAddress) }
        Add-ElvCheck $report 'N1' "$($r.Name) enabled outbound block" ([bool]$ok)
        Add-ElvCheck $report 'N2' "$($r.Name) scoped to the worker SID" ($sec -match [regex]::Escape($wsid)) "$sec"
        Add-ElvCheck $report 'N3' "$($r.Name) address set = $($r.Remote.Count) ranges" ($addr.Count -ge 1) ($addr -join ',')
    }
}
Add-ElvChange $report 'residual' 'egress' 'DNS via Dnscache (not worker SID); loopback unfiltered (AT-76); host allow-listing needs the egress proxy' $false
Add-ElvProductionChecks $report
Save-ElvReport $report
