<#
.SYNOPSIS
  A11/A12: enable the worker for its OWN one-time Claude login, lock it down, register the worker task.
.DESCRIPTION
  -Mode enable-for-login : refuses unless the HARD GATE passes. Owner types a password; account is enabled. Owner then
                           runs:  runas /user:elv-stg-worker cmd  -> claude -> log in with the WORKER's own login.
                           NEVER copy C:\Users\<owner>\.claude.
  -Mode lockdown         : adds SeDenyInteractiveLogonRight for the worker; with -LogonType S4U also resets the
                           password to a random unstored value (S4U needs none).
  -Mode register-task    : registers ElevariqStagingWorker (worker identity, Limited) -> bin\<Launcher> (admin-only
                           dir; the launcher creates the Job Object limits, M11). Default S4U (no stored password).
  HARD GATE (r3, fail closed; every item must be PASS, no UNKNOWN):
    G1 worker exists                       G2 worker in deny group (ADSI, fail closed)     G3 worker NOT an administrator
    G4 explicit inheritable DENY on every DENY target recorded in state\deny-targets.json
    G5 state\verify-complete.json: complete=true, newer than deny-targets.json appliedAt (H1 per-object verification)
    G6 Test-ElvLayout: 0 FAIL (H4; layout ACLs re-evaluated now, not just "work\ exists")
    G7 firewall: both worker rules bound to the CURRENT worker SID, enabled, outbound, block (H4); profiles enforcing
    G8 shadow copies: NONE of a DENY-target volume older than appliedAt (H5; elevation required, else UNKNOWN=FAIL)
    G9 bin\ and the launcher are admin-only writable (M11 launcher integrity)
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('enable-for-login', 'lockdown', 'register-task')][string]$Mode,
    [switch]$Apply, [ValidateSet('S4U', 'Password')][string]$LogonType = 'S4U', [string]$Launcher = 'run-worker.ps1', [string]$ApprovedManifestHash = ''
)
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun "06-worker-$Mode" $DryRun -ApprovedManifestHash $ApprovedManifestHash
trap { Save-ElvReport $report $_; break }
$wsid = Resolve-ElvLocalSid $script:ElvWorkerAccount
$gsid = Resolve-ElvGroupSid
if ($script:ElvWorkerTask -eq $script:ProductionTask) { throw 'Refusing: worker task name collides with production.' }
$stateDry = -not (Test-ElvElevation)

# ---- hard gate (fail closed). Each predicate returns $true or a reason string.
function G { param([string]$Id, [string]$Name, [scriptblock]$Body)
    $r = $null; try { $r = & $Body } catch { $r = "ERROR: $($_.Exception.Message)" }
    if ($r -eq $true) { Add-ElvCheck $report $Id $Name $true; return $true }
    Add-ElvCheck $report $Id $Name $false ([string]$r); return $false
}
$applied = Read-ElvState $stateDry 'deny-targets'
$gate = @()
$gate += G 'G1' 'worker exists' { [bool]$wsid }
$gate += G 'G2' 'worker in deny group (ADSI, fail closed)' { if (-not ($wsid -and $gsid)) { return 'no worker/group' }; if (@(Get-ElvGroupMemberSids $script:ElvGroup) -contains $wsid) { $true } else { 'not a member' } }
$gate += G 'G3' 'worker is NOT an administrator' { if (-not $wsid) { return 'no worker' }; if (@(Get-ElvGroupMemberSids 'Administrators') -contains $wsid) { 'IS an administrator' } else { $true } }
$gate += G 'G4' 'explicit inheritable DENY on every recorded DENY target' {
    if (-not $gsid) { return 'no group' }; if (-not $applied) { return 'no state\deny-targets.json' }
    $bad = @(@($applied.targets) | Where-Object { (Test-Path -LiteralPath $_) -and -not (Test-ElvDenyAce $_ $gsid 'explicit' ((Get-Item -LiteralPath $_ -Force).PSIsContainer)) })
    if ($bad.Count) { "missing on: $($bad -join ',')" } else { $true } }
$gate += G 'G5' 'H1 per-object verification complete and newer than the apply' {
    if (-not $applied) { return 'no deny-targets.json' }
    $v = Read-ElvState $stateDry 'verify-complete'
    if (-not $v) { return 'no verify-complete.json (run 00 -Verify chunks + 00 -Verify -Finalize)' }
    if (-not $v.complete) { return 'verify-complete.json says complete=false' }
    if (([datetime]$v.at) -lt ([datetime]$applied.appliedAt)) { return 'verify-complete.json predates the last 00 apply' }
    if ($v.appliedRef -ne $applied.ref) { return "verify ref $($v.appliedRef) != apply ref $($applied.ref)" }
    $true }
$gate += G 'G6' 'staging layout re-evaluated: 0 FAIL (Test-ElvLayout)' {
    $bsid = Resolve-ElvLocalSid $script:ElvBrokerAccount
    if (-not ($wsid -and $bsid -and $gsid)) { return 'identities/group missing' }
    $scratch = New-ElvReport '06-layout-gate' $true
    Test-ElvLayout $scratch $wsid $bsid $gsid *> $null
    $f = @($scratch.checks | Where-Object { $_.status -eq 'FAIL' })
    if ($f.Count) { "$($f.Count) layout FAIL: $(($f | Select-Object -First 3 | ForEach-Object { $_.name }) -join '; ')" } else { $true } }
$gate += G 'G7' 'firewall: both worker rules bound to the CURRENT worker SID; profiles enforcing' {
    if (-not $wsid) { return 'no worker' }
    if (-not (Test-ElvFirewallProfilesEnforcing)) { return 'profiles not enforcing' }
    $st = Get-ElvWorkerFirewallState $wsid
    $bad = @($st.Keys | Where-Object { -not $st[$_].Ok })
    if ($bad.Count) { "not bound to $wsid or not an enabled outbound block: $($bad -join ',')" } else { $true } }
$gate += G 'G8' 'no shadow copy of a DENY-target volume predates the apply (H5; UNKNOWN = FAIL)' {
    if (-not $applied) { return 'no deny-targets.json' }
    $r = Test-ElvNoPreDenyShadows @($applied.targets) ([datetime]$applied.appliedAt)   # throws UNKNOWN when not elevated
    if ($r.Ok) { $true } else { "stale shadows: $(($r.Stale | ForEach-Object { "$($_.Drive) $($_.Id) $($_.InstallDate)" }) -join '; ') -> delete (vssadmin delete shadows, separate authorization) or document" } }
$binDir = Join-Path $script:ElvStagingRoot 'bin'; $launcherPath = Join-Path $binDir $Launcher
$gate += G 'G9' 'bin\ and the launcher are admin-only writable' {
    if (-not (Test-Path -LiteralPath $binDir)) { return 'bin\ missing' }
    $p = @(Test-ElvAdminOnlyWritable $binDir $true); if (Test-Path -LiteralPath $launcherPath) { $p += @(Test-ElvAdminOnlyWritable $launcherPath) }
    if ($p.Count) { $p -join '; ' } else { $true } }
$gateOk = -not ($gate -contains $false)
Add-ElvCheck $report 'GATE' 'all gate items PASS' $gateOk
if (-not $gateOk -and -not $DryRun) { throw 'Isolation gate failed: the worker must not be enabled or run.' }

function Read-ElvNewPassword {
    $p1 = Read-Host -AsSecureString "Password for $($script:ElvWorkerAccount)"; $p2 = Read-Host -AsSecureString 'Repeat'
    $b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1); $b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2)
    try {
        $a = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b1); $b = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b2)
        if ($a -ne $b -or $a.Length -lt 16) { throw 'Passwords differ or shorter than 16 characters.' }
        return @{ Secure = $p1; Plain = $a }
    } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2) }
}

switch ($Mode) {
    'enable-for-login' {
        if ($DryRun) { Add-ElvChange $report 'enable-localuser' $script:ElvWorkerAccount 'owner sets password; enable; then runas + claude login (worker''s own login)' $false; break }
        $pw = Read-ElvNewPassword
        Set-LocalUser -Name $script:ElvWorkerAccount -Password $pw.Secure; $pw = $null
        Enable-LocalUser -Name $script:ElvWorkerAccount
        Add-ElvChange $report 'enable-localuser' $script:ElvWorkerAccount 'enabled for one-time login' $true
        Write-Host "`nNEXT (owner): runas /user:$($script:ElvWorkerAccount) cmd   then: claude   (log in with the WORKER's own login)."
        Write-Host "Also capture: whoami /groups /fo csv > C:\ElevariqStaging\work\worker-groups.csv  (feeds 00 -Verify -CapturedWorkerGroupsCsv)"
        Write-Host "Then run: 06-worker-enable.ps1 -Mode lockdown -Apply"
    }
    'lockdown' {
        $w = '*<worker-SID>'; if ($wsid) { $w = "*$wsid" }
        Invoke-ElvRightsChange -Report $report -DryRun $DryRun -Label '06-lockdown' -Add @{ SeDenyInteractiveLogonRight = @($w) }
        if ($LogonType -eq 'S4U') {
            if ($DryRun) { Add-ElvChange $report 'set-localuser' $script:ElvWorkerAccount 'reset password to random unstored value (S4U needs none)' $false }
            else {
                $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
                Set-LocalUser -Name $script:ElvWorkerAccount -Password (ConvertTo-SecureString ([Convert]::ToBase64String($b) + 'aA1!') -AsPlainText -Force)
                [Array]::Clear($b, 0, $b.Length)
                Add-ElvChange $report 'set-localuser' $script:ElvWorkerAccount 'password reset (unstored)' $true
            }
        }
        if (-not $DryRun) { Add-ElvCheck $report 'K1' 'worker denied interactive logon' (Test-ElvRightHeld (Get-ElvCurrentRights) 'SeDenyInteractiveLogonRight' $wsid $script:ElvWorkerAccount) }
    }
    'register-task' {
        [void](Assert-StagingPath $report $launcherPath)
        if ($DryRun) { Add-ElvChange $report 'register-scheduledtask' $script:ElvWorkerTask "principal=$($script:ElvWorkerAccount) $LogonType Limited; action=powershell -File $launcherPath (Job Object limits); not started" $false; break }
        if (-not (Test-Path -LiteralPath $launcherPath)) { throw "Launcher not found: $launcherPath (install run-worker.ps1 into the admin-only bin\ first)" }
        if (-not (Test-ElvRightHeld (Get-ElvCurrentRights) 'SeDenyInteractiveLogonRight' $wsid $script:ElvWorkerAccount)) { throw 'Run -Mode lockdown first.' }
        $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcherPath`"" -WorkingDirectory (Join-Path $script:ElvStagingRoot 'work')
        $s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 8)
        if ($LogonType -eq 'S4U') {
            $p = New-ScheduledTaskPrincipal -UserId $script:ElvWorkerAccount -LogonType S4U -RunLevel Limited
            Register-ScheduledTask -TaskName $script:ElvWorkerTask -Action $a -Settings $s -Principal $p -ErrorAction Stop | Out-Null
        } else {
            $pw = Read-ElvNewPassword
            Set-LocalUser -Name $script:ElvWorkerAccount -Password $pw.Secure
            Register-ScheduledTask -TaskName $script:ElvWorkerTask -Action $a -Settings $s -User $script:ElvWorkerAccount -Password $pw.Plain -RunLevel Limited -ErrorAction Stop | Out-Null
            $pw = $null
        }
        $t = Get-ScheduledTask -TaskName $script:ElvWorkerTask
        Add-ElvCheck $report 'T1' 'worker task runs as the worker, Limited' (($t.Principal.UserId -match "$($script:ElvWorkerAccount)$") -and $t.Principal.RunLevel -eq 'Limited')
        Add-ElvChange $report 'register-scheduledtask' $script:ElvWorkerTask 'registered (not started). NEXT: real-token acceptance tests per ADVERSARIAL_ACCEPTANCE_MATRIX.md (owner-run, independently reviewed)' $true
    }
}
Add-ElvProductionChecks $report
Save-ElvReport $report
