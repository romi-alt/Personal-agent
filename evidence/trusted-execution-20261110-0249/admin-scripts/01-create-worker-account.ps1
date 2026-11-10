<#
.SYNOPSIS
  Create the dedicated low-privilege STAGING worker account + secured staging broker root. DESIGN ARTIFACT.
.DESCRIPTION
  Creates a standard (non-administrator) local user 'elv-stg-worker' and the staging tree under C:\ElevariqStaging.
  Makes ZERO changes to production or owner resources. Every path is guarded by Assert-StagingPath.
.PARAMETER DryRun       Default $true. Prints proposed changes; makes none.
.PARAMETER Apply        Perform the changes. Requires elevation.
.PARAMETER StagingOnly  Default $true. In this mode only C:\ElevariqStaging objects may be touched.
.NOTES
  Requires administrator in Apply mode. Does not touch production. The credential is DPAPI-protected under the
  CURRENT (owner) identity; the broker must run as that same identity to decrypt it (preflight D6).
#>
[CmdletBinding()]
param([bool]$DryRun = $true, [switch]$Apply, [bool]$StagingOnly = $true)
. (Join-Path $PSScriptRoot '_common.ps1')
$report = New-ElvReport '01-create-worker-account'
if ($Apply) { $DryRun = $false }
$report.dryRun = $DryRun; $report.stagingOnly = $StagingOnly
Write-Host "== 01 Create staging worker account ($(if ($DryRun) { 'DRY-RUN' } else { 'APPLY' }) / $(if ($StagingOnly) { 'STAGING-ONLY' } else { 'PRODUCTION-SCOPE' })) =="
if (-not $StagingOnly) { throw "This pilot script runs StagingOnly. Production-scope provisioning is a separate, later, authorized stage." }
if (-not $DryRun -and -not (Test-ElvElevation)) { throw "Apply mode requires an elevated PowerShell." }

# Guard the roots BEFORE any action.
[void](Assert-StagingPath $report $script:ElvStagingRoot $StagingOnly)
[void](Assert-StagingPath $report $script:ElvBrokerRoot  $StagingOnly)

# Reject ambiguous/unexpected identities (owner requirement #4).
$owner = Get-ElvOwnerContext
if ($owner.Sid -notmatch '^S-1-5-21-') { throw "Owner SID $($owner.Sid) is not a local account SID; refusing." }
$existingSid = Resolve-ElvLocalSid $script:ElvWorkerAccount
if ($existingSid) { Add-ElvChange $report 'noop' $script:ElvWorkerAccount "account already exists ($existingSid); no change" $false }

if ($DryRun) {
    Add-ElvChange $report 'create-localuser' $script:ElvWorkerAccount 'standard user, random password, PasswordNeverExpires, Users group only' $false
    Add-ElvChange $report 'mkdir' $script:ElvStagingRoot 'create staging root' $false
    Add-ElvChange $report 'secure-broker-root' $script:ElvBrokerRoot 'owner USER SID + SYSTEM Full, inheritance reset, BEFORE writing credential' $false
    Add-ElvChange $report 'record-password' "$script:ElvBrokerRoot\worker-cred.xml" 'DPAPI credential (owner identity); not written in dry-run' $false
}
elseif (-not $existingSid) {
    Add-Type -AssemblyName System.Web
    $pw = [System.Web.Security.Membership]::GeneratePassword(32, 8)
    $sec = ConvertTo-SecureString $pw -AsPlainText -Force
    New-LocalUser -Name $script:ElvWorkerAccount -Password $sec -FullName 'ELEVARIQ Staging Worker' `
        -Description 'Low-privilege ELEVARIQ STAGING worker (pilot)' -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
    Add-LocalGroupMember -Group 'Users' -Member $script:ElvWorkerAccount
    New-Item -ItemType Directory -Force $script:ElvStagingRoot | Out-Null
    New-Item -ItemType Directory -Force $script:ElvBrokerRoot | Out-Null
    # Lock the broker root to owner+SYSTEM BEFORE writing the credential (preflight D7). /grant:r is idempotent.
    & icacls $script:ElvBrokerRoot /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" /grant:r "*$($owner.Sid):(OI)(CI)F" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to secure broker root before writing credential (icacls exit $LASTEXITCODE)." }
    [pscustomobject]@{ user = $script:ElvWorkerAccount; password = $pw } |
        Export-Clixml (Join-Path $script:ElvBrokerRoot 'worker-cred.xml')
    Remove-Variable pw, sec
    $newSid = Resolve-ElvLocalSid $script:ElvWorkerAccount -MustExist $true
    Add-ElvChange $report 'create-localuser' $script:ElvWorkerAccount "created standard user ($newSid)" $true
    Add-ElvChange $report 'secure-broker-root' $script:ElvBrokerRoot 'owner+SYSTEM Full, inheritance reset' $true
    Add-ElvChange $report 'record-password' "$script:ElvBrokerRoot\worker-cred.xml" 'DPAPI credential written (owner identity)' $true
}

# Report the privileges the ACL/rights stage will confirm the worker does NOT hold (a standard user lacks these).
foreach ($p in 'SeDebugPrivilege','SeImpersonatePrivilege','SeAssignPrimaryTokenPrivilege','SeBackupPrivilege',
    'SeRestorePrivilege','SeTakeOwnershipPrivilege','SeLoadDriverPrivilege','SeCreateServicePrivilege') {
    Add-ElvChange $report 'expect-absent-privilege' $script:ElvWorkerAccount $p $false
}
Save-ElvReport $report
