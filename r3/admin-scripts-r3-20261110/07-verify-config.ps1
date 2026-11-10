<#
.SYNOPSIS
  Read-only CONFIGURATION verification of every stage. THESE ARE NOT ACCESS TESTS.
.DESCRIPTION
  Evaluates parsed ACEs by SID, group memberships (ADSI, fail closed), user rights, tasks, firewall rules, owners,
  drive letters, H1 verification state and H5 shadow copies. A PASS here means "configured as designed"; it does NOT
  mean Windows denies the worker. Only the real-token acceptance matrix (ADVERSARIAL_ACCEPTANCE_MATRIX.md) under the real worker token can show that.
  Changes nothing. Run elevated for the user-rights and shadow-copy sections; otherwise those checks are UNKNOWN/SKIP.
.PARAMETER Stage  Highest stage expected to be applied (00..06). Later stages are reported as SKIP.
#>
[CmdletBinding()]
param([ValidateSet('00', '01', '02', '03', '04', '05', '06')][string]$Stage = '06')
. (Join-Path $PSScriptRoot '_common.ps1')
$report = New-ElvReport '07-verify-config' $true
trap { Save-ElvReport $report $_; break }
Write-Host "== 07 configuration verification up to stage $Stage (READ-ONLY; NOT access tests) =="
$st = [int]$Stage
$elevated = Test-ElvElevation
$stateDry = -not $elevated
$gsid = Resolve-ElvGroupSid; $wsid = Resolve-ElvLocalSid $script:ElvWorkerAccount; $bsid = Resolve-ElvLocalSid $script:ElvBrokerAccount
$applied = Read-ElvState $stateDry 'deny-targets'

# 00 / 00a
Add-ElvCheck $report 'C00.1' "group $($script:ElvGroup) exists" ([bool]$gsid)
if ($gsid) {
    $targets = @($script:ElvDenyRoots + $script:ElvDenyFolders); if ($applied) { $targets = @($applied.targets) }
    foreach ($t in @($targets | Where-Object { Test-Path -LiteralPath $_ })) {
        Add-ElvCheck $report 'C00.2' "explicit inheritable DENY on $t" (Test-ElvDenyAce $t $gsid 'explicit' (Get-Item -LiteralPath $t -Force).PSIsContainer)
    }
    $tok = Get-ElvTokenSidSet @($gsid, $wsid, $bsid)
    foreach ($s in "$($script:ProductionCheckout)\scripts\windows\run-supervisor.ps1", "$($script:ProductionCheckout)\.env", "$($script:ProductionCheckout)\.git\config", 'E:\Agent\.claude', 'E:\Agent\v2-staging') {
        if (Test-Path -LiteralPath $s) { $m = Get-ElvEffectiveMask $s $tok; Add-ElvCheck $report 'C00.3' "DENY reaches $s and modelled mask = 0" ((Test-ElvDenyAce $s $gsid 'any') -and ($m -eq 0)) ('0x{0:X}' -f $m) }
    }
    $allowed = @($wsid, $bsid | Where-Object { $_ })
    try { $unexpected = @(Get-ElvGroupMemberSids $script:ElvGroup | Where-Object { $allowed -notcontains $_ }); Add-ElvCheck $report 'C00.4' 'deny group has only the staging identities' ($unexpected.Count -eq 0) ($unexpected -join ',') }
    catch { Add-ElvCheck $report 'C00.4' 'deny group membership enumerable' $false $_.Exception.Message }
    $v = Read-ElvState $stateDry 'verify-complete'
    Add-ElvCheck $report 'C00.6' 'H1 per-object verification complete and newer than the apply' ([bool]($v -and $v.complete -and $applied -and ([datetime]$v.at -ge [datetime]$applied.appliedAt) -and ($v.appliedRef -eq $applied.ref))) $(if ($v) { "at=$($v.at) items=$($v.items)" } else { 'no verify-complete.json' })
    if ($elevated -and $applied) { try { $r = Test-ElvNoPreDenyShadows @($applied.targets) ([datetime]$applied.appliedAt); Add-ElvCheck $report 'C00.7' 'no pre-DENY shadow copies of target volumes (H5)' $r.Ok "$($r.Stale.Count) stale / $($r.All.Count) total" } catch { Add-ElvCheck $report 'C00.7' 'shadow copies' $false $_.Exception.Message } }
    else { Add-ElvCheck $report 'C00.7' 'pre-DENY shadow copies (H5)' 'UNKNOWN' 'needs elevation + deny-targets.json' }
}
$res = 'E:\Agent\v2-staging\hardening\isotest\outside'
if (Test-Path -LiteralPath $res) { Add-ElvCheck $report 'C00.5' 'test residue Everyone:F removed (00a)' (@(Get-ElvAces $res | Where-Object { $_.Sid -eq 'S-1-1-0' -and -not $_.Inherited -and $_.Type -eq 'AccessAllowed' }).Count -eq 0) }

# 01
if ($st -ge 1) {
    $part = Get-Partition -ErrorAction SilentlyContinue | Where-Object { $_.AccessPaths -contains "$($script:ElvStagingRoot)\" }
    Add-ElvCheck $report 'C01.1' 'staging VHDX mounted at C:\ElevariqStaging' ([bool]$part)
    if ($part) {
        $aces = @(Get-ElvAces $script:ElvStagingRoot)
        Add-ElvCheck $report 'C01.2' 'staging root: no broad-group access and no broad ACE of any kind' (((Get-ElvEffectiveMask $script:ElvStagingRoot $script:BroadSids -Aces $aces) -eq 0) -and (@($aces | Where-Object { $_.Type -eq 'AccessAllowed' -and ($script:BroadSids -contains $_.Sid) }).Count -eq 0))
        Add-ElvCheck $report 'C01.5' 'staging volume has no drive letter (L10)' (-not $part.DriveLetter) "'$($part.DriveLetter)'"
        $o = (Get-Acl -LiteralPath $script:ElvStagingRoot).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        Add-ElvCheck $report 'C01.6' 'staging root owned by Administrators/SYSTEM (M5)' ($script:TrustedWriterSids -contains $o) $o
    }
    if (Test-Path -LiteralPath $script:ElvDiskDir) {
        Add-ElvCheck $report 'C01.3' 'VHDX folder: no broad-group access' ((Get-ElvEffectiveMask $script:ElvDiskDir $script:BroadSids) -eq 0)
        $o = (Get-Acl -LiteralPath $script:ElvDiskDir).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        Add-ElvCheck $report 'C01.7' 'VHDX folder owned by Administrators/SYSTEM (M5)' ($script:TrustedWriterSids -contains $o) $o
        if (Test-Path -LiteralPath $script:ElvVhdxPath) { $o = (Get-Acl -LiteralPath $script:ElvVhdxPath).GetOwner([System.Security.Principal.SecurityIdentifier]).Value; Add-ElvCheck $report 'C01.8' 'VHDX file owned by Administrators/SYSTEM' ($script:TrustedWriterSids -contains $o) $o }
    }
    Add-ElvCheck $report 'C01.4' 'disk attach task runs as SYSTEM' ([bool](Get-ScheduledTask -TaskName $script:ElvDiskTask -ErrorAction SilentlyContinue | Where-Object { $_.Principal.UserId -match 'SYSTEM|S-1-5-18' }))
}
# 02
if ($st -ge 2) {
    $rights = $null; if ($elevated) { try { $rights = Get-ElvCurrentRights } catch {} }
    foreach ($id in @(@{ N = $script:ElvWorkerAccount; S = $wsid }, @{ N = $script:ElvBrokerAccount; S = $bsid })) {
        Add-ElvCheck $report 'C02.1' "$($id.N) exists" ([bool]$id.S)
        if (-not $id.S) { continue }
        try {
            $g = @(Get-ElvAccountGroupNames $id.S)
            Add-ElvCheck $report 'C02.2' "$($id.N) not an administrator" ($g -notcontains 'Administrators') ($g -join ',')
            Add-ElvCheck $report 'C02.3' "$($id.N) in deny group" ($g -contains $script:ElvGroup)
            Add-ElvCheck $report 'C02.6' "$($id.N) groups within Users + deny group (M4)" (@($g | Where-Object { @('Users', $script:ElvGroup) -notcontains $_ }).Count -eq 0) ($g -join ',')
        } catch { Add-ElvCheck $report 'C02.2' "$($id.N) group enumeration" $false $_.Exception.Message }
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
    if ((Test-Path -LiteralPath $bin) -and $bsid) { Add-ElvCheck $report 'C04.2' 'broker cannot write its own code' (((Get-ElvEffectiveMask $bin (Get-ElvTokenSidSet @($bsid, $gsid))) -band $script:WriteMask) -eq 0) }
}
# 05
if ($st -ge 5) {
    $prof = $false; try { $prof = Test-ElvFirewallProfilesEnforcing } catch {}
    Add-ElvCheck $report 'C05.0' 'firewall profiles enabled and honouring local rules' $prof
    $fs = Get-ElvWorkerFirewallState $wsid
    foreach ($n in $fs.Keys) { Add-ElvCheck $report 'C05.1' "$n present, enabled, outbound block, bound to the CURRENT worker SID" $fs[$n].Ok $fs[$n].LocalUser }
    $allows = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "$($script:ElvFirewallPrefix)-*" -and $_.Action -eq 'Allow' })
    Add-ElvCheck $report 'C05.2' 'no staging ALLOW rules (r1 leftovers)' ($allows.Count -eq 0)
    $hostRules = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "$($script:ElvHostRulePrefix)-*" })
    Add-ElvCheck $report 'C05.3' 'host-level SMB/WebDAV delegation rules present (H3; optional, separately authorized)' $(if ($hostRules.Count -ge 2) { $true } else { "INFO" }) "$($hostRules.Count) host rules"
    foreach ($svc in 'WebClient', 'BITS') { $s = Get-Service $svc -ErrorAction SilentlyContinue; Add-ElvCheck $report 'C05.4' "service $svc state (H3 delegation vector)" 'INFO' "$($s.Status)/$($s.StartType)" }
}
# 06
if ($st -ge 6) {
    $wt = Get-ScheduledTask -TaskName $script:ElvWorkerTask -ErrorAction SilentlyContinue
    Add-ElvCheck $report 'C06.1' 'worker task runs as elv-stg-worker, Limited' ([bool]($wt -and $wt.Principal.UserId -match "$($script:ElvWorkerAccount)$" -and $wt.Principal.RunLevel -eq 'Limited'))
    if ($elevated -and $wsid) { try { Add-ElvCheck $report 'C06.2' 'worker denied interactive logon' (Test-ElvRightHeld (Get-ElvCurrentRights) 'SeDenyInteractiveLogonRight' $wsid $script:ElvWorkerAccount) } catch {} }
    $binDir = Join-Path $script:ElvStagingRoot 'bin'
    if (Test-Path -LiteralPath $binDir) { $p = @(Test-ElvAdminOnlyWritable $binDir $true); Add-ElvCheck $report 'C06.3' 'bin\ (launcher) admin-only writable' ($p.Count -eq 0) ($p -join '; ') }
}
Add-ElvProductionChecks $report
$fails = @($report.checks | Where-Object { $_.status -eq 'FAIL' }).Count
Write-Host "`nCONFIGURATION: $fails FAIL. Reminder: configuration checks are NOT evidence that Windows denies the worker."
Save-ElvReport $report
