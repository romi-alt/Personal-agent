<#
.SYNOPSIS
  A1 (owner, NON-elevated): freeze the reviewed r2 scripts into an owner-only folder with SHA256SUMS.
.DESCRIPTION
  Run this AFTER the independent review. It copies every *.ps1 in this folder to
  <owner profile>\ElevariqAdmin\scripts-r2-<timestamp>\ (inherits the protected profile ACL: SYSTEM, Administrators,
  owner), writes SHA256SUMS there and checks that no broad group can write the copy. Every -Apply refuses to run unless
  it is launched from such a copy whose files still match SHA256SUMS (Assert-ElvTrustedScriptLocation).
.PARAMETER ApprovedSums  Optional: the SHA256SUMS the reviewer approved. If given, the SOURCE files must match it
                         exactly, so a file swapped on E:\ after the review is not frozen.
#>
[CmdletBinding()]
param([string]$ApprovedSums)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$owner = Get-ElvOwnerContext
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $owner.Sid) { throw 'Run as the owner.' }

$src = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1 -File)
$hashes = [ordered]@{}
foreach ($f in $src) { $hashes[$f.Name] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower() }
if ($ApprovedSums) {
    $ok = @{}
    foreach ($l in Get-Content -LiteralPath $ApprovedSums) { if ($l -match '^([0-9a-f]{64})\s+(\S+)$') { $ok[$Matches[2]] = $Matches[1] } }
    $bad = @($hashes.Keys | Where-Object { $ok[$_] -ne $hashes[$_] }) + @($ok.Keys | Where-Object { -not $hashes.Contains($_) })
    if ($bad.Count) { throw "Source does not match the approved SHA256SUMS: $($bad -join ', ')" }
}
$dest = Join-Path $owner.AdminDir ('scripts-{0}-{1}' -f $script:ElvRevision, (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $dest) { throw "Destination exists: $dest" }
New-Item -ItemType Directory -Force $dest | Out-Null
foreach ($f in $src) { Copy-Item -LiteralPath $f.FullName -Destination $dest }
($hashes.Keys | ForEach-Object { '{0}  {1}' -f $hashes[$_], $_ }) | Set-Content -Encoding ascii (Join-Path $dest 'SHA256SUMS')
foreach ($f in Get-ChildItem -LiteralPath $dest -Filter *.ps1 -File) {
    if ((Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower() -ne $hashes[$f.Name]) { throw "Copy mismatch: $($f.Name)" }
}
$broad = @((Get-Item -LiteralPath $dest)) + @(Get-ChildItem -LiteralPath $dest -File) | Where-Object { (Get-ElvBroadWriteMask $_.FullName) -ne 0 }
if ($broad) { throw "Frozen copy is writable by a broad group: $($broad.FullName -join ', ')" }
Write-Host "Frozen $($src.Count) scripts to $dest"
Get-Content (Join-Path $dest 'SHA256SUMS')
Write-Host "`nRun every -Apply from that folder in an elevated shell, e.g.:  & '$dest\00-isolation-group-deny.ps1' -Sweep"
