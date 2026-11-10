<#
.SYNOPSIS
  A2/A4/A5: deny the ElevariqIsolatedIdentities group all owner data volumes. TOUCHES PRODUCTION VOLUME ACLs.
.DESCRIPTION
  Stages (all in one run with -Apply; -Sweep alone is read-only):
    1. Pre-flight: production invariants, group membership.
    2. ACL backups to <owner profile>\ElevariqAdmin\acl (root /save always; full-tree /save unless -SkipFullBackup).
    3. MANDATORY sweep of dirs AND files under every target for (a) explicit ALLOW ACEs for broad groups and
       (b) protected DACLs that still give a broad group any access. Either would defeat an inherited DENY.
       Apply REFUSES while any finding is not covered by -AdditionalDenyPaths (or removed via 00a).
    4. Create the (empty) group; add an inheritable explicit DENY Full for it on each target (idempotent: skipped
       when an equivalent explicit DENY already exists - r1 defect D2).
    5. Verify: explicit DENY on each target; inherited DENY on sentinel paths; production invariants unchanged.
  Effect on every existing principal: none (the group has no members until 02 adds the staging identities).
.PARAMETER Apply                Perform changes (elevated, from the frozen trusted copy).
.PARAMETER Sweep                Read-only sweep only (works without elevation; unreadable items are reported).
.PARAMETER AdditionalDenyPaths  Swept paths (protected or explicit-allow) to receive their own explicit DENY.
.PARAMETER SkipFullBackup       Skip the full-tree icacls /save (root saves still taken). Recorded in the report.
.PARAMETER SweepRoots           Read-only chunked sweep: with -Sweep only (never with -Apply, which always sweeps every
                                target), sweep just these paths. Each must lie under a DENY target. The path itself is
                                checked as well as everything below it, so chunks (top-level folders and files) together
                                cover a whole target except the target root ACL itself (that is in the root baselines).
#>
[CmdletBinding()]
param([switch]$Apply, [switch]$Sweep, [string[]]$AdditionalDenyPaths = @(), [switch]$SkipFullBackup, [string[]]$SweepRoots = @())
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
if ($SweepRoots.Count -and ($Apply -or -not $Sweep)) { throw '-SweepRoots is only for a read-only -Sweep; -Apply always sweeps every target.' }
$report = Initialize-ElvRun '00-isolation-group-deny' $DryRun -NoElevationNeeded:($DryRun)
$owner = Get-ElvOwnerContext

$targets = @($script:ElvDenyRoots + $script:ElvDenyFolders | Where-Object { Test-Path -LiteralPath $_ })
foreach ($p in $AdditionalDenyPaths) {
    if (-not (Test-Path -LiteralPath $p)) { throw "AdditionalDenyPaths entry does not exist: $p" }
    $targets += $p
}
foreach ($t in $targets) { [void](Assert-DenyTarget $report $t $AdditionalDenyPaths) }
Add-ElvChange $report 'targets' ($targets -join ', ') 'DENY targets (validated by Assert-DenyTarget)' $false

# ---- 1. pre-flight
Add-ElvProductionChecks $report
$gsid = Resolve-ElvGroupSid
if ($gsid) {
    $members = @(Get-LocalGroupMember -Group $script:ElvGroup -ErrorAction SilentlyContinue | ForEach-Object { $_.SID.Value })
    $okMembers = @($script:ElvWorkerAccount, $script:ElvBrokerAccount | ForEach-Object { Resolve-ElvLocalSid $_ } | Where-Object { $_ })
    $unexpected = @($members | Where-Object { $okMembers -notcontains $_ })
    Add-ElvCheck $report 'G0' 'deny group has no unexpected members' ($unexpected.Count -eq 0) ($unexpected -join ',')
    if ($unexpected.Count -and -not $DryRun) { throw "Group $($script:ElvGroup) has unexpected members: $($unexpected -join ',')" }
}

# ---- 3. sweep (function first; it runs before any change)
function Invoke-ElvSweep {
    param([string[]]$Roots, [string]$OutCsv)
    # Issues (one CSV row each, streamed to disk; only path+issue is kept in memory, bounded by the finding count):
    #   explicit-broad-allow        explicit ALLOW for a broad SID: overrides an inherited DENY          (blocks -Apply)
    #   protected-with-broad-access inheritance cut AND a broad SID still has access: DENY never arrives  (blocks -Apply)
    #   null-dacl                   no DACL at all = everyone full access                                (blocks -Apply)
    #   unreadable                  ACL could not be read (not elevated, or no READ_CONTROL)              (blocks -Apply)
    #   unlistable                  directory could not be enumerated: its CONTENTS were NOT swept        (blocks -Apply)
    #   reparse-point               junction/symlink: NOT followed (no loops). Access through it is decided by
    #                               the TARGET's ACL, so an OUTSIDE target is not covered by this DENY   (review; WARN)
    # This is CONFIGURATION evidence (broad-group ACL exposure), not effective access of a real worker token.
    $skip = '\\(\$RECYCLE\.BIN|System Volume Information)(\\|$)'
    $rows = New-Object System.Collections.ArrayList
    $script:sweepStats = @{ items = 0; unreadable = 0; unlistable = 0; reparse = 0 }
    $w = New-Object System.IO.StreamWriter($OutCsv, $false, (New-Object System.Text.UTF8Encoding($true)))
    $w.WriteLine('"path","issue","detail"')
    $emit = { param($p, $i, $d)
        $w.WriteLine((@($p, $i, $d) | ForEach-Object { '"' + ([string]$_ -replace '"', '""') + '"' }) -join ','); $w.Flush()
        [void]$rows.Add([pscustomobject]@{ path = $p; issue = $i })
    }
    $check = { param($item)
        $fp = $item.FullName
        $script:sweepStats.items++
        if ($script:sweepStats.items % 20000 -eq 0) { Write-Host "    swept $($script:sweepStats.items) ..."; [GC]::Collect() }
        if ($fp -match $skip -or ($rootSet -contains $fp.TrimEnd('\'))) { return }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $script:sweepStats.reparse++
            $tgt = @($item.Target) -join ';'
            $inside = [bool](@($rootSet | Where-Object { $tgt -and (Test-ElvUnder $tgt "$_\") }).Count)
            & $emit $fp 'reparse-point' ("{0} -> {1} (target {2} a DENY target)" -f $item.LinkType, $tgt, $(if ($inside) { 'inside' } else { 'OUTSIDE' }))
        }
        try {
            $acl = Get-Acl -LiteralPath $fp; $sddl = $acl.Sddl
            if ($sddl -match 'D:NO_ACCESS_CONTROL') { & $emit $fp 'null-dacl' $sddl; return }
            $aces = @(Get-ElvAces $fp -Sddl $sddl)
            $explicitBroad = @($aces | Where-Object { -not $_.Inherited -and -not $_.InheritOnly -and $_.Type -eq 'AccessAllowed' -and ($script:BroadSids -contains $_.Sid) })
            if ($explicitBroad.Count) { & $emit $fp 'explicit-broad-allow' (($explicitBroad | ForEach-Object { '{0}:0x{1:X}' -f $_.Sid, $_.Mask }) -join ' ') }
            if ($acl.AreAccessRulesProtected -and(Get-ElvEffectiveMask $fp $script:BroadSids -Aces $aces) -ne 0) { & $emit $fp 'protected-with-broad-access' $sddl }
        } catch { $script:sweepStats.unreadable++; & $emit $fp 'unreadable' $_.Exception.Message }
    }
    # Deny-target roots themselves are excluded (they get the DENY; their ACL is in the root baselines).
    $rootSet = @($script:ElvDenyRoots + $script:ElvDenyFolders | ForEach-Object { (Get-ElvCanonicalPath $_).TrimEnd('\') })
    try {
        foreach ($root in $Roots) {
            $ri = Get-Item -LiteralPath $root -Force
            & $check $ri                                   # a chunk root is itself swept (no-op for a deny-target root)
            if ($ri.PSIsContainer -and -not ($ri.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                # PS 5.1 -Recurse does not descend into junctions/symlinks (verified with a loop junction).
                # Enumeration errors are CAPTURED, not swallowed: each is an unswept subtree.
                $enumErr = $null
                Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable +enumErr | ForEach-Object { & $check $_ }
                foreach ($e in @($enumErr)) {
                    $script:sweepStats.unlistable++
                    & $emit ([string]$e.TargetObject) 'unlistable' $e.Exception.Message
                }
                $enumErr = $null
            }
        }
    } finally { $w.Close() }
    $s = $script:sweepStats
    Write-Host ("    SWEEP-SUMMARY items={0} findings={1} unreadable={2} unlistable={3} reparse={4} -> {5}" -f $s.items, $rows.Count, $s.unreadable, $s.unlistable, $s.reparse, $OutCsv)
    return $rows
}

if ($Sweep -or -not $DryRun) {
    $sweepDir = Join-Path $PSScriptRoot 'reports'; if (-not $DryRun) { $sweepDir = Join-Path $owner.AdminDir 'sweep' }
    New-Item -ItemType Directory -Force $sweepDir | Out-Null
    $sweepSet = $targets
    if ($SweepRoots.Count) {   # (-Apply / missing -Sweep already refused at the top)
        foreach ($sr in $SweepRoots) {
            if (-not (Test-Path -LiteralPath $sr)) { throw "SweepRoots entry does not exist: $sr" }
            if (-not @($targets | Where-Object { Test-ElvUnder $sr $_ }).Count) { throw "SweepRoots entry is not under a DENY target: $sr" }
        }
        $sweepSet = $SweepRoots
        Add-ElvChange $report 'sweep-chunk' ($SweepRoots -join ', ') 'partial read-only sweep (chunk); not sufficient for -Apply' $false
    }
    $csv = Join-Path $sweepDir ('sweep-{0}-{1}.csv' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID)
    $findings = @(Invoke-ElvSweep $sweepSet $csv)
    $covered = @($AdditionalDenyPaths | ForEach-Object { (Get-ElvCanonicalPath $_).TrimEnd('\') })
    $open = @($findings | Where-Object { $_.issue -ne 'reparse-point' -and $covered -notcontains $_.path.TrimEnd('\') })
    Add-ElvCheck $report 'S1' 'sweep: no uncovered explicit-broad-allow / protected-with-broad-access / null-dacl / unreadable / unlistable items' ($open.Count -eq 0) "$($open.Count) open; see $csv"
    $rp = @($findings | Where-Object { $_.issue -eq 'reparse-point' })
    $s2 = 'WARN'; if (-not $rp.Count) { $s2 = $true }
    Add-ElvCheck $report 'S2' 'sweep: reparse points reviewed (not followed; a target OUTSIDE the DENY targets is governed only by its own ACL, not by this DENY)' $s2 "$($rp.Count) reparse points; see $csv"
    if ($open.Count -and -not $DryRun) {
        Add-ElvRefusal $report 'sweep findings not covered (remove via 00a or pass via -AdditionalDenyPaths)' $csv
        Save-ElvReport $report; throw 'Apply refused: open sweep findings.'
    }
    if ($Sweep -and $DryRun) { Save-ElvReport $report; return }
} else {
    Add-ElvChange $report 'sweep' ($targets -join ', ') 'mandatory dirs+files sweep runs before any change in -Apply (use -Sweep to preview)' $false
}

# ---- 2. backups
$aclDir = Join-Path $owner.AdminDir 'acl'
foreach ($t in $targets) {
    $tag = ($t.TrimEnd('\') -replace '[:\\]', '_')
    if ($DryRun) { Add-ElvChange $report 'backup' $t "icacls /save root -> $aclDir\$tag-root.acl$(if (-not $SkipFullBackup) { " and full tree -> $tag-full.acl" })" $false; continue }
    New-Item -ItemType Directory -Force $aclDir | Out-Null
    & icacls.exe $t /save (Join-Path $aclDir "$tag-root.acl") /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "ACL root backup failed for $t" }
    (Get-Acl -LiteralPath $t).Sddl | Set-Content -Encoding utf8 (Join-Path $aclDir "$tag-root.sddl")
    if (-not $SkipFullBackup -and (Get-Item -LiteralPath $t).PSIsContainer) {
        $wild = Join-Path $t '*'
        & icacls.exe $wild /save (Join-Path $aclDir "$tag-full.acl") /T /C /Q | Out-Null   # /C: continue past unreadable system items
    }
    Add-ElvChange $report 'backup' $t "saved to $aclDir" $true
}
if ($SkipFullBackup) { Add-ElvChange $report 'note' 'backup' 'full-tree backup SKIPPED by operator (-SkipFullBackup)' (-not $DryRun) }

# ---- 4. group + DENY
if (-not $gsid) {
    if ($DryRun) { Add-ElvChange $report 'new-localgroup' $script:ElvGroup 'create EMPTY group (members added by 02)' $false; $gsid = '<group-SID>' }
    else {
        New-LocalGroup -Name $script:ElvGroup -Description 'ELEVARIQ isolated identities: denied all owner data volumes' | Out-Null
        $gsid = Resolve-ElvGroupSid -MustExist $true
        Add-ElvChange $report 'new-localgroup' $script:ElvGroup "created ($gsid)" $true
    }
}
foreach ($t in $targets) {
    $isDir = (Get-Item -LiteralPath $t -Force).PSIsContainer
    if (-not $DryRun -and (Test-ElvDenyAce $t $gsid 'explicit' $isDir)) { Add-ElvChange $report 'noop' $t 'equivalent explicit DENY already present (idempotent)' $false; continue }
    $spec = "*${gsid}:F"; if ($isDir) { $spec = "*${gsid}:(OI)(CI)F" }
    Invoke-ElvIcacls @($t, '/deny', $spec) $DryRun $report $t 'DENY Full for isolation group (inherits to children)'
}

# ---- 5. verify
if (-not $DryRun) {
    foreach ($t in $targets) {
        $isDir = (Get-Item -LiteralPath $t -Force).PSIsContainer
        Add-ElvCheck $report 'V1' "explicit DENY on $t" (Test-ElvDenyAce $t $gsid 'explicit' $isDir)
    }
    $sentinels = @("$($script:ProductionCheckout)\scripts\windows\run-supervisor.ps1", "$($script:ProductionCheckout)\.env",
        "$($script:ProductionCheckout)\.git\config", "$($script:ProductionCheckout)\dist", 'E:\Agent\.claude', 'E:\Agent\v2-staging')
    $sentinels += @(Get-ChildItem -LiteralPath 'F:\' -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '^\$RECYCLE|System Volume' } | Select-Object -First 3 | ForEach-Object { $_.FullName })
    foreach ($s in $sentinels) { if (Test-Path -LiteralPath $s) { Add-ElvCheck $report 'V2' "inherited DENY reaches $s" (Test-ElvDenyAce $s $gsid 'any') } }
    Add-ElvProductionChecks $report
}
Save-ElvReport $report
