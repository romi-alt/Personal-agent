<#
.SYNOPSIS
  A10: worker-SID outbound egress restriction, plus (separately authorized) host-level rules for delegated egress (H3).
.DESCRIPTION
  Worker rules (per SID): ONE IPv4 block rule and ONE IPv6 block rule scoped to the worker SID (-LocalUser), whose
  remote address set is the COMPLEMENT of { 127.0.0.0/8 + owner-supplied -AllowIPv4Cidrs } (IPv6: everything but ::1).
  r3 changes:
    M6  replace is NOT atomic in Windows Firewall, so: (a) -Apply REFUSES while the worker is enabled or has processes;
        (b) new rules are created under temporary names, verified, and only then the old rules are removed and the new
        ones renamed. A failure leaves the old rules in place.
    L6  strict CIDRs; an empty block set is refused.  L9  N2 exact SID token; N3 exact address-set comparison.
    H3  per-SID rules do NOT match egress the worker delegates to system components. Each supported mechanism gets an
        explicit, independently testable restriction or a recorded residual (NETWORK_DELEGATION_RISKS.md):
          SMB redirector  (kernel, "System", TCP 445/139)      -HostRules: block Program=System to non-LAN   [GLOBAL]
          WebDAV          (WebClient service, LocalService)     -HostRules: block Service=WebClient to non-LAN [GLOBAL]
          BITS            (SYSTEM svchost; impersonation UNVERIFIED) residual: real-token test AT-H3-BITS decides
          DNS             (Dnscache, NETWORK SERVICE)           residual (recorded); proxy-side name allow-list
          loopback        (not filtered by Windows Firewall)    residual; listener inventory AT-76
        -HostRules changes GLOBAL state (affects the owner too) and is a separate authorization. -LanCidrs defaults to
        RFC1918 + link-local so LAN shares keep working; adjust to the owner's network.
    Profiles: all three must be Enabled with AllowLocalFirewallRules (checked; FAIL otherwise).
  Residuals (record, do not hide): DNS; loopback; BITS until tested; host-name allow-listing needs the egress proxy.
.PARAMETER AllowIPv4Cidrs  Owner-verified destination CIDRs (e.g. the provider's published ranges) to leave reachable.
.PARAMETER HostRules       Also create the GLOBAL SMB/WebDAV delegation blocks (separate authorization).
.PARAMETER LanCidrs        Destinations the host-level rules leave reachable (default: private + link-local + loopback).
#>
[CmdletBinding()]
param([switch]$Apply, [string[]]$AllowIPv4Cidrs = @(), [switch]$HostRules,
      [string[]]$LanCidrs = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '127.0.0.0/8'), [string]$ApprovedManifestHash = '')
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun '05-firewall-egress' $DryRun -ApprovedManifestHash $ApprovedManifestHash
trap { Save-ElvReport $report $_; break }

$wsid = Resolve-ElvLocalSid $script:ElvWorkerAccount
if (-not $wsid -and -not $DryRun) { throw 'Worker account missing: apply 02 first.' }
$sddl = 'D:(A;;CC;;;<worker-SID>)'; if ($wsid) { $sddl = "D:(A;;CC;;;$wsid)" }
foreach ($c in $AllowIPv4Cidrs + $LanCidrs) { [void](Get-ElvIPv4Range $c) }   # validates every CIDR (throws on bad input)

# M6: never replace rules under a live worker.
if ($wsid) {
    $u = Get-LocalUser -SID $wsid
    $procs = @(Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like "*\$($script:ElvWorkerAccount)" })
    $quiet = (-not $u.Enabled) -and ($procs.Count -eq 0)
    Add-ElvCheck $report 'M6' 'worker is disabled and has no processes (rules may be replaced)' $quiet "enabled=$($u.Enabled) procs=$($procs.Count)"
    if (-not $quiet -and -not $DryRun) { throw 'Refusing: disable the worker and stop its processes before replacing firewall rules (M6).' }
}
$prof = $false; try { $prof = Test-ElvFirewallProfilesEnforcing } catch {}
Add-ElvCheck $report 'FP' 'all firewall profiles enabled and honouring local rules (ActiveStore)' $prof
if (-not $prof -and -not $DryRun) { throw 'Firewall profiles are not enforcing local rules; the worker rules would be ineffective.' }

$v4 = Get-ElvIPv4Complement (@('127.0.0.0/8') + $AllowIPv4Cidrs)
$v6 = @('::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
$rules = @(
    @{ Name = "$($script:ElvFirewallPrefix)-Block-IPv4"; Remote = $v4; Desc = 'staging worker: block IPv4 except loopback and owner-approved CIDRs'; Extra = @{} },
    @{ Name = "$($script:ElvFirewallPrefix)-Block-IPv6"; Remote = $v6; Desc = 'staging worker: block IPv6 except ::1'; Extra = @{} }
)
if ($HostRules) {
    $lan4 = Get-ElvIPv4Complement $LanCidrs
    $rules += @{ Name = "$($script:ElvHostRulePrefix)-Block-SMB-Out"; Remote = $lan4; Desc = 'GLOBAL: kernel SMB redirector may not reach non-LAN hosts (H3 delegation)'; Extra = @{ Program = 'System'; Protocol = 'TCP'; RemotePort = @('445', '139') }; Host = $true }
    $rules += @{ Name = "$($script:ElvHostRulePrefix)-Block-WebClient-Out"; Remote = $lan4; Desc = 'GLOBAL: WebDAV (WebClient service) may not reach non-LAN hosts (H3 delegation)'; Extra = @{ Service = 'WebClient' }; Host = $true }
    Add-ElvChange $report 'note' 'host-rules' 'GLOBAL rules requested (-HostRules): they also apply to the owner; separate authorization' $false
}

function New-ElvRule { param($R, [string]$DisplayName)
    $args = @{ DisplayName = $DisplayName; Group = $script:ElvFirewallGroup; Description = $R.Desc; Direction = 'Outbound'; Action = 'Block'; RemoteAddress = $R.Remote; Profile = 'Any'; Enabled = 'True'; ErrorAction = 'Stop' }
    if (-not $R.Host) { $args.LocalUser = $sddl }
    foreach ($k in $R.Extra.Keys) { $args[$k] = $R.Extra[$k] }
    New-NetFirewallRule @args | Out-Null
}
function Test-ElvRuleLive { param($R, [string]$DisplayName)
    $fw = Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue
    if (-not $fw) { return $false }
    $addr = @(($fw | Get-NetFirewallAddressFilter).RemoteAddress)
    if ($R.Host) { return (([string]$fw.Enabled -eq 'True') -and ([string]$fw.Action -eq 'Block') -and ([string]$fw.Direction -eq 'Outbound') -and ((@($addr | Sort-Object) -join ',') -eq (@($R.Remote | Sort-Object) -join ','))) }
    $sec = [string]($fw | Get-NetFirewallSecurityFilter).LocalUser
    return (Test-ElvWorkerFirewallRule $fw $sec $addr $wsid $R.Remote)
}

# Replace: create "<name>.new", verify, remove old, rename. Only rules carrying our prefixes are ever touched.
$prefixes = @("$($script:ElvFirewallPrefix)-*"); if ($HostRules) { $prefixes += "$($script:ElvHostRulePrefix)-*" }
foreach ($r in $rules) {
    $tmp = "$($r.Name).new"
    if ($DryRun) { Add-ElvChange $report 'new-netfirewallrule' $r.Name ("Outbound BLOCK {0}Remote={1} {2}" -f $(if ($r.Host) { 'GLOBAL ' } else { "LocalUser=$sddl " }), ($r.Remote -join ','), (($r.Extra.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value -join '/')" }) -join ' ')) $false; continue }
    Get-NetFirewallRule -DisplayName $tmp -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop
    New-ElvRule $r $tmp
    if (-not (Test-ElvRuleLive $r $tmp)) { Get-NetFirewallRule -DisplayName $tmp -ErrorAction SilentlyContinue | Remove-NetFirewallRule; throw "New rule $tmp failed verification; old rules left in place." }
    Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue | ForEach-Object { $_ | Remove-NetFirewallRule -ErrorAction Stop; Add-ElvChange $report 'remove-netfirewallrule' $r.Name 'replaced (old removed after new verified)' $true }
    Get-NetFirewallRule -DisplayName $tmp | Set-NetFirewallRule -NewDisplayName $r.Name -ErrorAction Stop
    Add-ElvChange $report 'new-netfirewallrule' $r.Name 'created and verified' $true
}
# Stale rules under our prefixes that are not in the current set (e.g. r1 names) are removed.
if (-not $DryRun) {
    $keep = @($rules | ForEach-Object { $_.Name })
    foreach ($o in @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $n = $_.DisplayName; ($prefixes | Where-Object { $n -like $_ }) -and ($keep -notcontains $n) })) {
        $o | Remove-NetFirewallRule -ErrorAction Stop; Add-ElvChange $report 'remove-netfirewallrule' $o.DisplayName 'stale rule under our prefix removed' $true
    }
    foreach ($r in $rules) {
        $fw = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
        $addr = @(); $sec = ''; if ($fw) { $addr = @(($fw | Get-NetFirewallAddressFilter).RemoteAddress); $sec = [string]($fw | Get-NetFirewallSecurityFilter).LocalUser }
        Add-ElvCheck $report 'N1' "$($r.Name) enabled outbound block" ([bool]($fw -and [string]$fw.Enabled -eq 'True' -and [string]$fw.Action -eq 'Block' -and [string]$fw.Direction -eq 'Outbound'))
        if (-not $r.Host) { Add-ElvCheck $report 'N2' "$($r.Name) scoped to EXACTLY the current worker SID" ($sec -match ('\(A;;CC;;;' + [regex]::Escape($wsid) + '\)')) "$sec" }
        Add-ElvCheck $report 'N3' "$($r.Name) address set equals the computed $($r.Remote.Count) ranges" ((@($addr | Sort-Object) -join ',') -eq (@($r.Remote | Sort-Object) -join ','))
    }
}
Add-ElvChange $report 'residual' 'egress' 'DNS via Dnscache (not worker SID); loopback unfiltered (AT-76); BITS delegation unverified (AT-H3-BITS); SMB/WebDAV only with -HostRules; host-name allow-listing needs the egress proxy' $false
Add-ElvProductionChecks $report
Save-ElvReport $report
