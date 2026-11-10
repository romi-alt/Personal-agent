<#
.SYNOPSIS
  A7/A8: create elv-stg-worker and elv-stg-broker DISABLED, join them to the deny group, set user rights.
.DESCRIPTION
  Fixes r1 R-3 (account created enabled, no deny-group membership) and replaces the r1 owner-DPAPI credential file:
  each account gets a random password that is NEVER stored or displayed. Passwords are set interactively later only
  where needed (06 for the worker's one-time Claude login; 04 for the broker task, which needs a Password logon so the
  broker can use its own DPAPI key).
    - Both accounts: standard users, member of Users (needed: Program Files grants Users, not Authenticated Users),
      member of ElevariqIsolatedIdentities BEFORE either is ever enabled.
    - Rights added: SeBatchLogonRight (both); SeDenyNetworkLogonRight + SeDenyRemoteInteractiveLogonRight (both);
      SeDenyInteractiveLogonRight (broker now; worker in 06 after its one-time Claude login).
  Prerequisite (enforced): 00 and 01 applied.
#>
[CmdletBinding()]
param([switch]$Apply)
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$report = Initialize-ElvRun '02-identities-and-rights' $DryRun
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
    @{ Name = $script:ElvWorkerAccount; Full = 'ELEVARIQ Staging Worker'; Desc = 'ELEVARIQ staging worker (isolated; no owner data access)' },
    @{ Name = $script:ElvBrokerAccount; Full = 'ELEVARIQ Staging Broker'; Desc = 'ELEVARIQ staging approval broker (isolated)' }
)
$sids = @{}
foreach ($i in $ids) {
    if ($i.Name -eq $owner.Account) { throw 'Refusing: identity name equals the owner account.' }
    $sid = Resolve-ElvLocalSid $i.Name
    if ($sid) {
        $u = Get-LocalUser -Name $i.Name
        Add-ElvChange $report 'noop' $i.Name "exists ($sid), enabled=$($u.Enabled)" $false
        if ($u.Enabled -and -not $DryRun) {
            $inGroup = @(Get-LocalGroupMember -Group $script:ElvGroup | Where-Object { $_.SID.Value -eq $sid }).Count -gt 0
            if (-not $inGroup) { throw "SAFETY: $($i.Name) is ENABLED but not in $($script:ElvGroup). Disable it first." }
        }
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
    foreach ($grp in @('Users', $script:ElvGroup)) {
        $already = $sid -and @(Get-LocalGroupMember -Group $grp -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $sid }).Count -gt 0
        if ($already) { Add-ElvChange $report 'noop' "$grp/$($i.Name)" 'already a member' $false; continue }
        if ($DryRun) { Add-ElvChange $report 'add-localgroupmember' "$grp/$($i.Name)" 'add' $false }
        else { Add-LocalGroupMember -Group $grp -Member $i.Name; Add-ElvChange $report 'add-localgroupmember' "$grp/$($i.Name)" 'added' $true }
    }
}

# User rights (backup INF of the previous state is saved in <owner>\ElevariqAdmin\rights).
$w = '*<worker-SID>'; $b = '*<broker-SID>'
if ($sids[$script:ElvWorkerAccount]) { $w = "*$($sids[$script:ElvWorkerAccount])" }
if ($sids[$script:ElvBrokerAccount]) { $b = "*$($sids[$script:ElvBrokerAccount])" }
Invoke-ElvRightsChange -Report $report -DryRun $DryRun -Label '02' -Add @{
    SeBatchLogonRight                 = @($w, $b)
    SeDenyNetworkLogonRight           = @($w, $b)
    SeDenyRemoteInteractiveLogonRight = @($w, $b)
    SeDenyInteractiveLogonRight       = @($b)
}

if (-not $DryRun) {
    $admins = @(Get-LocalGroupMember Administrators | ForEach-Object { $_.SID.Value })
    $members = @(Get-LocalGroupMember -Group $script:ElvGroup | ForEach-Object { $_.SID.Value })
    $rights = Get-ElvCurrentRights
    foreach ($n in $sids.Keys) {
        $s = $sids[$n]
        Add-ElvCheck $report 'I1' "$n is not an administrator" (-not ($admins -contains $s))
        Add-ElvCheck $report 'I2' "$n is in $($script:ElvGroup)" ($members -contains $s)
        Add-ElvCheck $report 'I3' "$n is still disabled" (-not (Get-LocalUser -SID $s).Enabled)
        Add-ElvCheck $report 'I4' "$n holds SeBatchLogonRight" (Test-ElvRightHeld $rights 'SeBatchLogonRight' $s $n)
        Add-ElvCheck $report 'I5' "$n denied network + RDP logon" ((Test-ElvRightHeld $rights 'SeDenyNetworkLogonRight' $s $n) -and (Test-ElvRightHeld $rights 'SeDenyRemoteInteractiveLogonRight' $s $n))
    }
}
Add-ElvProductionChecks $report
Save-ElvReport $report
