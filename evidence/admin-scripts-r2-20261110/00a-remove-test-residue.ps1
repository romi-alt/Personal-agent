<#
.SYNOPSIS
  A3: remove the isolation-test residue ACEs found by the 2026-11-10 assessment (P4, P5). Exact, fixed targets only.
.DESCRIPTION
  P4  E:\Agent\v2-staging\hardening\isotest\outside   explicit Everyone:(OI)(CI)FullControl  -> would override an
      inherited DENY (explicit allow is evaluated before inherited deny).
  P5  E:\Agent\v2-staging\hardening\repo and ...\isotest\tools   explicit AppContainer SID RX (earlier AppContainer test).
  Only these (path, SID) pairs are touched; anything else is refused. These are staging test folders, not production.
  The two HKCU AppContainer profile mappings (elevariq-iso-smoke, elevariq-worker-isotest) live in the OWNER's hive:
  remove them from a NON-elevated owner shell with the command printed below (not done here).
.PARAMETER Apply  Perform changes. Elevation not required if the owner owns the folders (they do); run from the frozen copy.
#>
[CmdletBinding()]
param([switch]$Apply)
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun '00a-remove-test-residue' $DryRun -NoElevationNeeded

$acSid = 'S-1-15-2-2956649102-4223940443-41726279-2319145132-3979920432-1607303059-3113665130'
$residue = @(
    @{ Path = 'E:\Agent\v2-staging\hardening\isotest\outside'; Sid = 'S-1-1-0' },
    @{ Path = 'E:\Agent\v2-staging\hardening\repo';            Sid = $acSid },
    @{ Path = 'E:\Agent\v2-staging\hardening\isotest\tools';   Sid = $acSid }
)
foreach ($r in $residue) {
    Assert-ElvNotProduction $report $r.Path
    if (-not (Test-Path -LiteralPath $r.Path)) { Add-ElvChange $report 'noop' $r.Path 'path absent' $false; continue }
    $present = @(Get-ElvAces $r.Path | Where-Object { $_.Sid -eq $r.Sid -and -not $_.Inherited -and $_.Type -eq 'AccessAllowed' })
    if (-not $present.Count) { Add-ElvChange $report 'noop' $r.Path "no explicit allow for $($r.Sid)" $false; continue }
    Invoke-ElvIcacls @($r.Path, '/remove:g', "*$($r.Sid)") $DryRun $report $r.Path "remove explicit allow for $($r.Sid)"
    if (-not $DryRun) {
        $left = @(Get-ElvAces $r.Path | Where-Object { $_.Sid -eq $r.Sid -and -not $_.Inherited })
        Add-ElvCheck $report 'A3' "residue removed on $($r.Path)" ($left.Count -eq 0)
    }
}
Add-ElvChange $report 'manual' 'HKCU AppContainer mappings' 'owner, non-elevated: Remove-Item HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings\<profile-SID> for elevariq-iso-smoke / elevariq-worker-isotest (identify by Moniker value first)' $false
Save-ElvReport $report
