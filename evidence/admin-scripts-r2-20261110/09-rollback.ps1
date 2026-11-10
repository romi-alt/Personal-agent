<#
.SYNOPSIS
  Full rollback of r2 (R-8), in reverse order. Idempotent; each step skips what is already gone.
.DESCRIPTION
  1. Emergency stop: disable both identities; stop their processes.
  2. Tasks: ElevariqStagingWorker, ElevariqStagingBroker, ElevariqStagingDiskAttach (never the production task).
  3. Firewall: every rule whose DisplayName starts with ELEVARIQ-STG-Worker- (r1 and r2 names).
  4. User rights: remove both identities (SID and name forms) from the five rights r2 touched.
  5. Staging volume: archive broker\state to <owner>\ElevariqAdmin\archive, remove mount point, detach and delete the
     VHDX, delete the staging folders (guarded).
  6. Identities: leave the deny group, delete the accounts and their profiles (only these two SIDs).
  7. ONLY with -IncludeProductionDeny (separately authorized: it changes production volume ACLs): remove the group's
     DENY ACEs (removal of an inheritable ACE propagates), compare each root SDDL with the 00 backup, delete the group.
     Runs AFTER step 6, so no isolated identity can regain access in between.
#>
[CmdletBinding()]
param([switch]$Apply, [switch]$IncludeProductionDeny, [string[]]$AdditionalDenyPaths = @())
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun '09-rollback' $DryRun
$owner = Get-ElvOwnerContext
$ids = @(@{ N = $script:ElvWorkerAccount; S = (Resolve-ElvLocalSid $script:ElvWorkerAccount) }, @{ N = $script:ElvBrokerAccount; S = (Resolve-ElvLocalSid $script:ElvBrokerAccount) })
$gsid = Resolve-ElvGroupSid
function Step { param([string]$Action, [string]$Target, [string]$Detail, [scriptblock]$Do)
    if ($DryRun) { Add-ElvChange $report $Action $Target $Detail $false; return }
    & $Do; Add-ElvChange $report $Action $Target $Detail $true
}

# 1. emergency stop
foreach ($i in $ids | Where-Object { $_.S }) {
    $n = $i.N
    Step 'disable-localuser' $n 'no new logons' { Disable-LocalUser -Name $n }
    Step 'stop-process' $n 'all processes owned by this identity' { Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like "*\$n" } | Stop-Process -Force -ErrorAction SilentlyContinue }
}
# 2. tasks
foreach ($t in $script:ElvWorkerTask, $script:ElvBrokerTask, $script:ElvDiskTask) {
    if ($t -eq $script:ProductionTask) { throw 'Refusing: staging task name equals production.' }
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Step 'unregister-scheduledtask' $t 'remove' { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction Stop } }
    else { Add-ElvChange $report 'noop' $t 'absent' $false }
}
# 3. firewall
foreach ($r in @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "$($script:ElvFirewallPrefix)-*" })) {
    $rr = $r; Step 'remove-netfirewallrule' $r.DisplayName 'remove' { $rr | Remove-NetFirewallRule -ErrorAction Stop }
}
# 4. user rights (needs elevation even to read; dry-run lists intent only)
$rightNames = 'SeBatchLogonRight', 'SeDenyNetworkLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyInteractiveLogonRight'
if ($DryRun) { Add-ElvChange $report 'secedit' 'USER_RIGHTS' "remove staging identities from $($rightNames -join ', ')" $false }
else {
    $cur = Get-ElvCurrentRights; $remove = @{}
    foreach ($rn in $rightNames) {
        if (-not $cur.ContainsKey($rn)) { continue }
        $hits = @($cur[$rn] | Where-Object { $e = $_; $ids | Where-Object { $_.S -and ($e -eq "*$($_.S)" -or $e -ieq $_.N -or $e -ieq "$env:COMPUTERNAME\$($_.N)") } })
        if ($hits.Count) { $remove[$rn] = $hits }
    }
    if ($remove.Count) { Invoke-ElvRightsChange -Report $report -DryRun $false -Label '09-rollback' -Remove $remove }
    else { Add-ElvChange $report 'noop' 'USER_RIGHTS' 'no staging entries present' $false }
}
# 5. staging volume
$state = Join-Path $script:ElvStagingRoot 'broker\state'
if (Test-Path -LiteralPath $state) {
    $arch = Join-Path $owner.AdminDir ('archive\broker-state-{0}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Step 'archive' $state "copy to $arch (audit chain kept)" { New-Item -ItemType Directory -Force $arch | Out-Null; Copy-Item -LiteralPath $state -Destination $arch -Recurse -Force }
}
[void](Assert-StagingPath $report $script:ElvStagingRoot); [void](Assert-StagingPath $report $script:ElvVhdxPath)
if (Get-Partition -ErrorAction SilentlyContinue | Where-Object { $_.AccessPaths -contains "$($script:ElvStagingRoot)\" }) {
    Step 'mountvol' $script:ElvStagingRoot 'remove mount point' { & mountvol.exe $script:ElvStagingRoot /D; if ($LASTEXITCODE) { throw 'mountvol /D failed' } }
}
if (Test-Path -LiteralPath $script:ElvVhdxPath) {
    Step 'dismount-diskimage' $script:ElvVhdxPath 'detach' { Dismount-DiskImage -ImagePath $script:ElvVhdxPath -ErrorAction SilentlyContinue | Out-Null }
    Step 'remove-item' $script:ElvVhdxPath 'delete VHDX' { Remove-Item -LiteralPath $script:ElvVhdxPath -Force }
}
foreach ($d in $script:ElvStagingRoot, $script:ElvDiskDir) {
    if (Test-Path -LiteralPath $d) { $dd = $d; Step 'remove-item' $d 'delete staging folder' { Remove-Item -LiteralPath $dd -Recurse -Force } }
}
# 6. identities
foreach ($i in $ids | Where-Object { $_.S }) {
    $n = $i.N; $s = $i.S
    if ($gsid) { Step 'remove-localgroupmember' "$($script:ElvGroup)/$n" 'leave deny group' { Remove-LocalGroupMember -Group $script:ElvGroup -Member $n -ErrorAction SilentlyContinue } }
    Step 'remove-localuser' $n "delete ($s)" { Remove-LocalUser -SID $s }
    Step 'remove-profile' $n 'delete profile of this SID only' { Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $s } | Remove-CimInstance }
}
# 7. production DENY (opt-in)
if ($IncludeProductionDeny -and $gsid) {
    if (-not $DryRun -and @(Get-LocalGroupMember -Group $script:ElvGroup -ErrorAction SilentlyContinue).Count) { throw 'Refusing: deny group still has members.' }
    $targets = @($script:ElvDenyRoots + $script:ElvDenyFolders + $AdditionalDenyPaths | Where-Object { Test-Path -LiteralPath $_ })
    foreach ($t in $targets) {
        [void](Assert-DenyTarget $report $t $AdditionalDenyPaths)
        Invoke-ElvIcacls @($t, '/remove:d', "*$gsid") $DryRun $report $t 'remove isolation-group DENY'
        if (-not $DryRun) {
            Add-ElvCheck $report 'RB1' "no group DENY left on $t" (-not (Test-ElvDenyAce $t $gsid 'any'))
            $bk = Join-Path $owner.AdminDir ("acl\{0}-root.sddl" -f ($t.TrimEnd('\') -replace '[:\\]', '_'))
            if (Test-Path -LiteralPath $bk) { Add-ElvCheck $report 'RB2' "root SDDL equals pre-00 backup: $t" ((Get-Acl -LiteralPath $t).Sddl -eq (Get-Content -LiteralPath $bk -Raw).Trim()) }
        }
    }
    Step 'remove-localgroup' $script:ElvGroup 'delete group' { Remove-LocalGroup -Name $script:ElvGroup }
} elseif ($gsid) { Add-ElvChange $report 'skip' $script:ElvGroup 'production DENY kept (pass -IncludeProductionDeny, separately authorized, to remove)' $false }
Add-ElvProductionChecks $report
Save-ElvReport $report
