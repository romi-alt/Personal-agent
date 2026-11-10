<#
.SYNOPSIS
  Configure NTFS ACLs for the STAGING worker isolation pilot. DESIGN ARTIFACT - review before running.
.DESCRIPTION
  Sets ACLs ONLY on newly created objects under C:\ElevariqStaging:
    - work   : worker Modify; owner USER SID + SYSTEM Full; inheritance reset.
    - broker : worker DENY all; owner USER SID + SYSTEM Full (signing key, audit, approvals).
    - home   : worker Modify (synthetic agent home + synthetic DB).
    - decoys : SYNTHETIC production/credential look-alikes created here, with worker DENY, so the acceptance matrix
      can prove the worker is blocked WITHOUT ever touching real production or owner files.
  Makes NO change to: the production checkout, production task/DB/env, owner credential stores, any pre-existing
  directory ACL, or the global firewall. Every target is guarded by Assert-StagingPath (throws otherwise).
.PARAMETER DryRun       Default $true.
.PARAMETER Apply        Perform changes. Requires elevation.
.PARAMETER StagingOnly  Default $true. Only C:\ElevariqStaging may be touched.
#>
[CmdletBinding()]
param([bool]$DryRun = $true, [switch]$Apply, [bool]$StagingOnly = $true)
. (Join-Path $PSScriptRoot '_common.ps1')
$report = New-ElvReport '02-configure-acls'
if ($Apply) { $DryRun = $false }
$report.dryRun = $DryRun; $report.stagingOnly = $StagingOnly
Write-Host "== 02 Configure staging ACLs ($(if ($DryRun) { 'DRY-RUN' } else { 'APPLY' }) / $(if ($StagingOnly) { 'STAGING-ONLY' } else { 'PRODUCTION-SCOPE' })) =="
if (-not $StagingOnly) { throw "This pilot script runs StagingOnly. Production isolation ACLs are a separate, later, authorized stage (see PRODUCTION_ISOLATION_STAGE)." }
if (-not $DryRun -and -not (Test-ElvElevation)) { throw "Apply mode requires an elevated PowerShell." }

$owner = Get-ElvOwnerContext
$ownerP = "*$($owner.Sid)"
$sid = Resolve-ElvLocalSid $script:ElvWorkerAccount
if (-not $sid -and -not $DryRun) { throw "Worker account missing. Run 01 -Apply first." }
if ($sid -and $sid -eq $owner.Sid) { throw "Owner and worker SIDs identical; no identity separation. Abort." }
$workerP = if ($sid) { "*$sid" } else { "<worker-SID>" }
Add-ElvChange $report 'identity' $script:ElvWorkerAccount "worker SID=$sid; owner SID=$($owner.Sid)" $false

# Grant a staging directory to the worker (Modify) + owner + SYSTEM (Full). /grant:r is idempotent (replaces).
function Set-StagingDir {
    param([string]$Path, [string]$WorkerRights) # 'M' or 'DENY'
    [void](Assert-StagingPath $report $Path $StagingOnly)
    if (-not $DryRun) { New-Item -ItemType Directory -Force $Path | Out-Null }
    if ($WorkerRights -eq 'DENY') {
        if ($sid) { Clear-ElvPrincipalAces $Path $workerP $DryRun $report }
        [void](Invoke-ElvIcacls @($Path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '/grant:r', "$($ownerP):(OI)(CI)F", '/deny', "$($workerP):(OI)(CI)F") `
            $DryRun $report $Path 'worker DENY all; owner+SYSTEM Full; inheritance reset')
    } else {
        [void](Invoke-ElvIcacls @($Path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '/grant:r', "$($ownerP):(OI)(CI)F", '/grant:r', "$($workerP):(OI)(CI)$WorkerRights") `
            $DryRun $report $Path "worker $WorkerRights; owner+SYSTEM Full; inheritance reset")
    }
}

Set-StagingDir $script:ElvWorkRoot    'M'      # worker tree
Set-StagingDir $script:ElvBrokerRoot  'DENY'   # broker state: worker denied
Set-StagingDir $script:ElvStagingHome 'M'      # synthetic agent home

# SYNTHETIC decoys: create look-alikes the worker must NOT read, with worker DENY. These stand in for production/owner
# resources so the acceptance matrix proves enforcement without touching anything real.
[void](Assert-StagingPath $report $script:ElvDecoyRoot $StagingOnly)
if (-not $DryRun) {
    New-Item -ItemType Directory -Force "$script:ElvDecoyRoot\fake-claude", "$script:ElvDecoyRoot\fake-prod-checkout" | Out-Null
    'SYNTHETIC-CREDENTIAL-VALUE-DO-NOT-USE' | Set-Content "$script:ElvDecoyRoot\fake-claude\.credentials.json" -Encoding ascii
    'SYNTHETIC-PRODUCTION-LOOKALIKE'        | Set-Content "$script:ElvDecoyRoot\fake-prod-checkout\.env" -Encoding ascii
}
if ($sid) { Clear-ElvPrincipalAces $script:ElvDecoyRoot $workerP $DryRun $report }
[void](Invoke-ElvIcacls @($script:ElvDecoyRoot, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '/grant:r', "$($ownerP):(OI)(CI)F", '/deny', "$($workerP):(OI)(CI)F") `
    $DryRun $report $script:ElvDecoyRoot 'SYNTHETIC decoys: worker DENY (stand-ins for prod/owner; nothing real touched)')

# Report-only: the real-production exposure the pilot deliberately does NOT change.
Add-ElvChange $report 'report-only' 'E:\' 'Authenticated Users:Modify on E:\ is inherited by production. A new worker is an Authenticated User, so it could reach production via that grant. The PILOT does NOT change this (owner constraint). Closing it is the separate PRODUCTION_ISOLATION_STAGE.' $false
Save-ElvReport $report
