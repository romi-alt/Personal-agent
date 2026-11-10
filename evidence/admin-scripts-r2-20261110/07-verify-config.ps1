<#
.SYNOPSIS
  Read-only CONFIGURATION verification of every stage. THESE ARE NOT ACCESS TESTS.
.DESCRIPTION
  Evaluates parsed ACEs by SID, group memberships, user rights, tasks and firewall rules. It replaces r1's 04 -Mode
  verify, whose G3/G4 regex "$script:X:\(N\)" expanded to "\(N\)" in PS 5.1 (matching ANY principal) and which read
  icacls text. A PASS here means "configured as designed"; it does NOT mean Windows denies the worker. Only the
  real-account probes in ADVERSARIAL_ACCEPTANCE_MATRIX.md can show that.
  Changes nothing. Run elevated for the user-rights section (secedit export needs it); otherwise those checks SKIP.
.PARAMETER Stage  Highest stage expected to be applied (00..06). Later stages are reported as SKIP.
#>
[CmdletBinding()]
param([ValidateSet('00', '01', '02', '03', '04', '05', '06')][string]$Stage = '06')
. (Join-Path $PSScriptRoot '_common.ps1')
$report = New-ElvReport '07-verify-config' $true
Write-Host "== 07 configuration verification up to stage $Stage (READ-ONLY; NOT access tests) =="
$st = [int]$Stage
$elevated = Test-ElvElevation
$gsid = Resolve-ElvGroupSid; $wsid = Resolve-ElvLocalSid $script:ElvWorkerAccount; $bsid = Resolve-ElvLocalSid $script:ElvBrokerAccount

# 00 / 00a
Add-ElvCheck $report 'C00.1' "group $($script:ElvGroup) exists" ([bool]$gsid)
if ($gsid) {
    foreach ($t in @($script:ElvDenyRoots + $script:ElvDenyFolders | Where-Object { Test-Path -LiteralPath $_ })) {
        Add-ElvCheck $report 'C00.2' "explicit inheritable DENY on $t" (Test-ElvDenyAce $t $gsid 'explicit' (Get-Item -LiteralPath $t -Force).PSIsContainer)
    }
    foreach ($s in "$($script:ProductionCheckout)\scripts\windows\run-supervisor.ps1", "$($script:ProductionCheckout)\.env", "$($script:ProductionCheckout)\.git\config", 'E:\Agent\.claude', 'E:\Agent\v2-staging') {
        if (Test-Path -LiteralPath $s) { Add-ElvCheck $report 'C00.3' "DENY reaches $s" (Test-ElvDenyAce $s $gsid 'any') }
    }
    $allowed = @($wsid, $bsid | Where-Object { $_ })
    $unexpected = @(Get-LocalGroupMember -Group $script:ElvGroup -ErrorAction SilentlyContinue | Where-Object { $allowed -notcontains $_.SID.Value } | ForEach-Object { $_.Name })
    Add-ElvCheck $report 'C00.4' 'deny group has only the staging identities' ($unexpected.Count -eq 0) ($unexpected -join ',')
}
$res = 'E:\Agent\v2-staging\hardening\isotest\outside'
if (Test-Path -LiteralPath $res) { Add-ElvCheck $report 'C00.5' 'test residue Everyone:F removed (00a)' (@(Get-ElvAces $res | Where-Object { $_.Sid -eq 'S-1-1-0' -and -not $_.Inherited -and $_.Type -eq 'AccessAllowed' }).Count -eq 0) }

# 01
if ($st -ge 1) {
    $mounted = [bool](Get-Partition -ErrorAction SilentlyContinue | Where-Object { $_.AccessPaths -contains "$($script:ElvStagingRoot)\" })
    Add-ElvCheck $report 'C01.1' 'staging VHDX mounted at C:\ElevariqStaging' $mounted
    if ($mounted) { Add-ElvCheck $report 'C01.2' 'staging root: no broad-group access' ((Get-ElvEffectiveMask $script:ElvStagingRoot $script:BroadSids) -eq 0) }
    if (Test-Path -LiteralPath $script:ElvDiskDir) { Add-ElvCheck $report 'C01.3' 'VHDX folder: no broad-group access' ((Get-ElvEffectiveMask $script:ElvDiskDir $script:BroadSids) -eq 0) }
    Add-ElvCheck $report 'C01.4' 'disk attach task runs as SYSTEM' ([bool](Get-ScheduledTask -TaskName $script:ElvDiskTask -ErrorAction SilentlyContinue | Where-Object { $_.Principal.UserId -match 'SYSTEM|S-1-5-18' }))
}
# 02
if ($st -ge 2) {
    $admins = @(Get-LocalGroupMember Administrators -ErrorAction SilentlyContinue | ForEach-Object { $_.SID.Value })
    $rights = $null; if ($elevated) { $rights = Get-ElvCurrentRights }
    foreach ($id in @(@{ N = $script:ElvWorkerAccount; S = $wsid }, @{ N = $script:ElvBrokerAccount; S = $bsid })) {
        Add-ElvCheck $report 'C02.1' "$($id.N) exists" ([bool]$id.S)
        if (-not $id.S) { continue }
        Add-ElvCheck $report 'C02.2' "$($id.N) not an administrator" (-not ($admins -contains $id.S))
        Add-ElvCheck $report 'C02.3' "$($id.N) in deny group" ([bool]@(Get-LocalGroupMember -Group $script:ElvGroup -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $id.S }).Count)
        if ($rights) {
            Add-ElvCheck $report 'C02.4' "$($id.N) SeBatchLogonRight" (Test-ElvRightHeld $rights 'SeBatchLogonRight' $id.S $id.N)
            Add-ElvCheck $report 'C02.5' "$($id.N) denied network + RDP logon" ((Test-ElvRightHeld $rights 'SeDenyNetworkLogonRight' $id.S $id.N) -and (Test-ElvRightHeld $rights 'SeDenyRemoteInteractiveLogonRight' $id.S $id.N))
        } else { Add-ElvCheck $report 'C02.4' "$($id.N) user rights" 'SKIP' 'not elevated' }
    }
}
# 03
if ($st -ge 3 -and $wsid -and $bsid) { Test-ElvLayout $report $wsid $bsid $gsid }
# 04
if ($st -ge 4) {
    $bt = Get-ScheduledTask -TaskName $script:ElvBrokerTask -ErrorAction SilentlyContinue
    Add-ElvCheck $report 'C04.1' 'broker task runs as elv-stg-broker, Limited' ([bool]($bt -and $bt.Principal.UserId -match "$($script:ElvBrokerAccount)$" -and $bt.Principal.RunLevel -eq 'Limited'))
    $bin = Join-Path $script:ElvStagingRoot 'broker\bin'
    if ((Test-Path -LiteralPath $bin) -and $bsid) { Add-ElvCheck $report 'C04.2' 'broker cannot write its own code' (((Get-ElvEffectiveMask $bin (@($script:BroadSids) + @($bsid, $gsid))) -band 0xD0156) -eq 0) }
}
# 05
if ($st -ge 5) {
    foreach ($n in "$($script:ElvFirewallPrefix)-Block-IPv4", "$($script:ElvFirewallPrefix)-Block-IPv6") {
        $fw = Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue
        $scoped = $false; if ($fw -and $wsid) { $scoped = (($fw | Get-NetFirewallSecurityFilter).LocalUser -match [regex]::Escape($wsid)) }
        Add-ElvCheck $report 'C05.1' "$n present, enabled, outbound block, worker-scoped" ([bool]($fw -and $fw.Enabled -eq 'True' -and $fw.Action -eq 'Block' -and $fw.Direction -eq 'Outbound' -and $scoped))
    }
    $allows = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "$($script:ElvFirewallPrefix)-*" -and $_.Action -eq 'Allow' })
    Add-ElvCheck $report 'C05.2' 'no staging ALLOW rules (r1 leftovers)' ($allows.Count -eq 0)
}
# 06
if ($st -ge 6) {
    $wt = Get-ScheduledTask -TaskName $script:ElvWorkerTask -ErrorAction SilentlyContinue
    Add-ElvCheck $report 'C06.1' 'worker task runs as elv-stg-worker, Limited' ([bool]($wt -and $wt.Principal.UserId -match "$($script:ElvWorkerAccount)$" -and $wt.Principal.RunLevel -eq 'Limited'))
    if ($elevated -and $wsid) { Add-ElvCheck $report 'C06.2' 'worker denied interactive logon' (Test-ElvRightHeld (Get-ElvCurrentRights) 'SeDenyInteractiveLogonRight' $wsid $script:ElvWorkerAccount) }
}
Add-ElvProductionChecks $report
$fails = @($report.checks | Where-Object { $_.status -eq 'FAIL' }).Count
Write-Host "`nCONFIGURATION: $fails FAIL. Reminder: configuration checks are NOT evidence that Windows denies the worker."
Save-ElvReport $report
