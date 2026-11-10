<#
.SYNOPSIS
  A11/A12: enable the worker for its OWN one-time Claude login, lock it down, register the worker task.
.DESCRIPTION
  -Mode enable-for-login : refuses unless the isolation configuration is in place (deny group membership, explicit
                           DENY on E:\/F:\, staging layout, worker firewall rules). Owner types a password; account
                           is enabled. Owner then runs:  runas /user:elv-stg-worker cmd  -> claude -> log in with the
                           WORKER's own login. NEVER copy C:\Users\<owner>\.claude.
  -Mode lockdown         : adds SeDenyInteractiveLogonRight for the worker; with -LogonType S4U also resets the
                           password to a random unstored value (S4U needs none).
  -Mode register-task    : registers ElevariqStagingWorker (worker identity, Limited) -> work\bin\<Launcher>.
                           Default S4U (no stored password). Use -LogonType Password only if the worker's tooling
                           needs DPAPI (S4U sessions cannot unlock the user's DPAPI keys); the owner types it.
                           The task is NOT started here; the acceptance matrix decides when.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('enable-for-login', 'lockdown', 'register-task')][string]$Mode,
    [switch]$Apply, [ValidateSet('S4U', 'Password')][string]$LogonType = 'S4U', [string]$Launcher = 'run-worker.ps1'
)
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun "06-worker-$Mode" $DryRun
$wsid = Resolve-ElvLocalSid $script:ElvWorkerAccount
$gsid = Resolve-ElvGroupSid
if ($script:ElvWorkerTask -eq $script:ProductionTask) { throw 'Refusing: worker task name collides with production.' }

# Hard gate: never enable / run the worker unless isolation is configured (r1 enabled the account first).
$gate = [ordered]@{
    'worker exists'                 = [bool]$wsid
    'worker in deny group'          = [bool]($wsid -and $gsid -and @(Get-LocalGroupMember -Group $script:ElvGroup -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $wsid }).Count)
    'explicit DENY on E:\ and F:\'  = [bool]($gsid -and @($script:ElvDenyRoots | Where-Object { -not (Test-ElvDenyAce $_ $gsid 'explicit' $true) }).Count -eq 0)
    'staging work\ exists'          = Test-Path -LiteralPath (Join-Path $script:ElvStagingRoot 'work')
    'worker DENY on broker\'        = [bool]($wsid -and (Test-Path -LiteralPath (Join-Path $script:ElvStagingRoot 'broker')) -and (Test-ElvDenyAce (Join-Path $script:ElvStagingRoot 'broker') $wsid 'explicit'))
    'worker firewall rules present' = (@(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "$($script:ElvFirewallPrefix)-Block-*" -and $_.Enabled -eq 'True' }).Count -ge 2)
}
foreach ($k in $gate.Keys) { Add-ElvCheck $report 'GATE' $k ([bool]$gate[$k]) }
$gateOk = -not ($gate.Values -contains $false)
if (-not $gateOk -and -not $DryRun) { Save-ElvReport $report; throw 'Isolation gate failed: the worker must not be enabled or run.' }

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
        $launcherPath = Join-Path $script:ElvStagingRoot "work\bin\$Launcher"
        [void](Assert-StagingPath $report $launcherPath)
        if ($DryRun) { Add-ElvChange $report 'register-scheduledtask' $script:ElvWorkerTask "principal=$($script:ElvWorkerAccount) $LogonType Limited; action=powershell -File $launcherPath; not started" $false; break }
        if (-not (Test-Path -LiteralPath $launcherPath)) { throw "Launcher not found: $launcherPath" }
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
        Add-ElvChange $report 'register-scheduledtask' $script:ElvWorkerTask 'registered (not started)' $true
    }
}
Add-ElvProductionChecks $report
Save-ElvReport $report
