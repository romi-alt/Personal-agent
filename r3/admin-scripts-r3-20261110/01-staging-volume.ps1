<#
.SYNOPSIS
  A6: size-capped staging VHDX volume mounted at C:\ElevariqStaging with a PROTECTED root ACL.
.DESCRIPTION
  Prerequisite (enforced): 00 applied - deny group exists and E:\, F:\ carry its explicit DENY.
    1. C:\ElevariqStagingDisk  : protected; SYSTEM + Administrators only (holds the VHDX); owner = Administrators (M5).
    2. C:\ElevariqStaging      : empty mount-point folder; protected; SYSTEM + Administrators + owner RX; owner = Administrators.
       M5: a PRE-EXISTING folder is refused unless it is empty AND already owned by SYSTEM/Administrators AND not a
       reparse point (an Authenticated User can pre-create folders under C:\ and would keep implicit WRITE_DAC).
    3. diskpart: expandable VHDX (max $ElvVhdxMaxMB MB), NTFS, label ELVSTG, NO default drive letter (L10), mounted at
       C:\ElevariqStaging.
    4. Volume root: inheritance off, the EXPLICIT AU/Users/CREATOR OWNER/Everyone ACEs that a fresh format adds are
       removed, SYSTEM + Administrators Full, owner SID Full. Verified: no broad group retains any access, and no broad
       ACE of any kind remains (L7).
    5. SYSTEM startup task ElevariqStagingDiskAttach re-attaches the VHDX at boot (verify mount point after reboot).
  Idempotent: if an ELVSTG volume is already mounted at the root, steps 1-3 are skipped and 4 is re-verified.
#>
[CmdletBinding()]
param([switch]$Apply, [string]$ApprovedManifestHash = '')
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun '01-staging-volume' $DryRun -ApprovedManifestHash $ApprovedManifestHash
trap { Save-ElvReport $report $_; break }
$owner = Get-ElvOwnerContext
foreach ($p in $script:ElvStagingRoot, $script:ElvDiskDir, $script:ElvVhdxPath) { [void](Assert-StagingPath $report $p) }

# prerequisite: 00
$gsid = Resolve-ElvGroupSid
$pre = $gsid -and (@($script:ElvDenyRoots | Where-Object { -not (Test-ElvDenyAce $_ $gsid 'explicit' $true) }).Count -eq 0)
Add-ElvCheck $report 'PRE' '00 applied (group + explicit DENY on E:\, F:\)' ([bool]$pre)
if (-not $pre -and -not $DryRun) { throw 'Prerequisite failed: apply 00-isolation-group-deny.ps1 first.' }
Add-ElvProductionChecks $report

function Get-ElvStagingVolume {
    Get-Partition -ErrorAction SilentlyContinue | Where-Object { $_.AccessPaths -contains "$($script:ElvStagingRoot)\" } |
        ForEach-Object { Get-Volume -Partition $_ -ErrorAction SilentlyContinue } | Where-Object { $_.FileSystemLabel -eq $script:ElvVolumeLabel }
}
# M5: a pre-existing folder must be empty, not a reparse point, and owned by SYSTEM/Administrators.
function Assert-ElvSafePreexisting {
    param([string]$Dir)
    if (-not (Test-Path -LiteralPath $Dir)) { return }
    $it = Get-Item -LiteralPath $Dir -Force
    if ($it.Attributes -band [IO.FileAttributes]::ReparsePoint) { Add-ElvRefusal $report 'pre-existing folder is a reparse point' $Dir; throw "Refusing: $Dir is a reparse point." }
    if (@(Get-ChildItem -LiteralPath $Dir -Force).Count) { Add-ElvRefusal $report 'pre-existing folder is not empty' $Dir; throw "Refusing: $Dir not empty." }
    $o = (Get-Acl -LiteralPath $Dir).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($script:TrustedWriterSids -notcontains $o) { Add-ElvRefusal $report "pre-existing folder owned by $o (not SYSTEM/Administrators): pre-created by someone else?" $Dir; throw "Refusing: $Dir has owner $o." }
}
$vol = Get-ElvStagingVolume
$base = @("*$($script:SidSystem):(OI)(CI)F", "*$($script:SidAdmins):(OI)(CI)F")

if ($vol) { Add-ElvChange $report 'noop' $script:ElvStagingRoot 'ELVSTG volume already mounted; skipping create/attach' $false }
else {
    Assert-ElvSafePreexisting $script:ElvStagingRoot; Assert-ElvSafePreexisting $script:ElvDiskDir
    if (Test-Path -LiteralPath $script:ElvVhdxPath) { Add-ElvRefusal $report 'VHDX already exists but is not mounted at the root' $script:ElvVhdxPath; throw 'Refusing: stale VHDX; inspect or run 09 rollback.' }
    if (-not $DryRun) { New-Item -ItemType Directory -Force $script:ElvDiskDir, $script:ElvStagingRoot | Out-Null }
    foreach ($d in $script:ElvDiskDir, $script:ElvStagingRoot) { Invoke-ElvIcacls @($d, '/setowner', "*$($script:SidAdmins)") $DryRun $report $d 'owner = Administrators (M5)' }
    Invoke-ElvIcacls (@($script:ElvDiskDir, '/inheritance:r', '/grant:r') + $base) $DryRun $report $script:ElvDiskDir 'protected: SYSTEM + Administrators only'
    Invoke-ElvIcacls (@($script:ElvStagingRoot, '/inheritance:r', '/grant:r') + $base + @("*$($owner.Sid):(RX)")) $DryRun $report $script:ElvStagingRoot 'mount-point folder protected before mounting (owner RX)'

    $dp = @(
        "create vdisk file=`"$($script:ElvVhdxPath)`" maximum=$($script:ElvVhdxMaxMB) type=expandable",
        'attach vdisk', 'create partition primary',
        "format fs=ntfs label=$($script:ElvVolumeLabel) quick",
        'attributes volume set nodefaultdriveletter',
        "assign mount=`"$($script:ElvStagingRoot)\`""
    )
    if ($DryRun) { Add-ElvChange $report 'diskpart' $script:ElvVhdxPath ($dp -join ' ; ') $false }
    else {
        New-Item -ItemType Directory -Force $owner.AdminDir | Out-Null
        $dpFile = Join-Path $owner.AdminDir ('diskpart-{0}.txt' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        $dp | Set-Content -Encoding ascii -LiteralPath $dpFile
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { $out = @(& diskpart.exe /s $dpFile 2>&1 | ForEach-Object { [string]$_ }); $code = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
        if ($code -ne 0) { Add-ElvRefusal $report "diskpart exit ${code}: $($out -join ' ')" $dpFile; throw 'diskpart failed (see report); run 09 rollback for partial state.' }
        $vol = Get-ElvStagingVolume
        if (-not $vol) { throw 'diskpart reported success but no ELVSTG volume is mounted at the root.' }
        Add-ElvChange $report 'diskpart' $script:ElvVhdxPath "created + mounted ($([math]::Round($vol.Size/1GB,1)) GB volume)" $true
    }
}

# Volume root ACL: a fresh NTFS root carries EXPLICIT broad ACEs; /inheritance:r alone does not remove them.
$strip = @('/remove:g', '*S-1-5-11', '*S-1-5-32-545', '*S-1-3-0', '*S-1-1-0')
Invoke-ElvIcacls (@($script:ElvStagingRoot, '/inheritance:r') + $strip) $DryRun $report $script:ElvStagingRoot 'volume root: strip explicit broad ACEs'
Invoke-ElvIcacls (@($script:ElvStagingRoot, '/setowner', "*$($script:SidAdmins)")) $DryRun $report $script:ElvStagingRoot 'volume root owner = Administrators'
Invoke-ElvIcacls (@($script:ElvStagingRoot, '/grant:r') + $base + @("*$($owner.Sid):(OI)(CI)F")) $DryRun $report $script:ElvStagingRoot 'volume root: SYSTEM + Administrators + owner Full'
if (-not $DryRun) {
    foreach ($d in @(@{ P = $script:ElvStagingRoot; N = 'staging volume root' }, @{ P = $script:ElvDiskDir; N = 'VHDX folder' })) {
        $aces = @(Get-ElvAces $d.P)
        Add-ElvCheck $report 'V1' "no broad group has ANY access to the $($d.N)" ((Get-ElvEffectiveMask $d.P $script:BroadSids -Aces $aces) -eq 0)
        Add-ElvCheck $report 'V1b' "no broad ACE of any kind (incl. inherit-only) on the $($d.N)" (@($aces | Where-Object { $_.Type -eq 'AccessAllowed' -and ($script:BroadSids -contains $_.Sid) }).Count -eq 0)
        $o = (Get-Acl -LiteralPath $d.P).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        Add-ElvCheck $report 'V2' "$($d.N) owned by Administrators/SYSTEM" ($script:TrustedWriterSids -contains $o) $o
    }
    $vo = (Get-Acl -LiteralPath $script:ElvVhdxPath).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    Add-ElvCheck $report 'V2' 'VHDX file owned by Administrators/SYSTEM' ($script:TrustedWriterSids -contains $vo) $vo
    $part = Get-Partition -ErrorAction SilentlyContinue | Where-Object { $_.AccessPaths -contains "$($script:ElvStagingRoot)\" }
    Add-ElvCheck $report 'V3' 'staging volume has NO drive letter (L10)' ([bool]($part -and -not $part.DriveLetter)) "letter='$($part.DriveLetter)'"
}

# Re-attach at boot (SYSTEM). The command embeds only the fixed, admin-only VHDX path.
$cmd = "Mount-DiskImage -ImagePath '$($script:ElvVhdxPath)' -NoDriveLetter -ErrorAction Stop"
if ($DryRun) { Add-ElvChange $report 'register-scheduledtask' $script:ElvDiskTask "SYSTEM, AtStartup: $cmd" $false }
elseif (Get-ScheduledTask -TaskName $script:ElvDiskTask -ErrorAction SilentlyContinue) { Add-ElvChange $report 'noop' $script:ElvDiskTask 'already registered' $false }
else {
    $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -Command `"$cmd`""
    $t = New-ScheduledTaskTrigger -AtStartup
    $p = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $script:ElvDiskTask -Action $a -Trigger $t -Principal $p -ErrorAction Stop | Out-Null
    Add-ElvChange $report 'register-scheduledtask' $script:ElvDiskTask 'registered (verify the mount point survives a reboot)' $true
}
Add-ElvProductionChecks $report
Save-ElvReport $report
