# Offline tests for admin-scripts r2. Non-elevated; makes NO system changes (dry-run only + pure functions).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root '_common.ps1')
$pass = 0; $fail = 0
function T([string]$Name, [scriptblock]$Body) {
    try { $r = & $Body; if ($r -eq $true) { $script:pass++; Write-Host "PASS $Name" } else { $script:fail++; Write-Host "FAIL $Name -> $r" } }
    catch { $script:fail++; Write-Host "FAIL $Name -> EXC $($_.Exception.Message)" }
}
function Throws([scriptblock]$b) { try { & $b; return $false } catch { return $true } }
$rep = New-ElvReport 'test-r2' $true

# --- R-4: the r1 interpolation bug and its r2 fix
T 'r1 regex bug reproduced ("$script:X:\(N\)" -> "\(N\)")' { $script:Xa = 'elv'; ("$script:Xa:\(N\)" -eq '\(N\)') }
T 'r2 form keeps the name ("${script:X}:")' { $script:Xa = 'elv'; ("${script:Xa}:\(N\)" -eq 'elv:\(N\)') }

# --- path guards
T 'staging root accepted'               { (Assert-StagingPath $rep 'C:\ElevariqStaging\work\x') -like 'C:\ElevariqStaging\*' }
T 'staging prefix trap rejected'        { Throws { Assert-StagingPath $rep 'C:\ElevariqStagingEvil\x' } }
T 'disk dir accepted'                   { [bool](Assert-StagingPath $rep 'C:\ElevariqStagingDisk\elv-staging.vhdx') }
T 'production checkout rejected'        { Throws { Assert-StagingPath $rep 'E:\Agent\Personal-agent\dist' } }
T 'owner .claude rejected'              { Throws { Assert-StagingPath $rep (Join-Path $env:USERPROFILE '.claude') } }
T 'prod home rejected'                  { Throws { Assert-StagingPath $rep (Join-Path $env:LOCALAPPDATA 'ElevariqAgent\agent.db') } }
T 'dot-dot escape rejected'             { Throws { Assert-StagingPath $rep 'C:\ElevariqStaging\..\Windows' } }
T 'deny target E:\ accepted'            { (Assert-DenyTarget $rep 'E:\') -eq 'E:\' }
T 'deny target C:\Download accepted'    { [bool](Assert-DenyTarget $rep 'C:\Download') }
T 'deny target C:\Windows rejected'     { Throws { Assert-DenyTarget $rep 'C:\Windows' } }
T 'deny target inside prod rejected even if listed' { Throws { Assert-DenyTarget $rep 'E:\Agent\Personal-agent\dist' @('E:\Agent\Personal-agent\dist') } }
T 'deny target listed extra accepted'   { [bool](Assert-DenyTarget $rep 'E:\Agent\v2-staging' @('E:\Agent\v2-staging')) }

# --- IPv4 complement
T 'complement of loopback only' { ((Get-ElvIPv4Complement @('127.0.0.0/8')) -join ',') -eq '0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255' }
T 'complement with allow CIDR'  { ((Get-ElvIPv4Complement @('127.0.0.0/8', '160.79.104.0/23')) -join ',') -eq '0.0.0.0-126.255.255.255,128.0.0.0-160.79.103.255,160.79.106.0-255.255.255.255' }
T 'overlapping CIDRs merged'    { ((Get-ElvIPv4Complement @('10.0.0.0/8', '10.1.0.0/16')) -join ',') -eq '0.0.0.0-9.255.255.255,11.0.0.0-255.255.255.255' }
T 'unaligned CIDR normalised'   { ((Get-ElvIPv4Complement @('10.0.0.5/24')) -join ',') -eq '0.0.0.0-9.255.255.255,10.0.1.0-255.255.255.255' }
T 'bad CIDR throws'             { Throws { Get-ElvIPv4Range '999.1.1.1/8' } }
T 'host name rejected (r1 defect)' { Throws { Get-ElvIPv4Range 'api.anthropic.com' } }

# --- user-rights INF
$inf = @('[Unicode]', 'Unicode=yes', '[Privilege Rights]', 'SeBatchLogonRight = *S-1-5-32-544,*S-1-5-32-551', 'SeDenyNetworkLogonRight = Guest', '[Version]', 'signature="$CHICAGO$"')
$cur = ConvertFrom-ElvRightsInf $inf
T 'INF parse' { ($cur['SeBatchLogonRight'].Count -eq 2) -and ($cur['SeDenyNetworkLogonRight'][0] -eq 'Guest') -and -not $cur.ContainsKey('signature') }
$new = New-ElvRightsInf -Current $cur -Add @{ SeBatchLogonRight = @('*S-1-5-21-1-2-3-1002'); SeDenyInteractiveLogonRight = @('*S-1-5-21-1-2-3-1003') }
T 'INF add keeps existing, adds new right' { ($new -match 'SeBatchLogonRight = \*S-1-5-32-544,\*S-1-5-32-551,\*S-1-5-21-1-2-3-1002') -and ($new -match 'SeDenyInteractiveLogonRight = \*S-1-5-21-1-2-3-1003') -and ($new -notmatch 'SeDenyNetworkLogonRight') }
$rem = New-ElvRightsInf -Current (ConvertFrom-ElvRightsInf ($new -split "`r`n")) -Remove @{ SeBatchLogonRight = @('*S-1-5-21-1-2-3-1002') }
T 'INF remove' { $rem -match 'SeBatchLogonRight = \*S-1-5-32-544,\*S-1-5-32-551\s*$' }
T 'INF add idempotent' { $twice = New-ElvRightsInf -Current (ConvertFrom-ElvRightsInf ($new -split "`r`n")) -Add @{ SeBatchLogonRight = @('*S-1-5-21-1-2-3-1002') }; ([regex]::Matches($twice, '1002')).Count -eq 1 }
T 'right held by SID or name' { (Test-ElvRightHeld @{ R = @('*S-1-2'); Q = @('bob') } 'R' 'S-1-2' 'x') -and (Test-ElvRightHeld @{ Q = @('bob') } 'Q' 'S-9' 'bob') -and -not (Test-ElvRightHeld @{ R = @('*S-1-3') } 'R' 'S-1-2' 'x') }

# --- spec semantics
T 'spec M'    { (Test-ElvSpec 0x1301BF 'M') -and -not (Test-ElvSpec 0x1200A9 'M') }
T 'spec RX'   { (Test-ElvSpec 0x1200A9 'RX') -and -not (Test-ElvSpec 0x1301BF 'RX') }
T 'spec W'    { (Test-ElvSpec 0x100116 'W') -and -not (Test-ElvSpec 0x1301BF 'W') }
T 'spec DENY/none' { (Test-ElvSpec 0 'DENY') -and (Test-ElvSpec 0 '') -and -not (Test-ElvSpec 1 'DENY') }

# --- ACL evaluation against REAL objects (read-only)
T 'E:\ grants broad groups write today (the finding)' { (Get-ElvBroadWriteMask 'E:\Agent\Personal-agent\.env') -ne 0 }
T 'owner profile denies broad groups' { (Get-ElvEffectiveMask (Join-Path $env:USERPROFILE '.claude') $script:BroadSids) -eq 0 }
T 'no group DENY exists yet on E:\ (nothing applied)' { -not (Get-LocalGroup -Name $script:ElvGroup -ErrorAction SilentlyContinue) }

# --- R-7: trusted location refuses -Apply from E:\ (dry-run: WARN only)
T 'trusted-location check WARNs from E:\ in dry-run' { $r = New-ElvReport 't' $true; Assert-ElvTrustedScriptLocation $r $true; ($r.checks[0].status -eq 'WARN') }
T 'trusted-location check THROWS from E:\ for apply' { Throws { Assert-ElvTrustedScriptLocation (New-ElvReport 't' $false) $false } }

# --- chunked sweep guards (00 -SweepRoots)
$s00 = Join-Path $root '00-isolation-group-deny.ps1'
T '-SweepRoots outside DENY targets refused' { Throws { & $s00 -Sweep -SweepRoots 'C:\Windows' *>$null } }
T '-SweepRoots without -Sweep refused'       { Throws { & $s00 -SweepRoots 'E:\Agent' *>$null } }
T '-SweepRoots with -Apply refused'          { Throws { & $s00 -Apply -Sweep -SweepRoots 'E:\Agent' *>$null } }

# --- every script parses and dry-runs cleanly without changing the system
$before = [ordered]@{
    users = (Get-LocalUser | ForEach-Object Name) -join ','; groups = (Get-LocalGroup | ForEach-Object Name) -join ','
    tasks = (Get-ScheduledTask | Where-Object TaskName -like 'Elevariq*' | ForEach-Object TaskName) -join ','
    fw = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object DisplayName -like 'ELEVARIQ*').Count
    eRoot = (Get-Acl 'E:\').Sddl; staging = (Test-Path 'C:\ElevariqStaging'); disk = (Test-Path 'C:\ElevariqStagingDisk')
}
foreach ($f in Get-ChildItem -LiteralPath $root -Filter *.ps1 -File) {
    $errs = $null; [void][Management.Automation.PSParser]::Tokenize((Get-Content -Raw -LiteralPath $f.FullName), [ref]$errs)
    T "parse $($f.Name)" { $errs.Count -eq 0 }
}
$runs = @(
    @('00-isolation-group-deny.ps1', @{}), @('00a-remove-test-residue.ps1', @{}), @('01-staging-volume.ps1', @{}),
    @('02-identities-and-rights.ps1', @{}), @('03-staging-layout.ps1', @{}), @('04-broker-install.ps1', @{}),
    @('05-firewall-egress.ps1', @{ AllowIPv4Cidrs = @('160.79.104.0/23') }), @('06-worker-enable.ps1', @{ Mode = 'enable-for-login' }),
    @('06-worker-enable.ps1', @{ Mode = 'lockdown' }), @('06-worker-enable.ps1', @{ Mode = 'register-task' }),
    @('07-verify-config.ps1', @{ Stage = '00' }), @('09-rollback.ps1', @{}), @('09-rollback.ps1', @{ IncludeProductionDeny = $true })
)
$logDir = Join-Path $PSScriptRoot 'dryrun-logs'; New-Item -ItemType Directory -Force $logDir | Out-Null
foreach ($r in $runs) {
    # NB: not '$name' - PowerShell variables are case-insensitive and T() has a $Name parameter.
    $scriptFile = $r[0]; $args2 = $r[1]
    $log = Join-Path $logDir ('{0}{1}.log' -f $scriptFile, $(if ($args2.Mode) { "-$($args2.Mode)" } elseif ($args2.IncludeProductionDeny) { '-proddeny' } else { '' }))
    T "dry-run $scriptFile $(($args2.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')" {
        $out = & (Join-Path $root $scriptFile) @args2 *>&1 | Out-String
        $out | Set-Content -Encoding utf8 $log
        # case-SENSITIVE: the change tag is upper-case 'APPLIED '; check labels such as "00 applied" are not changes
        ($out -cnotmatch 'APPLIED ') -and ($out -cmatch 'DRY-RUN|PASS|FAIL|SKIP')
    }
}
$after = [ordered]@{
    users = (Get-LocalUser | ForEach-Object Name) -join ','; groups = (Get-LocalGroup | ForEach-Object Name) -join ','
    tasks = (Get-ScheduledTask | Where-Object TaskName -like 'Elevariq*' | ForEach-Object TaskName) -join ','
    fw = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object DisplayName -like 'ELEVARIQ*').Count
    eRoot = (Get-Acl 'E:\').Sddl; staging = (Test-Path 'C:\ElevariqStaging'); disk = (Test-Path 'C:\ElevariqStagingDisk')
}
foreach ($k in $before.Keys) { $kk = $k; T "system unchanged after dry-runs: $k" { "$($before[$kk])" -eq "$($after[$kk])" } }
$p = Get-ElvProductionState
T 'production untouched (task Running, PID alive, HEAD e60278f)' { $p.TaskState -eq 'Running' -and $p.PidAlive -and $p.Head -eq 'e60278f' }
Write-Host "`nTEST-R2 pass=$pass fail=$fail"
