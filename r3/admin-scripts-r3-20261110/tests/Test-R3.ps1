# Offline regression tests for admin-scripts r3. Non-elevated; makes NO system changes.
# Pure functions + synthetic ACL fixtures under %LOCALAPPDATA%\ElevariqR3Fixtures + dry-runs of every script and mode.
# Real open-for-read checks run with the RUNNER's own token on fixture files it owns; they are mechanism tests, not
# worker-isolation tests (the worker account does not exist).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root '_common.ps1')
. (Join-Path $PSScriptRoot 'Fixture-AclCases.ps1')
$pass = 0; $fail = 0; $results = New-Object System.Collections.ArrayList
function T([string]$Name, [scriptblock]$Body) {
    try { $r = & $Body; if ($r -eq $true) { $script:pass++; Write-Host "PASS $Name"; [void]$results.Add(@{ n = $Name; s = 'PASS' }) } else { $script:fail++; Write-Host "FAIL $Name -> $r"; [void]$results.Add(@{ n = $Name; s = 'FAIL'; d = "$r" }) } }
    catch { $script:fail++; Write-Host "FAIL $Name -> EXC $($_.Exception.Message)"; [void]$results.Add(@{ n = $Name; s = 'FAIL'; d = $_.Exception.Message }) }
}
function Throws([scriptblock]$b) { try { & $b | Out-Null; return $false } catch { return $true } }
function ThrowsLike([scriptblock]$b, [string]$Pattern) { try { & $b | Out-Null; return "no exception" } catch { if ($_.Exception.Message -match $Pattern) { return $true } else { return "wrong exception: $($_.Exception.Message)" } } }
$rep = New-ElvReport 'test-r3' $true
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$testStart = Get-Date

Write-Host "`n### A. r1/r2 regressions kept"
T 'r1 regex bug reproduced ("$script:X:\(N\)" -> "\(N\)")' { $script:Xa = 'elv'; ("$script:Xa:\(N\)" -eq '\(N\)') }
T 'r2 form keeps the name ("${script:X}:")' { $script:Xa = 'elv'; ("${script:Xa}:\(N\)" -eq 'elv:\(N\)') }

Write-Host "`n### B. path guards (L1)"
T 'staging root accepted'               { (Assert-StagingPath $rep 'C:\ElevariqStaging\work\x') -like 'C:\ElevariqStaging\*' }
T 'staging prefix trap rejected'        { Throws { Assert-StagingPath $rep 'C:\ElevariqStagingEvil\x' } }
T 'disk dir accepted'                   { [bool](Assert-StagingPath $rep 'C:\ElevariqStagingDisk\elv-staging.vhdx') }
T 'production checkout rejected'        { Throws { Assert-StagingPath $rep 'E:\Agent\Personal-agent\dist' } }
T 'owner .claude rejected'              { Throws { Assert-StagingPath $rep (Join-Path $env:USERPROFILE '.claude') } }
T 'prod home rejected'                  { Throws { Assert-StagingPath $rep (Join-Path $env:LOCALAPPDATA 'ElevariqAgent\agent.db') } }
T 'dot-dot escape rejected'             { Throws { Assert-StagingPath $rep 'C:\ElevariqStaging\..\Windows' } }
T 'L1 \\?\ device form refused'         { ThrowsLike { Get-ElvCanonicalPath '\\?\E:\Agent\Personal-agent\.env' } 'Refus|Illegal' }
T 'L1 \\.\ device form refused'         { ThrowsLike { Get-ElvCanonicalPath '\\.\E:\Agent\Personal-agent\.env' } 'Refus|not supported' }
T 'L1 admin-share UNC refused'          { ThrowsLike { Get-ElvCanonicalPath '\\localhost\E$\Agent\Personal-agent\.env' } 'UNC' }
T 'L1 forward-slash UNC refused'        { ThrowsLike { Get-ElvCanonicalPath '//localhost/E$/x' } 'UNC' }
T 'L1 relative path canonicalised to a drive path' { (Get-ElvCanonicalPath 'tests\x') -match '^[A-Za-z]:\\' }
T 'L1 Assert-ElvNotProduction refuses admin-share form of production' { Throws { Assert-ElvNotProduction $rep '\\localhost\E$\Agent\Personal-agent\.env' } }
T 'deny target E:\ accepted'            { (Assert-DenyTarget $rep 'E:\') -eq 'E:\' }
T 'deny target C:\Download accepted'    { [bool](Assert-DenyTarget $rep 'C:\Download') }
T 'deny target E:\$RECYCLE.BIN accepted (M11)' { [bool](Assert-DenyTarget $rep 'E:\$RECYCLE.BIN') }
T 'deny target C:\Windows rejected'     { Throws { Assert-DenyTarget $rep 'C:\Windows' } }
T 'deny target inside prod rejected even if listed' { Throws { Assert-DenyTarget $rep 'E:\Agent\Personal-agent\dist' @('E:\Agent\Personal-agent\dist') } }
T 'L1/M3 listed extra accepted ONLY when it is a coverable sweep finding' {
    $f = @([pscustomobject]@{ path = 'E:\Agent\v2-staging'; issue = 'explicit-broad-allow' })
    ([bool](Assert-DenyTarget $rep 'E:\Agent\v2-staging' @('E:\Agent\v2-staging') $f)) -and
    (Throws { Assert-DenyTarget $rep 'E:\Agent\v2-staging' @('E:\Agent\v2-staging') @([pscustomobject]@{ path = 'E:\Agent\v2-staging'; issue = 'unlistable' }) }) -and
    (Throws { Assert-DenyTarget $rep 'C:\Windows' @('C:\Windows') $f }) }
T 'L1 self-authorising -Additional C:\Windows refused when sweep findings are given' { Throws { Assert-DenyTarget $rep 'C:\Windows' @('C:\Windows') @() } }

Write-Host "`n### C. IPv4 complement (L6)"
T 'complement of loopback only' { ((Get-ElvIPv4Complement @('127.0.0.0/8')) -join ',') -eq '0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255' }
T 'complement with allow CIDR'  { ((Get-ElvIPv4Complement @('127.0.0.0/8', '160.79.104.0/23')) -join ',') -eq '0.0.0.0-126.255.255.255,128.0.0.0-160.79.103.255,160.79.106.0-255.255.255.255' }
T 'overlapping CIDRs merged'    { ((Get-ElvIPv4Complement @('10.0.0.0/8', '10.1.0.0/16')) -join ',') -eq '0.0.0.0-9.255.255.255,11.0.0.0-255.255.255.255' }
T 'unaligned CIDR normalised'   { ((Get-ElvIPv4Complement @('10.0.0.5/24')) -join ',') -eq '0.0.0.0-9.255.255.255,10.0.1.0-255.255.255.255' }
T 'bad CIDR throws'             { Throws { Get-ElvIPv4Range '999.1.1.1/8' } }
T 'host name rejected'          { Throws { Get-ElvIPv4Range 'api.anthropic.com' } }
T 'L6 leading-zero octet (octal trap) rejected' { Throws { Get-ElvIPv4Range '010.0.0.0/8' } }
T 'L6 empty complement (0.0.0.0/0) refused'    { ThrowsLike { Get-ElvIPv4Complement @('0.0.0.0/0') } 'EMPTY' }

Write-Host "`n### D. user-rights INF (L2/L3)"
$inf = @('[Unicode]', 'Unicode=yes', '[Privilege Rights]', 'SeBatchLogonRight = *S-1-5-32-544,*S-1-5-32-551', 'SeDenyNetworkLogonRight = Guest', '[Version]', 'signature="$CHICAGO$"')
$cur = ConvertFrom-ElvRightsInf $inf
T 'INF parse' { ($cur['SeBatchLogonRight'].Count -eq 2) -and ($cur['SeDenyNetworkLogonRight'][0] -eq 'Guest') -and -not $cur.ContainsKey('signature') }
$new = New-ElvRightsInf -Current $cur -Add @{ SeBatchLogonRight = @('*S-1-5-21-1-2-3-1002'); SeDenyInteractiveLogonRight = @('*S-1-5-21-1-2-3-1003') }
T 'INF add keeps existing, adds new right' { ($new -match 'SeBatchLogonRight = \*S-1-5-32-544,\*S-1-5-32-551,\*S-1-5-21-1-2-3-1002') -and ($new -match 'SeDenyInteractiveLogonRight = \*S-1-5-21-1-2-3-1003') -and ($new -notmatch 'SeDenyNetworkLogonRight') }
$rem = New-ElvRightsInf -Current (ConvertFrom-ElvRightsInf ($new -split "`r`n")) -Remove @{ SeBatchLogonRight = @('*S-1-5-21-1-2-3-1002') }
T 'INF remove' { $rem -match 'SeBatchLogonRight = \*S-1-5-32-544,\*S-1-5-32-551\s*$' }
T 'INF add idempotent' { $twice = New-ElvRightsInf -Current (ConvertFrom-ElvRightsInf ($new -split "`r`n")) -Add @{ SeBatchLogonRight = @('*S-1-5-21-1-2-3-1002') }; ([regex]::Matches($twice, '1002')).Count -eq 1 }
T 'L2 remove with case mismatch terminates and removes' {
    $job = Start-Job -ScriptBlock { param($c) . $c; New-ElvRightsInf -Current @{ SeX = @('*s-1-2-3', '*S-1-2-3', '*S-1-9') } -Remove @{ SeX = @('*S-1-2-3') } } -ArgumentList (Join-Path $root '_common.ps1')
    if (-not (Wait-Job $job -Timeout 20)) { Stop-Job $job; Remove-Job $job -Force; return 'HUNG (r2 L2 defect)' }
    $o = Receive-Job $job; Remove-Job $job; ($o -split "`r`n" | Select-Object -Last 1) -eq 'SeX = *S-1-9' }
T 'right held by SID or name' { (Test-ElvRightHeld @{ R = @('*S-1-2'); Q = @('bob') } 'R' 'S-1-2' 'x') -and (Test-ElvRightHeld @{ Q = @('bob') } 'Q' 'S-9' 'bob') -and -not (Test-ElvRightHeld @{ R = @('*S-1-3') } 'R' 'S-1-2' 'x') }

Write-Host "`n### E. spec semantics (M9/I4)"
T 'spec M'    { (Test-ElvSpec 0x1301BF 'M') -and -not (Test-ElvSpec 0x1200A9 'M') }
T 'spec RX'   { (Test-ElvSpec 0x1200A9 'RX') -and -not (Test-ElvSpec 0x1301BF 'RX') }
T 'spec W'    { (Test-ElvSpec 0x100116 'W') -and -not (Test-ElvSpec 0x1301BF 'W') }
T 'spec WD-this = add-file only (no list, no delete, no write-dac)' { (Test-ElvSpec 0x2 'WD-this') -and -not (Test-ElvSpec 0x3 'WD-this') -and -not (Test-ElvSpec 0x10002 'WD-this') -and -not (Test-ElvSpec 0x100116 'WD-this') }
T 'spec RX+D = read + delete, no write'  { (Test-ElvSpec 0x1300A9 'RX+D') -and -not (Test-ElvSpec 0x1200A9 'RX+D') -and -not (Test-ElvSpec 0x1301BF 'RX+D') }
T 'spec DENY/none' { (Test-ElvSpec 0 'DENY') -and (Test-ElvSpec 0 '') -and -not (Test-ElvSpec 1 'DENY') }
T 'layout: bin admin-only, requests WD-this+OwnerRights, approvals broker RX+D' {
    $bin = $script:ElvLayout | ? { $_.Rel -eq 'bin' }; $rq = $script:ElvLayout | ? { $_.Rel -eq 'spool\requests' }; $ap = $script:ElvLayout | ? { $_.Rel -eq 'spool\approvals' }
    ($bin.W -eq 'RX' -and $bin.O -eq 'RX' -and -not $bin.B) -and ($rq.W -eq 'WD-this' -and $rq.OwnerRights) -and ($ap.B -eq 'RX+D' -and $ap.W -eq 'DENY') }
T 'ConvertTo-ElvGrant specs' { ((ConvertTo-ElvGrant 'S-1-9' 'WD-this') -join ' ') -eq '/grant:r *S-1-9:(WD)' -and ((ConvertTo-ElvGrant 'S-1-9' 'RX+D') -join ' ') -eq '/grant:r *S-1-9:(OI)(CI)(RX,DE)' -and ((ConvertTo-ElvGrant 'S-1-9' 'DENY') -join ' ') -eq '/deny *S-1-9:(OI)(CI)F' }

Write-Host "`n### F. B1 classification, pure synthetic SDDL (reviewer counterexample)"
$ioAllow = 'D:AI(A;OICIIO;FA;;;WD)(A;ID;0x1301bf;;;AU)'
$protIO  = 'D:PAI(A;OICIIO;0x1301bf;;;BU)(A;OICI;FA;;;SY)'
$r2Filter = { param($sddl) @(Get-ElvAces -Sddl $sddl | Where-Object { -not $_.Inherited -and -not $_.InheritOnly -and $_.Type -eq 'AccessAllowed' -and ($script:BroadSids -contains $_.Sid) }).Count }
T 'B1 OLD filter misses the explicit inherit-only Everyone:F (reproduces the rejected behaviour)' { (& $r2Filter $ioAllow) -eq 0 }
T 'B1 NEW classification flags it as explicit-broad-allow (IO)' { $c = @(Get-ElvAclClassification -Sddl $ioAllow); $c.Count -eq 1 -and $c[0].issue -eq 'explicit-broad-allow' -and $c[0].detail -match 'S-1-1-0:0x1F01FF\(IO\)' }
T 'B1 OLD protected test (effective mask skips IO) misses protected IO-only Users:M' { (Get-ElvEffectiveMask -Sids $script:BroadSids -Aces @(Get-ElvAces -Sddl $protIO)) -eq 0 }
T 'B1 NEW classification flags protected-with-broad-access for IO-only broad ACE' { @(Get-ElvAclClassification -Sddl $protIO | ? { $_.issue -eq 'protected-with-broad-access' }).Count -eq 1 }
T 'classification: null DACL' { @(Get-ElvAclClassification -Sddl 'O:BAG:BAD:NO_ACCESS_CONTROL')[0].issue -eq 'null-dacl' }
T 'classification: clean protected DACL (SYSTEM/BA only) -> no finding' { @(Get-ElvAclClassification -Sddl 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)').Count -eq 0 }
T 'classification: inherited broad allow (not explicit, not protected) -> no finding (covered by the ancestor)' { @(Get-ElvAclClassification -Sddl 'D:AI(A;ID;0x1301bf;;;AU)').Count -eq 0 }
T 'classification: zero-mask broad ACE ignored' { @(Get-ElvAclClassification -Sddl 'D:AI(A;OICI;;;;WD)').Count -eq 0 }
T 'L5 broad SIDs include NTLM (S-1-5-64-10), asserted identity, NETWORK, SERVICE, Guests' { @('S-1-5-64-10','S-1-18-1','S-1-5-2','S-1-5-6','S-1-5-32-546') | ? { $script:BroadSids -notcontains $_ } | Measure-Object | % { $_.Count -eq 0 } }
T 'effective mask: ACE ordering deny-before-allow and allow-before-deny (object itself)' {
    ((Get-ElvEffectiveMask -Sids @('S-1-1-0') -Aces @(Get-ElvAces -Sddl 'D:(D;;FA;;;WD)(A;;FA;;;WD)')) -eq 0) -and ((Get-ElvEffectiveMask -Sids @('S-1-1-0') -Aces @(Get-ElvAces -Sddl 'D:(A;;FA;;;WD)(D;;FA;;;WD)')) -eq 0x1F01FF) }
T 'effective mask: generic rights expanded (GR|GW -> 0x12019F)' { (Get-ElvEffectiveMask -Sids @('S-1-1-0') -Aces @(Get-ElvAces -Sddl 'D:(A;;GRGW;;;WD)')) -eq 0x12019F }
T 'effective mask: group membership (SID set) decides; non-member SID ignored' { ((Get-ElvEffectiveMask -Sids @('S-1-5-11') -Aces @(Get-ElvAces -Sddl 'D:(A;;FA;;;BU)')) -eq 0) -and ((Get-ElvEffectiveMask -Sids @('S-1-5-11','S-1-5-32-545') -Aces @(Get-ElvAces -Sddl 'D:(A;;FA;;;BU)')) -eq 0x1F01FF) }

Write-Host "`n### G. on-disk synthetic fixture: sweep, r2 baseline, per-object verification, REAL open checks"
$fx = $null; $fxProblems = @()
try {
    try { $fx = New-ElvAclFixture } catch { Write-Host "FAIL fixture build -> $($_.Exception.Message)"; $script:fail++ }
  if ($fx) {
    T 'fixture built' { [bool]$fx -and (Test-Path -LiteralPath (Join-Path $fx.Model 'X\c.txt')) }
    $csv = Join-Path $env:TEMP "elv-r3-sweep-$PID.csv"
    $sw = Invoke-ElvSweep -Roots @($fx.Model) -OutCsv $csv -RootSet @($fx.Model)
    $issues = @{}; foreach ($r in $sw.Rows) { $k = $r.path.Substring($fx.Model.Length).TrimStart('\'); if (-not $issues[$k]) { $issues[$k] = @() }; $issues[$k] += $r.issue }
    T 'sweep r3: X (explicit inherit-only Everyone:F) -> explicit-broad-allow'  { $issues['X'] -contains 'explicit-broad-allow' }
    T 'sweep r3: P (protected, IO-only Users:M) -> explicit-broad-allow + protected-with-broad-access' { ($issues['P'] -contains 'explicit-broad-allow') -and ($issues['P'] -contains 'protected-with-broad-access') }
    T 'sweep r3: O (explicit Everyone:F, own explicit DENY) -> explicit-broad-allow (coverable)' { $issues['O'] -contains 'explicit-broad-allow' }
    T 'sweep r3: N, Q (protected owner-only), work, locked -> no finding' { -not $issues['N'] -and -not $issues['Q'] -and -not $issues['work'] -and -not $issues['X\deep\locked'] }
    T 'sweep r3: req (worker add-file-only) is UNLISTABLE to the non-elevated runner -> the sweep MUST run elevated' { $issues['req'] -contains 'unlistable' }
    T 'sweep r3: children of X carry only inherited ACEs -> no finding on them (the finding is on X)' { -not $issues['X\c.txt'] -and -not $issues['X\deep'] }
    T 'sweep r3: U\u.txt unreadable (OWNER RIGHTS strips READ_CONTROL) reported' { $issues['U\u.txt'] -contains 'unreadable' }
    T 'sweep r3: junction J reported as reparse-point OUTSIDE and not followed' { ($issues['J'] -contains 'reparse-point') -and -not $issues['J\s.txt'] -and ((Import-Csv $csv | ? { $_.issue -eq 'reparse-point' }).detail -match 'OUTSIDE') }
    T 'sweep r3: stats consistent (findings = rows minus reparse/unreadable/unlistable)' { $sw.Stats.findings -eq @($sw.Rows | ? { $_.issue -notin @('reparse-point','unreadable','unlistable','skipped-root') }).Count }
    $r2json = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'r2-baseline-check.ps1') -FixtureRoot $fx.Model) -join ''   # NO Out-String: it wraps long JSON lines and corrupts them
    # PS 5.1: @($json | ConvertFrom-Json) wraps a returned array as ONE element, so iterate the raw parse result.
    $parsed = $null; try { $parsed = $r2json | ConvertFrom-Json } catch {}
    $r2map = @{}; $r2count = 0
    foreach ($r in $parsed) { $r2count++; $k = ($r.path -ireplace [regex]::Escape($fx.Model), '').TrimStart('\'); if (-not $r2map[$k]) { $r2map[$k] = @() }; $r2map[$k] += $r.issue }
    T 'r2 BASELINE (rejected hash 126d700c): X NOT flagged (B1 reproduced on disk)' { ($r2count -ge 1) -and -not $r2map['X'] }
    T 'r2 BASELINE: P NOT flagged (B1 protected variant reproduced on disk)'        { ($r2count -ge 1) -and -not $r2map['P'] }
    T 'r2 BASELINE: O IS flagged (non-IO explicit allow was always detected)'      { $r2map['O'] -contains 'explicit-broad-allow' }
    # per-object verification (H1) with the modelled token: broad SIDs + fake group SID (the runner's SID is NOT in it)
    $vcsv = Join-Path $env:TEMP "elv-r3-verify-$PID.csv"
    $tok = Get-ElvTokenSidSet @($fx.FakeGroupSid)
    $vr = Invoke-ElvObjectVerify -Roots @($fx.Model) -OutCsv $vcsv -RootSet @() -TokenSids $tok
    $exp = @{}; foreach ($r in $vr.Rows) { $k = $r.path.Substring($fx.Model.Length).TrimStart('\'); if (-not $exp[$k]) { $exp[$k] = @() }; $exp[$k] += $r.issue }
    T 'V3: model root itself has mask 0 (explicit DENY applies)' { -not $exp[''] }
    T 'V3: X\c.txt EXPOSED (nearer inherited Everyone:F precedes the root DENY)' { $exp['X\c.txt'] -contains 'exposed' }
    T 'V3: nested X\deep\deeper\f.txt EXPOSED' { $exp['X\deep\deeper\f.txt'] -contains 'exposed' }
    T 'V3: X itself NOT exposed (inherit-only ACE does not apply to X)' { -not $exp['X'] }
    T 'V3: X\deep\locked\l.txt NOT exposed (protected cut, no broad ACE)' { -not $exp['X\deep\locked\l.txt'] }
    T 'V3: P\d.txt EXPOSED (protected parent passes Users:M down, DENY never arrives)' { $exp['P\d.txt'] -contains 'exposed' }
    T 'V3: O\g.txt NOT exposed (explicit DENY on O sorts before its explicit allow: the AdditionalDenyPaths remedy)' { -not $exp['O\g.txt'] }
    T 'V3: N\e.txt NOT exposed (plain inheritance: DENY arrives)' { -not $exp['N\e.txt'] }
    T 'V3: Q\h.txt NOT exposed (protected owner-only)' { -not $exp['Q\h.txt'] }
    T 'V3: U\u.txt unreadable counted as failure' { ($exp['U\u.txt'] -contains 'unreadable') -and ($vr.Stats.unreadable -ge 1) }
    T 'V3: junction not followed (no rows under J\)' { ($exp['J'] -contains 'reparse-point') -and -not $exp['J\s.txt'] }
    T 'V3 with captured token CSV adds the real worker SIDs to the modelled token (integrity-level SIDs filtered)' {
        $cap = Join-Path $env:TEMP "elv-r3-groups-$PID.csv"; '"Group Name","Type","SID","Attributes"' | Set-Content $cap
        "`"Everyone`",`"Well-known group`",`"S-1-1-0`",`"Mandatory`"" | Add-Content $cap
        "`"captured`",`"User`",`"$me`",`"`"" | Add-Content $cap
        "`"integrity`",`"Label`",`"S-1-16-8192`",`"`"" | Add-Content $cap
        $tok2 = Get-ElvTokenSidSet @($fx.FakeGroupSid) $cap
        Remove-Item $cap -Force
        ($tok2 -contains $me) -and ($tok2 -notcontains 'S-1-16-8192') -and ($tok2 -contains 'S-1-1-0') }
    # REAL open checks with the runner's token (S-1-5-113 DENY on real\, inherit-only)
    T 'REAL: real\X\c.txt open-for-read ALLOWED despite the ancestor DENY (demonstrated counterexample, runner token)' { (Test-FxRealOpen (Join-Path $fx.Real 'X\c.txt') 'Read') -eq 'ALLOWED' }
    T 'REAL: real\X\c.txt open-for-write ALLOWED too (Full, not just read)' { (Test-FxRealOpen (Join-Path $fx.Real 'X\c.txt') 'ReadWrite') -eq 'ALLOWED' }
    T 'REAL: real\P\d.txt ALLOWED (protected parent with IO-only Users:M)' { (Test-FxRealOpen (Join-Path $fx.Real 'P\d.txt') 'Read') -eq 'ALLOWED' }
    T 'REAL: real\N\e.txt DENIED (inherited DENY works where nothing precedes it)' { (Test-FxRealOpen (Join-Path $fx.Real 'N\e.txt') 'Read') -eq 'DENIED' }
    T 'REAL: real\O\g.txt DENIED (explicit DENY on O precedes its explicit Everyone allow)' { (Test-FxRealOpen (Join-Path $fx.Real 'O\g.txt') 'Read') -eq 'DENIED' }
    T 'REAL: real\N\locked\l.txt DENIED (protected empty DACL; owner keeps only RC/WDAC)' { (Test-FxRealOpen (Join-Path $fx.Real 'N\locked\l.txt') 'Read') -eq 'DENIED' }
    T 'REAL agrees with the model on every real\ case (prediction = observation)' {
        $tokR = Get-ElvTokenSidSet @($fx.RealDenySid, $me)   # the runner's token: broad + S-1-5-113 + its own SID
        $ok = $true
        foreach ($c in @(@{ P = 'X\c.txt'; E = 'ALLOWED' }, @{ P = 'P\d.txt'; E = 'ALLOWED' }, @{ P = 'N\e.txt'; E = 'DENIED' }, @{ P = 'O\g.txt'; E = 'DENIED' }, @{ P = 'N\locked\l.txt'; E = 'DENIED' })) {
            $p = Join-Path $fx.Real $c.P
            $real = Test-FxRealOpen $p 'Read'
            if ($real -ne $c.E) { $ok = "REAL mismatch on $($c.P): real=$real expected=$($c.E)"; continue }
            # Model prediction needs READ_CONTROL on the object; where the DENY blocks even that (O, locked), the
            # non-elevated runner cannot read the ACL. The real deny is already demonstrated above; only compare the
            # model where the ACL is readable (the real run reads ACLs elevated).
            $m = $null; try { $m = Get-ElvEffectiveMask $p $tokR } catch {}
            if ($null -ne $m) { $pred = $(if ($m -band 0x1) { 'ALLOWED' } else { 'DENIED' }); if ($pred -ne $c.E) { $ok = "MODEL mismatch on $($c.P): model=$pred ($('0x{0:X}' -f $m)) expected=$($c.E)" } }
        }
        $ok }
    T 'REAL: junction target outside the deny root is readable through the junction (DENY does not cover reparse targets)' { (Test-FxRealOpen (Join-Path $fx.Model 'J\s.txt') 'Read') -eq 'ALLOWED' }
    # positive controls + M9 request-spool semantics
    T 'POSITIVE: authorised work\ dir: create + write + read succeed' { $p = Join-Path $fx.Model 'work\new.txt'; [IO.File]::WriteAllText($p, 'ok'); ([IO.File]::ReadAllText($p) -eq 'ok') }
    T 'M9: creator can write a NEW request through the creation handle' { $p = Join-Path $fx.Model 'req\r1.json'; $fs = [IO.File]::Open($p, 'CreateNew', 'Write', 'None'); $b = [Text.Encoding]::ASCII.GetBytes('{"r":1}'); $fs.Write($b, 0, $b.Length); $fs.Dispose(); $true }
    T 'M9: creator can NOT reopen its own request for write (OWNER RIGHTS RC only, no implicit WRITE_DAC)' { (Test-FxRealOpen (Join-Path $fx.Model 'req\r1.json') 'ReadWrite') -eq 'DENIED' }
    T 'M9: creator can NOT read it back either' { (Test-FxRealOpen (Join-Path $fx.Model 'req\r1.json') 'Read') -eq 'DENIED' }
    T 'M9: creator can NOT change the DACL of its request (WRITE_DAC stripped)' { Throws { $a = Get-Acl -LiteralPath (Join-Path $fx.Model 'req\r1.json'); $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow'))); Set-Acl -LiteralPath (Join-Path $fx.Model 'req\r1.json') -AclObject $a } }
    T 'M9: creator can NOT list the request directory (no FILE_LIST_DIRECTORY)' { Throws { Get-ChildItem -LiteralPath (Join-Path $fx.Model 'req') -ErrorAction Stop | Out-Null } }
    # R3-N1 and M1
    T 'R3-N1: inheritable ACE spec on a FILE is refused (icacls would silently drop it with exit 0)' { ThrowsLike { Invoke-ElvIcacls @((Join-Path $fx.Model 'N\e.txt'), '/deny', '*S-1-5-32-547:(OI)(CI)F') $false $rep (Join-Path $fx.Model 'N\e.txt') 'x' } 'inheritable|R3-N1|silently' }
    T 'M1: icacls failure under EAP=Stop is captured and recorded as a refusal with the exit code' {
        $r = New-ElvReport 'm1' $false
        $thrown = Throws { Invoke-ElvIcacls @('C:\elv-does-not-exist-9f3a\zz', '/grant', '*S-1-1-0:R') $false $r 'C:\elv-does-not-exist-9f3a\zz' 'x' }
        $thrown -and ($r.refusals.Count -eq 1) -and ($r.refusals[0].reason -match 'icacls exit \d+') }
    T 'M1: trap saves the report on an unexpected error (00 -Verify without a group throws; report has error)' {
        $before = @(Get-ChildItem (Join-Path $root 'reports') -Filter '00-isolation-group-deny-*.json' | % Name)
        $null = Throws { & (Join-Path $root '00-isolation-group-deny.ps1') -Verify *>&1 | Out-Null }
        $new = @(Get-ChildItem (Join-Path $root 'reports') -Filter '00-isolation-group-deny-*.json' | ? { $before -notcontains $_.Name })
        if ($new.Count -lt 1) { return 'no new report' }
        $j = Get-Content $new[-1].FullName -Raw | ConvertFrom-Json
        [bool]$j.error -and ($j.error -match 'Nothing to verify|deny group') }
    # M2 backups: baseline preserved across a re-run, timestamped copies, exit codes checked
    T 'M2: second backup run keeps the FIRST baseline-root.sddl and adds a new timestamped copy' {
        $bdir = Join-Path $env:TEMP "elv-r3-acl-$PID"; $t = Join-Path $fx.Model 'N'
        $d1 = Backup-ElvAcl -Target $t -AclDir $bdir -Stamp '20260101-000000' -Full $true
        $base1 = Get-Content (Join-Path $d1 'baseline-root.sddl') -Raw
        Invoke-FxIcacls @($t, '/grant', '*S-1-5-32-546:(RX)')          # change the ACL between runs (as a partial-failure rerun would see)
        $d2 = Backup-ElvAcl -Target $t -AclDir $bdir -Stamp '20260101-000001' -Full $true
        $base2 = Get-Content (Join-Path $d2 'baseline-root.sddl') -Raw
        $ok = ($d1 -eq $d2) -and ($base1 -eq $base2) -and (Test-Path (Join-Path $d1 '20260101-000000-root.sddl')) -and (Test-Path (Join-Path $d1 '20260101-000001-root.sddl')) -and ((Get-Content (Join-Path $d1 '20260101-000001-root.sddl') -Raw) -ne $base1) -and (Test-Path (Join-Path $d1 '20260101-000001-full.acl'))
        Invoke-FxIcacls @($t, '/remove:g', '*S-1-5-32-546'); Remove-Item $bdir -Recurse -Force -ErrorAction SilentlyContinue; $ok }
    T 'M2: full-tree backup failure (missing target) is an error, not silent' { Throws { Backup-ElvAcl -Target 'C:\elv-does-not-exist-9f3a' -AclDir (Join-Path $env:TEMP "elv-r3-acl2-$PID") -Stamp 'x' -Full $true } }
    # chunk records + coverage (H1/M8) using the dry-run state dir beside the scripts
    T 'H1: chunk coverage: chunks over every top-level child -> no missing; one child left out -> reported' {
        $tops = @(Get-ChildItem -LiteralPath $fx.Model -Force | % FullName)
        $recs = @([pscustomobject]@{ roots = $tops })
        $m1 = @(Test-ElvChunkCoverage $recs @($fx.Model))
        $recs2 = @([pscustomobject]@{ roots = @($tops | Select-Object -Skip 1) })
        $m2 = @(Test-ElvChunkCoverage $recs2 @($fx.Model))
        ($m1.Count -eq 0) -and ($m2.Count -eq 1) -and ($m2[0] -ieq $tops[0].TrimEnd('\')) }
    T 'H1: chunk record round-trip (Write/Get, elevated flag recorded as false here)' {
        $p = Write-ElvChunkRecord $true 'verify' @($fx.Model) @{ items = 3; exposed = 0; unreadable = 0; unlistable = 0 } 'x.csv' 'ref1'
        $r = @(Get-ElvChunkRecords $true 'verify' $testStart | ? { $_.csv -eq 'x.csv' })
        Remove-Item $p -Force; ($r.Count -eq 1) -and ($r[0].elevated -eq $false) -and ($r[0].appliedRef -eq 'ref1') -and ($r[0].roots[0] -ieq $fx.Model.TrimEnd('\')) }
    # L7 layout checks on a synthetic staging layout (fake worker/broker SIDs, runner as owner)
    T 'L7: Test-ElvLayout passes on a layout applied exactly as 03 would (synthetic root, fake identity SIDs)' {
        $W = 'S-1-5-32-556'; $B = 'S-1-5-32-558'; $Gs = 'S-1-5-32-559'   # resolvable BUILTIN SIDs absent from the runner token and BroadSids
        $sroot = Join-Path $fx.Root 'staging'; New-Item -ItemType Directory -Force $sroot | Out-Null
        $saved = $script:ElvStagingRoot; $script:ElvStagingRoot = $sroot
        try {
            $who = @{ W = $W; B = $B; O = $me }
            foreach ($d in $script:ElvLayout) {
                $path = $sroot; if ($d.Rel) { $path = Join-Path $sroot $d.Rel }
                New-Item -ItemType Directory -Force $path | Out-Null
                if ($d.Rel) { Invoke-FxIcacls @($path, '/inheritance:r') }
                Invoke-FxIcacls @($path, '/grant:r', "*$($script:SidSystem):(OI)(CI)F", "*$($script:SidAdmins):(OI)(CI)F")
                foreach ($k in 'O', 'B', 'W') { $spec = $d[$k]; if ($spec) { Invoke-FxIcacls (@($path) + (ConvertTo-ElvGrant $who[$k] $spec)) } }
                if ($d.OwnerRights) { Invoke-FxIcacls @($path, '/grant', "*$($script:SidOwnerRights):(OI)(IO)(RC)") }
            }
            Invoke-FxIcacls @($sroot, '/inheritance:r', '/grant:r', "*$($script:SidSystem):(OI)(CI)F", "*$($script:SidAdmins):(OI)(CI)F", "*${me}:F")   # root: owner F (this folder) so the runner keeps control
            $lr = New-ElvReport 'layout-test' $true
            Test-ElvLayout $lr $W $B $Gs *> $null
            $f = @($lr.checks | ? { $_.status -eq 'FAIL' })
            if ($f.Count) { return "FAILS: $(($f | % { $_.name + ' ' + $_.detail }) -join '; ')" }
            # negative: an inherit-only Everyone ACE on work\ must be caught by L0b even though L0 (object mask) stays 0
            Invoke-FxIcacls @((Join-Path $sroot 'work'), '/grant', '*S-1-1-0:(OI)(CI)(IO)RX')
            $lr2 = New-ElvReport 'layout-test2' $true; Test-ElvLayout $lr2 $W $B $Gs *> $null
            $neg = @($lr2.checks | ? { $_.status -eq 'FAIL' -and $_.id -eq 'L0b' -and $_.name -like '*\work' })
            if ($neg.Count -ne 1) { return 'L0b did not catch the inherit-only broad ACE' }
            $true
        } finally { $script:ElvStagingRoot = $saved; foreach ($d in Get-ChildItem -LiteralPath $sroot -Recurse -Directory -Force) { & icacls.exe $d.FullName /grant "*${me}:(OI)(CI)F" *> $null } }
    }
  }
} finally {
    if ($fx) { $fxProblems = @(Remove-ElvAclFixture $fx) }
    Remove-Item (Join-Path $env:TEMP "elv-r3-*-$PID.csv") -Force -ErrorAction SilentlyContinue
}
T 'fixture removed cleanly (no residue in the owner profile)' { if ($fxProblems.Count) { $fxProblems -join '; ' } else { $true } }

Write-Host "`n### H. H2 trusted location and manifest"
T 'H2: Test-ElvAdminOnlyWritable reports the OWNER SID as a writer on an owner-writable dir' { @(Test-ElvAdminOnlyWritable $root $true | ? { $_ -match $me -or $_ -match 'S-1-5-11' }).Count -ge 1 }
T 'H2: canonical manifest is ordinal-sorted, LF, trailing LF' { (Get-ElvCanonicalManifest @{ 'b.ps1' = 'bb'; 'A.ps1' = 'aa'; '_c.ps1' = 'cc' }) -eq "aa  A.ps1`ncc  _c.ps1`nbb  b.ps1`n" }
$tdir = Join-Path $env:TEMP "elv-r3-trusted-$PID"
try {
    New-Item -ItemType Directory -Force $tdir | Out-Null
    Get-ChildItem -LiteralPath $root -Filter *.ps1 -File | Copy-Item -Destination $tdir
    [IO.File]::WriteAllText((Join-Path $tdir 'SHA256SUMS'), (Get-ElvCanonicalManifest (Get-ElvScriptHashes $tdir)), (New-Object System.Text.ASCIIEncoding))
    $mh = Get-ElvManifestHash (Join-Path $tdir 'SHA256SUMS')
    T 'H2: manifest hash is 64 hex and deterministic' { ($mh -match '^[0-9a-f]{64}$') -and ($mh -eq (Get-ElvManifestHash (Join-Path $tdir 'SHA256SUMS'))) }
    T 'H2: dry-run from an owner-writable copy -> R7 WARN (never PASS)' { $r = New-ElvReport 't' $true; Assert-ElvTrustedScriptLocation $r $true '' $tdir; $r.checks[0].status -eq 'WARN' }
    T 'H2: APPLY from an owner-writable copy refused even with the right manifest hash' { ThrowsLike { Assert-ElvTrustedScriptLocation (New-ElvReport 't' $false) $false $mh $tdir } 'Apply refused' }
    T 'H2: APPLY without -ApprovedManifestHash is a recorded problem' { $r = New-ElvReport 't' $false; $null = Throws { Assert-ElvTrustedScriptLocation $r $false '' $tdir }; $r.refusals[0].reason -match 'ApprovedManifestHash' }
    T 'H2: APPLY with a WRONG manifest hash is a recorded problem' { $r = New-ElvReport 't' $false; $null = Throws { Assert-ElvTrustedScriptLocation $r $false ('0' * 64) $tdir }; $r.refusals[0].reason -match 'does not match the out-of-band' }
    T 'H2: a tampered script is a recorded hash mismatch' { Add-Content (Join-Path $tdir '09-rollback.ps1') '# tamper'; $r = New-ElvReport 't' $false; $null = Throws { Assert-ElvTrustedScriptLocation $r $false $mh $tdir }; $r.refusals[0].reason -match 'hash mismatch 09-rollback.ps1' }
    T 'H2: non-canonical SHA256SUMS (CRLF) is a recorded problem' { [IO.File]::WriteAllText((Join-Path $tdir 'SHA256SUMS'), ((Get-ElvCanonicalManifest (Get-ElvScriptHashes $tdir)) -replace "`n", "`r`n")); $r = New-ElvReport 't' $false; $null = Throws { Assert-ElvTrustedScriptLocation $r $false $mh $tdir }; $r.refusals[0].reason -match 'canonical' }
} finally { Remove-Item $tdir -Recurse -Force -ErrorAction SilentlyContinue }
T 'H2: Freeze refuses to run non-elevated (and -ApprovedSums is mandatory)' { (Throws { & (Join-Path $root 'Freeze-AdminScripts.ps1') -ApprovedSums (Join-Path $root '_common.ps1') *>&1 | Out-Null }) -and ((Get-Command (Join-Path $root 'Freeze-AdminScripts.ps1')).Parameters['ApprovedSums'].Attributes | ? { $_ -is [System.Management.Automation.ParameterAttribute] -and $_.Mandatory }) }
T 'H2: every script exposes -ApprovedManifestHash (00,00a,01..06,09)' { @('00-isolation-group-deny','00a-remove-test-residue','01-staging-volume','02-identities-and-rights','03-staging-layout','04-broker-install','05-firewall-egress','06-worker-enable','09-rollback') | ? { -not (Get-Command (Join-Path $root "$_.ps1")).Parameters.ContainsKey('ApprovedManifestHash') } | Measure-Object | % { $_.Count -eq 0 } }

Write-Host "`n### I. H4 firewall predicate, L4 groups, H5 shadows, I1/I2"
$rule = [pscustomobject]@{ Enabled = 'True'; Action = 'Block'; Direction = 'Outbound' }
T 'H4: rule bound to a STALE SID is rejected' { -not (Test-ElvWorkerFirewallRule $rule 'D:(A;;CC;;;S-1-5-21-1-2-3-1001)' @('1.1.1.1') 'S-1-5-21-1-2-3-1002') }
T 'H4: rule bound to the current SID accepted' { Test-ElvWorkerFirewallRule $rule 'D:(A;;CC;;;S-1-5-21-1-2-3-1001)' @('1.1.1.1') 'S-1-5-21-1-2-3-1001' }
T 'L9: substring SID (…-100 vs …-1001) rejected' { -not (Test-ElvWorkerFirewallRule $rule 'D:(A;;CC;;;S-1-5-21-1-2-3-1001)' @('1.1.1.1') 'S-1-5-21-1-2-3-100') }
T 'H4: disabled / allow / inbound rules rejected' { -not (Test-ElvWorkerFirewallRule ([pscustomobject]@{ Enabled = 'False'; Action = 'Block'; Direction = 'Outbound' }) 'D:(A;;CC;;;S-1-9)' @() 'S-1-9') -and -not (Test-ElvWorkerFirewallRule ([pscustomobject]@{ Enabled = 'True'; Action = 'Allow'; Direction = 'Outbound' }) 'D:(A;;CC;;;S-1-9)' @() 'S-1-9') -and -not (Test-ElvWorkerFirewallRule ([pscustomobject]@{ Enabled = 'True'; Action = 'Block'; Direction = 'Inbound' }) 'D:(A;;CC;;;S-1-9)' @() 'S-1-9') }
T 'L9: address set compared exactly' { (Test-ElvWorkerFirewallRule $rule 'D:(A;;CC;;;S-1-9)' @('1.1.1.1-2.2.2.2','3.3.3.3') 'S-1-9' @('3.3.3.3','1.1.1.1-2.2.2.2')) -and -not (Test-ElvWorkerFirewallRule $rule 'D:(A;;CC;;;S-1-9)' @('1.1.1.1-2.2.2.2') 'S-1-9' @('3.3.3.3','1.1.1.1-2.2.2.2')) }
T 'H4: missing rule rejected (fail closed)' { -not (Test-ElvWorkerFirewallRule $null '' @() 'S-1-9') }
T 'L4: group members via ADSI include the runner (Administrators)' { (Get-ElvGroupMemberSids 'Administrators') -contains $me }
T 'L4: non-existent group THROWS (fail closed) instead of returning nothing' { Throws { Get-ElvGroupMemberSids 'ElvNoSuchGroup9f3a' } }
T 'L4: Get-ElvAccountGroupNames (DIRECT memberships) for the runner includes Administrators' { $g = @(Get-ElvAccountGroupNames $me); ($g -contains 'Administrators') }
T 'H5: shadow enumeration THROWS UNKNOWN when not elevated (fail closed)' { ThrowsLike { Get-ElvShadowCopies } 'UNKNOWN' }
T 'H5: pre-DENY shadow gate THROWS when not elevated (06 gate records FAIL)' { Throws { Test-ElvNoPreDenyShadows @('E:\') (Get-Date) } }
T 'H5: deny-target drives derived (E, F, C, D)' { $d = Get-ElvDenyTargetDrives @('E:\','F:\','C:\Download','D:\src','E:\$RECYCLE.BIN'); ($d -join ',') -eq 'C:,D:,E:,F:' }
T 'I1: owner resolved by the fixed SID, not $env:USERNAME' { $o = Get-ElvOwnerContext; ($o.Sid -eq $script:ExpectedOwnerSid) -and ($o.Profile -like 'C:\Users\*') -and (Throws { Get-ElvOwnerContext 'S-1-5-21-1-2-3-4' }) }
T 'I2/L8: production state found by command line and .git\HEAD (no git.exe, no hard-coded PID)' { $p = Get-ElvProductionState; ($p.SupervisorPids.Count -ge 1) -and ($p.Head -eq 'e60278f') -and -not ((Get-Content (Join-Path $root '_common.ps1') -Raw) -match 'ProductionPid\s*=\s*\d') }
T 'Get-ElvGitHead reads a symbolic ref correctly on the production checkout' { (Get-ElvGitHead 'E:\Agent\Personal-agent') -eq 'e60278f' }

Write-Host "`n### J. ACL evaluation against REAL objects (read-only)"
T 'E:\ grants broad groups write today (the finding)' { (Get-ElvBroadWriteMask 'E:\Agent\Personal-agent\.env') -ne 0 }
T 'owner profile denies broad groups' { (Get-ElvEffectiveMask (Join-Path $env:USERPROFILE '.claude') $script:BroadSids) -eq 0 }
T 'no group DENY exists yet on E:\ (nothing applied)' { -not (Get-LocalGroup -Name $script:ElvGroup -ErrorAction SilentlyContinue) }
T 'E:\$RECYCLE.BIN (M11) grants Users add-subdirectory today' { if (Test-Path 'E:\$RECYCLE.BIN') { ((Get-ElvEffectiveMask 'E:\$RECYCLE.BIN' @('S-1-5-32-545')) -band 0x4) -ne 0 } else { 'INFO: absent' -eq 'x' } }

Write-Host "`n### K. 00 mode guards and 06 gate (dry-run, fail closed)"
$s00 = Join-Path $root '00-isolation-group-deny.ps1'
T '-SweepRoots outside DENY targets refused' { Throws { & $s00 -Sweep -SweepRoots 'C:\Windows' *>$null } }
T '-SweepRoots without -Sweep refused'       { Throws { & $s00 -SweepRoots 'E:\Agent' *>$null } }
T '-SweepRoots with -Apply refused'          { Throws { & $s00 -Apply -Sweep -SweepRoots 'E:\Agent' *>$null } }
T '-VerifyRoots without -Verify refused'     { Throws { & $s00 -VerifyRoots 'E:\Agent' *>$null } }
T '-Sweep and -Verify together refused'      { Throws { & $s00 -Sweep -Verify *>$null } }
T '-Finalize without -Sweep/-Verify refused' { Throws { & $s00 -Finalize *>$null } }
T '-ListShadows non-elevated FAILS CLOSED (throws UNKNOWN; report saved with error)' { ThrowsLike { & $s00 -ListShadows *>$null } 'UNKNOWN' }
T '-Sweep -SweepRoots <tests dir> runs read-only and writes a chunk record' {
    $o = & $s00 -Sweep -SweepRoots $PSScriptRoot *>&1 | Out-String
    $rec = @(Get-ElvChunkRecords $true 'sweep' $testStart | ? { $_.roots -contains $PSScriptRoot.TrimEnd('\') })
    ($o -match 'SWEEP-SUMMARY') -and ($rec.Count -ge 1) -and ($rec[0].elevated -eq $false) }
T '-Sweep -Finalize on a partial chunk set reports coverage FAIL and complete=false (no exception)' {
    $o = & $s00 -Sweep -Finalize *>&1 | Out-String
    $sc = Read-ElvState $true 'sweep-complete'
    ($o -match '\[FAIL\] SF1') -and ($sc.complete -eq $false) }
T '06 gate dry-run: G5 (verify-complete) and G8 (shadows) FAIL closed with explicit reasons' {
    $o = & (Join-Path $root '06-worker-enable.ps1') -Mode enable-for-login *>&1 | Out-String
    ($o -match '\[FAIL\] G5 .*no deny-targets.json|\[FAIL\] G5 .*no verify-complete') -and ($o -match '\[FAIL\] G8 .*UNKNOWN|\[FAIL\] G8 .*no deny-targets') -and ($o -match '\[FAIL\] GATE') }

Write-Host "`n### L. every script parses and dry-runs cleanly without changing the system"
$before = [ordered]@{
    users = (Get-LocalUser | ForEach-Object Name) -join ','; groups = (Get-LocalGroup | ForEach-Object Name) -join ','
    tasks = (Get-ScheduledTask | Where-Object TaskName -like 'Elevariq*' | ForEach-Object TaskName) -join ','
    fw = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object DisplayName -like 'ELEVARIQ*').Count
    eRoot = (Get-Acl 'E:\').Sddl; fRoot = (Get-Acl 'F:\').Sddl; staging = (Test-Path 'C:\ElevariqStaging'); disk = (Test-Path 'C:\ElevariqStagingDisk')
    prodEnv = (Get-Acl 'E:\Agent\Personal-agent\.env').Sddl
}
foreach ($f in Get-ChildItem -LiteralPath $root -Filter *.ps1 -File) {
    $errs = $null; [void][Management.Automation.PSParser]::Tokenize((Get-Content -Raw -LiteralPath $f.FullName), [ref]$errs)
    T "parse $($f.Name)" { $errs.Count -eq 0 }
}
$runs = @(
    @('00-isolation-group-deny.ps1', @{}), @('00a-remove-test-residue.ps1', @{}), @('01-staging-volume.ps1', @{}),
    @('02-identities-and-rights.ps1', @{}), @('02-identities-and-rights.ps1', @{ VolumeQuotaMB = 2048 }), @('03-staging-layout.ps1', @{}), @('04-broker-install.ps1', @{}),
    @('05-firewall-egress.ps1', @{ AllowIPv4Cidrs = @('160.79.104.0/23') }), @('05-firewall-egress.ps1', @{ HostRules = $true }),
    @('06-worker-enable.ps1', @{ Mode = 'enable-for-login' }), @('06-worker-enable.ps1', @{ Mode = 'lockdown' }), @('06-worker-enable.ps1', @{ Mode = 'register-task' }),
    @('07-verify-config.ps1', @{ Stage = '00' }), @('07-verify-config.ps1', @{ Stage = '06' }), @('09-rollback.ps1', @{}), @('09-rollback.ps1', @{ IncludeProductionDeny = $true })
)
$logDir = Join-Path $PSScriptRoot 'dryrun-logs'; New-Item -ItemType Directory -Force $logDir | Out-Null
foreach ($r in $runs) {
    $scriptFile = $r[0]; $args2 = $r[1]
    $suffix = ($args2.GetEnumerator() | ForEach-Object { "-$($_.Key)=$($_.Value -join '+')" }) -join ''
    $log = Join-Path $logDir ('{0}{1}.log' -f $scriptFile, ($suffix -replace '[^\w\-=+.]', '_'))
    T "dry-run $scriptFile $suffix" {
        $repBefore = @(Get-ChildItem (Join-Path $root 'reports') -Filter '*.json' | % Name)
        $out = & (Join-Path $root $scriptFile) @args2 *>&1 | Out-String
        $out | Set-Content -Encoding utf8 $log
        $new = @(Get-ChildItem (Join-Path $root 'reports') -Filter '*.json' | ? { $repBefore -notcontains $_.Name } | Sort-Object LastWriteTime)
        if ($new.Count -lt 1) { return 'no report written' }
        $j = Get-Content $new[-1].FullName -Raw | ConvertFrom-Json
        if (-not $j.dryRun) { return 'report says dryRun=false' }
        if (@($j.changes | ? { $_.applied -eq $true }).Count) { return 'an APPLIED change was recorded in a dry-run' }
        if ($j.error) { return "script error: $($j.error)" }
        ($out -cnotmatch 'APPLIED ') -and ($out -cmatch 'DRY-RUN|PASS|FAIL|SKIP') }
}
$after = [ordered]@{
    users = (Get-LocalUser | ForEach-Object Name) -join ','; groups = (Get-LocalGroup | ForEach-Object Name) -join ','
    tasks = (Get-ScheduledTask | Where-Object TaskName -like 'Elevariq*' | ForEach-Object TaskName) -join ','
    fw = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object DisplayName -like 'ELEVARIQ*').Count
    eRoot = (Get-Acl 'E:\').Sddl; fRoot = (Get-Acl 'F:\').Sddl; staging = (Test-Path 'C:\ElevariqStaging'); disk = (Test-Path 'C:\ElevariqStagingDisk')
    prodEnv = (Get-Acl 'E:\Agent\Personal-agent\.env').Sddl
}
foreach ($k in $before.Keys) { $kk = $k; T "system unchanged after dry-runs: $k" { "$($before[$kk])" -eq "$($after[$kk])" } }
$p = Get-ElvProductionState
T 'production untouched (task Running, supervisor alive, HEAD e60278f)' { $p.TaskState -eq 'Running' -and $p.SupervisorPids.Count -ge 1 -and $p.Head -eq 'e60278f' }
# cleanup of test chunk/state records written beside the scripts
Get-ChildItem (Join-Path $root 'state') -Filter "*-$PID.*" -ErrorAction SilentlyContinue | Remove-Item -Force
Remove-Item (Join-Path $root 'state\sweep-complete.json') -Force -ErrorAction SilentlyContinue
Write-Host "`nTEST-R3 pass=$pass fail=$fail"
$results | ConvertTo-Json -Depth 3 | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot 'test-r3-results.json')
