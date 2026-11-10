<#
.SYNOPSIS
  Full rollback of r3 (R-8), in reverse order. Idempotent; each step skips what is already gone.
.DESCRIPTION
  1. Emergency stop: disable both identities; stop their processes; RE-QUERY and throw if any process remains (M7).
  2. Tasks: the three known tasks PLUS every task whose principal is a staging identity (M7). Never the production task.
  3. User rights: remove both identities (SID and name forms; SIDs also from state\identities.json so deleted accounts
     still match, M8) from the five rights; re-export and verify (L3).
  4. Staging volume: archive broker\state with robocopy /XJ (M10: never follows junctions), remove the mount point
     (trailing backslash, L10), detach with -ErrorAction Stop (L11), delete the VHDX and the staging folders (guarded;
     reparse-point components refused).
  5. Identities: leave the deny group, delete the accounts and their profiles (only these two SIDs).
  6. Firewall: every rule under both prefixes, AFTER the identities are gone (M7 ordering).
  7. ONLY with -IncludeProductionDeny (separately authorized): remove the group's DENY ACEs from every target recorded
     in state\deny-targets.json (M8; -AdditionalDenyPaths is only a fallback), compare each root SDDL with the
     baseline-root.sddl from 00 (M2), delete the group. Runs AFTER step 5, so no isolated identity can regain access.
#>
[CmdletBinding()]
param([switch]$Apply, [switch]$IncludeProductionDeny, [string[]]$AdditionalDenyPaths = @(), [string]$ApprovedManifestHash = '')
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun '09-rollback' $DryRun -ApprovedManifestHash $ApprovedManifestHash
trap { Save-ElvReport $report $_; break }
$owner = Get-ElvOwnerContext
$stateDry = -not (Test-ElvElevation)
$idState = Read-ElvState $stateDry 'identities'; $applied = Read-ElvState $stateDry 'deny-targets'
$ids = @(@{ N = $script:ElvWorkerAccount; S = (Resolve-ElvLocalSid $script:ElvWorkerAccount) }, @{ N = $script:ElvBrokerAccount; S = (Resolve-ElvLocalSid $script:ElvBrokerAccount) })
if ($idState) {   # M8: SIDs of already-deleted accounts still need their rights/ACEs removed
    foreach ($i in $ids) { if (-not $i.S) { $rec = $idState.($(if ($i.N -eq $script:ElvWorkerAccount) { 'worker' } else { 'broker' })); if ($rec -and $rec.sid) { $i.S = [string]$rec.sid; $i.Deleted = $true } } }
}
$gsid = Resolve-ElvGroupSid
function Step { param([string]$Action, [string]$Target, [string]$Detail, [scriptblock]$Do)
    if ($DryRun) { Add-ElvChange $report $Action $Target $Detail $false; return }
    & $Do; Add-ElvChange $report $Action $Target $Detail $true
}
function Get-ElvIdentityProcesses { @(Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $u = $_.UserName; $ids | Where-Object { $u -like "*\$($_.N)" } }) }

# 1. emergency stop
foreach ($i in $ids | Where-Object { $_.S -and -not $_.Deleted }) {
    $n = $i.N
    Step 'disable-localuser' $n 'no new logons' { Disable-LocalUser -Name $n }
}
Step 'stop-process' 'staging identities' 'all processes owned by the identities; re-queried afterwards (M7)' {
    Get-ElvIdentityProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $left = Get-ElvIdentityProcesses
    if ($left.Count) { throw "Processes still running for staging identities: $(($left | ForEach-Object { "$($_.ProcessName):$($_.Id)" }) -join ',')" }
}
# 2. tasks (known names + any task whose principal is a staging identity)
$taskNames = @($script:ElvWorkerTask, $script:ElvBrokerTask, $script:ElvDiskTask)
$byPrincipal = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $p = [string]$_.Principal.UserId; $ids | Where-Object { $p -match ('(^|\\)' + [regex]::Escape($_.N) + '$') -or ($_.S -and $p -eq $_.S) } })
foreach ($t in $taskNames + @($byPrincipal | ForEach-Object { $_.TaskName }) | Sort-Object -Unique) {
    if ($t -eq $script:ProductionTask) { throw 'Refusing: staging task name equals production.' }
    $tt = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if ($tt) { if ($tt.Principal.UserId -match 'Roman|S-1-5-21-.*-1001$' -and $taskNames -notcontains $t) { throw "Refusing: task $t runs as the owner." }; Step 'unregister-scheduledtask' $t "remove (principal $($tt.Principal.UserId))" { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction Stop } }
    else { Add-ElvChange $report 'noop' $t 'absent' $false }
}
Add-ElvCheck $report 'M7' 'no scheduled task left with a staging-identity principal' (@(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $p = [string]$_.Principal.UserId; $ids | Where-Object { $p -match ('(^|\\)' + [regex]::Escape($_.N) + '$') } }).Count -eq 0 -or $DryRun)
# 3. user rights (needs elevation even to read; dry-run lists intent only)
$rightNames = 'SeBatchLogonRight', 'SeDenyNetworkLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyInteractiveLogonRight'
if ($DryRun) { Add-ElvChange $report 'secedit' 'USER_RIGHTS' "remove staging identities (SIDs: $(($ids | ForEach-Object { $_.S }) -join ',')) from $($rightNames -join ', '); re-export + verify" $false }
else {
    $cur = Get-ElvCurrentRights; $remove = @{}
    foreach ($rn in $rightNames) {
        if (-not $cur.ContainsKey($rn)) { continue }
        $hits = @($cur[$rn] | Where-Object { $e = $_; $ids | Where-Object { $_.S -and ($e -eq "*$($_.S)" -or $e -ieq $_.N -or $e -ieq "$env:COMPUTERNAME\$($_.N)") } })
        if ($hits.Count) { $remove[$rn] = $hits }
    }
    if ($remove.Count) { Invoke-ElvRightsChange -Report $report -DryRun $false -Label '09-rollback' -Remove $remove }
    else { Add-ElvChange $report 'noop' 'USER_RIGHTS' 'no staging entries present' $false }
    $after = Get-ElvCurrentRights
    $leftover = @(); foreach ($rn in $rightNames) { if ($after.ContainsKey($rn)) { foreach ($e in $after[$rn]) { foreach ($i in $ids) { if ($i.S -and $e -eq "*$($i.S)") { $leftover += "$rn=$e" } } } } }
    Add-ElvCheck $report 'RB0' 'no staging SID remains in any touched user right (L3/M8)' ($leftover.Count -eq 0) ($leftover -join ',')
}
# 4. staging volume
$state = Join-Path $script:ElvStagingRoot 'broker\state'
if (Test-Path -LiteralPath $state) {
    $arch = Join-Path $owner.AdminDir ('archive\broker-state-{0}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Step 'archive' $state "robocopy /E /XJ to $arch (audit chain kept; junctions NOT followed, M10)" {
        New-Item -ItemType Directory -Force $arch | Out-Null
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { $o = @(& robocopy.exe $state $arch /E /XJ /COPY:DAT /R:0 /W:0 /NP /NFL /NDL 2>&1 | ForEach-Object { [string]$_ }); $code = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
        if ($code -ge 8) { throw "robocopy archive failed (exit $code): $(($o | Select-Object -Last 5) -join ' | ')" }
    }
}
[void](Assert-StagingPath $report $script:ElvStagingRoot); [void](Assert-StagingPath $report $script:ElvVhdxPath)
if (Get-Partition -ErrorAction SilentlyContinue | Where-Object { $_.AccessPaths -contains "$($script:ElvStagingRoot)\" }) {
    Step 'mountvol' $script:ElvStagingRoot 'remove mount point' {
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { $o = @(& mountvol.exe "$($script:ElvStagingRoot)\" /D 2>&1 | ForEach-Object { [string]$_ }); $code = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
        if ($code) { throw "mountvol /D failed ($code): $($o -join ' ')" }
    }
}
if (Test-Path -LiteralPath $script:ElvVhdxPath) {
    Step 'dismount-diskimage' $script:ElvVhdxPath 'detach (errors are fatal, L11)' { Dismount-DiskImage -ImagePath $script:ElvVhdxPath -ErrorAction Stop | Out-Null }
    Step 'remove-item' $script:ElvVhdxPath 'delete VHDX' { Remove-Item -LiteralPath $script:ElvVhdxPath -Force }
}
foreach ($d in $script:ElvStagingRoot, $script:ElvDiskDir) {
    if (Test-Path -LiteralPath $d) {
        $dd = $d
        $rps = @(Get-ElvReparsePointsUnder @($dd))
        Step 'remove-item' $d "delete staging folder (reparse points inside are unlinked first: $($rps.Count))" {
            foreach ($rp in $rps) { & cmd.exe /c rmdir "$rp" 2>&1 | Out-Null }   # rmdir removes the link, never the target
            Remove-Item -LiteralPath $dd -Recurse -Force
        }
    }
}
# 5. identities
foreach ($i in $ids | Where-Object { $_.S -and -not $_.Deleted }) {
    $n = $i.N; $s = $i.S
    if ($gsid) { Step 'remove-localgroupmember' "$($script:ElvGroup)/$n" 'leave deny group' { Remove-LocalGroupMember -Group $script:ElvGroup -Member $n -ErrorAction SilentlyContinue } }
    Step 'remove-localuser' $n "delete ($s)" { Remove-LocalUser -SID $s }
    Step 'remove-profile' $n 'delete profile of this SID only' { Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $s } | Remove-CimInstance }
}
# 6. firewall (after the identities are gone, M7)
foreach ($r in @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "$($script:ElvFirewallPrefix)-*" -or $_.DisplayName -like "$($script:ElvHostRulePrefix)-*" })) {
    $rr = $r; Step 'remove-netfirewallrule' $r.DisplayName 'remove' { $rr | Remove-NetFirewallRule -ErrorAction Stop }
}
# 7. production DENY (opt-in)
if ($IncludeProductionDeny -and $gsid) {
    if (-not $DryRun -and @(Get-ElvGroupMemberSids $script:ElvGroup).Count) { throw 'Refusing: deny group still has members.' }
    $targets = @()
    if ($applied) { $targets = @($applied.targets) ; Add-ElvChange $report 'note' 'targets' "from state\deny-targets.json (ref $($applied.ref))" $false }
    else { $targets = @($script:ElvDenyRoots + $script:ElvDenyFolders + $AdditionalDenyPaths); Add-ElvChange $report 'note' 'targets' 'NO deny-targets.json: using built-in list + -AdditionalDenyPaths (fallback)' $false }
    foreach ($t in @($targets | Where-Object { Test-Path -LiteralPath $_ })) {
        [void](Assert-DenyTarget $report $t ($AdditionalDenyPaths + @($applied.additional)))
        Invoke-ElvIcacls @($t, '/remove:d', "*$gsid") $DryRun $report $t 'remove isolation-group DENY'
        if (-not $DryRun) {
            Add-ElvCheck $report 'RB1' "no group DENY left on $t" (-not (Test-ElvDenyAce $t $gsid 'any'))
            $bk = Join-Path $owner.AdminDir ("acl\{0}\baseline-root.sddl" -f ($t.TrimEnd('\') -replace '[:\\$]', '_'))
            if (Test-Path -LiteralPath $bk) { Add-ElvCheck $report 'RB2' "root SDDL equals the pre-00 BASELINE: $t" ((Get-Acl -LiteralPath $t).Sddl -eq (Get-Content -LiteralPath $bk -Raw).Trim()) }
            else { Add-ElvCheck $report 'RB2' "baseline-root.sddl present for $t" $false $bk }
        }
    }
    Step 'remove-localgroup' $script:ElvGroup 'delete group' { Remove-LocalGroup -Name $script:ElvGroup }
} elseif ($gsid) { Add-ElvChange $report 'skip' $script:ElvGroup 'production DENY kept (pass -IncludeProductionDeny, separately authorized, to remove)' $false }
Add-ElvProductionChecks $report
Save-ElvReport $report
