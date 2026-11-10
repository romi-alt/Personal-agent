# ELEVARIQ worker-isolation admin scripts, revision r3 (2026-11-10). Shared helpers.
#
# DESIGN ARTIFACTS. Every script defaults to -DryRun and changes nothing unless the OWNER runs it with -Apply from an
# elevated shell, from the FROZEN admin-only copy, with the out-of-band -ApprovedManifestHash. The agent never runs -Apply.
#
# r3 changes vs r2 (INDEPENDENT_REVIEW_R2.md; see R2_REVIEW_FINDING_MATRIX.md for every ID):
#   B1  ACL classification no longer ignores inherit-only ACEs (Get-ElvAclClassification, pure, SDDL-testable)
#   H1  per-object post-DENY verification (Invoke-ElvObjectVerify, chunkable, state-recorded; 06 gates on it)
#   H2  trusted copy must be ADMIN-ONLY writable and owned by Administrators/SYSTEM; the owner SID counts as a writer;
#       -Apply requires an out-of-band -ApprovedManifestHash (SHA-256 of the canonical SHA256SUMS)
#   H4  firewall gate binds to the CURRENT worker SID (Test-ElvWorkerFirewallRule, pure)
#   H5  shadow copies: fail-closed check (Get-ElvShadowCopies throws UNKNOWN when not elevated)
#   M1  Invoke-ElvIcacls captures stderr with ErrorActionPreference=Continue and checks the exit code; reports are
#       saved on failure (trap in every script; Initialize-ElvRun saves before refusing)
#   M8  state records (deny-targets, identities, sweep/verify chunks) under <AdminDir>\state
#   M9  spool\requests is add-file-only for the worker with an OWNER RIGHTS ACE; bin\ is admin-write-only
#   L1  path guards reject UNC/device paths and reparse points in the path
#   L2  rights-removal loop fixed; L3 rights are re-exported and verified after secedit /configure
#   L4  group enumeration fails CLOSED (ADSI, errors thrown)
#   L5  broad SID list extended (NTLM, asserted identity, NETWORK, SERVICE, Guests, RDP users) + captured token SIDs
#   L6  CIDR octets with leading zeros rejected; an empty complement is refused
#   L7  layout checks also require NO broad ACE of any kind and the expected inheritance flags
#   L8  production HEAD is read from .git\HEAD, not by running git elevated
#   I1  owner is resolved by the EXPECTED owner SID, never from $env:USERNAME
#   I2  the production supervisor is found by command line, not by a hard-coded PID
#   NEW R3-N1: icacls silently DROPS an (OI)/(CI) ACE on a FILE and still exits 0; Invoke-ElvIcacls refuses such specs
#
# PowerShell 5.1 compatible. Interpolate scope-qualified variables followed by ':' as "${script:Name}:".

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- constants
$script:ElvRevision        = 'r3-20261110'
$script:ElvGroup           = 'ElevariqIsolatedIdentities'
$script:ElvWorkerAccount   = 'elv-stg-worker'
$script:ElvBrokerAccount   = 'elv-stg-broker'
$script:ElvWorkerDesc      = 'ELEVARIQ staging worker (isolated; no owner data access)'
$script:ElvBrokerDesc      = 'ELEVARIQ staging approval broker (isolated)'

$script:ElvStagingRoot     = 'C:\ElevariqStaging'                 # mount point of the staging VHDX volume
$script:ElvDiskDir         = 'C:\ElevariqStagingDisk'             # holds the VHDX file (admin/SYSTEM only)
$script:ElvVhdxPath        = 'C:\ElevariqStagingDisk\elv-staging.vhdx'
$script:ElvVhdxMaxMB       = 40960
$script:ElvVolumeLabel     = 'ELVSTG'

$script:ElvWorkerTask      = 'ElevariqStagingWorker'
$script:ElvBrokerTask      = 'ElevariqStagingBroker'
$script:ElvDiskTask        = 'ElevariqStagingDiskAttach'
$script:ElvFirewallPrefix  = 'ELEVARIQ-STG-Worker'
$script:ElvHostRulePrefix  = 'ELEVARIQ-STG-Host'                   # H3: host-level (global) delegation rules, separately authorized
$script:ElvFirewallGroup   = 'ELEVARIQ Staging Isolation'

# Owner data locations that must be denied to the isolation group (measured 2026-11-10; extend from the sweep).
# M11: the per-volume $RECYCLE.BIN containers are protected DACLs granting Users add-subdirectory; they get their own DENY.
$script:ElvDenyRoots       = @('E:\', 'F:\')
$script:ElvDenyFolders     = @('C:\Download', 'C:\Intel', 'D:\src', 'D:\Intel', 'E:\$RECYCLE.BIN', 'F:\$RECYCLE.BIN')
$script:ElvSweepSkipNames  = @('System Volume Information')         # reported as 'skipped-root' rows, never silently

# Production objects. Never a privileged target of any script.
$script:ProductionCheckout = 'E:\Agent\Personal-agent'
$script:ProductionTask     = 'ElevariqPersonalAgent'
$script:ProductionCommit   = 'e60278f'
$script:ProductionCliMatch = 'E:\Agent\Personal-agent\dist\cli\index.js'   # I2: supervisor found by command line

# I1: the owner is a fixed SID, never $env:USERNAME (over-the-shoulder elevation by another admin must not redirect grants).
$script:ExpectedOwnerSid   = 'S-1-5-21-3837883729-3478098758-1729361560-1001'

# Well-known SIDs.
$script:SidSystem = 'S-1-5-18'; $script:SidAdmins = 'S-1-5-32-544'; $script:SidOwnerRights = 'S-1-3-4'
$script:TrustedWriterSids = @($script:SidSystem, $script:SidAdmins)
# L5: every SID a standard-user token on this host may carry, plus the classic broad groups. Captured token SIDs
# (Get-ElvTokenSidSet -CapturedGroupsCsv) are added on top when available.
$script:BroadSids = @(
    'S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-5-4', 'S-1-5-3', 'S-1-5-15', 'S-1-5-113', 'S-1-2-0', 'S-1-2-1', 'S-1-3-0',
    'S-1-5-64-10', 'S-1-5-64-14', 'S-1-5-64-21', 'S-1-18-1', 'S-1-18-2', 'S-1-5-14', 'S-1-5-2', 'S-1-5-6',
    'S-1-5-32-546', 'S-1-5-32-555', 'S-1-5-7')
# Rights that let a principal change content, delete, or change the ACL/owner.
$script:WriteMask = 0xD0156L     # FILE_WRITE_DATA|FILE_APPEND_DATA|FILE_WRITE_EA|FILE_DELETE_CHILD|FILE_WRITE_ATTRIBUTES|DELETE|WRITE_DAC|WRITE_OWNER

# ---------------------------------------------------------------- reporting
function New-ElvReport {
    param([string]$ScriptName, [bool]$DryRun)
    $dir = Join-Path $PSScriptRoot 'reports'
    New-Item -ItemType Directory -Force $dir | Out-Null
    [pscustomobject]@{
        script = $ScriptName; revision = $script:ElvRevision; startedAt = (Get-Date).ToString('o'); finishedAt = $null; dryRun = $DryRun
        user = [Security.Principal.WindowsIdentity]::GetCurrent().Name; elevated = (Test-ElvElevation)
        changes = New-Object System.Collections.ArrayList; refusals = New-Object System.Collections.ArrayList
        checks = New-Object System.Collections.ArrayList; error = $null
        path = (Join-Path $dir ('{0}-{1}-{2}.json' -f $ScriptName, (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID))
    }
}
function Add-ElvChange {
    param($Report, [string]$Action, [string]$Target, [string]$Detail, [bool]$Applied)
    [void]$Report.changes.Add([pscustomobject]@{ action = $Action; target = $Target; detail = $Detail; applied = $Applied; at = (Get-Date).ToString('o') })
    $tag = 'DRY-RUN '; if ($Applied) { $tag = 'APPLIED ' }
    Write-Host ('  {0}{1}: {2} -- {3}' -f $tag, $Action, $Target, $Detail)
}
function Add-ElvRefusal {
    param($Report, [string]$Reason, [string]$Target)
    [void]$Report.refusals.Add([pscustomobject]@{ reason = $Reason; target = $Target; at = (Get-Date).ToString('o') })
    Write-Warning ('  REFUSED: {0} ({1})' -f $Reason, $Target)
}
function Add-ElvCheck {
    param($Report, [string]$Id, [string]$Name, $Result, [string]$Detail = '')
    $status = 'FAIL'; if ($Result -eq $true) { $status = 'PASS' } elseif ($Result -is [string]) { $status = $Result }
    [void]$Report.checks.Add([pscustomobject]@{ id = $Id; name = $Name; status = $status; detail = $Detail })
    Write-Host ('  [{0}] {1} {2} {3}' -f $status, $Id, $Name, $Detail)
}
# M1: always called, also on failure (every script installs `trap { Save-ElvReport -Error $_ ; break }`).
function Save-ElvReport {
    param($Report, $Error = $null)
    if ($null -eq $Report) { return }
    if ($Error) { $Report.error = [string]$Error }
    $Report.finishedAt = (Get-Date).ToString('o')
    $Report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $Report.path
    $mode = 'APPLY'; if ($Report.dryRun) { $mode = 'DRY-RUN' }
    $fails = @($Report.checks | Where-Object { $_.status -eq 'FAIL' }).Count
    Write-Host ("`nReport: {0}`nChanges: {1}  Refusals: {2}  Checks: {3} ({4} FAIL)  Mode: {5}{6}" -f $Report.path, $Report.changes.Count, $Report.refusals.Count, $Report.checks.Count, $fails, $mode, $(if ($Report.error) { "  ERROR: $($Report.error)" } else { '' }))
}

# ---------------------------------------------------------------- environment
function Test-ElvElevation {
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    $p.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}
# I1: resolved by SID. The running identity may differ (another admin elevating); grants still go to the expected owner.
function Get-ElvOwnerContext {
    param([string]$OwnerSid = $script:ExpectedOwnerSid)
    if ($OwnerSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw "Owner SID $OwnerSid is not a local account SID." }
    $u = @(Get-LocalUser -ErrorAction Stop | Where-Object { $_.SID.Value -eq $OwnerSid })
    if ($u.Count -ne 1) { throw "Owner SID $OwnerSid does not resolve to exactly one local account." }
    $profile = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$OwnerSid" -ErrorAction Stop).ProfileImagePath
    [pscustomobject]@{ Account = $u[0].Name; Sid = $OwnerSid; Profile = $profile; AdminDir = (Join-Path $profile 'ElevariqAdmin')
                       RunningAsOwner = ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -eq $OwnerSid) }
}
function Resolve-ElvLocalSid {
    param([string]$Account, [bool]$MustExist = $false)
    $m = @(Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -eq $Account })
    if ($m.Count -gt 1) { throw "Ambiguous account '$Account'." }
    if ($m.Count -eq 0) { if ($MustExist) { throw "Account '$Account' does not exist." }; return $null }
    $sid = $m[0].SID.Value
    if ($sid -notmatch '^S-1-5-21-') { throw "Account '$Account' SID $sid is not a local account SID." }
    return $sid
}
function Resolve-ElvGroupSid {
    param([bool]$MustExist = $false)
    $g = $null; try { $g = Get-LocalGroup -Name $script:ElvGroup -ErrorAction Stop } catch {}
    if (-not $g) { if ($MustExist) { throw "Group '$($script:ElvGroup)' does not exist (run 00 -Apply first)." }; return $null }
    return $g.SID.Value
}
# L4: fail CLOSED. ADSI enumerates orphaned SIDs that make Get-LocalGroupMember throw. Any error propagates.
function Get-ElvGroupMemberSids {
    param([string]$Group)
    $g = [ADSI]"WinNT://./$Group,group"
    $out = @()
    foreach ($m in @($g.Invoke('Members'))) {
        $bytes = $m.GetType().InvokeMember('objectSid', 'GetProperty', $null, $m, $null)
        $out += (New-Object System.Security.Principal.SecurityIdentifier($bytes, 0)).Value
    }
    return $out
}
# M4: an account's local group memberships by SID (fail closed).
function Get-ElvAccountGroupNames {
    param([string]$Sid)
    $names = @()
    foreach ($g in @(Get-LocalGroup -ErrorAction Stop)) {
        $members = @(); try { $members = Get-ElvGroupMemberSids $g.Name } catch { throw "Cannot enumerate group $($g.Name): $($_.Exception.Message)" }
        if ($members -contains $Sid) { $names += $g.Name }
    }
    return $names
}

# ---------------------------------------------------------------- state records (M8)
function Get-ElvStateDir {
    param([bool]$DryRun)
    if ($DryRun) { $d = Join-Path $PSScriptRoot 'state' } else { $d = Join-Path (Get-ElvOwnerContext).AdminDir 'state' }
    New-Item -ItemType Directory -Force $d | Out-Null
    return $d
}
function Write-ElvState {
    param([bool]$DryRun, [string]$Name, $Object, [switch]$Timestamped)
    $dir = Get-ElvStateDir $DryRun
    $file = "$Name.json"; if ($Timestamped) { $file = '{0}-{1}-{2}.json' -f $Name, (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID }
    $p = Join-Path $dir $file
    $Object | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -LiteralPath $p
    return $p
}
function Read-ElvState {
    param([bool]$DryRun, [string]$Name)
    $p = Join-Path (Get-ElvStateDir $DryRun) "$Name.json"
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    return (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json)
}

# ---------------------------------------------------------------- path guards
# L1: only absolute drive paths. UNC, \\?\, \\.\ and admin-share forms are refused outright.
function Get-ElvCanonicalPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Empty path.' }
    if ($Path -match '^\\\\' -or $Path -match '^//') { throw "Refusing UNC/device path form: $Path" }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -notmatch '^[A-Za-z]:\\') { throw "Refusing non-drive path: $Path" }
    if ($full -match '^\\\\') { throw "Refusing path that canonicalises to a UNC/device form: $Path" }
    return $full
}
# L1: no component of an EXISTING path may be a reparse point (junction/symlink) unless explicitly allowed.
function Assert-ElvNoReparseInPath {
    param([string]$Path)
    $c = Get-ElvCanonicalPath $Path
    $parts = $c.TrimEnd('\').Split('\'); $cur = $parts[0] + '\'
    for ($i = 1; $i -lt $parts.Count; $i++) {
        $cur = Join-Path $cur $parts[$i]
        if (-not (Test-Path -LiteralPath $cur)) { return }
        $it = Get-Item -LiteralPath $cur -Force
        if ($it.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing path with a reparse point component: $cur" }
    }
}
function Test-ElvUnder {
    param([string]$Path, [string]$Root)
    $p = (Get-ElvCanonicalPath $Path).TrimEnd('\'); $r = (Get-ElvCanonicalPath $Root).TrimEnd('\')
    return ($p -ieq $r -or $p.StartsWith("$r\", [StringComparison]::OrdinalIgnoreCase))
}
function Assert-ElvNotProduction {
    param($Report, [string]$Path)
    $owner = Get-ElvOwnerContext
    $forbidden = @($script:ProductionCheckout, (Join-Path $owner.Profile 'AppData\Local\ElevariqAgent'), (Join-Path $owner.Profile '.claude'))
    foreach ($f in $forbidden) {
        if (Test-ElvUnder $Path $f) { Add-ElvRefusal $Report 'production/owner path is never a privileged target' $Path; throw "Refusing production/owner path: $Path" }
    }
}
# Staging scripts may only touch the staging mount point, the disk dir, or paths below them.
function Assert-StagingPath {
    param($Report, [string]$Path)
    Assert-ElvNotProduction $Report $Path
    if (-not ((Test-ElvUnder $Path $script:ElvStagingRoot) -or (Test-ElvUnder $Path $script:ElvDiskDir))) {
        Add-ElvRefusal $Report "outside $($script:ElvStagingRoot) / $($script:ElvDiskDir)" $Path
        throw "Staging guard: $Path is not a staging path."
    }
    Assert-ElvNoReparseInPath $Path
    return (Get-ElvCanonicalPath $Path)
}
# 00 may only place DENY ACEs on the listed roots/folders and on SWEPT FINDINGS the owner passes explicitly (M3/L1:
# -Additional entries are only accepted when they appear in $SweptFindings with a coverable issue type).
function Assert-DenyTarget {
    param($Report, [string]$Path, [string[]]$Additional = @(), $SweptFindings = $null)
    $c = Get-ElvCanonicalPath $Path
    $builtin = @($script:ElvDenyRoots + $script:ElvDenyFolders | ForEach-Object { (Get-ElvCanonicalPath $_).TrimEnd('\') })
    $extra = @($Additional | ForEach-Object { (Get-ElvCanonicalPath $_).TrimEnd('\') })
    $key = $c.TrimEnd('\')
    if ($builtin -contains $key) {
        if ($c -match '^[A-Za-z]:\\$') { return $c }   # a volume root is allowed even though production lives below it
        Assert-ElvNotProduction $Report $c; return $c
    }
    if ($extra -notcontains $key) { Add-ElvRefusal $Report 'not an approved DENY target' $c; throw "Not an approved DENY target: $c" }
    if ($null -ne $SweptFindings) {
        $hit = @($SweptFindings | Where-Object { ($_.path.TrimEnd('\') -ieq $key) -and ($script:CoverableIssues -contains $_.issue) })
        if (-not $hit.Count) { Add-ElvRefusal $Report 'AdditionalDenyPaths entry is not a coverable sweep finding (explicit-broad-allow / protected-with-broad-access)' $c; throw "Not a coverable sweep finding: $c" }
    }
    Assert-ElvNotProduction $Report $c
    Assert-ElvNoReparseInPath $c
    return $c
}
$script:CoverableIssues = @('explicit-broad-allow', 'protected-with-broad-access')

# ---------------------------------------------------------------- ACL helpers
$script:GenericMap = @{ 0x80000000L = 0x120089; 0x40000000L = 0x120116; 0x20000000L = 0x1200A0; 0x10000000L = 0x1F01FF }
function Expand-ElvMask([long]$m) {
    $r = $m -band 0x0FFFFFFFL
    foreach ($g in $script:GenericMap.Keys) { if ($m -band $g) { $r = $r -bor $script:GenericMap[$g] } }
    return $r
}
function Get-ElvAces {
    param([string]$Path, [string]$Sddl)   # -Sddl: already-read descriptor (avoids a second Get-Acl in the sweep)
    $sddl = $Sddl; if (-not $sddl) { $sddl = (Get-Acl -LiteralPath $Path).Sddl }
    $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)
    if ($null -eq $raw.DiscretionaryAcl) { return }
    foreach ($ace in $raw.DiscretionaryAcl) {
        $flags = [int]$ace.AceFlags
        [pscustomobject]@{
            Sid = $ace.SecurityIdentifier.Value; Type = [string]$ace.AceQualifier
            Mask = Expand-ElvMask ([long]$ace.AccessMask -band 0xFFFFFFFFL)
            Inherited = [bool]($flags -band 0x10); InheritOnly = [bool]($flags -band 0x08)
            ObjectInherit = [bool]($flags -band 0x01); ContainerInherit = [bool]($flags -band 0x02); NoPropagate = [bool]($flags -band 0x04)
        }
    }
}
function Test-ElvDaclProtected {
    param([string]$Sddl)
    $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($Sddl)
    return [bool]($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)
}
# Ordered DACL evaluation of THIS OBJECT for a SID set (DACL only; no privileges, labels or owner-implicit rights).
# Inherit-only ACEs are correctly skipped here because they do not apply to the object itself. This is a CONFIGURATION
# model, not the Windows access check: final acceptance needs real access checks under the worker token (08-*).
function Get-ElvEffectiveMask {
    param([string]$Path, [string[]]$Sids, $Aces)   # -Aces: already-parsed ACEs (from Get-ElvAces)
    if ($null -eq $Aces) { $Aces = @(Get-ElvAces $Path) }
    $granted = 0L; $denied = 0L
    foreach ($a in $Aces) {
        if ($a.InheritOnly -or ($Sids -notcontains $a.Sid)) { continue }
        if ($a.Type -eq 'AccessAllowed') { $granted = $granted -bor ($a.Mask -band (-bnot $denied)) }
        elseif ($a.Type -eq 'AccessDenied') { $denied = $denied -bor ($a.Mask -band (-bnot $granted)) }
    }
    return $granted
}
# B1 (pure): what on THIS DACL would defeat a DENY inherited from a deny-target root, for the object OR its descendants.
#   explicit-broad-allow        any non-inherited ALLOW for a broad SID, INCLUDING inherit-only ACEs (r2 skipped those:
#                               a child inherits them AHEAD of the root DENY and is fully exposed)
#   protected-with-broad-access inheritance cut AND any ALLOW for a broad SID exists (including inherit-only)
#   null-dacl                   no DACL = everyone full access
function Get-ElvAclClassification {
    param([string]$Sddl, [bool]$IsContainer = $true, [string[]]$BroadSids = $script:BroadSids)
    $out = @()
    if ($Sddl -match 'D:NO_ACCESS_CONTROL') { return @([pscustomobject]@{ issue = 'null-dacl'; detail = $Sddl }) }
    $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($Sddl)
    if ($null -eq $raw.DiscretionaryAcl) { return @([pscustomobject]@{ issue = 'null-dacl'; detail = $Sddl }) }
    $aces = @(Get-ElvAces -Sddl $Sddl)
    $fmt = { param($a) '{0}:0x{1:X}{2}{3}' -f $a.Sid, $a.Mask, $(if ($a.InheritOnly) { '(IO)' } else { '' }), $(if ($a.ObjectInherit -or $a.ContainerInherit) { '(inheritable)' } else { '' }) }
    $explicitBroad = @($aces | Where-Object { -not $_.Inherited -and $_.Type -eq 'AccessAllowed' -and $_.Mask -ne 0 -and ($BroadSids -contains $_.Sid) })
    if ($explicitBroad.Count) { $out += [pscustomobject]@{ issue = 'explicit-broad-allow'; detail = (($explicitBroad | ForEach-Object { & $fmt $_ }) -join ' ') } }
    if (Test-ElvDaclProtected $Sddl) {
        $anyBroad = @($aces | Where-Object { $_.Type -eq 'AccessAllowed' -and $_.Mask -ne 0 -and ($BroadSids -contains $_.Sid) })
        if ($anyBroad.Count) { $out += [pscustomobject]@{ issue = 'protected-with-broad-access'; detail = (($anyBroad | ForEach-Object { & $fmt $_ }) -join ' ') } }
    }
    return $out
}
# True if the path carries a DENY-FullControl ACE for $Sid (inherited or explicit as requested) applying to this object.
function Test-ElvDenyAce {
    param([string]$Path, [string]$Sid, [ValidateSet('any','explicit','inherited')][string]$Kind = 'any', [bool]$RequireInheritable = $false)
    foreach ($a in (Get-ElvAces $Path)) {
        if ($a.Sid -ne $Sid -or $a.Type -ne 'AccessDenied' -or $a.InheritOnly) { continue }
        if (($a.Mask -band 0x1F01FF) -ne 0x1F01FF) { continue }
        if ($Kind -eq 'explicit' -and $a.Inherited) { continue }
        if ($Kind -eq 'inherited' -and -not $a.Inherited) { continue }
        if ($RequireInheritable -and -not ($a.ObjectInherit -and $a.ContainerInherit)) { continue }
        return $true
    }
    return $false
}
# Write-type rights any broad group holds on a path (0 = none).
function Get-ElvBroadWriteMask { param([string]$Path) return ((Get-ElvEffectiveMask $Path $script:BroadSids) -band $script:WriteMask) }
# The SID set a worker token is modelled with: broad SIDs + the identities + the group + (optionally) SIDs captured
# from `whoami /groups /fo csv` under the real worker (H1: replaces guessing once the account exists).
function Get-ElvTokenSidSet {
    param([string[]]$ExtraSids = @(), [string]$CapturedGroupsCsv)
    $set = New-Object System.Collections.ArrayList
    foreach ($s in @($script:BroadSids) + @($ExtraSids | Where-Object { $_ })) { if ($set -notcontains $s) { [void]$set.Add($s) } }
    if ($CapturedGroupsCsv -and (Test-Path -LiteralPath $CapturedGroupsCsv)) {
        foreach ($row in (Import-Csv -LiteralPath $CapturedGroupsCsv)) { $s = $row.SID; if ($s -and $s -notmatch '^S-1-16-' -and $set -notcontains $s) { [void]$set.Add($s) } }
    }
    return @($set)
}

# H2 (pure over an ACL): is a folder/file writable ONLY by SYSTEM/Administrators? Returns problem strings.
function Test-ElvAdminOnlyWritable {
    param([string]$Path, [bool]$RequireProtected = $false)
    $problems = @()
    $acl = Get-Acl -LiteralPath $Path
    $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($script:TrustedWriterSids -notcontains $ownerSid) { $problems += "owner $ownerSid is not SYSTEM/Administrators on $Path" }
    if ($RequireProtected -and -not $acl.AreAccessRulesProtected) { $problems += "inheritance not cut on $Path" }
    foreach ($a in @(Get-ElvAces -Sddl $acl.Sddl)) {
        if ($a.Type -ne 'AccessAllowed') { continue }
        if (($a.Mask -band $script:WriteMask) -and ($script:TrustedWriterSids -notcontains $a.Sid)) { $problems += ('write 0x{0:X} for {1}{2} on {3}' -f ($a.Mask -band $script:WriteMask), $a.Sid, $(if ($a.InheritOnly) { '(IO)' } else { '' }), $Path) }
    }
    return $problems
}

# icacls with a CHECKED exit code and CAPTURED stderr (M1: under $ErrorActionPreference='Stop', a stderr line thrown
# before the exit code was examined). R3-N1: icacls silently drops (OI)/(CI)/(IO) specs on FILES (exit 0) - refused.
function Invoke-ElvIcacls {
    param([string[]]$IcaclsArgs, [bool]$DryRun, $Report, [string]$Path, [string]$Detail)
    if (Test-Path -LiteralPath $Path) {
        $isDir = (Get-Item -LiteralPath $Path -Force).PSIsContainer
        if (-not $isDir -and (@($IcaclsArgs | Where-Object { $_ -match '\((OI|CI|IO|NP)\)' }).Count)) {
            Add-ElvRefusal $Report 'inheritance flags on a FILE are silently dropped by icacls (R3-N1)' $Path; throw "Refusing inheritable ACE spec on file $Path"
        }
    }
    if ($DryRun) { Add-ElvChange $Report 'icacls' $Path "$Detail [icacls $($IcaclsArgs -join ' ')]" $false; return }
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = @(& icacls.exe @IcaclsArgs 2>&1 | ForEach-Object { [string]$_ }); $code = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
    if ($code -ne 0) { Add-ElvRefusal $Report "icacls exit ${code}: $($out -join ' | ')" $Path; throw "icacls failed on ${Path} (exit $code)" }
    $failed = @($out | Where-Object { $_ -match 'Failed processing (\d+) files' -and [int]$Matches[1] -gt 0 })
    if ($failed.Count) { Add-ElvRefusal $Report "icacls reported failed items: $($failed -join ' | ')" $Path; throw "icacls reported failed items on $Path" }
    Add-ElvChange $Report 'icacls' $Path $Detail $true
}

# M2: timestamped ACL backups; the FIRST root SDDL becomes baseline-root.sddl and is never overwritten; the full-tree
# /save exit code is checked. Returns the backup directory.
function Backup-ElvAcl {
    param([string]$Target, [string]$AclDir, [string]$Stamp, [bool]$Full, $Report)
    if (-not (Test-Path -LiteralPath $Target)) { throw "ACL backup target does not exist: $Target" }
    $isDir = (Get-Item -LiteralPath $Target -Force).PSIsContainer
    $sddl = (Get-Acl -LiteralPath $Target).Sddl
    $tag = ($Target.TrimEnd('\') -replace '[:\\$]', '_')
    $tdir = Join-Path $AclDir $tag
    New-Item -ItemType Directory -Force $tdir | Out-Null
    # Native icacls calls only: EAP=Continue so a stderr line does not throw before the exit code is read (M1).
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $o1 = @(& icacls.exe $Target /save (Join-Path $tdir "$Stamp-root.acl") /C /Q 2>&1 | ForEach-Object { [string]$_ }); $c1 = $LASTEXITCODE
    } finally { $ErrorActionPreference = $eap }
    if ($c1 -ne 0) { throw "ACL root backup failed for $Target (exit $c1): $($o1 -join ' | ')" }
    $sddl | Set-Content -Encoding utf8 (Join-Path $tdir "$Stamp-root.sddl")
    $baseline = Join-Path $tdir 'baseline-root.sddl'
    if (-not (Test-Path -LiteralPath $baseline)) { $sddl | Set-Content -Encoding utf8 $baseline; if ($Report) { Add-ElvChange $Report 'backup-baseline' $Target "FIRST pre-change root SDDL recorded: $baseline" $true } }
    elseif ($Report) { Add-ElvChange $Report 'backup-baseline' $Target 'baseline-root.sddl already exists; kept (not overwritten)' $false }
    if ($Full -and $isDir) {
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { $o2 = @(& icacls.exe (Join-Path $Target '*') /save (Join-Path $tdir "$Stamp-full.acl") /T /C /Q 2>&1 | ForEach-Object { [string]$_ }); $c2 = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
        if ($c2 -ne 0) { if ($Report) { Add-ElvRefusal $Report "full-tree ACL backup failed (exit $c2): $(($o2 | Select-Object -Last 3) -join ' | ')" $Target }; throw "Full-tree backup failed for $Target (exit $c2); fix or pass -SkipFullBackup (recorded)." }
    }
    return $tdir
}

# ---------------------------------------------------------------- H2 trusted script location + out-of-band manifest hash
# Canonical SHA256SUMS: '<sha256 lower>  <name>' per *.ps1, sorted ordinal by name, LF line endings, trailing LF, ASCII.
function Get-ElvCanonicalManifest {
    param([hashtable]$Hashes)
    $names = [string[]]@($Hashes.Keys); [Array]::Sort($names, [StringComparer]::Ordinal)
    $lines = @($names | ForEach-Object { '{0}  {1}' -f $Hashes[$_], $_ })
    return (($lines -join "`n") + "`n")
}
function Get-ElvManifestHash {
    param([string]$ManifestPath)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($ManifestPath))) -replace '-', '').ToLower() } finally { $sha.Dispose() }
}
function Get-ElvScriptHashes {
    param([string]$Dir)
    $h = @{}
    foreach ($f in (Get-ChildItem -LiteralPath $Dir -Filter *.ps1 -File)) { $h[$f.Name] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower() }
    return $h
}
# For -Apply: (1) folder, scripts and SHA256SUMS owned by SYSTEM/Administrators and writable by NOBODY else (the owner's
# own SID included: the production task runs non-elevated as the owner), (2) SHA256SUMS complete and matching,
# (3) SHA-256 of SHA256SUMS equals the OUT-OF-BAND value the owner types (-ApprovedManifestHash).
function Assert-ElvTrustedScriptLocation {
    param($Report, [bool]$DryRun, [string]$ApprovedManifestHash = '', [string]$Dir = $PSScriptRoot)
    $problems = @()
    $problems += Test-ElvAdminOnlyWritable $Dir $true
    foreach ($f in (Get-ChildItem -LiteralPath $Dir -Filter *.ps1 -File)) { $problems += Test-ElvAdminOnlyWritable $f.FullName }
    $sums = Join-Path $Dir 'SHA256SUMS'
    if (-not (Test-Path -LiteralPath $sums)) { $problems += 'SHA256SUMS missing' }
    else {
        $problems += Test-ElvAdminOnlyWritable $sums
        $expected = @{}
        foreach ($line in (Get-Content -LiteralPath $sums)) { if ($line -match '^([0-9a-f]{64})\s+(\S+)$') { $expected[$Matches[2]] = $Matches[1] } }
        $actual = Get-ElvScriptHashes $Dir
        foreach ($k in $actual.Keys) {
            if (-not $expected.ContainsKey($k)) { $problems += "unlisted script $k" }
            elseif ($expected[$k] -ne $actual[$k]) { $problems += "hash mismatch $k" }
        }
        foreach ($k in $expected.Keys) { if (-not $actual.ContainsKey($k)) { $problems += "listed but missing $k" } }
        if ((Get-ElvCanonicalManifest $actual) -ne ([IO.File]::ReadAllText($sums))) { $problems += 'SHA256SUMS is not in canonical form (regenerate with Freeze-AdminScripts.ps1)' }
        if (-not $DryRun) {
            if ($ApprovedManifestHash -notmatch '^[0-9a-f]{64}$') { $problems += '-ApprovedManifestHash (64 hex, obtained OUT OF BAND from the review hand-back) is required for -Apply' }
            elseif ((Get-ElvManifestHash $sums) -ne $ApprovedManifestHash.ToLower()) { $problems += 'SHA256SUMS does not match the out-of-band ApprovedManifestHash' }
        }
    }
    if ($problems.Count -eq 0) { Add-ElvCheck $Report 'R7' 'trusted admin-only script location + canonical SHA256SUMS + out-of-band manifest hash' $true; return }
    if ($DryRun) { Add-ElvCheck $Report 'R7' 'trusted admin-only script location + canonical SHA256SUMS + out-of-band manifest hash' 'WARN' ($problems -join '; '); return }
    Add-ElvRefusal $Report ($problems -join '; ') $Dir
    throw 'Apply refused: run only from the frozen, admin-only, hash-verified copy with the out-of-band -ApprovedManifestHash (see Freeze-AdminScripts.ps1 and TRUSTED_INSTALLATION_CHAIN.md).'
}

# Common preamble for every script: mode, elevation, trusted location. Saves the report BEFORE any refusal (M1).
function Initialize-ElvRun {
    param([string]$Name, [bool]$DryRun, [switch]$NoElevationNeeded, [string]$ApprovedManifestHash = '')
    $r = New-ElvReport $Name $DryRun
    $mode = 'APPLY'; if ($DryRun) { $mode = 'DRY-RUN' }
    Write-Host "== $Name ($mode, revision $($script:ElvRevision)) =="
    try {
        if (-not $DryRun -and -not $NoElevationNeeded -and -not (Test-ElvElevation)) { Add-ElvRefusal $r 'Apply mode requires an elevated PowerShell' $Name; throw 'Apply mode requires an elevated PowerShell.' }
        Assert-ElvTrustedScriptLocation $r $DryRun $ApprovedManifestHash
    } catch { Save-ElvReport $r $_; throw }
    return $r
}

# ---------------------------------------------------------------- production invariants (read-only)
# L8: never run git elevated over the (lower-integrity) production repo; read .git\HEAD and refs directly.
function Get-ElvGitHead {
    param([string]$Repo)
    try {
        $head = (Get-Content -LiteralPath (Join-Path $Repo '.git\HEAD') -Raw -ErrorAction Stop).Trim()
        if ($head -match '^ref:\s*(\S+)$') {
            $refFile = Join-Path $Repo ('.git\' + ($Matches[1] -replace '/', '\'))
            if (Test-Path -LiteralPath $refFile) { return (Get-Content -LiteralPath $refFile -Raw).Trim().Substring(0, 7) }
            $packed = Join-Path $Repo '.git\packed-refs'
            if (Test-Path -LiteralPath $packed) { foreach ($l in (Get-Content -LiteralPath $packed)) { if ($l -match "^([0-9a-f]{40})\s+$([regex]::Escape($Matches[1]))$") { return $Matches[1].Substring(0, 7) } } }
            return $null
        }
        return $head.Substring(0, 7)
    } catch { return $null }
}
# I2: the supervisor is the node.exe whose command line runs the production CLI; its PID is reported, not assumed.
function Get-ElvProductionState {
    $t = Get-ScheduledTask -TaskName $script:ProductionTask -ErrorAction SilentlyContinue
    $sup = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$($script:ProductionCliMatch)*" })
    [pscustomobject]@{
        TaskState = $(if ($t) { [string]$t.State } else { 'MISSING' })
        TaskAction = $(if ($t) { ($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | ' } else { '' })
        SupervisorPids = @($sup | ForEach-Object { $_.ProcessId })
        Head = (Get-ElvGitHead $script:ProductionCheckout)
    }
}
function Add-ElvProductionChecks {
    param($Report)
    $s = Get-ElvProductionState
    Add-ElvCheck $Report 'P0' 'production task present and running' ($s.TaskState -eq 'Running') $s.TaskState
    Add-ElvCheck $Report 'P1' 'production supervisor process alive (found by command line)' ($s.SupervisorPids.Count -ge 1) "pids=$($s.SupervisorPids -join ',')"
    Add-ElvCheck $Report 'P2' "production HEAD = $($script:ProductionCommit)" ($s.Head -eq $script:ProductionCommit) "$($s.Head)"
    Add-ElvCheck $Report 'P3' 'production task action still points at the checkout script' ($s.TaskAction -like '*E:\Agent\Personal-agent\scripts\windows\run-supervisor.ps1*') ''
}

# ---------------------------------------------------------------- user rights (secedit), pure parsing helpers
function ConvertFrom-ElvRightsInf {
    param([string[]]$Lines)
    $rights = @{}; $in = $false
    foreach ($l in $Lines) {
        if ($l -match '^\s*\[(.+)\]\s*$') { $in = ($Matches[1] -eq 'Privilege Rights'); continue }
        if ($in -and $l -match '^\s*(Se\w+)\s*=\s*(.*)$') {
            $rights[$Matches[1]] = @($Matches[2].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        }
    }
    return $rights
}
# Returns INF text that sets ONLY the named rights to (current +/- SIDs). Entries are '*S-1-...' or names.
# L2: removal is case-insensitive and terminates.
function New-ElvRightsInf {
    param([hashtable]$Current, [hashtable]$Add = @{}, [hashtable]$Remove = @{})
    $names = @($Add.Keys) + @($Remove.Keys) | Sort-Object -Unique
    $out = @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]')
    foreach ($n in $names) {
        $set = New-Object System.Collections.ArrayList
        if ($Current.ContainsKey($n)) { foreach ($e in $Current[$n]) { [void]$set.Add($e) } }
        if ($Add.ContainsKey($n)) { foreach ($e in $Add[$n]) { if (-not ($set -contains $e)) { [void]$set.Add($e) } } }
        if ($Remove.ContainsKey($n)) { foreach ($e in $Remove[$n]) { $set = [System.Collections.ArrayList]@($set | Where-Object { $_ -ne $e }) } }
        $out += ('{0} = {1}' -f $n, ($set -join ','))
    }
    return ($out -join "`r`n")
}
function Get-ElvCurrentRights {
    $tmp = Join-Path $env:TEMP ("elv-rights-{0}.inf" -f [guid]::NewGuid())
    try {
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { & secedit.exe /export /cfg $tmp /areas USER_RIGHTS /quiet 2>&1 | Out-Null; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
        if ($code -ne 0 -or -not (Test-Path -LiteralPath $tmp)) { throw "secedit /export failed ($code); elevation is required even to read user rights" }
        return (ConvertFrom-ElvRightsInf (Get-Content -LiteralPath $tmp))
    } finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
}
# L3/M8: after /configure the rights are RE-EXPORTED and every requested add/remove is verified; otherwise throw.
function Invoke-ElvRightsChange {
    param($Report, [bool]$DryRun, [hashtable]$Add = @{}, [hashtable]$Remove = @{}, [string]$Label)
    $owner = Get-ElvOwnerContext
    $dir = Join-Path $owner.AdminDir 'rights'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $desc = "add=$(($Add.GetEnumerator() | ForEach-Object { "$($_.Key):$($_.Value -join '+')" }) -join ';') remove=$(($Remove.GetEnumerator() | ForEach-Object { "$($_.Key):$($_.Value -join '+')" }) -join ';')"
    if ($DryRun) { Add-ElvChange $Report 'secedit' 'USER_RIGHTS' "$Label $desc (backup export to $dir; re-export + verify after configure)" $false; return }
    New-Item -ItemType Directory -Force $dir | Out-Null
    $exp = Join-Path $dir "rights-before-$Label-$stamp.inf"
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        & secedit.exe /export /cfg $exp /areas USER_RIGHTS /quiet 2>&1 | Out-Null; $code = $LASTEXITCODE
        if ($code -ne 0) { throw "secedit /export failed ($code)" }
        $cur = ConvertFrom-ElvRightsInf (Get-Content -LiteralPath $exp)
        $inf = Join-Path $dir "rights-apply-$Label-$stamp.inf"
        New-ElvRightsInf -Current $cur -Add $Add -Remove $Remove | Set-Content -Encoding Unicode -LiteralPath $inf
        & secedit.exe /configure /db (Join-Path $dir "secedit-$stamp.sdb") /cfg $inf /areas USER_RIGHTS /quiet 2>&1 | Out-Null; $code = $LASTEXITCODE
        if ($code -ne 0) { throw "secedit /configure failed ($code)" }
    } finally { $ErrorActionPreference = $eap }
    $after = Get-ElvCurrentRights
    $bad = @()
    foreach ($n in $Add.Keys) { foreach ($e in $Add[$n]) { if (-not ($after.ContainsKey($n) -and ($after[$n] -contains $e))) { $bad += "add $n $e not present after configure" } } }
    foreach ($n in $Remove.Keys) { foreach ($e in $Remove[$n]) { if ($after.ContainsKey($n) -and ($after[$n] -contains $e)) { $bad += "remove $n $e still present after configure (secedit may ignore an empty right line; remove it manually with ntrights/secpol)" } } }
    if ($bad.Count) { Add-ElvRefusal $Report ($bad -join '; ') 'USER_RIGHTS'; throw "User-rights verification failed: $($bad -join '; ')" }
    Add-ElvChange $Report 'secedit' 'USER_RIGHTS' "$Label $desc (before: $exp; verified by re-export)" $true
}
# secedit exports entries as '*SID' or (for some accounts) as names; accept either form.
function Test-ElvRightHeld {
    param([hashtable]$Rights, [string]$Right, [string]$Sid, [string]$Name)
    if (-not $Rights.ContainsKey($Right)) { return $false }
    foreach ($e in $Rights[$Right]) { if ($e -eq "*$Sid" -or $e -ieq $Name -or $e -ieq "$env:COMPUTERNAME\$Name") { return $true } }
    return $false
}

# ---------------------------------------------------------------- IPv4 complement (pure)
function ConvertTo-ElvUInt32 { param([string]$Ip) $b = ([Net.IPAddress]::Parse($Ip)).GetAddressBytes(); [Array]::Reverse($b); [BitConverter]::ToUInt32($b, 0) }
function ConvertFrom-ElvUInt32 { param([uint32]$N) $b = [BitConverter]::GetBytes($N); [Array]::Reverse($b); ([Net.IPAddress]$b).ToString() }
# L6: dotted-decimal only, no leading zeros (IPAddress.Parse reads 010 as octal), each octet 0-255.
function Get-ElvIPv4Range {
    param([string]$Cidr)
    if ($Cidr -notmatch '^((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})/(\d{1,2})$') { throw "Not a strict IPv4 CIDR (no leading zeros): $Cidr" }
    $octets = $Matches[1].Split('.'); foreach ($o in $octets) { if ([int]$o -gt 255) { throw "Bad octet in $Cidr" } }
    $len = [int]$Matches[2]; if ($len -lt 0 -or $len -gt 32) { throw "Bad prefix: $Cidr" }
    $base = [uint64](ConvertTo-ElvUInt32 $Matches[1]); $size = [uint64][math]::Pow(2, 32 - $len)
    $start = $base - ($base % $size)
    return [pscustomobject]@{ S = $start; E = ($start + $size - 1) }
}
# Ranges of the IPv4 space NOT covered by the given CIDRs, as "a.b.c.d-w.x.y.z" strings for -RemoteAddress.
function Get-ElvIPv4Complement {
    param([string[]]$ExcludeCidrs)
    $r = @($ExcludeCidrs | ForEach-Object { Get-ElvIPv4Range $_ } | Sort-Object S)
    $out = @(); $next = [uint64]0
    foreach ($x in $r) {
        if ($x.S -gt $next) { $out += ('{0}-{1}' -f (ConvertFrom-ElvUInt32 ([uint32]$next)), (ConvertFrom-ElvUInt32 ([uint32]($x.S - 1)))) }
        if ($x.E + 1 -gt $next) { $next = $x.E + 1 }
    }
    if ($next -le [uint64]4294967295) { $out += ('{0}-255.255.255.255' -f (ConvertFrom-ElvUInt32 ([uint32]$next))) }
    if ($out.Count -eq 0) { throw 'Refusing an EMPTY block set: the allow CIDRs cover the whole IPv4 space (L6).' }
    return $out
}

# ---------------------------------------------------------------- H4 firewall rule predicate (pure)
# A worker rule counts only if it is enabled, outbound, Block, and its LocalUser SDDL names EXACTLY the current worker SID.
function Test-ElvWorkerFirewallRule {
    param($Rule, [string]$LocalUserSddl, [string[]]$RemoteAddresses, [string]$WorkerSid, [string[]]$ExpectedRemote = $null)
    if ($null -eq $Rule) { return $false }
    if ([string]$Rule.Enabled -ne 'True' -or [string]$Rule.Action -ne 'Block' -or [string]$Rule.Direction -ne 'Outbound') { return $false }
    if (-not $WorkerSid) { return $false }
    if ($LocalUserSddl -notmatch ('\(A;;CC;;;' + [regex]::Escape($WorkerSid) + '\)')) { return $false }   # L9: exact SID token
    if ($null -ne $ExpectedRemote) {
        $a = @($RemoteAddresses | ForEach-Object { [string]$_ } | Sort-Object); $e = @($ExpectedRemote | ForEach-Object { [string]$_ } | Sort-Object)
        if (($a -join ',') -ne ($e -join ',')) { return $false }
    }
    return $true
}
function Get-ElvWorkerFirewallState {
    param([string]$WorkerSid)
    $out = @{}
    foreach ($n in "$($script:ElvFirewallPrefix)-Block-IPv4", "$($script:ElvFirewallPrefix)-Block-IPv6") {
        $fw = Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue
        $sec = ''; $addr = @()
        if ($fw) { $sec = [string]($fw | Get-NetFirewallSecurityFilter).LocalUser; $addr = @(($fw | Get-NetFirewallAddressFilter).RemoteAddress) }
        $out[$n] = [pscustomobject]@{ Rule = $fw; LocalUser = $sec; Remote = $addr; Ok = (Test-ElvWorkerFirewallRule $fw $sec $addr $WorkerSid) }
    }
    return $out
}
function Test-ElvFirewallProfilesEnforcing {
    $p = @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop)
    $bad = @($p | Where-Object { [string]$_.Enabled -ne 'True' -or [string]$_.AllowLocalFirewallRules -eq 'False' })
    return ($bad.Count -eq 0)
}

# ---------------------------------------------------------------- H5 shadow copies (fail closed)
function Get-ElvShadowCopies {
    if (-not (Test-ElvElevation)) { throw 'UNKNOWN: shadow copies cannot be enumerated without elevation (fail closed).' }
    $sc = @(Get-CimInstance Win32_ShadowCopy -ErrorAction Stop)
    $vols = @{}; foreach ($v in @(Get-CimInstance Win32_Volume -ErrorAction Stop)) { $vols[$v.DeviceID] = $v.DriveLetter }
    return @($sc | ForEach-Object { [pscustomobject]@{ Id = $_.ID; Device = $_.DeviceObject; VolumeDevice = $_.VolumeName; Drive = $vols[$_.VolumeName]; InstallDate = $_.InstallDate } })
}
# Drives that hold DENY targets (shadow copies of these volumes keep the pre-DENY ACLs).
function Get-ElvDenyTargetDrives { param([string[]]$Targets) return @($Targets | ForEach-Object { $_.Substring(0, 2).ToUpper() } | Sort-Object -Unique) }
function Test-ElvNoPreDenyShadows {
    param([string[]]$Targets, [datetime]$AppliedAt)
    $drives = Get-ElvDenyTargetDrives $Targets
    $sc = Get-ElvShadowCopies   # throws when not elevated
    $stale = @($sc | Where-Object { $_.Drive -and ($drives -contains $_.Drive.TrimEnd('\').ToUpper()) -and ($_.InstallDate -lt $AppliedAt) })
    return [pscustomobject]@{ Ok = ($stale.Count -eq 0); Stale = $stale; All = $sc }
}

# ---------------------------------------------------------------- walker, sweep, verify (shared by 00 and the tests)
# Walks roots without following reparse points. Enumeration errors are captured (unlistable), never swallowed.
function Invoke-ElvWalk {
    param([string[]]$Roots, [scriptblock]$OnItem, [scriptblock]$OnUnlistable, [string[]]$SkipNames = $script:ElvSweepSkipNames, [scriptblock]$OnSkipped)
    $skipRx = '\\(' + (($SkipNames | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')(\\|$)'
    foreach ($root in $Roots) {
        $ri = Get-Item -LiteralPath $root -Force
        & $OnItem $ri
        if ($ri.PSIsContainer -and -not ($ri.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            $enumErr = $null
            Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable +enumErr | ForEach-Object {
                if ($SkipNames.Count -and ($_.FullName -match $skipRx)) { if ($OnSkipped -and $_.PSIsContainer -and ($SkipNames -contains $_.Name)) { & $OnSkipped $_ }; return }
                & $OnItem $_
            }
            foreach ($e in @($enumErr)) { & $OnUnlistable ([string]$e.TargetObject) $e.Exception.Message }
            $enumErr = $null
        }
    }
}
function New-ElvCsvWriter { param([string]$Path, [string[]]$Header)
    $w = New-Object System.IO.StreamWriter($Path, $false, (New-Object System.Text.UTF8Encoding($true)))
    $w.WriteLine((($Header | ForEach-Object { '"' + $_ + '"' }) -join ',')); return $w
}
function Write-ElvCsvRow { param($Writer, [string[]]$Values) $Writer.WriteLine((($Values | ForEach-Object { '"' + ([string]$_ -replace '"', '""') + '"' }) -join ',')); $Writer.Flush() }

# B1-fixed sweep. Rows: explicit-broad-allow, protected-with-broad-access, null-dacl, unreadable, unlistable,
# reparse-point (not followed; WARN), skipped-root (INFO). Returns rows (path+issue only) and stats.
function Invoke-ElvSweep {
    param([string[]]$Roots, [string]$OutCsv, [string[]]$RootSet, [string[]]$BroadSids = $script:BroadSids)
    $rows = New-Object System.Collections.ArrayList
    $stats = @{ items = 0; unreadable = 0; unlistable = 0; reparse = 0; skipped = 0; findings = 0 }
    $w = New-ElvCsvWriter $OutCsv @('path', 'issue', 'detail')
    $emit = { param($p, $i, $d) Write-ElvCsvRow $w @($p, $i, $d); [void]$rows.Add([pscustomobject]@{ path = $p; issue = $i }) }
    $onItem = { param($item)
        $fp = $item.FullName
        $stats.items++
        if ($stats.items % 20000 -eq 0) { Write-Host "    swept $($stats.items) ..."; [GC]::Collect() }
        if ($RootSet -contains $fp.TrimEnd('\')) { return }   # deny-target roots: their ACL is in the root baselines
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $stats.reparse++
            $tgt = @($item.Target) -join ';'
            $inside = $false; try { $inside = [bool](@($RootSet | Where-Object { $tgt -and (Test-ElvUnder $tgt "$_\") }).Count) } catch {}
            & $emit $fp 'reparse-point' ("{0} -> {1} (target {2} a DENY target)" -f $item.LinkType, $tgt, $(if ($inside) { 'inside' } else { 'OUTSIDE' }))
        }
        try {
            $sddl = (Get-Acl -LiteralPath $fp).Sddl
            foreach ($c in @(Get-ElvAclClassification -Sddl $sddl -IsContainer $item.PSIsContainer -BroadSids $BroadSids)) { $stats.findings++; & $emit $fp $c.issue $c.detail }
        } catch { $stats.unreadable++; & $emit $fp 'unreadable' $_.Exception.Message }
    }
    $onUnlistable = { param($p, $m) $stats.unlistable++; & $emit $p 'unlistable' $m }
    $onSkipped = { param($item) $stats.skipped++; & $emit $item.FullName 'skipped-root' 'excluded by design (not swept)' }
    try { Invoke-ElvWalk -Roots $Roots -OnItem $onItem -OnUnlistable $onUnlistable -OnSkipped $onSkipped } finally { $w.Close() }
    Write-Host ("    SWEEP-SUMMARY items={0} findings={1} unreadable={2} unlistable={3} reparse={4} skipped={5} -> {6}" -f $stats.items, $stats.findings, $stats.unreadable, $stats.unlistable, $stats.reparse, $stats.skipped, $OutCsv)
    return [pscustomobject]@{ Rows = @($rows); Stats = $stats }
}
# H1: per-object verification AFTER the DENY. For every item the modelled worker-token mask must be 0.
# Rows: exposed (mask != 0), unreadable, unlistable, reparse-point, skipped-root. Configuration evidence only.
function Invoke-ElvObjectVerify {
    param([string[]]$Roots, [string]$OutCsv, [string[]]$RootSet, [string[]]$TokenSids)
    $rows = New-Object System.Collections.ArrayList
    $stats = @{ items = 0; exposed = 0; unreadable = 0; unlistable = 0; reparse = 0; skipped = 0 }
    $w = New-ElvCsvWriter $OutCsv @('path', 'issue', 'detail')
    $emit = { param($p, $i, $d) Write-ElvCsvRow $w @($p, $i, $d); [void]$rows.Add([pscustomobject]@{ path = $p; issue = $i }) }
    $onItem = { param($item)
        $fp = $item.FullName
        $stats.items++
        if ($stats.items % 20000 -eq 0) { Write-Host "    verified $($stats.items) ..."; [GC]::Collect() }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $stats.reparse++; & $emit $fp 'reparse-point' ("{0} -> {1} (not followed)" -f $item.LinkType, (@($item.Target) -join ';')) }
        try {
            $aces = @(Get-ElvAces $fp)
            $m = Get-ElvEffectiveMask $fp $TokenSids -Aces $aces
            if ($m -ne 0) { $stats.exposed++; & $emit $fp 'exposed' ('0x{0:X}' -f $m) }
        } catch { $stats.unreadable++; & $emit $fp 'unreadable' $_.Exception.Message }
    }
    $onUnlistable = { param($p, $m) $stats.unlistable++; & $emit $p 'unlistable' $m }
    $onSkipped = { param($item) $stats.skipped++; & $emit $item.FullName 'skipped-root' 'excluded by design (not verified)' }
    try { Invoke-ElvWalk -Roots $Roots -OnItem $onItem -OnUnlistable $onUnlistable -OnSkipped $onSkipped } finally { $w.Close() }
    Write-Host ("    VERIFY-SUMMARY items={0} exposed={1} unreadable={2} unlistable={3} reparse={4} skipped={5} -> {6}" -f $stats.items, $stats.exposed, $stats.unreadable, $stats.unlistable, $stats.reparse, $stats.skipped, $OutCsv)
    return [pscustomobject]@{ Rows = @($rows); Stats = $stats }
}
# Chunk records (M8/H1): each chunked run writes one; -Finalize merges them and checks COVERAGE against the live
# top level of every target. Coverage = every top-level child of every target is inside some chunk root (or the
# target itself was a chunk root). The target roots themselves are checked directly at finalize time.
function Write-ElvChunkRecord {
    param([bool]$DryRun, [string]$Kind, [string[]]$Roots, $Stats, [string]$Csv, [string]$AppliedRef = '')
    $rec = [pscustomobject]@{ kind = $Kind; revision = $script:ElvRevision; at = (Get-Date).ToString('o'); elevated = (Test-ElvElevation)
        user = [Security.Principal.WindowsIdentity]::GetCurrent().Name; roots = @($Roots | ForEach-Object { (Get-ElvCanonicalPath $_).TrimEnd('\') })
        stats = $Stats; csv = $Csv; appliedRef = $AppliedRef }
    return (Write-ElvState $DryRun "$Kind-chunk" $rec -Timestamped)
}
function Get-ElvChunkRecords {
    param([bool]$DryRun, [string]$Kind, [datetime]$Since)
    $dir = Get-ElvStateDir $DryRun
    @(Get-ChildItem -LiteralPath $dir -Filter "$Kind-chunk-*.json" -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json } |
        Where-Object { $_.kind -eq $Kind -and ([datetime]$_.at) -ge $Since })
}
function Test-ElvChunkCoverage {
    param($Records, [string[]]$Targets)
    $chunkRoots = @($Records | ForEach-Object { @($_.roots) } | ForEach-Object { [string]$_ })
    $missing = @()
    foreach ($t in $Targets) {
        $tk = (Get-ElvCanonicalPath $t).TrimEnd('\')
        if ($chunkRoots | Where-Object { $_ -ieq $tk }) { continue }   # the whole target was a chunk root
        if (-not (Test-Path -LiteralPath $t)) { continue }
        foreach ($child in @(Get-ChildItem -LiteralPath $t -Force -ErrorAction Stop)) {
            if ($script:ElvSweepSkipNames -contains $child.Name) { continue }
            $ck = $child.FullName.TrimEnd('\')
            if (-not ($chunkRoots | Where-Object { $_ -ieq $ck -or (Test-ElvUnder $ck $_) })) { $missing += $ck }
        }
    }
    return $missing
}

# ---------------------------------------------------------------- staging layout (single source of truth)
# Rights per principal key: W=worker B=broker O=owner. 'DENY' = explicit deny Full. All dirs: inheritance reset;
# SYSTEM + Administrators always Full. 'RX-this' = read/list this folder only (no inheritance).
# M9: 'WD-this' = add-file on this folder only (no list, no delete, no write to existing files); OwnerRights adds an
# inheritable OWNER RIGHTS (S-1-3-4) ACE with READ_CONTROL only, so the worker gets NO implicit WRITE_DAC on files it
# creates. 'RX+D' (I4) = read + delete (consume) for the broker. 'bin' is admin-write-only (launcher integrity, M11).
$script:ElvLayout = @(
    @{ Rel = '';                 W = 'RX-this'; B = 'RX-this'; O = 'F' },
    @{ Rel = 'bin';              W = 'RX';      B = $null;     O = 'RX' },
    @{ Rel = 'work';             W = 'M';       B = $null;     O = 'F' },
    @{ Rel = 'home';             W = 'M';       B = $null;     O = 'F' },
    @{ Rel = 'broker';           W = 'DENY';    B = 'RX-this'; O = 'F' },
    @{ Rel = 'broker\bin';       W = 'DENY';    B = 'RX';      O = 'RX' },
    @{ Rel = 'broker\state';     W = 'DENY';    B = 'M';       O = 'F' },
    @{ Rel = 'spool';            W = 'RX-this'; B = 'RX-this'; O = 'F' },
    @{ Rel = 'spool\requests';   W = 'WD-this'; B = 'M';       O = 'F'; OwnerRights = $true },
    @{ Rel = 'spool\approvals';  W = 'DENY';    B = 'RX+D';    O = 'M' },
    @{ Rel = 'spool\decisions';  W = 'RX';      B = 'M';       O = 'F' },
    @{ Rel = 'decoys';           W = 'DENY';    B = $null;     O = 'F' }
)
$script:ElvWorkerWritableRels = @('work', 'home', 'spool\requests')
# Does an evaluated mask match a layout spec? (configuration semantics, not an access test)
function Test-ElvSpec {
    param([long]$Mask, [string]$Spec)
    switch ($Spec) {
        ''        { return ($Mask -eq 0) }   # [string]$null arrives as ''
        'DENY'    { return ($Mask -eq 0) }
        'RX-this' { return [bool](($Mask -band 0x1) -and -not ($Mask -band $script:WriteMask)) }
        'RX'      { return [bool](($Mask -band 0x1) -and -not ($Mask -band $script:WriteMask)) }
        'RX+D'    { return [bool](($Mask -band 0x1) -and ($Mask -band 0x10000) -and -not ($Mask -band 0xC0156)) }
        'W'       { return [bool](($Mask -band 0x2) -and -not ($Mask -band 0x1) -and -not ($Mask -band 0xD0040)) }
        'WD-this' { return [bool](($Mask -band 0x2) -and -not ($Mask -band 0x1) -and -not ($Mask -band 0xD0154)) }
        'M'       { return [bool]((($Mask -band 0x3) -eq 0x3) -and ($Mask -band 0x10000) -and -not ($Mask -band 0xC0000)) }
        'F'       { return (($Mask -band 0x1F01FF) -eq 0x1F01FF) }
    }
    return $false
}
function Test-ElvSpecInheritable { param([string]$Spec) return ($Spec -and $Spec -notmatch '-this$') }
# L7: evaluate every layout directory for broad groups, worker and broker token SID sets, AND require that no broad
# ACE of any kind exists (inherit-only included) and that each identity's ACE carries the expected inheritance flags.
function Test-ElvLayout {
    param($Report, [string]$WorkerSid, [string]$BrokerSid, [string]$GroupSid)
    $wTok = Get-ElvTokenSidSet @($WorkerSid, $GroupSid); $bTok = Get-ElvTokenSidSet @($BrokerSid, $GroupSid)
    foreach ($d in $script:ElvLayout) {
        $path = $script:ElvStagingRoot; if ($d.Rel) { $path = Join-Path $script:ElvStagingRoot $d.Rel }
        $name = '\' + $d.Rel
        if (-not (Test-Path -LiteralPath $path)) { Add-ElvCheck $Report 'L' "layout dir exists: $name" $false; continue }
        $aces = @(Get-ElvAces $path)
        Add-ElvCheck $Report 'L0' "no broad-group access: $name" ((Get-ElvEffectiveMask $path $script:BroadSids -Aces $aces) -eq 0)
        $broadAny = @($aces | Where-Object { $_.Type -eq 'AccessAllowed' -and ($script:BroadSids -contains $_.Sid) })
        Add-ElvCheck $Report 'L0b' "no broad ACE of any kind (incl. inherit-only): $name" ($broadAny.Count -eq 0) (($broadAny | ForEach-Object { $_.Sid }) -join ',')
        $wm = Get-ElvEffectiveMask $path $wTok -Aces $aces; $bm = Get-ElvEffectiveMask $path $bTok -Aces $aces
        Add-ElvCheck $Report 'L1' "worker = $($d.W): $name" (Test-ElvSpec $wm $d.W) ('0x{0:X}' -f $wm)
        Add-ElvCheck $Report 'L2' "broker = $($d.B): $name" (Test-ElvSpec $bm $d.B) ('0x{0:X}' -f $bm)
        foreach ($k in @(@{ K = 'W'; S = $WorkerSid }, @{ K = 'B'; S = $BrokerSid })) {
            $spec = $d[$k.K]; if (-not $spec -or $spec -eq 'DENY') { continue }
            $mine = @($aces | Where-Object { $_.Sid -eq $k.S -and $_.Type -eq 'AccessAllowed' -and -not $_.Inherited })
            if (Test-ElvSpecInheritable $spec) { $ok = [bool]@($mine | Where-Object { $_.ObjectInherit -and $_.ContainerInherit }).Count }
            else { $ok = ($mine.Count -ge 1) -and -not [bool]@($mine | Where-Object { $_.ObjectInherit -or $_.ContainerInherit }).Count }
            Add-ElvCheck $Report 'L4' "$($k.K) ACE inheritance flags match '$spec': $name" $ok
        }
        if ($d.W -eq 'DENY') { Add-ElvCheck $Report 'L3' "explicit worker DENY ACE present: $name" (Test-ElvDenyAce $path $WorkerSid 'explicit' $true) }
        if ($d.OwnerRights) { Add-ElvCheck $Report 'L5' "OWNER RIGHTS inherit-only RC ACE present: $name" ([bool]@($aces | Where-Object { $_.Sid -eq $script:SidOwnerRights -and $_.InheritOnly -and $_.ObjectInherit -and ($_.Mask -band 0x20000) -and -not ($_.Mask -band 0xFFFDFFFF) }).Count) }
    }
}
function ConvertTo-ElvGrant {
    param([string]$Sid, [string]$Spec)
    switch ($Spec) {
        'RX-this' { return @('/grant:r', "*${Sid}:(RX)") }
        'WD-this' { return @('/grant:r', "*${Sid}:(WD)") }
        'RX+D'    { return @('/grant:r', "*${Sid}:(OI)(CI)(RX,DE)") }
        'DENY'    { return @('/deny', "*${Sid}:(OI)(CI)F") }
        default   { return @('/grant:r', "*${Sid}:(OI)(CI)$Spec") }
    }
}
# L12: any reparse point under a worker-writable layout dir blocks a re-run of 03 (propagation vs junctions unverified).
function Get-ElvReparsePointsUnder {
    param([string[]]$Dirs)
    $out = @()
    foreach ($d in $Dirs) {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        $out += @(Get-ChildItem -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | ForEach-Object { $_.FullName })
    }
    return $out
}
