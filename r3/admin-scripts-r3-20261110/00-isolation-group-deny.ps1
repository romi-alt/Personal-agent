<#
.SYNOPSIS
  A2/A4/A5: deny the ElevariqIsolatedIdentities group all owner data volumes. TOUCHES PRODUCTION VOLUME ACLs.
.DESCRIPTION
  Modes (all read-only except -Apply):
    (none)                 dry-run preview.
    -Sweep [-SweepRoots]   B1-fixed sweep of dirs AND files for anything that would defeat an inherited DENY:
                           explicit-broad-allow (INCLUDING inherit-only ACEs), protected-with-broad-access (including
                           inherit-only), null-dacl, unreadable, unlistable; reparse points reported (not followed);
                           skipped roots reported. Writes a chunk record.
    -Sweep -Finalize       merges the chunk records of the last 24 h, checks COVERAGE against the live top level of
                           every target, writes state\sweep-complete.json (consumed by -Apply -UseFinalizedSweep when
                           every chunk was ELEVATED).
    -Verify [-VerifyRoots] H1: per-object verification AFTER the DENY: the modelled worker-token mask must be 0 on
                           every item (exposed / unreadable / unlistable are failures). Writes a chunk record.
    -Verify -Finalize      merges verify chunks newer than the last apply, checks coverage, checks the target roots
                           themselves, writes state\verify-complete.json. 06 refuses to enable the worker without it.
    -ListShadows           H5 (elevated): lists shadow copies of the DENY-target volumes.
    -Apply                 1 pre-flight (production, group members fail-closed, shadow copies recorded)
                           2 timestamped ACL backups (the FIRST root SDDL is kept as the never-overwritten baseline)
                           3 sweep (in-process, or -UseFinalizedSweep); refuses on uncoverable or uncovered findings
                           4 empty group + explicit inheritable DENY Full on each target (idempotent)
                           5 V1 explicit DENY per target, V2 sentinels, V3-lite on sentinels + additional paths;
                             writes state\deny-targets.json. The FULL V3 runs as -Verify chunks + -Verify -Finalize.
  Effect on every existing principal: none (the group has no members until 02 adds the staging identities).
.PARAMETER AdditionalDenyPaths  Swept findings of type explicit-broad-allow / protected-with-broad-access that receive
                                their own explicit DENY (M3: unlistable/unreadable/null-dacl can NOT be covered).
.PARAMETER ApprovedManifestHash H2: SHA-256 of the frozen SHA256SUMS, obtained OUT OF BAND. Required for -Apply.
.PARAMETER CapturedWorkerGroupsCsv  Optional `whoami /groups /fo csv` captured under the real worker (adds its SIDs).
#>
[CmdletBinding()]
param([switch]$Apply, [switch]$Sweep, [switch]$Verify, [switch]$Finalize, [switch]$ListShadows,
      [string[]]$AdditionalDenyPaths = @(), [switch]$SkipFullBackup, [string[]]$SweepRoots = @(), [string[]]$VerifyRoots = @(),
      [switch]$UseFinalizedSweep, [string]$ApprovedManifestHash = '', [string]$CapturedWorkerGroupsCsv = '')
. (Join-Path $PSScriptRoot '_common.ps1')
$DryRun = -not $Apply
$modes = @($Sweep, $Verify, $ListShadows, $Apply | Where-Object { $_ }).Count
if ($modes -gt 1) { throw 'Choose one of -Sweep, -Verify, -ListShadows, -Apply.' }
if ($SweepRoots.Count -and -not $Sweep) { throw '-SweepRoots is only for a read-only -Sweep.' }
if ($VerifyRoots.Count -and -not $Verify) { throw '-VerifyRoots is only for a read-only -Verify.' }
if ($Finalize -and -not ($Sweep -or $Verify)) { throw '-Finalize needs -Sweep or -Verify.' }
$report = Initialize-ElvRun '00-isolation-group-deny' $DryRun -NoElevationNeeded:($DryRun) -ApprovedManifestHash $ApprovedManifestHash
trap { Save-ElvReport $report $_; break }
$owner = Get-ElvOwnerContext
$stateDry = -not (Test-ElvElevation)     # elevated runs record state under the owner's ElevariqAdmin; others beside the scripts

$targets = @($script:ElvDenyRoots + $script:ElvDenyFolders | Where-Object { Test-Path -LiteralPath $_ })
foreach ($p in $AdditionalDenyPaths) { if (-not (Test-Path -LiteralPath $p)) { throw "AdditionalDenyPaths entry does not exist: $p" }; $targets += $p }
foreach ($t in $targets) { [void](Assert-DenyTarget $report $t $AdditionalDenyPaths) }   # additional paths re-checked against the sweep below
$rootSet = @($script:ElvDenyRoots + $script:ElvDenyFolders | ForEach-Object { (Get-ElvCanonicalPath $_).TrimEnd('\') })
Add-ElvChange $report 'targets' ($targets -join ', ') 'DENY targets (validated by Assert-DenyTarget)' $false

# ---- -ListShadows (H5, read-only, elevated)
if ($ListShadows) {
    $sc = Get-ElvShadowCopies
    $drives = Get-ElvDenyTargetDrives $targets
    $hits = @($sc | Where-Object { $_.Drive -and ($drives -contains $_.Drive.TrimEnd('\').ToUpper()) })
    foreach ($h in $hits) { Add-ElvChange $report 'shadow-copy' "$($h.Drive) $($h.Device)" "id=$($h.Id) created=$($h.InstallDate) (keeps PRE-DENY ACLs; delete separately or account for it)" $false }
    Add-ElvCheck $report 'H5' 'no shadow copies of DENY-target volumes' ($hits.Count -eq 0) "$($hits.Count) of $($sc.Count) total"
    Save-ElvReport $report; return
}

# ---- -Verify (H1): per-object post-DENY verification (read-only)
if ($Verify) {
    $gsid = Resolve-ElvGroupSid; $wsid = Resolve-ElvLocalSid $script:ElvWorkerAccount; $bsid = Resolve-ElvLocalSid $script:ElvBrokerAccount
    $applied = Read-ElvState $stateDry 'deny-targets'
    if ($Finalize) {
        if (-not $applied) { throw 'No state\deny-targets.json: 00 -Apply has not been recorded in this state dir.' }
        $since = [datetime]$applied.appliedAt
        $recs = @(Get-ElvChunkRecords $stateDry 'verify' $since)
        Add-ElvCheck $report 'VF0' "verify chunk records newer than apply ($since)" ($recs.Count -ge 1) "$($recs.Count) records"
        $missing = @(); if ($recs.Count) { $missing = Test-ElvChunkCoverage $recs @($applied.targets) }
        Add-ElvCheck $report 'VF1' 'coverage: every top-level item of every target lies in a chunk' (($recs.Count -ge 1) -and ($missing.Count -eq 0)) ($missing -join ';')
        $bad = @($recs | Where-Object { $_.stats.exposed -ne 0 -or $_.stats.unreadable -ne 0 -or $_.stats.unlistable -ne 0 })
        Add-ElvCheck $report 'VF2' 'every chunk: exposed=0 unreadable=0 unlistable=0' ($bad.Count -eq 0) (($bad | ForEach-Object { "$($_.roots -join ',') exposed=$($_.stats.exposed) unreadable=$($_.stats.unreadable) unlistable=$($_.stats.unlistable)" }) -join ' | ')
        $tok = Get-ElvTokenSidSet @($gsid, $wsid, $bsid) $CapturedWorkerGroupsCsv
        $rootsOk = $true
        foreach ($t in @($applied.targets)) { if (Test-Path -LiteralPath $t) { $m = Get-ElvEffectiveMask $t $tok; if ($m -ne 0) { $rootsOk = $false; Add-ElvCheck $report 'VF3' "target root mask 0: $t" $false ('0x{0:X}' -f $m) } } }
        Add-ElvCheck $report 'VF3' 'every target root: modelled worker mask = 0' $rootsOk
        $notElev = @($recs | Where-Object { -not $_.elevated })
        Add-ElvCheck $report 'VF4' 'every chunk ran elevated (IntelOptaneData and other admin-only trees are unlistable otherwise)' ($notElev.Count -eq 0) "$($notElev.Count) non-elevated"
        $complete = ($recs.Count -ge 1) -and ($missing.Count -eq 0) -and ($bad.Count -eq 0) -and $rootsOk -and ($notElev.Count -eq 0)
        $p = Write-ElvState $stateDry 'verify-complete' ([pscustomobject]@{ complete = $complete; at = (Get-Date).ToString('o'); appliedAt = $applied.appliedAt; appliedRef = $applied.ref
            targets = @($applied.targets); chunks = @($recs | ForEach-Object { $_.csv }); items = (($recs | ForEach-Object { $_.stats.items }) | Measure-Object -Sum).Sum; tokenSids = $tok })
        Add-ElvCheck $report 'VF5' "verify-complete.json written (complete=$complete)" $complete $p
        Save-ElvReport $report; return
    }
    if (-not $gsid) { throw 'Nothing to verify: the deny group does not exist (00 -Apply has not run).' }
    $tok = Get-ElvTokenSidSet @($gsid, $wsid, $bsid) $CapturedWorkerGroupsCsv
    $set = $targets
    if ($VerifyRoots.Count) {
        foreach ($vr in $VerifyRoots) { if (-not (Test-Path -LiteralPath $vr)) { throw "VerifyRoots entry does not exist: $vr" }; if (-not @($targets | Where-Object { Test-ElvUnder $vr $_ }).Count) { throw "VerifyRoots entry is not under a DENY target: $vr" } }
        $set = $VerifyRoots
    }
    $dir = Get-ElvStateDir $stateDry
    $csv = Join-Path $dir ('verify-{0}-{1}.csv' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID)
    $res = Invoke-ElvObjectVerify -Roots $set -OutCsv $csv -RootSet $rootSet -TokenSids $tok
    $rec = Write-ElvChunkRecord $stateDry 'verify' $set $res.Stats $csv $(if ($applied) { [string]$applied.ref } else { '' })
    Add-ElvCheck $report 'V3' "per-object verification: exposed=0 unreadable=0 unlistable=0 over $($res.Stats.items) items" (($res.Stats.exposed -eq 0) -and ($res.Stats.unreadable -eq 0) -and ($res.Stats.unlistable -eq 0)) "exposed=$($res.Stats.exposed) unreadable=$($res.Stats.unreadable) unlistable=$($res.Stats.unlistable); $csv; record $rec"
    Add-ElvChange $report 'note' 'V3' 'configuration evidence (modelled token over the DACL). NOT an access test: final acceptance needs the real-token acceptance matrix under the worker identity.' $false
    Save-ElvReport $report; return
}

# ---- 1. pre-flight (Apply and dry-run)
Add-ElvProductionChecks $report
$gsid = Resolve-ElvGroupSid
if ($gsid) {
    $members = @(Get-ElvGroupMemberSids $script:ElvGroup)    # L4: throws (fail closed) instead of returning nothing
    $okMembers = @($script:ElvWorkerAccount, $script:ElvBrokerAccount | ForEach-Object { Resolve-ElvLocalSid $_ } | Where-Object { $_ })
    $unexpected = @($members | Where-Object { $okMembers -notcontains $_ })
    Add-ElvCheck $report 'G0' 'deny group has no unexpected members' ($unexpected.Count -eq 0) ($unexpected -join ',')
    if ($unexpected.Count -and -not $DryRun) { throw "Group $($script:ElvGroup) has unexpected members: $($unexpected -join ',')" }
}
$shadowNote = 'not enumerated (not elevated)'
if (Test-ElvElevation) {
    $sc = @(Get-ElvShadowCopies); $drives = Get-ElvDenyTargetDrives $targets
    $hits = @($sc | Where-Object { $_.Drive -and ($drives -contains $_.Drive.TrimEnd('\').ToUpper()) })
    $shadowNote = "$($hits.Count) shadow copies of target volumes: " + (($hits | ForEach-Object { "$($_.Drive) $($_.Id) $($_.InstallDate)" }) -join '; ')
    $s = 'WARN'; if ($hits.Count -eq 0) { $s = $true }
    Add-ElvCheck $report 'H5' 'pre-existing shadow copies of DENY-target volumes (they keep pre-DENY ACLs; 06 gate fails closed until deleted or accounted for)' $s $shadowNote
} else { Add-ElvCheck $report 'H5' 'shadow copies of DENY-target volumes' 'UNKNOWN' $shadowNote }

# ---- 3. sweep
$findings = @()
if ($Sweep -or -not $DryRun) {
    if ($Sweep -and $Finalize) {
        $recs = @(Get-ElvChunkRecords $stateDry 'sweep' ((Get-Date).AddHours(-24)))
        Add-ElvCheck $report 'SF0' 'sweep chunk records in the last 24 h' ($recs.Count -ge 1) "$($recs.Count) records"
        $missing = @(); if ($recs.Count) { $missing = Test-ElvChunkCoverage $recs $targets }
        Add-ElvCheck $report 'SF1' 'coverage: every top-level item of every target lies in a chunk' (($recs.Count -ge 1) -and ($missing.Count -eq 0)) ($missing -join ';')
        $all = @(); foreach ($r in $recs) { if (Test-Path -LiteralPath $r.csv) { $all += @(Import-Csv -LiteralPath $r.csv | Where-Object { $_.issue -notin @('reparse-point', 'skipped-root') } | ForEach-Object { [pscustomobject]@{ path = $_.path; issue = $_.issue; detail = $_.detail } }) } else { Add-ElvCheck $report 'SF2' "chunk CSV present: $($r.csv)" $false } }
        $elev = @($recs | Where-Object { $_.elevated }).Count -eq $recs.Count
        $complete = ($recs.Count -ge 1) -and ($missing.Count -eq 0)
        $p = Write-ElvState $stateDry 'sweep-complete' ([pscustomobject]@{ complete = $complete; allElevated = $elev; at = (Get-Date).ToString('o'); targets = $targets; chunks = @($recs | ForEach-Object { $_.csv }); findings = $all
            items = (($recs | ForEach-Object { $_.stats.items }) | Measure-Object -Sum).Sum })
        Add-ElvCheck $report 'SF3' "sweep-complete.json written (complete=$complete allElevated=$elev findings=$($all.Count))" $complete $p
        Save-ElvReport $report; return
    }
    if ($UseFinalizedSweep -and -not $DryRun) {
        $sc = Read-ElvState $stateDry 'sweep-complete'
        if (-not $sc -or -not $sc.complete -or -not $sc.allElevated) { throw '-UseFinalizedSweep: no complete, all-elevated sweep-complete.json in the state dir.' }
        if (([datetime]$sc.at) -lt (Get-Date).AddHours(-24)) { throw '-UseFinalizedSweep: sweep-complete.json is older than 24 h; re-run the chunks.' }
        if ((@($sc.targets) -join '|') -ne ($targets -join '|')) { throw '-UseFinalizedSweep: target list differs from the finalized sweep.' }
        $findings = @($sc.findings | ForEach-Object { [pscustomobject]@{ path = $_.path; issue = $_.issue } })
        Add-ElvChange $report 'sweep' 'finalized' "using sweep-complete.json from $($sc.at) ($($sc.items) items, $($findings.Count) findings)" $false
    } else {
        $sweepDir = Get-ElvStateDir $stateDry
        $sweepSet = $targets
        if ($SweepRoots.Count) {
            foreach ($sr in $SweepRoots) {
                if (-not (Test-Path -LiteralPath $sr)) { throw "SweepRoots entry does not exist: $sr" }
                if (-not @($targets | Where-Object { Test-ElvUnder $sr $_ }).Count) { throw "SweepRoots entry is not under a DENY target: $sr" }
            }
            $sweepSet = $SweepRoots
            Add-ElvChange $report 'sweep-chunk' ($SweepRoots -join ', ') 'partial read-only sweep (chunk); finalize with -Sweep -Finalize' $false
        }
        $csv = Join-Path $sweepDir ('sweep-{0}-{1}.csv' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID)
        $res = Invoke-ElvSweep -Roots $sweepSet -OutCsv $csv -RootSet $rootSet
        $findings = @($res.Rows | Where-Object { $_.issue -notin @('reparse-point', 'skipped-root') })
        $rec = Write-ElvChunkRecord $stateDry 'sweep' $sweepSet $res.Stats $csv
        $rp = @($res.Rows | Where-Object { $_.issue -eq 'reparse-point' })
        $s2 = 'WARN'; if (-not $rp.Count) { $s2 = $true }
        Add-ElvCheck $report 'S2' 'sweep: reparse points reviewed (not followed; a target OUTSIDE the DENY targets is governed only by its own ACL)' $s2 "$($rp.Count) reparse points; see $csv"
        $sk = @($res.Rows | Where-Object { $_.issue -eq 'skipped-root' })
        Add-ElvCheck $report 'S3' 'sweep: skipped roots reported (System Volume Information)' 'INFO' (($sk | ForEach-Object { $_.path }) -join ';')
        Add-ElvChange $report 'sweep-record' $rec "chunk record (elevated=$(Test-ElvElevation))" $false
    }
    # M3: only explicit-broad-allow / protected-with-broad-access may be covered; everything else must be RESOLVED.
    $covered = @($AdditionalDenyPaths | ForEach-Object { (Get-ElvCanonicalPath $_).TrimEnd('\') })
    $open = @($findings | Where-Object { -not (($script:CoverableIssues -contains $_.issue) -and ($covered -contains $_.path.TrimEnd('\'))) })
    $uncoverable = @($open | Where-Object { $script:CoverableIssues -notcontains $_.issue })
    Add-ElvCheck $report 'S1' 'sweep: no open findings (coverable ones listed in -AdditionalDenyPaths; unlistable/unreadable/null-dacl must be RESOLVED, never covered)' ($open.Count -eq 0) "$($open.Count) open ($($uncoverable.Count) uncoverable)"
    foreach ($p in $AdditionalDenyPaths) { [void](Assert-DenyTarget $report $p $AdditionalDenyPaths $findings) }   # L1/M3: must be a coverable finding of THIS sweep
    if ($open.Count -and -not $DryRun) { Add-ElvRefusal $report 'sweep findings not covered or not coverable' 'sweep'; throw 'Apply refused: open sweep findings.' }
    if ($Sweep -and $DryRun) { Save-ElvReport $report; return }
} else {
    Add-ElvChange $report 'sweep' ($targets -join ', ') 'mandatory dirs+files sweep (B1-fixed) runs before any change in -Apply (use -Sweep to preview)' $false
}

# ---- 2. backups (M2: timestamped; the first root SDDL is the never-overwritten baseline; full /save exit checked)
$aclDir = Join-Path $owner.AdminDir 'acl'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($t in $targets) {
    $tag = ($t.TrimEnd('\') -replace '[:\\$]', '_')
    $tdir = Join-Path $aclDir $tag
    if ($DryRun) { Add-ElvChange $report 'backup' $t "icacls /save root -> $tdir\$stamp-root.acl; baseline-root.sddl kept if present$(if (-not $SkipFullBackup) { "; full tree -> $stamp-full.acl (exit checked)" })" $false; continue }
    $tdir = Backup-ElvAcl -Target $t -AclDir $aclDir -Stamp $stamp -Full (-not $SkipFullBackup) -Report $report
    Add-ElvChange $report 'backup' $t "saved to $tdir ($stamp)" $true
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
    $spec = "*${gsid}:F"; if ($isDir) { $spec = "*${gsid}:(OI)(CI)F" }     # R3-N1: files never get inheritance flags
    Invoke-ElvIcacls @($t, '/deny', $spec) $DryRun $report $t 'DENY Full for isolation group (inherits to children)'
}

# ---- 5. verify + state
if (-not $DryRun) {
    foreach ($t in $targets) {
        $isDir = (Get-Item -LiteralPath $t -Force).PSIsContainer
        Add-ElvCheck $report 'V1' "explicit DENY on $t" (Test-ElvDenyAce $t $gsid 'explicit' $isDir)
    }
    $sentinels = @("$($script:ProductionCheckout)\scripts\windows\run-supervisor.ps1", "$($script:ProductionCheckout)\.env",
        "$($script:ProductionCheckout)\.git\config", "$($script:ProductionCheckout)\dist", 'E:\Agent\.claude', 'E:\Agent\v2-staging')
    $sentinels += @(Get-ChildItem -LiteralPath 'F:\' -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '^\$RECYCLE|System Volume' } | Select-Object -First 3 | ForEach-Object { $_.FullName })
    $tok = Get-ElvTokenSidSet @($gsid) $CapturedWorkerGroupsCsv
    foreach ($s in $sentinels + $AdditionalDenyPaths) {
        if (-not (Test-Path -LiteralPath $s)) { continue }
        Add-ElvCheck $report 'V2' "DENY ACE reaches $s" (Test-ElvDenyAce $s $gsid 'any')
        $m = Get-ElvEffectiveMask $s $tok
        Add-ElvCheck $report 'V3-lite' "modelled worker mask = 0 on $s" ($m -eq 0) ('0x{0:X}' -f $m)
    }
    $ref = "$stamp-$PID"
    $p = Write-ElvState $false 'deny-targets' ([pscustomobject]@{ ref = $ref; appliedAt = (Get-Date).ToString('o'); groupSid = $gsid; targets = $targets; additional = $AdditionalDenyPaths; shadowCopies = $shadowNote; report = $report.path })
    Add-ElvChange $report 'state' $p 'deny-targets.json written (read by -Verify -Finalize, 06 gate and 09 rollback)' $true
    Add-ElvChange $report 'NEXT' '00 -Verify' 'run the chunked per-object verification (elevated, chunk per top-level folder, production idle), then 00 -Verify -Finalize. 06 refuses without verify-complete.json' $false
    Add-ElvProductionChecks $report
}
Save-ElvReport $report
