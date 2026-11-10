<#
.SYNOPSIS
  Per-user outbound firewall policy for the ELEVARIQ worker account. DESIGN ARTIFACT - review before running.
.DESCRIPTION
  Windows Defender Firewall rules cannot be scoped to a user on OUTBOUND by default the way inbound can, so this
  script implements the enforceable part and documents the gap:
    - Default outbound for the machine stays NotConfigured (Allow); we do NOT flip the global default (too broad).
    - Creates BLOCK rules for the worker account's known executables (node.exe under the worker tree) to all remote
      addresses EXCEPT an allowlist (the Anthropic API + an owner-run outbound proxy), using -LocalUser (the worker
      SID) so only the worker is constrained.
  HONEST LIMIT: a child process the worker launches under a different image path is not covered by an image-based
  rule; true per-identity egress control needs either (a) the authenticated outbound proxy with the worker's traffic
  forced through it, or (b) Windows Firewall 'Filter by user' with the worker SID on every rule. Both are documented
  in FIREWALL_CONFIGURATION.md. This script sets the SID-scoped baseline and reports residual gaps.
.PARAMETER DryRun  Default $true.
.PARAMETER Apply   Perform changes. Requires elevation.
#>
[CmdletBinding()]
param([bool]$DryRun = $true, [switch]$Apply, [bool]$StagingOnly = $true)
. (Join-Path $PSScriptRoot '_common.ps1')
$report = New-ElvReport '03-firewall-rules'
if ($Apply) { $DryRun = $false }
$report.dryRun = $DryRun; $report.stagingOnly = $StagingOnly
Write-Host "== 03 Staging firewall rules ($(if ($DryRun) { 'DRY-RUN' } else { 'APPLY' }) / $(if ($StagingOnly) { 'STAGING-ONLY' } else { 'PRODUCTION-SCOPE' })) =="
if (-not $StagingOnly) { throw "This pilot script runs StagingOnly." }
if (-not $DryRun -and -not (Test-ElvElevation)) { throw "Apply mode requires an elevated PowerShell." }

# These are NEW rules; the global/default outbound policy is NOT changed (owner constraint). Rules are SID-scoped and
# named with the staging prefix so they can never collide with or alter a production rule.
$sid = Resolve-ElvLocalSid $script:ElvWorkerAccount
$sddl = if ($sid) { "D:(A;;CC;;;$sid)" } else { "D:(A;;CC;;;<worker-SID>)" }

$allowHosts = @('api.anthropic.com')
$proxy = '127.0.0.1'   # placeholder: an owner-run authenticated egress proxy, if deployed

$rules = @(
    @{ Name = "$script:ElvFirewallPrefix-Allow-Anthropic"; Action = 'Allow'; Remote = $allowHosts;  Desc = 'staging worker -> Anthropic API' },
    @{ Name = "$script:ElvFirewallPrefix-Allow-Proxy";     Action = 'Allow'; Remote = @($proxy);     Desc = 'staging worker -> owner egress proxy' },
    @{ Name = "$script:ElvFirewallPrefix-Block-Other";     Action = 'Block'; Remote = @('Any');       Desc = 'staging worker -> everything else (deny)' }
)
foreach ($r in $rules) {
    if ($DryRun) {
        Add-ElvChange $report 'new-netfirewallrule' $r.Name ("Outbound {0}; LocalUser=worker-SID; Remote={1}; {2}" -f $r.Action, ($r.Remote -join ','), $r.Desc) $false
    } else {
        if (-not $sid) { throw "Worker account not found; run 01 -Apply first." }
        try { Remove-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue } catch {}
        $params = @{
            DisplayName = $r.Name; Direction = 'Outbound'; Action = $r.Action; LocalUser = $sddl
            Description = $r.Desc; Profile = 'Any'
        }
        if ($r.Remote -notcontains 'Any') { $params['RemoteAddress'] = $r.Remote }
        New-NetFirewallRule @params | Out-Null
        Add-ElvChange $report 'new-netfirewallrule' $r.Name ("{0} created" -f $r.Action) $true
    }
}

Add-ElvChange $report 'residual-gap' 'egress' 'Image-based rules do not cover arbitrary child images. Force worker traffic through the authenticated proxy for complete control.' $false
Save-ElvReport $report
