# Synthetic ACL fixtures for the r3 regression suite. Dot-source; call New-ElvAclFixture / Remove-ElvAclFixture.
# Everything is created under the OWNER's protected profile (%LOCALAPPDATA%\ElevariqR3Fixtures), so broad groups have
# no inherited access to start with. Nothing outside that folder is touched. No system object is created.
#
# Two sub-fixtures:
#   model\  deny SID = a FAKE group SID (not in any token). Walkable by the test runner; used for sweep classification,
#           the r2 baseline comparison and per-object verification (configuration model).
#   real\   deny SID = S-1-5-113 ("Local account"), which IS in the runner's token, so REAL open-for-read checks with
#           the runner's own token show whether Windows actually denies. The runner is NOT the worker: this proves the
#           mechanism (nearer inherited allow beats farther inherited deny), not the worker's isolation.
#           Builder detail: every case directory under real\ also carries an explicit <runner>:(CI)RX ACE so the ACL
#           propagation can enumerate it; that ACE has no OI and never reaches the probed FILES.
$script:ElvFixtureFakeGroupSid = 'S-1-5-32-547'   # BUILTINPower Users: resolvable (icacls requires it), not in BroadSids, not in the runner's token
$script:ElvFixtureRealDenySid  = 'S-1-5-113'

function Invoke-FxIcacls { param([string[]]$IcArgs)
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $o = @(& icacls.exe @IcArgs 2>&1 | ForEach-Object { [string]$_ }); $c = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
    if ($c -ne 0) { throw "fixture icacls failed ($c): $($IcArgs -join ' ') :: $($o -join ' | ')" }
}
function New-FxFile { param([string]$Path, [string]$Content = 'fixture') New-Item -ItemType Directory -Force (Split-Path -Parent $Path) | Out-Null; [IO.File]::WriteAllText($Path, $Content) }

function New-ElvAclFixture {
    param([string]$Root = (Join-Path $env:LOCALAPPDATA ('ElevariqR3Fixtures\acl-{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID)))
    $fxPartial = $null
    try {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $G = $script:ElvFixtureFakeGroupSid; $R = $script:ElvFixtureRealDenySid
    $model = Join-Path $Root 'model'; $real = Join-Path $Root 'real'; $outside = Join-Path $Root 'outside'
    New-Item -ItemType Directory -Force $model, $real, $outside | Out-Null
    New-FxFile (Join-Path $outside 's.txt') 'outside-target'

    # ---------------- model\ (fake group SID; mirrors E:\ with an explicit inheritable DENY on the root)
    foreach ($rel in 'X\c.txt', 'X\deep\deeper\f.txt', 'X\deep\locked\l.txt', 'P\d.txt', 'N\e.txt', 'O\g.txt', 'Q\h.txt', 'U\u.txt', 'work\w.txt') { New-FxFile (Join-Path $model $rel) }
    New-Item -ItemType Directory -Force (Join-Path $model 'req') | Out-Null
    Invoke-FxIcacls @($model, '/inheritance:r', '/grant:r', "*${me}:(OI)(CI)F")
    Invoke-FxIcacls @((Join-Path $model 'X'), '/grant', '*S-1-1-0:(OI)(CI)(IO)F')                                  # reviewer's counterexample: inherit-only broad allow
    Invoke-FxIcacls @((Join-Path $model 'X\deep\locked'), '/inheritance:r', '/grant:r', "*${me}:(OI)(CI)F")          # protected, no broad: exposure stops here
    Invoke-FxIcacls @((Join-Path $model 'P'), '/inheritance:r', '/grant:r', "*${me}:(OI)(CI)F", '*S-1-5-32-545:(OI)(CI)(IO)M')   # protected, ONLY inherit-only broad access
    Invoke-FxIcacls @((Join-Path $model 'O'), '/grant', '*S-1-1-0:(OI)(CI)F')                                       # explicit broad allow (non-IO), then its own explicit DENY
    Invoke-FxIcacls @((Join-Path $model 'O'), '/deny', "*${G}:(OI)(CI)F")                                          # = the -AdditionalDenyPaths remedy
    Invoke-FxIcacls @((Join-Path $model 'Q'), '/inheritance:r', '/grant:r', "*${me}:(OI)(CI)F")                      # protected, owner only
    Invoke-FxIcacls @((Join-Path $model 'U\u.txt'), '/inheritance:r', '/grant:r', '*S-1-3-4:(RA,DE)')               # unreadable: OWNER RIGHTS strips implicit READ_CONTROL (DE added only so the non-elevated runner can delete it in teardown; RA/DE give no read)
    Invoke-FxIcacls @((Join-Path $model 'req'), '/inheritance:r', '/grant:r', "*${me}:(WD)", '*S-1-3-4:(OI)(IO)(RC,DE)')  # M9 spool\requests semantics (production uses RC only; DE here is a teardown affordance and leaves WRITE_DATA/WRITE_DAC absent)
    Invoke-FxIcacls @($model, '/deny', "*${G}:(OI)(CI)F")                                                           # the group DENY at the "volume root"
    & cmd.exe /c mklink /J (Join-Path $model 'J') $outside | Out-Null                                                # junction to OUTSIDE the deny root

    # ---------------- real\ (S-1-5-113 is in the runner's token; the DENY on real\ is inherit-only so real\ stays listable)
    foreach ($rel in 'X\c.txt', 'N\e.txt', 'N\locked\l.txt', 'O\g.txt', 'P\d.txt') { New-FxFile (Join-Path $real $rel) }
    Invoke-FxIcacls @($real, '/inheritance:r', '/grant:r', "*${me}:(OI)(CI)F")
    foreach ($d in 'X', 'N', 'O', 'P') { Invoke-FxIcacls @((Join-Path $real $d), '/grant', "*${me}:(CI)(RX)") }   # builder-only traverse/list ACE (no OI)
    Invoke-FxIcacls @((Join-Path $real 'X'), '/grant', '*S-1-1-0:(OI)(CI)(IO)F')
    Invoke-FxIcacls @((Join-Path $real 'O'), '/grant', '*S-1-1-0:(OI)(CI)F')
    Invoke-FxIcacls @((Join-Path $real 'O'), '/deny', "*${R}:(OI)(CI)F")
    Invoke-FxIcacls @((Join-Path $real 'P'), '/inheritance:r', '/grant:r', "*${me}:(CI)(RX)", '*S-1-5-32-545:(OI)(CI)(IO)M')
    Invoke-FxIcacls @((Join-Path $real 'N\locked'), '/inheritance:r', '/grant:r', "*${me}:(RX)")   # runner may traverse/list, so l.txt is reachable but its own DACL is empty
    Invoke-FxIcacls @((Join-Path $real 'N\locked\l.txt'), '/inheritance:r')
    Invoke-FxIcacls @($real, '/deny', "*${R}:(OI)(CI)(IO)F")                                                       # farther ancestor DENY (inherit-only on real\ itself)

    $fxPartial = [pscustomobject]@{ Root = $Root; Model = $model; Real = $real; Outside = $outside; Me = $me; FakeGroupSid = $G; RealDenySid = $R }
    return $fxPartial
    } catch {
        $partial = [pscustomobject]@{ Root = $Root; Model = (Join-Path $Root 'model'); Real = (Join-Path $Root 'real'); Outside = (Join-Path $Root 'outside'); Me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; FakeGroupSid = $script:ElvFixtureFakeGroupSid; RealDenySid = $script:ElvFixtureRealDenySid }
        [void](Remove-ElvAclFixture $partial)
        throw
    }
}

function Remove-ElvAclFixture {
    param($Fx)
    $me = $Fx.Me; $problems = @()
    try {
        # Unlink junctions first so no /reset or delete ever follows one into the outside target (M10 lesson).
        foreach ($rp in @(Get-ChildItem -LiteralPath $Fx.Root -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { & cmd.exe /c rmdir "$($rp.FullName)" 2>&1 | Out-Null }
        # Lift the inherit-only / explicit denies that would otherwise re-apply to the runner after a reset.
        foreach ($p in @($Fx.Real, (Join-Path $Fx.Real 'O'))) { if (Test-Path -LiteralPath $p) { try { Invoke-FxIcacls @($p, '/remove:d', "*$($Fx.RealDenySid)") } catch { $problems += $_.Exception.Message } } }
        # The runner owns every object (implicit WRITE_DAC on dirs; OWNER-RIGHTS files keep DELETE), so /reset restores
        # inherited full control top-down and every file is then deletable.
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { foreach ($sub in 'model', 'real', 'outside') { $p = Join-Path $Fx.Root $sub; if (Test-Path -LiteralPath $p) { & icacls.exe $p /reset /T /C /Q 2>&1 | Out-Null } } } finally { $ErrorActionPreference = $eap }
        # Resilient delete: files first (so parent DELETE_CHILD/file DELETE both apply), then directories deepest-first.
        foreach ($f in @(Get-ChildItem -LiteralPath $Fx.Root -Recurse -Force -File -ErrorAction SilentlyContinue)) { try { [IO.File]::Delete($f.FullName) } catch { try { & cmd.exe /c del /f /q "$($f.FullName)" 2>&1 | Out-Null } catch {} } }
        foreach ($d in @(Get-ChildItem -LiteralPath $Fx.Root -Recurse -Force -Directory -ErrorAction SilentlyContinue | Sort-Object { $_.FullName.Length } -Descending)) { try { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue } catch {} }
        Remove-Item -LiteralPath $Fx.Root -Recurse -Force -ErrorAction Stop
    } catch { $problems += $_.Exception.Message }
    if (Test-Path -LiteralPath $Fx.Root) { $problems += "fixture root still present: $($Fx.Root)" }
    return $problems
}

# Real access check with the RUNNER's token: open-only, no bytes written. Returns 'ALLOWED' | 'DENIED' | 'MISSING' | 'ERROR:<type>'.
function Test-FxRealOpen {
    param([string]$Path, [ValidateSet('Read', 'ReadWrite')][string]$Access = 'Read')
    if (-not [IO.File]::Exists($Path)) { try { [void][IO.File]::GetAttributes($Path) } catch [System.IO.FileNotFoundException] { return 'MISSING' } catch [System.IO.DirectoryNotFoundException] { return 'MISSING' } catch {} }
    try { $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]$Access, [IO.FileShare]::ReadWrite); $fs.Dispose(); return 'ALLOWED' }
    catch [System.UnauthorizedAccessException] { return 'DENIED' }
    catch { return "ERROR:$($_.Exception.GetType().Name)" }
}
