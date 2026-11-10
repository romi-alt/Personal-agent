<#
.SYNOPSIS
  A7/A8: create elv-stg-worker and elv-stg-broker DISABLED, join them to the deny group, set user rights, quotas.
.DESCRIPTION
    - Both accounts: standard users, member of Users (needed: Program Files grants Users, not Authenticated Users),
      member of ElevariqIsolatedIdentities BEFORE either is ever enabled. Random passwords, never stored or shown.
    - M4: a PRE-EXISTING account is adopted ONLY if its description matches, it is disabled, and its only group
      memberships are a subset of {Users, ElevariqIsolatedIdentities}; otherwise -Apply throws (someone pre-created it).
    - Rights added: SeBatchLogonRight (both); SeDenyNetworkLogonRight + SeDenyRemoteInteractiveLogonRight (both);
      SeDenyInteractiveLogonRight (broker now; worker in 06 after its one-time Claude login). Rights are RE-EXPORTED
      and verified after secedit /configure (L3).
    - M11: optional NTFS quotas per identity on every fixed NTFS volume (-VolumeQuotaMB > 0): `fsutil quota enforce`
      is a per-volume setting (default limit = none, so no effect on other users) plus a per-SID limit. This is the only
      per-user DISK cap Windows offers outside the VHDX. Process and memory caps: see the Job Object launcher (bin\).
    - M8: writes state\identities.json (names, SIDs) for 09.
  Prerequisite (enforced): 00 and 01 applied.
#>
[CmdletBinding()]
param([switch]$Apply, [int]$VolumeQuotaMB = 0, [string]$ApprovedManifestHash = '')
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun '02-identities-and-rights' $DryRun -ApprovedManifestHash $ApprovedManifestHash
trap { Save-ElvReport $report $_; break }
$owner = Get-ElvOwnerContext

$gsid = Resolve-ElvGroupSid
$pre00 = $gsid -and (@($script:ElvDenyRoots | Where-Object { -not (Test-ElvDenyAce $_ $gsid 'explicit' $true) }).Count -eq 0)
$pre01 = [bool](Get-Partition -ErrorAction SilentlyContinue | Where-Object { $_.AccessPaths -contains "$($script:ElvStagingRoot)\" })
Add-ElvCheck $report 'PRE00' 'deny group + DENY on E:\, F:\' ([bool]$pre00)
Add-ElvCheck $report 'PRE01' 'staging volume mounted' $pre01
if (-not $DryRun -and -not ($pre00 -and $pre01)) { throw 'Prerequisites failed: apply 00 and 01 first.' }

function New-ElvUnstoredPassword {
    $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    $s = ConvertTo-SecureString ([Convert]::ToBase64String($b) + 'aA1!') -AsPlainText -Force
    [Array]::Clear($b, 0, $b.Length); return $s
}

$ids = @(
    @{ Name = $script:ElvWorkerAccount; Full = 'ELEVARIQ Staging Worker'; Desc = $script:ElvWorkerDesc },
    @{ Name = $script:ElvBrokerAccount; Full = 'ELEVARIQ Staging Broker'; Desc = $script:ElvBrokerDesc }
)
$allowedGroups = @('Users', $script:ElvGroup)
$sids = @{}
foreach ($i in $ids) {
    if ($i.Name -eq $owner.Account) { throw 'Refusing: identity name equals the owner account.' }
    $sid = Resolve-ElvLocalSid $i.Name
    if ($sid) {
        $u = Get-LocalUser -Name $i.Name
        $groups = @(Get-ElvAccountGroupNames $sid)       # fail closed
        $foreign = @($groups | Where-Object { $allowedGroups -notcontains $_ })
        $adoptable = ($u.Description -eq $i.Desc) -and (-not $u.Enabled) -and ($foreign.Count -eq 0)
        Add-ElvCheck $report 'M4' "$($i.Name) pre-exists and is adoptable (description matches, disabled, groups subset of Users+deny group)" $adoptable "enabled=$($u.Enabled) groups=$($groups -join ',') desc='$($u.Description)'"
        if (-not $adoptable -and -not $DryRun) { throw "SAFETY: pre-existing $($i.Name) is not adoptable (enabled=$($u.Enabled), foreign groups: $($foreign -join ',')). Inspect and delete it first." }
        Add-ElvChange $report 'noop' $i.Name "exists ($sid), adopted" $false
    } elseif ($DryRun) {
        Add-ElvChange $report 'new-localuser' $i.Name 'standard user, DISABLED, random unstored password' $false
    } else {
        New-LocalUser -Name $i.Name -Password (New-ElvUnstoredPassword) -FullName $i.Full -Description $i.Desc `
            -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Disabled | Out-Null
        $sid = Resolve-ElvLocalSid $i.Name -MustExist $true
        Add-ElvChange $report 'new-localuser' $i.Name "created DISABLED ($sid)" $true
    }
    if ($sid) {
        if ($sid -eq $owner.Sid) { throw 'Refusing: identity SID equals owner SID.' }
        $sids[$i.Name] = $sid
    }
    foreach ($grp in $allowedGroups) {
        $already = $false; if ($sid) { $already = (@(Get-ElvGroupMemberSids $grp) -contains $sid) }
        if ($already) { Add-ElvChange $report 'noop' "$grp/$($i.Name)" 'already a member' $false; continue }
        if ($DryRun) { Add-ElvChange $report 'add-localgroupmember' "$grp/$($i.Name)" 'add' $false }
        else { Add-LocalGroupMember -Group $grp -Member $i.Name; Add-ElvChange $report 'add-localgroupmember' "$grp/$($i.Name)" 'added' $true }
    }
}

# User rights (backup INF of the previous state is saved in <owner>\ElevariqAdmin\rights; verified after configure).
$w = '*<worker-SID>'; $b = '*<broker-SID>'
if ($sids[$script:ElvWorkerAccount]) { $w = "*$($sids[$script:ElvWorkerAccount])" }
if ($sids[$script:ElvBrokerAccount]) { $b = "*$($sids[$script:ElvBrokerAccount])" }
Invoke-ElvRightsChange -Report $report -DryRun $DryRun -Label '02' -Add @{
    SeBatchLogonRight                 = @($w, $b)
    SeDenyNetworkLogonRight           = @($w, $b)
    SeDenyRemoteInteractiveLogonRight = @($w, $b)
    SeDenyInteractiveLogonRight       = @($b)
}

# M11: NTFS quotas (disk cap per identity on every fixed NTFS volume; the VHDX is capped by its own size).
if ($VolumeQuotaMB -gt 0) {
    $vols = @(Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter -and $_.FileSystem -eq 'NTFS' -and $_.DriveType -eq 'Fixed' -and $_.FileSystemLabel -ne $script:ElvVolumeLabel })
    foreach ($v in $vols) {
        $drive = "$($v.DriveLetter):"
        foreach ($n in $sids.Keys) {
            $lim = [int64]$VolumeQuotaMB * 1MB; $warn = [int64]($lim * 0.8)
            if ($DryRun) { Add-ElvChange $report 'fsutil-quota' "$drive/$n" "fsutil quota enforce $drive ; fsutil quota modify $drive $warn $lim $n" $false; continue }
            $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            try {
                $o1 = @(& fsutil.exe quota enforce $drive 2>&1 | ForEach-Object { [string]$_ }); $c1 = $LASTEXITCODE
                $o2 = @(& fsutil.exe quota modify $drive $warn $lim $n 2>&1 | ForEach-Object { [string]$_ }); $c2 = $LASTEXITCODE
            } finally { $ErrorActionPreference = $eap }
            if ($c1 -ne 0 -or $c2 -ne 0) { Add-ElvRefusal $report "fsutil quota failed ($c1/$c2): $(($o1 + $o2) -join ' | ')" "$drive/$n"; throw "fsutil quota failed on $drive for $n" }
            Add-ElvChange $report 'fsutil-quota' "$drive/$n" "limit ${VolumeQuotaMB} MB (warn 80%)" $true
        }
    }
} else { Add-ElvChange $report 'note' 'quota' 'no NTFS quota requested (-VolumeQuotaMB 0): the worker can fill C:, %TEMP%, ProgramData, Public (M11 residual)' $false }

if (-not $DryRun) {
    $admins = @(Get-ElvGroupMemberSids 'Administrators')
    $members = @(Get-ElvGroupMemberSids $script:ElvGroup)
    $rights = Get-ElvCurrentRights
    foreach ($n in $sids.Keys) {
        $s = $sids[$n]
        Add-ElvCheck $report 'I1' "$n is not an administrator" (-not ($admins -contains $s))
        Add-ElvCheck $report 'I2' "$n is in $($script:ElvGroup)" ($members -contains $s)
        Add-ElvCheck $report 'I3' "$n is still disabled" (-not (Get-LocalUser -SID $s).Enabled)
        Add-ElvCheck $report 'I4' "$n holds SeBatchLogonRight" (Test-ElvRightHeld $rights 'SeBatchLogonRight' $s $n)
        Add-ElvCheck $report 'I5' "$n denied network + RDP logon" ((Test-ElvRightHeld $rights 'SeDenyNetworkLogonRight' $s $n) -and (Test-ElvRightHeld $rights 'SeDenyRemoteInteractiveLogonRight' $s $n))
        $g = @(Get-ElvAccountGroupNames $s); $f = @($g | Where-Object { $allowedGroups -notcontains $_ })
        Add-ElvCheck $report 'I6' "$n group memberships are exactly within Users + deny group" ($f.Count -eq 0) ($g -join ',')
    }
    $p = Write-ElvState $false 'identities' ([pscustomobject]@{ at = (Get-Date).ToString('o'); worker = @{ name = $script:ElvWorkerAccount; sid = $sids[$script:ElvWorkerAccount] }; broker = @{ name = $script:ElvBrokerAccount; sid = $sids[$script:ElvBrokerAccount] }; groupSid = $gsid; quotaMB = $VolumeQuotaMB })
    Add-ElvChange $report 'state' $p 'identities.json written (read by 09 rollback)' $true
}
Add-ElvProductionChecks $report
Save-ElvReport $report
