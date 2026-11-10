# ELEVARIQ worker-isolation admin scripts, revision r2 (2026-11-10). Shared helpers.
#
# DESIGN ARTIFACTS. Every script defaults to -DryRun and changes nothing unless the OWNER runs it with -Apply from an
# elevated shell. The agent never runs -Apply.
#
# r2 changes vs r1 (ISOLATION_IMPLEMENTATION_PLAN.md section R):
#   R-1 new 00: empty deny group + inheritable DENY on owner data volumes, with sweep, backups, verification
#   R-2 staging root is a size-capped VHDX volume with a protected root ACL (r1 root inherited AU:Modify from C:\)
#   R-3 identities are created DISABLED and joined to the deny group before anything else
#   R-4 verification compares parsed ACEs by SID (r1 regex "$script:X:\(N\)" collapsed to "\(N\)"); it is labelled
#       a CONFIGURATION check, not an access test
#   R-5 egress: ONE block rule on the complement of (loopback + owner-supplied allow CIDRs); errors are fatal
#   R-6 broker runs as its own identity elv-stg-broker (not the owner, not the worker)
#   R-7 -Apply refuses to run unless the scripts sit in a location no broad group can write AND match SHA256SUMS
#   R-8 rollback covers group, DENY ACEs, VHDX, both identities, user rights, tasks, firewall
#
# PowerShell 5.1 compatible. Interpolate scope-qualified variables followed by ':' as "${script:Name}:".

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- constants
$script:ElvRevision        = 'r2-20261110'
$script:ElvGroup           = 'ElevariqIsolatedIdentities'
$script:ElvWorkerAccount   = 'elv-stg-worker'
$script:ElvBrokerAccount   = 'elv-stg-broker'

$script:ElvStagingRoot     = 'C:\ElevariqStaging'                 # mount point of the staging VHDX volume
$script:ElvDiskDir         = 'C:\ElevariqStagingDisk'             # holds the VHDX file (admin/SYSTEM only)
$script:ElvVhdxPath        = 'C:\ElevariqStagingDisk\elv-staging.vhdx'
$script:ElvVhdxMaxMB       = 40960
$script:ElvVolumeLabel     = 'ELVSTG'

$script:ElvWorkerTask      = 'ElevariqStagingWorker'
$script:ElvBrokerTask      = 'ElevariqStagingBroker'
$script:ElvDiskTask        = 'ElevariqStagingDiskAttach'
$script:ElvFirewallPrefix  = 'ELEVARIQ-STG-Worker'
$script:ElvFirewallGroup   = 'ELEVARIQ Staging Isolation'

# Owner data locations that must be denied to the isolation group (measured 2026-11-10; extend from the sweep).
$script:ElvDenyRoots       = @('E:\', 'F:\')
$script:ElvDenyFolders     = @('C:\Download', 'C:\Intel', 'D:\src', 'D:\Intel')

# Production objects. Never a privileged target of any script.
$script:ProductionCheckout = 'E:\Agent\Personal-agent'
$script:ProductionTask     = 'ElevariqPersonalAgent'
$script:ProductionPid      = 8992
$script:ProductionCommit   = 'e60278f'

# Well-known SIDs.
$script:SidSystem = 'S-1-5-18'; $script:SidAdmins = 'S-1-5-32-544'
$script:BroadSids = @('S-1-1-0','S-1-5-32-545','S-1-5-11','S-1-5-4','S-1-5-3','S-1-5-15','S-1-5-113','S-1-2-0','S-1-2-1','S-1-3-0')

# ---------------------------------------------------------------- reporting
function New-ElvReport {
    param([string]$ScriptName, [bool]$DryRun)
    $dir = Join-Path $PSScriptRoot 'reports'
    New-Item -ItemType Directory -Force $dir | Out-Null
    [pscustomobject]@{
        script = $ScriptName; revision = $script:ElvRevision; startedAt = (Get-Date).ToString('o'); dryRun = $DryRun
        user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        changes = New-Object System.Collections.ArrayList; refusals = New-Object System.Collections.ArrayList
        checks = New-Object System.Collections.ArrayList
        path = (Join-Path $dir ('{0}-{1}.json' -f $ScriptName, (Get-Date -Format 'yyyyMMdd-HHmmss')))
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
    [void]$Report.refusals.Add([pscustomobject]@{ reason = $Reason; target = $Target })
    Write-Warning ('  REFUSED: {0} ({1})' -f $Reason, $Target)
}
function Add-ElvCheck {
    param($Report, [string]$Id, [string]$Name, $Result, [string]$Detail = '')
    $status = 'FAIL'; if ($Result -eq $true) { $status = 'PASS' } elseif ($Result -is [string]) { $status = $Result }
    [void]$Report.checks.Add([pscustomobject]@{ id = $Id; name = $Name; status = $status; detail = $Detail })
    Write-Host ('  [{0}] {1} {2} {3}' -f $status, $Id, $Name, $Detail)
}
function Save-ElvReport {
    param($Report)
    $Report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $Report.path
    $mode = 'APPLY'; if ($Report.dryRun) { $mode = 'DRY-RUN' }
    Write-Host ("`nReport: {0}`nChanges: {1}  Refusals: {2}  Checks: {3}  Mode: {4}" -f $Report.path, $Report.changes.Count, $Report.refusals.Count, $Report.checks.Count, $mode)
}

# ---------------------------------------------------------------- environment
function Test-ElvElevation {
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    $p.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}
function Get-ElvOwnerContext {
    param([string]$OwnerAccount = $env:USERNAME)
    $u = $null; try { $u = Get-LocalUser -Name $OwnerAccount -ErrorAction Stop } catch {}
    if (-not $u) { throw "Owner account '$OwnerAccount' is not a local account." }
    $sid = $u.SID.Value
    if ($sid -notmatch '^S-1-5-21-') { throw "Owner SID $sid is not a local account SID." }
    $profile = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid" -ErrorAction Stop).ProfileImagePath
    [pscustomobject]@{ Account = $OwnerAccount; Sid = $sid; Profile = $profile; AdminDir = (Join-Path $profile 'ElevariqAdmin') }
}
function Resolve-ElvLocalSid {
    param([string]$Account, [bool]$MustExist = $false)
    $m = @(Get-LocalUser -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $Account })
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

# ---------------------------------------------------------------- path guards
function Get-ElvCanonicalPath { param([string]$Path) try { return [IO.Path]::GetFullPath($Path) } catch { return $Path } }
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
    return (Get-ElvCanonicalPath $Path)
}
# 00 may only place DENY ACEs on the listed roots/folders and on swept paths the owner passes explicitly.
function Assert-DenyTarget {
    param($Report, [string]$Path, [string[]]$Additional = @())
    $c = Get-ElvCanonicalPath $Path
    $allowed = @($script:ElvDenyRoots + $script:ElvDenyFolders + $Additional) | ForEach-Object { Get-ElvCanonicalPath $_ }
    if (-not ($allowed | Where-Object { $_.TrimEnd('\') -ieq $c.TrimEnd('\') })) {
        Add-ElvRefusal $Report 'not an approved DENY target' $c; throw "Not an approved DENY target: $c"
    }
    if ($c -match '^[A-Za-z]:\\$') { return $c }   # a volume root is allowed even though production lives below it
    Assert-ElvNotProduction $Report $c
    return $c
}

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
    $raw =New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)
    foreach ($ace in $raw.DiscretionaryAcl) {
        [pscustomobject]@{
            Sid = $ace.SecurityIdentifier.Value; Type = [string]$ace.AceQualifier
            Mask = Expand-ElvMask ([long]$ace.AccessMask -band 0xFFFFFFFFL)
            Inherited = [bool](([int]$ace.AceFlags) -band 0x10); InheritOnly = [bool](([int]$ace.AceFlags) -band 0x08)
            ObjectInherit = [bool](([int]$ace.AceFlags) -band 0x01); ContainerInherit = [bool](([int]$ace.AceFlags) -band 0x02)
        }
    }
}
# Ordered DACL evaluation for a SID set (DACL only; no privileges/labels). Returns the granted mask.
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
# Write-type rights any broad group holds on a path (0 = none). Used for the trusted-location check and volume root.
function Get-ElvBroadWriteMask { param([string]$Path) return ((Get-ElvEffectiveMask $Path $script:BroadSids) -band 0xD0156) }

# icacls with a CHECKED exit code (icacls does not throw).
function Invoke-ElvIcacls {
    param([string[]]$IcaclsArgs, [bool]$DryRun, $Report, [string]$Path, [string]$Detail)
    if ($DryRun) { Add-ElvChange $Report 'icacls' $Path "$Detail [icacls $($IcaclsArgs -join ' ')]" $false; return }
    $out = & icacls.exe @IcaclsArgs 2>&1
    if ($LASTEXITCODE -ne 0) { Add-ElvRefusal $Report "icacls exit ${LASTEXITCODE}: $($out -join ' ')" $Path; throw "icacls failed on $Path" }
    Add-ElvChange $Report 'icacls' $Path $Detail $true
}

# ---------------------------------------------------------------- R-7 trusted script location
# For -Apply: (1) the script folder and every script must be writable by NO broad group, (2) SHA256SUMS must match.
function Assert-ElvTrustedScriptLocation {
    param($Report, [bool]$DryRun)
    $problems = @()
    $items = @((Get-Item -LiteralPath $PSScriptRoot)) + @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1 -File)
    foreach ($i in $items) { if ((Get-ElvBroadWriteMask $i.FullName) -ne 0) { $problems += "broad write on $($i.FullName)" } }
    $sums = Join-Path $PSScriptRoot 'SHA256SUMS'
    if (-not (Test-Path -LiteralPath $sums)) { $problems += 'SHA256SUMS missing' }
    else {
        $expected = @{}
        foreach ($line in (Get-Content -LiteralPath $sums)) { if ($line -match '^([0-9a-f]{64})\s+(\S+)$') { $expected[$Matches[2]] = $Matches[1] } }
        foreach ($f in (Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1 -File)) {
            $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
            if (-not $expected.ContainsKey($f.Name)) { $problems += "unlisted script $($f.Name)" }
            elseif ($expected[$f.Name] -ne $h) { $problems += "hash mismatch $($f.Name)" }
        }
        foreach ($k in $expected.Keys) { if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $k))) { $problems += "listed but missing $k" } }
    }
    if ($problems.Count -eq 0) { Add-ElvCheck $Report 'R7' 'trusted script location + SHA256SUMS' $true; return }
    if ($DryRun) { Add-ElvCheck $Report 'R7' 'trusted script location + SHA256SUMS' 'WARN' ($problems -join '; '); return }
    Add-ElvRefusal $Report ($problems -join '; ') $PSScriptRoot
    throw 'Apply refused: run only from the frozen, owner-only, hash-verified copy (see Freeze-AdminScripts.ps1).'
}

# Common preamble for every script: mode, elevation, trusted location.
function Initialize-ElvRun {
    param([string]$Name, [bool]$DryRun, [switch]$NoElevationNeeded)
    $r = New-ElvReport $Name $DryRun
    $mode = 'APPLY'; if ($DryRun) { $mode = 'DRY-RUN' }
    Write-Host "== $Name ($mode, revision $($script:ElvRevision)) =="
    if (-not $DryRun -and -not $NoElevationNeeded -and -not (Test-ElvElevation)) { throw 'Apply mode requires an elevated PowerShell.' }
    Assert-ElvTrustedScriptLocation $r $DryRun
    return $r
}

# ---------------------------------------------------------------- production invariants (read-only)
function Get-ElvProductionState {
    $t = Get-ScheduledTask -TaskName $script:ProductionTask -ErrorAction SilentlyContinue
    $head = $null
    try { $head = (& 'C:\Program Files\Git\cmd\git.exe' -C $script:ProductionCheckout rev-parse --short HEAD 2>$null) } catch {}
    [pscustomobject]@{
        TaskState = $(if ($t) { [string]$t.State } else { 'MISSING' })
        TaskAction = $(if ($t) { ($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | ' } else { '' })
        PidAlive = [bool](Get-Process -Id $script:ProductionPid -ErrorAction SilentlyContinue)
        Head = $head
    }
}
function Add-ElvProductionChecks {
    param($Report)
    $s = Get-ElvProductionState
    Add-ElvCheck $Report 'P0' 'production task present and running' ($s.TaskState -eq 'Running') $s.TaskState
    Add-ElvCheck $Report 'P1' "production supervisor PID $($script:ProductionPid) alive" $s.PidAlive
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
function New-ElvRightsInf {
    param([hashtable]$Current, [hashtable]$Add = @{}, [hashtable]$Remove = @{})
    $names = @($Add.Keys) + @($Remove.Keys) | Sort-Object -Unique
    $out = @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]')
    foreach ($n in $names) {
        $set = New-Object System.Collections.ArrayList
        if ($Current.ContainsKey($n)) { foreach ($e in $Current[$n]) { [void]$set.Add($e) } }
        if ($Add.ContainsKey($n)) { foreach ($e in $Add[$n]) { if (-not ($set -contains $e)) { [void]$set.Add($e) } } }
        if ($Remove.ContainsKey($n)) { foreach ($e in $Remove[$n]) { while ($set -contains $e) { $set.Remove($e) } } }
        $out += ('{0} = {1}' -f $n, ($set -join ','))
    }
    return ($out -join "`r`n")
}
function Invoke-ElvRightsChange {
    param($Report, [bool]$DryRun, [hashtable]$Add = @{}, [hashtable]$Remove = @{}, [string]$Label)
    $owner = Get-ElvOwnerContext
    $dir = Join-Path $owner.AdminDir 'rights'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $desc = "add=$(($Add.GetEnumerator() | ForEach-Object { "$($_.Key):$($_.Value -join '+')" }) -join ';') remove=$(($Remove.GetEnumerator() | ForEach-Object { "$($_.Key):$($_.Value -join '+')" }) -join ';')"
    if ($DryRun) { Add-ElvChange $Report 'secedit' 'USER_RIGHTS' "$Label $desc (backup export to $dir)" $false; return }
    New-Item -ItemType Directory -Force $dir | Out-Null
    $exp = Join-Path $dir "rights-before-$Label-$stamp.inf"
    & secedit.exe /export /cfg $exp /areas USER_RIGHTS /quiet | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "secedit /export failed ($LASTEXITCODE)" }
    $cur = ConvertFrom-ElvRightsInf (Get-Content -LiteralPath $exp)
    $inf = Join-Path $dir "rights-apply-$Label-$stamp.inf"
    New-ElvRightsInf -Current $cur -Add $Add -Remove $Remove | Set-Content -Encoding Unicode -LiteralPath $inf
    & secedit.exe /configure /db (Join-Path $dir "secedit-$stamp.sdb") /cfg $inf /areas USER_RIGHTS /quiet | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "secedit /configure failed ($LASTEXITCODE)" }
    Add-ElvChange $Report 'secedit' 'USER_RIGHTS' "$Label $desc (before: $exp)" $true
}
# secedit exports entries as '*SID' or (for some accounts) as names; accept either form.
function Test-ElvRightHeld {
    param([hashtable]$Rights, [string]$Right, [string]$Sid, [string]$Name)
    if (-not $Rights.ContainsKey($Right)) { return $false }
    foreach ($e in $Rights[$Right]) { if ($e -eq "*$Sid" -or $e -ieq $Name -or $e -ieq "$env:COMPUTERNAME\$Name") { return $true } }
    return $false
}
function Get-ElvCurrentRights {
    $tmp = Join-Path $env:TEMP ("elv-rights-{0}.inf" -f [guid]::NewGuid())
    try { & secedit.exe /export /cfg $tmp /areas USER_RIGHTS /quiet | Out-Null; return (ConvertFrom-ElvRightsInf (Get-Content -LiteralPath $tmp)) }
    finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- IPv4 complement (pure)
function ConvertTo-ElvUInt32 { param([string]$Ip) $b = ([Net.IPAddress]::Parse($Ip)).GetAddressBytes(); [Array]::Reverse($b); [BitConverter]::ToUInt32($b, 0) }
function ConvertFrom-ElvUInt32 { param([uint32]$N) $b = [BitConverter]::GetBytes($N); [Array]::Reverse($b); ([Net.IPAddress]$b).ToString() }
function Get-ElvIPv4Range {
    param([string]$Cidr)
    if ($Cidr -notmatch '^(\d{1,3}(\.\d{1,3}){3})/(\d{1,2})$') { throw "Not an IPv4 CIDR: $Cidr" }
    $len = [int]$Matches[3]; if ($len -lt 0 -or $len -gt 32) { throw "Bad prefix: $Cidr" }
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
    return $out
}

# ---------------------------------------------------------------- staging layout (single source of truth)
# Rights per principal key: W=worker B=broker O=owner. 'DENY' = explicit deny Full. All dirs: inheritance reset;
# SYSTEM + Administrators always Full. 'RX-this' = read/list this folder only (no inheritance).
$script:ElvLayout = @(
    @{ Rel = '';                 W = 'RX-this'; B = 'RX-this'; O = 'F' },
    @{ Rel = 'work';             W = 'M';       B = $null;     O = 'F' },
    @{ Rel = 'home';             W = 'M';       B = $null;     O = 'F' },
    @{ Rel = 'broker';           W = 'DENY';    B = 'RX-this'; O = 'F' },
    @{ Rel = 'broker\bin';       W = 'DENY';    B = 'RX';      O = 'RX' },
    @{ Rel = 'broker\state';     W = 'DENY';    B = 'M';       O = 'F' },
    @{ Rel = 'spool';            W = 'RX-this'; B = 'RX-this'; O = 'F' },
    @{ Rel = 'spool\requests';   W = 'W';       B = 'M';       O = 'F' },
    @{ Rel = 'spool\approvals';  W = 'DENY';    B = 'M';       O = 'M' },
    @{ Rel = 'spool\decisions';  W = 'RX';      B = 'M';       O = 'F' },
    @{ Rel = 'decoys';           W = 'DENY';    B = $null;     O = 'F' }
)
# Does an evaluated mask match a layout spec? (configuration semantics, not an access test)
function Test-ElvSpec {
    param([long]$Mask, [string]$Spec)
    switch ($Spec) {
        ''        { return ($Mask -eq 0) }   # [string]$null arrives as ''
        'DENY'    { return ($Mask -eq 0) }
        'RX-this' { return [bool](($Mask -band 0x1) -and -not ($Mask -band 0xD0156)) }
        'RX'      { return [bool](($Mask -band 0x1) -and -not ($Mask -band 0xD0156)) }
        'W'       { return [bool](($Mask -band 0x2) -and -not ($Mask -band 0x1) -and -not ($Mask -band 0xD0040)) }
        'M'       { return [bool]((($Mask -band 0x3) -eq 0x3) -and ($Mask -band 0x10000) -and -not ($Mask -band 0xC0000)) }
        'F'       { return (($Mask -band 0x1F01FF) -eq 0x1F01FF) }
    }
    return $false
}
# Evaluate every layout directory for broad groups, worker and broker token SID sets.
function Test-ElvLayout {
    param($Report, [string]$WorkerSid, [string]$BrokerSid, [string]$GroupSid)
    $wTok = @($script:BroadSids) + @($WorkerSid, $GroupSid); $bTok = @($script:BroadSids) + @($BrokerSid, $GroupSid)
    foreach ($d in $script:ElvLayout) {
        $path = $script:ElvStagingRoot; if ($d.Rel) { $path = Join-Path $script:ElvStagingRoot $d.Rel }
        $name = '\' + $d.Rel
        if (-not (Test-Path -LiteralPath $path)) { Add-ElvCheck $Report 'L' "layout dir exists: $name" $false; continue }
        Add-ElvCheck $Report 'L0' "no broad-group access: $name" ((Get-ElvEffectiveMask $path $script:BroadSids) -eq 0)
        $wm = Get-ElvEffectiveMask $path $wTok; $bm = Get-ElvEffectiveMask $path $bTok
        Add-ElvCheck $Report 'L1' "worker = $($d.W): $name" (Test-ElvSpec $wm $d.W) ('0x{0:X}' -f $wm)
        Add-ElvCheck $Report 'L2' "broker = $($d.B): $name" (Test-ElvSpec $bm $d.B) ('0x{0:X}' -f $bm)
        if ($d.W -eq 'DENY') { Add-ElvCheck $Report 'L3' "explicit worker DENY ACE present: $name" (Test-ElvDenyAce $path $WorkerSid 'explicit' $true) }
    }
}
function ConvertTo-ElvGrant {
    param([string]$Sid, [string]$Spec)
    switch ($Spec) {
        'RX-this' { return @('/grant:r', "*${Sid}:(RX)") }
        'DENY'    { return @('/deny', "*${Sid}:(OI)(CI)F") }
        default   { return @('/grant:r', "*${Sid}:(OI)(CI)$Spec") }
    }
}
