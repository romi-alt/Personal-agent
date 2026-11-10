<#
.SYNOPSIS
  Staging volume layout + ACLs for worker / broker / owner (part of A6/A9). Only paths under C:\ElevariqStaging.
.DESCRIPTION
  Applies $ElvLayout from _common.ps1 (single source of truth). Every directory: inheritance reset, SYSTEM +
  Administrators Full, then the per-identity grants or explicit DENY. Idempotent: prior worker/broker ACEs are removed
  (grant AND deny) before re-applying. Creates SYNTHETIC decoys only (never real secrets).
  r3: bin\ (admin-write-only launcher dir), spool\requests add-file-only + OWNER RIGHTS (M9), broker RX+D on approvals
  (I4), L7 flag checks, M4 gate (identities not administrators), L12 refusal when a reparse point exists under any
  worker-writable directory (re-applying inheritable ACEs over worker-planted junctions is unverified).
  Prerequisite (enforced): 02 applied (both identities exist, disabled or not, and are in the deny group).
#>
[CmdletBinding()]
param([switch]$Apply, [string]$ApprovedManifestHash = '')
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun '03-staging-layout' $DryRun -ApprovedManifestHash $ApprovedManifestHash
trap { Save-ElvReport $report $_; break }
$owner = Get-ElvOwnerContext

$wsid = Resolve-ElvLocalSid $script:ElvWorkerAccount; $bsid = Resolve-ElvLocalSid $script:ElvBrokerAccount; $gsid = Resolve-ElvGroupSid
$pre = $wsid -and $bsid -and $gsid -and (Get-Partition -ErrorAction SilentlyContinue | Where-Object { $_.AccessPaths -contains "$($script:ElvStagingRoot)\" })
Add-ElvCheck $report 'PRE' '01 + 02 applied (volume mounted, identities exist)' ([bool]$pre)
if (-not $pre -and -not $DryRun) { throw 'Prerequisites failed: apply 01 and 02 first.' }
if ($wsid -and $bsid) {
    $admins = @(Get-ElvGroupMemberSids 'Administrators'); $members = @(Get-ElvGroupMemberSids $script:ElvGroup)
    $okIds = ($admins -notcontains $wsid) -and ($admins -notcontains $bsid) -and ($members -contains $wsid) -and ($members -contains $bsid)
    Add-ElvCheck $report 'M4' 'identities are not administrators and are in the deny group' $okIds
    if (-not $okIds -and -not $DryRun) { throw 'Gate failed: an identity is an administrator or not in the deny group.' }
}
if (-not $wsid) { $wsid = '<worker-SID>' }; if (-not $bsid) { $bsid = '<broker-SID>' }
$who = @{ W = $wsid; B = $bsid; O = $owner.Sid }

# L12: refuse to re-apply over worker-planted reparse points.
$wdirs = @($script:ElvWorkerWritableRels | ForEach-Object { Join-Path $script:ElvStagingRoot $_ })
$rps = @(Get-ElvReparsePointsUnder $wdirs)
Add-ElvCheck $report 'L12' 'no reparse points under worker-writable directories' ($rps.Count -eq 0) ($rps -join ';')
if ($rps.Count -and -not $DryRun) { throw "Refusing: reparse points under worker-writable dirs: $($rps -join ';'). Remove them (rmdir on the junction) before re-running 03." }

foreach ($d in $script:ElvLayout) {
    $path = $script:ElvStagingRoot; if ($d.Rel) { $path = Join-Path $script:ElvStagingRoot $d.Rel }
    [void](Assert-StagingPath $report $path)
    if (-not $DryRun -and -not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Force $path | Out-Null }
    if ($d.Rel) { Invoke-ElvIcacls @($path, '/inheritance:r') $DryRun $report $path 'inheritance reset' }
    Invoke-ElvIcacls @($path, '/remove', "*$wsid", "*$bsid", "*$($script:SidOwnerRights)") $DryRun $report $path 'clear prior worker/broker/OWNER RIGHTS ACEs (idempotent)'
    Invoke-ElvIcacls @($path, '/grant:r', "*$($script:SidSystem):(OI)(CI)F", "*$($script:SidAdmins):(OI)(CI)F") $DryRun $report $path 'SYSTEM + Administrators Full'
    foreach ($k in 'O', 'B', 'W') {
        $spec = $d[$k]; if (-not $spec) { continue }
        Invoke-ElvIcacls (@($path) + (ConvertTo-ElvGrant $who[$k] $spec)) $DryRun $report $path "$k $spec"
    }
    if ($d.OwnerRights) { Invoke-ElvIcacls @($path, '/grant', "*$($script:SidOwnerRights):(OI)(IO)(RC)") $DryRun $report $path 'OWNER RIGHTS inherit-only RC: creators get NO implicit WRITE_DAC on their files (M9)' }
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
