<#
.SYNOPSIS
  Staging volume layout + ACLs for worker / broker / owner (part of A6/A9). Only paths under C:\ElevariqStaging.
.DESCRIPTION
  Applies $ElvLayout from _common.ps1 (single source of truth). Every directory: inheritance reset, SYSTEM +
  Administrators Full, then the per-identity grants or explicit DENY. Idempotent: prior worker/broker/owner ACEs are
  removed (grant AND deny, r1 defect D2) before re-applying. Creates SYNTHETIC decoys only (never real secrets).
  Verification parses ACEs by SID and evaluates them (r1 R-4 used icacls text + a broken regex).
  Prerequisite (enforced): 02 applied (both identities exist and are in the deny group).
#>
[CmdletBinding()]
param([switch]$Apply)
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun '03-staging-layout' $DryRun
$owner = Get-ElvOwnerContext

$wsid = Resolve-ElvLocalSid $script:ElvWorkerAccount; $bsid = Resolve-ElvLocalSid $script:ElvBrokerAccount; $gsid = Resolve-ElvGroupSid
$pre = $wsid -and $bsid -and $gsid -and (Get-Partition -ErrorAction SilentlyContinue | Where-Object { $_.AccessPaths -contains "$($script:ElvStagingRoot)\" })
Add-ElvCheck $report 'PRE' '01 + 02 applied (volume mounted, identities exist)' ([bool]$pre)
if (-not $pre -and -not $DryRun) { throw 'Prerequisites failed: apply 01 and 02 first.' }
if (-not $wsid) { $wsid = '<worker-SID>' }; if (-not $bsid) { $bsid = '<broker-SID>' }
$who = @{ W = $wsid; B = $bsid; O = $owner.Sid }

foreach ($d in $script:ElvLayout) {
    $path = $script:ElvStagingRoot; if ($d.Rel) { $path = Join-Path $script:ElvStagingRoot $d.Rel }
    [void](Assert-StagingPath $report $path)
    if (-not $DryRun -and -not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Force $path | Out-Null }
    if ($d.Rel) { Invoke-ElvIcacls @($path, '/inheritance:r') $DryRun $report $path 'inheritance reset' }
    Invoke-ElvIcacls @($path, '/remove', "*$wsid", "*$bsid") $DryRun $report $path 'clear prior worker/broker ACEs (idempotent)'
    Invoke-ElvIcacls @($path, '/grant:r', "*$($script:SidSystem):(OI)(CI)F", "*$($script:SidAdmins):(OI)(CI)F") $DryRun $report $path 'SYSTEM + Administrators Full'
    foreach ($k in 'O', 'B', 'W') {
        $spec = $d[$k]; if (-not $spec) { continue }
        Invoke-ElvIcacls (@($path) + (ConvertTo-ElvGrant $who[$k] $spec)) $DryRun $report $path "$k $spec"
    }
}

# SYNTHETIC decoys (stand-ins for owner credentials / production env). Inherit decoys\ ACL (worker DENY).
$decoys = @{ 'decoys\fake-claude\.credentials.json' = 'SYNTHETIC-CREDENTIAL-VALUE-DO-NOT-USE'; 'decoys\fake-prod-checkout\.env' = 'SYNTHETIC-PRODUCTION-LOOKALIKE=1' }
foreach ($rel in $decoys.Keys) {
    $f = Join-Path $script:ElvStagingRoot $rel; [void](Assert-StagingPath $report $f)
    if ($DryRun) { Add-ElvChange $report 'write-decoy' $f 'synthetic marker file' $false; continue }
    New-Item -ItemType Directory -Force (Split-Path -Parent $f) | Out-Null
    $decoys[$rel] | Set-Content -Encoding ascii -LiteralPath $f
    Add-ElvChange $report 'write-decoy' $f 'synthetic marker file' $true
}

# Configuration verification by SID evaluation. NOT an access test - see ADVERSARIAL_ACCEPTANCE_MATRIX.md.
if (-not $DryRun) { Test-ElvLayout $report $wsid $bsid $gsid }
Add-ElvProductionChecks $report
Save-ElvReport $report
