<#
.SYNOPSIS
  A1 (owner, ELEVATED): freeze the reviewed r3 scripts into an ADMIN-ONLY folder with a canonical SHA256SUMS (H2).
.DESCRIPTION
  Trust anchor = the hashes the reviewer handed back OUT OF BAND (R3_INDEPENDENT_REVIEW_REQUEST.md / the hand-back
  message), never a file on E:\ (every Authenticated User can write E:\) and never a file the non-elevated owner can
  write (the production task runs as the owner, Limited).
    1. -ApprovedSums is MANDATORY: the SOURCE files must match it exactly (a file swapped on E:\ after review is refused).
    2. Elevation is MANDATORY: the destination <owner>\ElevariqAdmin\trusted\scripts-r3-<ts>\ gets
       /inheritance:r  SYSTEM:(OI)(CI)F  Administrators:(OI)(CI)F  <owner>:(OI)(CI)RX  and  /setowner Administrators,
       so a non-elevated owner process (the production agent, any npm dependency it runs) cannot modify it.
    3. SHA256SUMS is written in CANONICAL form (sorted, LF). The script prints the SHA-256 of that file: the owner
       compares it with the manifest hash in the hand-back message and types it as -ApprovedManifestHash on every -Apply.
    4. The copy is re-hashed and its ACL verified with the same predicate every -Apply uses (Test-ElvAdminOnlyWritable).
  BEFORE running anything from the frozen copy, the owner runs in the elevated shell:
      Get-ChildItem <dest>\*.ps1 | Get-FileHash -Algorithm SHA256
  and compares against the out-of-band list by eye. The scripts cannot verify themselves (H2(b)).
.PARAMETER ApprovedSums  Path to the reviewer-approved SHA256SUMS (mandatory). Keep it in an admin-only location.
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ApprovedSums)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
if (-not (Test-ElvElevation)) { throw 'Freeze must run ELEVATED so the frozen copy can be made admin-only (H2).' }
$owner = Get-ElvOwnerContext

$hashes = Get-ElvScriptHashes $PSScriptRoot
$ok = @{}
foreach ($l in Get-Content -LiteralPath $ApprovedSums) { if ($l -match '^([0-9a-f]{64})\s+(\S+)$') { $ok[$Matches[2]] = $Matches[1] } }
if ($ok.Count -eq 0) { throw "No hash lines in $ApprovedSums" }
$bad = @($hashes.Keys | Where-Object { $ok[$_] -ne $hashes[$_] }) + @($ok.Keys | Where-Object { -not $hashes.ContainsKey($_) })
if ($bad.Count) { throw "Source does not match the approved SHA256SUMS: $($bad -join ', ')" }

$trusted = Join-Path $owner.AdminDir 'trusted'
$dest = Join-Path $trusted ('scripts-{0}-{1}' -f $script:ElvRevision, (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $dest) { throw "Destination exists: $dest" }
New-Item -ItemType Directory -Force $dest | Out-Null
foreach ($f in Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1 -File) { Copy-Item -LiteralPath $f.FullName -Destination $dest }
[IO.File]::WriteAllText((Join-Path $dest 'SHA256SUMS'), (Get-ElvCanonicalManifest $hashes), (New-Object System.Text.ASCIIEncoding))

$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try {
    foreach ($args in @(
        @($dest, '/inheritance:r', '/grant:r', "*$($script:SidSystem):(OI)(CI)F", "*$($script:SidAdmins):(OI)(CI)F", "*$($owner.Sid):(OI)(CI)RX"),
        @($dest, '/setowner', "*$($script:SidAdmins)", '/T'))) {
        $o = @(& icacls.exe @args 2>&1 | ForEach-Object { [string]$_ }); if ($LASTEXITCODE -ne 0) { throw "icacls failed: $($o -join ' ')" }
    }
} finally { $ErrorActionPreference = $eap }

$copied = Get-ElvScriptHashes $dest
foreach ($k in $hashes.Keys) { if ($copied[$k] -ne $hashes[$k]) { throw "Copy mismatch: $k" } }
$problems = @(Test-ElvAdminOnlyWritable $dest $true)
foreach ($f in Get-ChildItem -LiteralPath $dest -File) { $problems += Test-ElvAdminOnlyWritable $f.FullName }
if ($problems.Count) { throw "Frozen copy is not admin-only: $($problems -join '; ')" }

$mh = Get-ElvManifestHash (Join-Path $dest 'SHA256SUMS')
Write-Host "Frozen $($hashes.Count) scripts to $dest (admin-only; owner RX)"
Get-Content (Join-Path $dest 'SHA256SUMS')
Write-Host "`nMANIFEST HASH (SHA-256 of SHA256SUMS): $mh"
Write-Host 'Compare it with the out-of-band manifest hash from the review hand-back. If equal, every -Apply is run as:'
Write-Host "  & '$dest\00-isolation-group-deny.ps1' -Sweep                              (read-only)"
Write-Host "  & '$dest\00-isolation-group-deny.ps1' -Apply -ApprovedManifestHash $mh"
