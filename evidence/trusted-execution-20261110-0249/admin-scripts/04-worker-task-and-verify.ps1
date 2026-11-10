<#
.SYNOPSIS
  Register the worker scheduled task under the worker identity, and VERIFY the isolation. DESIGN ARTIFACT.
.DESCRIPTION
  - Registers a scheduled task 'ElevariqWorker' that runs the worker launcher as 'elevariq-worker' (NOT the owner),
    with a distinct USERPROFILE/APPDATA/TEMP set to the worker tree. It does NOT replace the production supervisor
    task 'ElevariqPersonalAgent'; the supervisor/broker stays under the owner/SYSTEM identity.
  - VERIFY mode runs read-only checks of the resulting boundary (account is standard, broker root denies the worker,
    owner secrets deny the worker, firewall rules exist) and writes a pass/fail matrix.
.PARAMETER Mode     'register' | 'verify' | 'rollback'
.PARAMETER DryRun   Default $true.
.PARAMETER Apply    Perform changes. Requires elevation.
.NOTES
  The emergency stop is a separate always-available control: Stop-ScheduledTask + Stop-Process of the worker tree's
  node processes by owner, which the worker cannot prevent (owner > worker).
#>
[CmdletBinding()]
param([ValidateSet('register','verify','rollback')][string]$Mode = 'verify', [bool]$DryRun = $true, [switch]$Apply)
. (Join-Path $PSScriptRoot '_common.ps1')
$report = New-ElvReport "04-worker-task-$Mode"
if ($Apply) { $DryRun = $false }
$report.dryRun = $DryRun; $report.stagingOnly = $true
Write-Host "== 04 Staging worker task [$Mode] ($(if ($DryRun) { 'DRY-RUN' } else { 'APPLY' })) =="

$taskName = $script:ElvWorkerTask   # ElevariqStagingWorker (NEVER the production task)
if ($taskName -eq $script:ProductionTask) { throw "Refusing: staging task name collides with the production task." }

if ($Mode -eq 'register') {
    if (-not $DryRun -and -not (Test-ElvElevation)) { throw "Apply requires elevation." }
    $launcher = Join-Path $script:ElvWorkRoot 'run-worker.ps1'
    if ($DryRun) {
        Add-ElvChange $report 'register-scheduledtask' $taskName "principal=$script:ElvWorkerAccount (standard); action=powershell -File $launcher; env USERPROFILE/APPDATA/TEMP under $script:ElvWorkRoot" $false
        Add-ElvChange $report 'note' $taskName 'does NOT alter production task ElevariqPersonalAgent' $false
    } else {
        $cred = Import-Clixml (Join-Path $script:ElvBrokerRoot 'worker-cred.xml')
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -File `"$launcher`""
        $principal = New-ScheduledTaskPrincipal -UserId $script:ElvWorkerAccount -LogonType Password -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings `
            -User $script:ElvWorkerAccount -Password $cred.password | Out-Null
        Add-ElvChange $report 'register-scheduledtask' $taskName 'registered under worker identity' $true
    }
}
elseif ($Mode -eq 'rollback') {
    if ($DryRun) {
        Add-ElvChange $report 'unregister-scheduledtask' $taskName 'remove worker task' $false
        Add-ElvChange $report 'note' 'accounts/ACLs' 'rollback of account + ACLs handled by 05-rollback.ps1' $false
    } else {
        if (-not (Test-ElvElevation)) { throw "Apply requires elevation." }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Add-ElvChange $report 'unregister-scheduledtask' $taskName 'removed' $true
    }
}
else { # verify (read-only regardless of Apply)
    $checks = [ordered]@{}
    $wu = Get-LocalUser -Name $script:ElvWorkerAccount -ErrorAction SilentlyContinue
    $checks['G1 worker account exists']   = [bool]$wu
    $admins = (Get-LocalGroupMember Administrators -ErrorAction SilentlyContinue).Name
    $checks['G2 worker NOT an administrator'] = -not ($admins -contains "$env:COMPUTERNAME\$script:ElvWorkerAccount")
    $checks['G3 broker root denies worker']  = if (Test-Path $script:ElvBrokerRoot) { ((icacls $script:ElvBrokerRoot 2>$null) -join "`n") -match "$script:ElvWorkerAccount.*\(DENY\)|$script:ElvWorkerAccount:\(N\)" } else { $false }
    $checks['G4 decoy credential denies worker'] = if (Test-Path "$script:ElvDecoyRoot\fake-claude") { ((icacls "$script:ElvDecoyRoot\fake-claude" 2>$null) -join "`n") -match "$script:ElvWorkerAccount.*\(DENY\)|$script:ElvWorkerAccount:\(N\)" } else { 'n/a (not created)' }
    $checks['G9 staging egress block rule']  = [bool](Get-NetFirewallRule -DisplayName "$script:ElvFirewallPrefix-Block-Other" -ErrorAction SilentlyContinue)
    $checks['P0 production task untouched']   = ((Get-ScheduledTask -TaskName $script:ProductionTask -ErrorAction SilentlyContinue).State -eq 'Running')
    $checks['P1 production supervisor alive'] = [bool](Get-Process -Id $script:ProductionPid -ErrorAction SilentlyContinue)
    foreach ($k in $checks.Keys) {
        $v = $checks[$k]
        Add-ElvChange $report 'verify' $k ("result=$v") $false
    }
    $report | Add-Member -NotePropertyName verifyResults -NotePropertyValue $checks
}

Save-ElvReport $report
