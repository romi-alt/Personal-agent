# Chunked, READ-ONLY driver for 00-isolation-group-deny.ps1 -Sweep -SweepRoots (v2).
# Safety controls (none weakened when resources are short: the run stops and reports partial coverage instead):
#   - single instance: exclusive lock file; a second driver refuses to start (no overlapping sweeps)
#   - one child process per chunk, BelowNormal priority; the driver kills ONLY the child it started (by PID)
#   - production probe (read-only DB, readonly:true) before each chunk and every 60 s during one:
#       heartbeat older than $HbStaleS or PID 8992 gone  -> kill chunk, ABORT run
#       production has active/queued work               -> pause (yield) up to $WaitMaxMin, then ABORT
#   - free RAM < $KillMinMB during a chunk -> kill chunk, ABORT run; < $StartMinMB before a chunk -> wait, then ABORT
#   - per-chunk wall-clock limit $ChunkMaxMin -> kill chunk, record 'timeout', continue with the next chunk
#   - per chunk: items, findings, unreadable, unlistable, reparse, seconds, peak working set, exit status
param([int]$StartMinMB = 600, [int]$KillMinMB = 350, [int]$WaitMaxMin = 20, [int]$ChunkMaxMin = 40, [int]$HbStaleS = 60,
      [string[]]$Only = @(), [string[]]$SkipChunks = @())
$ErrorActionPreference = 'Stop'
$adm  = 'E:\Agent\v2-staging\worker-isolation\admin-scripts-r2-20261110'
$s00  = Join-Path $adm '00-isolation-group-deny.ps1'
$node = 'C:\Program Files\nodejs\node.exe'
$probeJs = Join-Path $PSScriptRoot 'hb.cjs'
$prodPid = 8992

# ---- single instance
$lockPath = Join-Path $adm 'reports\chunked-sweep.lock'
New-Item -ItemType Directory -Force (Split-Path $lockPath) | Out-Null
try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') } catch { throw "Another chunked sweep is running (lock held: $lockPath). Refusing to overlap." }

$runDir = Join-Path $adm ('reports\chunked-sweep-{0}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $runDir | Out-Null
$log = Join-Path $runDir 'driver.log'
function Log($m) { $l = '{0:HH:mm:ss} {1}' -f (Get-Date), $m; Add-Content -LiteralPath $log -Value $l -Encoding utf8; Write-Host $l }
function FreeMB { [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB) }
function Probe {
    $o = [ordered]@{ pidAlive = [bool](Get-Process -Id $prodPid -ErrorAction SilentlyContinue); task = (Get-ScheduledTask -TaskName 'ElevariqPersonalAgent' -ErrorAction SilentlyContinue).State; hbAgeS = $null; status = $null; activeOrQueued = $null; err = $null }
    try { $j = (& $node $probeJs) | ConvertFrom-Json; $o.hbAgeS = $j.hbAgeS; $o.status = $j.status; $o.activeOrQueued = $j.activeOrQueued }
    catch { $o.err = $_.Exception.Message }
    [pscustomobject]$o
}
function ProbeText($p) { "prod: task=$($p.task) pid=$($p.pidAlive) hb=$($p.hbAgeS)s $($p.status) work=$($p.activeOrQueued)$(if ($p.err) { " probeErr=$($p.err)" })" }
function Distress($p) { (-not $p.pidAlive) -or ($p.task -ne 'Running') -or ($null -eq $p.hbAgeS) -or ($p.hbAgeS -gt $HbStaleS) }
function Q([string]$s) { "'" + ($s -replace "'", "''") + "'" }

# ---- chunk plan (priority first)
$skipNames = '^(\$RECYCLE\.BIN|System Volume Information)$'
$prio = @('E:\Agent')   # ELEVARIQ: production checkout (.env, .git, dist, run-supervisor.ps1), staging, broker source, admin scripts, evidence
$chunks = New-Object System.Collections.ArrayList
foreach ($p in $prio) { if (Test-Path -LiteralPath $p) { [void]$chunks.Add(@{ id = $p; roots = @($p) }) } }
foreach ($root in 'E:\', 'F:\') {
    $items = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop | Where-Object { $_.Name -notmatch $skipNames })
    foreach ($d in $items | Where-Object PSIsContainer) { if ($prio -notcontains $d.FullName) { [void]$chunks.Add(@{ id = $d.FullName; roots = @($d.FullName) }) } }
    $files = @($items | Where-Object { -not $_.PSIsContainer } | ForEach-Object FullName)
    if ($files.Count) { [void]$chunks.Add(@{ id = "$root<files>"; roots = $files }) }
}
foreach ($f in 'C:\Download', 'C:\Intel', 'D:\src', 'D:\Intel') { if (Test-Path -LiteralPath $f) { [void]$chunks.Add(@{ id = $f; roots = @($f) }) } }
if ($Only.Count) { $chunks = @($chunks | Where-Object { $Only -contains $_.id }) }
if ($SkipChunks.Count) { $chunks = @($chunks | Where-Object { $SkipChunks -notcontains $_.id }) }

$p0 = Probe
Log "plan: $($chunks.Count) chunks; run dir $runDir; free=$(FreeMB) MB; $(ProbeText $p0)"
if (Distress $p0) { Log 'ABORT before start: production not healthy'; $lock.Close(); return }

$results = New-Object System.Collections.ArrayList
$abort = $null; $n = 0
foreach ($c in $chunks) {
    $n++
    # -- pre-chunk gate: memory and production work
    $waited = 0
    while ($true) {
        $pp = Probe; $free = FreeMB
        if (Distress $pp) { $abort = "production distress before chunk $n ($(ProbeText $pp))"; break }
        if ($free -ge $StartMinMB -and -not $pp.activeOrQueued) { break }
        if ($waited -ge $WaitMaxMin * 60) { $abort = "gate not satisfied after $WaitMaxMin min (free=$free MB, $(ProbeText $pp))"; break }
        if ($waited -eq 0) { Log "  waiting: free=$free MB, $(ProbeText $pp)" }
        Start-Sleep 30; $waited += 30
    }
    if ($abort) { break }

    $cmd = "`$ProgressPreference='SilentlyContinue'; & $(Q $s00) -Sweep -SweepRoots @($((@($c.roots) | ForEach-Object { Q $_ }) -join ','))"
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
    $out = Join-Path $runDir ('chunk-{0:D3}.out.txt' -f $n)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process powershell.exe -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc `
        -RedirectStandardOutput $out -RedirectStandardError "$out.err" -WindowStyle Hidden -PassThru
    $null = $proc.Handle                              # PS 5.1: cache the handle or ExitCode is lost
    try { $proc.PriorityClass = 'BelowNormal' } catch {}
    $why = $null; $peak = 0L; $lastProbe = 0
    while (-not $proc.HasExited) {
        Start-Sleep 2
        try { $proc.Refresh(); if ($proc.PeakWorkingSet64 -gt $peak) { $peak = $proc.PeakWorkingSet64 } } catch {}
        if ((FreeMB) -lt $KillMinMB) { $why = 'killed-low-memory' }
        elseif ($sw.Elapsed.TotalMinutes -gt $ChunkMaxMin) { $why = 'timeout' }
        elseif ($sw.Elapsed.TotalSeconds - $lastProbe -ge 60) { $lastProbe = $sw.Elapsed.TotalSeconds; $pp = Probe; if (Distress $pp) { $why = 'killed-production-distress' } }
        if ($why) { try { $proc.Kill() } catch {}; break }
    }
    $proc.WaitForExit(); $sw.Stop()
    $text = if (Test-Path $out) { Get-Content -Raw -LiteralPath $out } else { '' }
    $m = [regex]::Match([string]$text, 'SWEEP-SUMMARY items=(\d+) findings=(\d+) unreadable=(\d+) unlistable=(\d+) reparse=(\d+) -> (.+\.csv)')
    $status = if ($why) { $why } elseif ($m.Success) { "ok(exit $($proc.ExitCode))" } else { "error(exit $($proc.ExitCode))" }
    $r = [pscustomobject]@{ chunk = $c.id; status = $status; items = $m.Groups[1].Value; findings = $m.Groups[2].Value
        unreadable = $m.Groups[3].Value; unlistable = $m.Groups[4].Value; reparse = $m.Groups[5].Value
        seconds = [int]$sw.Elapsed.TotalSeconds; peakMB = [int]($peak / 1MB); csv = $m.Groups[6].Value.Trim() }
    [void]$results.Add($r)
    $results | Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $runDir 'coverage.csv')
    Log ("[{0}/{1}] {2} items={3} findings={4} unreadable={5} unlistable={6} reparse={7} {8}s peak={9}MB free={10}MB :: {11}" -f `
        $n, $chunks.Count, $status, $r.items, $r.findings, $r.unreadable, $r.unlistable, $r.reparse, $r.seconds, $r.peakMB, (FreeMB), $c.id)
    if ($why -in 'killed-low-memory', 'killed-production-distress') { $abort = "$why during chunk $n ($($c.id))"; break }
}

# ---- merge + coverage
$all = foreach ($r in $results | Where-Object { $_.status -like 'ok*' -and $_.csv }) {
    Import-Csv -LiteralPath $r.csv | ForEach-Object { $_ | Add-Member -NotePropertyName chunk -NotePropertyValue $r.chunk -PassThru }
}
@($all) | Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $runDir 'findings-merged.csv')
$done = @($results | Where-Object { $_.status -like 'ok*' })
$notRun = @($chunks | Select-Object -Skip $results.Count | ForEach-Object { $_.id })
$notRun | Set-Content -Encoding utf8 (Join-Path $runDir 'not-run.txt')
Log ("DONE complete={0}/{1} items={2} findings={3} {4}" -f $done.Count, $chunks.Count, (($done | Measure-Object items -Sum).Sum), @($all).Count, (ProbeText (Probe)))
if ($abort) { Log "ABORTED: $abort" }
@($all) | Group-Object issue | ForEach-Object { Log ("  {0}: {1}" -f $_.Name, $_.Count) }
@($results | Where-Object { $_.status -notlike 'ok*' }) | ForEach-Object { Log "  INCOMPLETE: $($_.status) $($_.chunk)" }
if ($notRun.Count) { Log "  NOT RUN: $($notRun.Count) chunks (not-run.txt)" }
$lock.Close(); Remove-Item -LiteralPath $lockPath -ErrorAction SilentlyContinue
