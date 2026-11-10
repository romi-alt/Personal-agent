<#
.SYNOPSIS
  A9: install a hash-verified broker release into broker\bin and register ElevariqStagingBroker as elv-stg-broker.
.DESCRIPTION
  r2 change (R-6): the broker runs as its OWN identity, not as the owner (r1/D6) and never as the worker.
    - Release verification: <ReleaseDir>\SHA256SUMS must list EVERY file (relative path) with a matching hash, no
      unlisted files, and the release folder itself must not be writable by any broad group (no swap after check).
    - Copy into C:\ElevariqStaging\broker\bin (Administrators-only write; broker RX; worker DENY), re-verify there.
    - Broker password: typed by the owner now, used to set the account password and register the task (Password
      logon so the broker's own DPAPI CurrentUser key works). Never written anywhere by this script.
    - Task: powershell -File broker\bin\<EntryScript>, principal elv-stg-broker, Limited. NOT started here.
  CURRENT STATUS: the repo has the broker LIBRARY (src/security/broker) but NO service entrypoint, spool transport or
  DPAPI key wrapper yet. Until a reviewed release exists, -Apply stops at release verification by design.
.PARAMETER ReleaseDir   Folder holding the reviewed broker release + SHA256SUMS (required for -Apply).
.PARAMETER EntryScript  Entry script inside the release. Default run-broker.ps1.
#>
[CmdletBinding()]
param([switch]$Apply, [string]$ReleaseDir, [string]$EntryScript = 'run-broker.ps1')
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun '04-broker-install' $DryRun
$bin = Join-Path $script:ElvStagingRoot 'broker\bin'
[void](Assert-StagingPath $report $bin)
$bsid = Resolve-ElvLocalSid $script:ElvBrokerAccount
if ($script:ElvBrokerTask -eq $script:ProductionTask) { throw 'Refusing: broker task name collides with production.' }

$pre = $bsid -and (Test-Path -LiteralPath $bin) -and (Test-ElvDenyAce $bin (Resolve-ElvLocalSid $script:ElvWorkerAccount) 'any')
Add-ElvCheck $report 'PRE' '03 applied (broker\bin exists, worker DENY present)' ([bool]$pre)
if (-not $pre -and -not $DryRun) { throw 'Prerequisite failed: apply 03 first.' }

function Test-ElvRelease {
    param([string]$Dir)
    $sums = Join-Path $Dir 'SHA256SUMS'
    if (-not (Test-Path -LiteralPath $sums)) { return 'SHA256SUMS missing' }
    $exp = @{}
    foreach ($l in Get-Content -LiteralPath $sums) { if ($l -match '^([0-9a-f]{64})\s+(.+)$') { $exp[$Matches[2].Trim().Replace('/', '\')] = $Matches[1] } }
    $root = (Get-ElvCanonicalPath $Dir).TrimEnd('\')
    $actual = @(Get-ChildItem -LiteralPath $Dir -Recurse -File -Force | Where-Object { $_.Name -ne 'SHA256SUMS' })
    foreach ($f in $actual) {
        $rel = $f.FullName.Substring($root.Length + 1)
        if (-not $exp.ContainsKey($rel)) { return "unlisted file $rel" }
        if ((Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower() -ne $exp[$rel]) { return "hash mismatch $rel" }
    }
    if ($actual.Count -ne $exp.Count) { return "listed $($exp.Count) files, found $($actual.Count)" }
    if (-not $exp.ContainsKey($EntryScript)) { return "entry script $EntryScript not in release" }
    return $null
}

if ($DryRun) {
    Add-ElvChange $report 'verify-release' "$ReleaseDir" 'SHA256SUMS complete + matching; release dir not broad-writable' $false
    Add-ElvChange $report 'copy' $bin 'replace broker\bin contents with the verified release; re-verify at destination' $false
    Add-ElvChange $report 'set-password+enable' $script:ElvBrokerAccount 'owner types the broker password (not stored)' $false
    Add-ElvChange $report 'register-scheduledtask' $script:ElvBrokerTask "principal=$($script:ElvBrokerAccount) Password logon, Limited; action=powershell -File $bin\$EntryScript; not started" $false
} else {
    if (-not $ReleaseDir) { throw '-ReleaseDir is required for -Apply.' }
    if ((Get-ElvBroadWriteMask $ReleaseDir) -ne 0) { Add-ElvRefusal $report 'release folder is writable by a broad group' $ReleaseDir; throw 'Refusing: move the release to an owner-only folder first.' }
    $err = Test-ElvRelease $ReleaseDir
    if ($err) { Add-ElvRefusal $report "release verification failed: $err" $ReleaseDir; throw "Release verification failed: $err" }
    Add-ElvCheck $report 'R1' 'source release verified' $true

    Get-ChildItem -LiteralPath $bin -Force | ForEach-Object { [void](Assert-StagingPath $report $_.FullName); Remove-Item -LiteralPath $_.FullName -Recurse -Force }
    Get-ChildItem -LiteralPath $ReleaseDir -Force | Copy-Item -Destination $bin -Recurse -Force
    $err = Test-ElvRelease $bin
    if ($err) { Add-ElvRefusal $report "destination verification failed: $err" $bin; throw "Destination verification failed: $err" }
    Add-ElvChange $report 'copy' $bin 'release installed and re-verified' $true
    Add-ElvCheck $report 'R2' 'no broad/broker write on broker\bin' (((Get-ElvBroadWriteMask $bin) -eq 0) -and (((Get-ElvEffectiveMask $bin @($bsid)) -band 0xD0156) -eq 0))

    $p1 = Read-Host -AsSecureString "Set password for $($script:ElvBrokerAccount)"
    $p2 = Read-Host -AsSecureString 'Repeat'
    $bs1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1); $bs2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bs1); $plain2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bs2)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bs1); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bs2)
    try {
        if ($plain -ne $plain2 -or $plain.Length -lt 16) { throw 'Passwords differ or shorter than 16 characters.' }
        Set-LocalUser -Name $script:ElvBrokerAccount -Password $p1
        Enable-LocalUser -Name $script:ElvBrokerAccount
        $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$bin\$EntryScript`"" -WorkingDirectory $bin
        $s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        $t = New-ScheduledTaskTrigger -AtStartup
        Register-ScheduledTask -TaskName $script:ElvBrokerTask -Action $a -Trigger $t -Settings $s -User $script:ElvBrokerAccount -Password $plain -RunLevel Limited -ErrorAction Stop | Out-Null
    } finally { $plain = $null; $plain2 = $null; [GC]::Collect() }
    $task = Get-ScheduledTask -TaskName $script:ElvBrokerTask
    Add-ElvCheck $report 'R3' 'broker task principal is elv-stg-broker, Limited' (($task.Principal.UserId -match "$($script:ElvBrokerAccount)$") -and $task.Principal.RunLevel -eq 'Limited')
    Add-ElvChange $report 'register-scheduledtask' $script:ElvBrokerTask 'registered (not started)' $true
}
Add-ElvProductionChecks $report
Save-ElvReport $report
