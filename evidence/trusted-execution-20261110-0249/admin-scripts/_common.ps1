# Shared helpers for the ELEVARIQ V2.1 worker-isolation admin scripts.
# These scripts are DESIGN ARTIFACTS. They default to -DryRun and MUST NOT be run by the agent.
# The owner runs them from an elevated PowerShell after review. Every script:
#   - supports -DryRun (default $true): prints each proposed change, makes none.
#   - supports -Apply: performs the change (requires elevation).
#   - DEFAULTS to -StagingOnly $true: operates ONLY on newly created objects under $ElvStagingRoot.
#   - writes a change report to .\reports\<script>-<timestamp>.json
#
# PILOT SAFETY CONTRACT (owner correction, 2026-11-10):
#   The staging pilot makes ZERO changes to production or owner resources. In StagingOnly mode (the default) every
#   path a privileged command touches MUST be under $ElvStagingRoot; Assert-StagingPath throws otherwise, BEFORE any
#   action. No production checkout, task, DB, env, owner credential store, existing directory ACL, or global firewall
#   default is read-for-modify or written. Production protection (E:\ grant / checkout DENY) is a SEPARATE, later,
#   explicitly-authorized "production isolation" stage, never part of the pilot.

# --- Dedicated staging resources (all newly created, all under one root) ---
$script:ElvStagingRoot    = 'C:\ElevariqStaging'            # the ONLY tree the pilot may touch
$script:ElvWorkerAccount  = 'elv-stg-worker'               # staging-only worker (distinct from any future prod worker)
$script:ElvWorkRoot       = "$script:ElvStagingRoot\work"   # worker tree
$script:ElvBrokerRoot     = "$script:ElvStagingRoot\broker" # broker state: approvals, audit, signing key
$script:ElvStagingHome    = "$script:ElvStagingRoot\home"   # synthetic agent home + synthetic DB
$script:ElvDecoyRoot      = "$script:ElvStagingRoot\decoys" # SYNTHETIC production/credential look-alikes to test isolation
$script:ElvFirewallPrefix = 'ELEVARIQ-STG-Worker'           # staging firewall rule name prefix
$script:ElvWorkerTask     = 'ElevariqStagingWorker'         # staging scheduled task (NOT the production task)

# --- Production objects the pilot must never modify (used only by guards) ---
$script:ProductionCheckout = 'E:\Agent\Personal-agent'
$script:ProductionTask     = 'ElevariqPersonalAgent'
$script:ProductionPid      = 8992
$script:ProductionHome     = (Join-Path $env:LOCALAPPDATA 'ElevariqAgent')

function New-ElvReport {
    param([string]$ScriptName)
    $dir = Join-Path $PSScriptRoot 'reports'
    New-Item -ItemType Directory -Force $dir | Out-Null
    [pscustomobject]@{
        script      = $ScriptName
        startedAt   = (Get-Date).ToString('o')
        dryRun      = $null
        stagingOnly = $null
        changes     = New-Object System.Collections.ArrayList
        refusals    = New-Object System.Collections.ArrayList
        path        = (Join-Path $dir ("{0}-{1}.json" -f $ScriptName, (Get-Date -Format 'yyyyMMdd-HHmmss')))
    }
}

function Add-ElvChange {
    param($Report, [string]$Action, [string]$Target, [string]$Detail, [bool]$Applied)
    [void]$Report.changes.Add([pscustomobject]@{ action = $Action; target = $Target; detail = $Detail; applied = $Applied; at = (Get-Date).ToString('o') })
    $tag = if ($Applied) { 'APPLIED ' } else { 'DRY-RUN ' }
    Write-Host ("  {0}{1}: {2} -- {3}" -f $tag, $Action, $Target, $Detail)
}

function Add-ElvRefusal {
    param($Report, [string]$Reason, [string]$Target)
    [void]$Report.refusals.Add([pscustomobject]@{ reason = $Reason; target = $Target })
    Write-Warning ("  REFUSED: {0} ({1})" -f $Reason, $Target)
}

# Canonicalize a path to its full form WITHOUT requiring it to exist, so guards compare canonical strings.
function Get-ElvCanonicalPath {
    param([string]$Path)
    try { return [System.IO.Path]::GetFullPath($Path) } catch { return $Path }
}

# HARD GUARD: in StagingOnly mode every privileged target must be under $ElvStagingRoot. Rejects production/owner
# paths and anything ambiguous. Throws (fail-closed) so no privileged action runs on a non-staging path.
function Assert-StagingPath {
    param($Report, [string]$Path, [bool]$StagingOnly)
    $full = Get-ElvCanonicalPath $Path
    $root = Get-ElvCanonicalPath $script:ElvStagingRoot
    # Always refuse known production objects, regardless of mode.
    $prodFull = Get-ElvCanonicalPath $script:ProductionCheckout
    $homeFull = Get-ElvCanonicalPath $script:ProductionHome
    if ($full -eq $prodFull -or $full.StartsWith("$prodFull\", [StringComparison]::OrdinalIgnoreCase) -or
        $full -eq $homeFull -or $full.StartsWith("$homeFull\", [StringComparison]::OrdinalIgnoreCase)) {
        Add-ElvRefusal $Report "refuses a production path" $full; throw "Refusing production path: $full"
    }
    if ($StagingOnly) {
        if (-not ($full -eq $root -or $full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase))) {
            Add-ElvRefusal $Report "StagingOnly: target is outside $root" $full
            throw "StagingOnly guard: $full is not under $root"
        }
    }
    return $full
}

# Resolve a local account to EXACTLY one SID; reject ambiguous, domain, or unexpected identities (owner requirement).
function Resolve-ElvLocalSid {
    param([string]$Account, [bool]$MustExist = $false)
    $matches = @(Get-LocalUser -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $Account })
    if ($matches.Count -gt 1) { throw "Ambiguous account '$Account' ($($matches.Count) matches)." }
    if ($matches.Count -eq 0) {
        if ($MustExist) { throw "Account '$Account' does not exist." }
        return $null
    }
    $sid = $matches[0].SID.Value
    if ($sid -notmatch '^S-1-5-21-') { throw "Account '$Account' SID $sid is not a local account SID." }
    return $sid
}

# The identity the BROKER runs as (the owner). Grant its USER SID explicitly: BUILTIN\Administrators is deny-only in a
# filtered token, so an Allow ACE for it grants a non-elevated broker nothing (preflight D3).
function Get-ElvOwnerContext {
    param([string]$OwnerAccount = $env:USERNAME)
    $u = try { Get-LocalUser -Name $OwnerAccount -ErrorAction Stop } catch { $null }
    $sid = if ($u) { $u.SID.Value } else { ([Security.Principal.NTAccount]$OwnerAccount).Translate([Security.Principal.SecurityIdentifier]).Value }
    $profile = $null
    try { $profile = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid" -ErrorAction Stop).ProfileImagePath } catch {}
    if (-not $profile) { $profile = $env:USERPROFILE }
    [pscustomobject]@{ Account = $OwnerAccount; Sid = $sid; Profile = $profile }
}

# Run icacls, CHECK the native exit code (icacls does not throw), return success/failure (preflight D1).
function Invoke-ElvIcacls {
    param([string[]]$IcaclsArgs, [bool]$DryRun, $Report, [string]$Path, [string]$Detail)
    if ($DryRun) { Add-ElvChange $Report 'icacls' $Path "$Detail [args: $($IcaclsArgs -join ' ')]" $false; return $true }
    $out = & icacls @IcaclsArgs 2>&1
    if ($LASTEXITCODE -ne 0) { Add-ElvRefusal $Report "icacls failed (exit $LASTEXITCODE): $($out -join ' ')" $Path; return $false }
    Add-ElvChange $Report 'icacls' $Path $Detail $true; return $true
}

# Idempotency: remove a principal's prior grant/deny ACEs before (re)adding, so re-runs do not stack ACEs (D2).
function Clear-ElvPrincipalAces {
    param([string]$Path, [string]$Principal, [bool]$DryRun, $Report)
    if ($DryRun) { Add-ElvChange $Report 'icacls-clear' $Path "remove existing ACEs for $Principal (idempotency)" $false; return }
    & icacls $Path /remove:g $Principal 2>&1 | Out-Null
    & icacls $Path /remove:d $Principal 2>&1 | Out-Null
}

function Save-ElvReport {
    param($Report)
    $Report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $Report.path
    Write-Host ("`nReport written: {0}" -f $Report.path)
    Write-Host ("Changes: {0}  Refusals: {1}  Mode: {2} / {3}" -f $Report.changes.Count, $Report.refusals.Count,
        ($(if ($Report.dryRun) { 'DRY-RUN' } else { 'APPLY' })), ($(if ($Report.stagingOnly) { 'STAGING-ONLY' } else { 'PRODUCTION-SCOPE' })))
}

function Test-ElvElevation {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}
