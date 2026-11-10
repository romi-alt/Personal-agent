<#
.SYNOPSIS
  Full rollback of the STAGING worker-isolation pilot. DESIGN ARTIFACT - review before running.
.DESCRIPTION
  Removes ONLY objects the pilot created, all under C:\ElevariqStaging plus the staging account/task/firewall rules:
    - Unregister the ElevariqStagingWorker scheduled task.
    - Remove the ELEVARIQ-STG-Worker-* firewall rules.
    - Remove the C:\ElevariqStaging tree (work, broker, home, decoys) after Assert-StagingPath.
    - Remove the elv-stg-worker local account.
  It NEVER restores or removes a production/owner ACL, because the pilot never created one. It never touches the
  production checkout, task, DB, env, supervisor or PID. There are no pre-existing ACLs to restore.
.PARAMETER DryRun       Default $true.
.PARAMETER Apply        Perform changes. Requires elevation.
.PARAMETER StagingOnly  Default $true.
#>
[CmdletBinding()]
param([bool]$DryRun = $true, [switch]$Apply, [bool]$StagingOnly = $true)
. (Join-Path $PSScriptRoot '_common.ps1')
$report = New-ElvReport '05-rollback'
if ($Apply) { $DryRun = $false }
$report.dryRun = $DryRun; $report.stagingOnly = $StagingOnly
Write-Host "== 05 Staging rollback ($(if ($DryRun) { 'DRY-RUN' } else { 'APPLY' }) / $(if ($StagingOnly) { 'STAGING-ONLY' } else { 'PRODUCTION-SCOPE' })) =="
if (-not $StagingOnly) { throw "This pilot rollback runs StagingOnly." }
if (-not $DryRun -and -not (Test-ElvElevation)) { throw "Apply requires elevation." }

$sid = Resolve-ElvLocalSid $script:ElvWorkerAccount
$principal = if ($sid) { "*$sid" } else { $script:ElvWorkerAccount }

# 1. Scheduled task (staging only; guarded against the production name).
if ($script:ElvWorkerTask -eq $script:ProductionTask) { throw "Refusing: staging task name equals production task." }
if ($DryRun) { Add-ElvChange $report 'unregister-scheduledtask' $script:ElvWorkerTask 'remove' $false }
else { Unregister-ScheduledTask -TaskName $script:ElvWorkerTask -Confirm:$false -ErrorAction SilentlyContinue; Add-ElvChange $report 'unregister-scheduledtask' $script:ElvWorkerTask 'removed' $true }

# 2. Firewall rules (staging prefix only).
foreach ($n in "$script:ElvFirewallPrefix-Allow-Anthropic","$script:ElvFirewallPrefix-Allow-Proxy","$script:ElvFirewallPrefix-Block-Other") {
    if ($DryRun) { Add-ElvChange $report 'remove-netfirewallrule' $n 'remove' $false }
    else { Remove-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue; Add-ElvChange $report 'remove-netfirewallrule' $n 'removed' $true }
}

# 3. The staging tree (one guarded recursive delete; everything we created lives here).
[void](Assert-StagingPath $report $script:ElvStagingRoot $StagingOnly)
if (Test-Path $script:ElvStagingRoot) {
    if ($DryRun) { Add-ElvChange $report 'remove-item' $script:ElvStagingRoot 'recursive delete of the staging tree (work/broker/home/decoys)' $false }
    else { Remove-Item -Recurse -Force $script:ElvStagingRoot; Add-ElvChange $report 'remove-item' $script:ElvStagingRoot 'deleted' $true }
} else { Add-ElvChange $report 'noop' $script:ElvStagingRoot 'staging tree absent' $false }

# 4. Account last.
if ($sid) {
    if ($DryRun) { Add-ElvChange $report 'remove-localuser' $script:ElvWorkerAccount "remove account ($sid)" $false }
    else { Remove-LocalUser -Name $script:ElvWorkerAccount; Add-ElvChange $report 'remove-localuser' $script:ElvWorkerAccount 'removed' $true }
} else { Add-ElvChange $report 'noop' $script:ElvWorkerAccount 'account not present' $false }

# 5. Confirm production untouched (read-only assertion).
Add-ElvChange $report 'verify-prod' $script:ProductionTask "state=$((Get-ScheduledTask -TaskName $script:ProductionTask -ErrorAction SilentlyContinue).State); pid8992Alive=$([bool](Get-Process -Id $script:ProductionPid -ErrorAction SilentlyContinue))" $false
Save-ElvReport $report
