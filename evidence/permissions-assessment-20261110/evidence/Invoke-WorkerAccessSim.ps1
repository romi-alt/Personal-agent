<#
  READ-ONLY. Simulates the effective NTFS access a NEW standard local account (e.g. elv-stg-worker) would receive,
  WITHOUT creating it. Reads each object's DACL (Get-Acl) and evaluates the ordered ACEs against the group SIDs that
  Windows puts into a standard user's token. No ACL, file, account, task or firewall object is modified.

  Limitation (stated in the audit): this is a DACL simulation. It does not model privileges (SeBackup etc. - a standard
  user has none that matter), mandatory integrity labels beyond noting them, or ACEs naming the not-yet-existing worker
  SID (none can exist yet). It must be CONFIRMED by real denial tests under the real account (acceptance matrix).
#>
param([string]$OutDir = (Join-Path $PSScriptRoot 'out'))
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force $OutDir | Out-Null

# Token group SIDs of a standard, non-admin local user.
$common = @('S-1-1-0','S-1-5-32-545','S-1-5-11','S-1-5-15','S-1-5-113','S-1-2-0')
$tokens = [ordered]@{
  'batch'       = $common + @('S-1-5-3')              # scheduled task "run whether logged on or not"
  'interactive' = $common + @('S-1-5-4','S-1-2-1')    # runas / console logon
}

$GENERIC = @{ 0x80000000L = 0x120089; 0x40000000L = 0x120116; 0x20000000L = 0x1200A0; 0x10000000L = 0x1F01FF }
function Expand-Mask([long]$m) {
  $r = $m -band 0x0FFFFFFFL
  foreach ($g in $GENERIC.Keys) { if ($m -band $g) { $r = $r -bor $GENERIC[$g] } }
  return $r
}

function Get-Effective([string]$Path, [string[]]$Sids) {
  try { $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop } catch { return @{ error = $_.Exception.Message } }
  $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($acl.Sddl)
  $granted = 0L; $denied = 0L
  foreach ($ace in $raw.DiscretionaryAcl) {
    if (([int]$ace.AceFlags) -band 0x08) { continue }   # INHERIT_ONLY_ACE
    $sid = $ace.SecurityIdentifier.Value
    if ($Sids -notcontains $sid) { continue }
    $mask = Expand-Mask ([long]$ace.AccessMask -band 0xFFFFFFFFL)
    if ($ace.AceQualifier -eq 'AccessAllowed') { $granted = $granted -bor ($mask -band (-bnot $denied)) }
    elseif ($ace.AceQualifier -eq 'AccessDenied') { $denied = $denied -bor ($mask -band (-bnot $granted)) }
  }
  $label = if ($acl.Sddl -match 'S:.*\(ML;[^;]*;([^;]*);') { $Matches[1] } else { '' }
  return @{ mask = $granted; owner = $acl.Owner; protected = $acl.AreAccessRulesProtected; sddl = $acl.Sddl; label = $label }
}

function Format-Rights([long]$m, [bool]$isDir) {
  $f = @()
  if ($m -band 0x1)     { $f += $(if ($isDir) {'List'} else {'Read'}) }
  if ($m -band 0x2)     { $f += $(if ($isDir) {'CreateFile'} else {'Write'}) }
  if ($m -band 0x4)     { $f += $(if ($isDir) {'CreateDir'} else {'Append'}) }
  if ($m -band 0x20)    { $f += $(if ($isDir) {'Traverse'} else {'Execute'}) }
  if ($m -band 0x40)    { $f += 'DeleteChild' }
  if ($m -band 0x100)   { $f += 'WriteAttr' }
  if ($m -band 0x10000) { $f += 'Delete' }
  if ($m -band 0x40000) { $f += 'WRITE_DAC' }
  if ($m -band 0x80000) { $f += 'WRITE_OWNER' }
  if (-not $f) { return 'NONE' }
  return ($f -join ',')
}

function Test-Path2([string]$p) { try { return (Test-Path -LiteralPath $p -ErrorAction Stop) } catch { return $false } }

function Measure-Object2([string]$Path, [string]$Category) {
  $exists = Test-Path2 $Path
  $row = [ordered]@{ category = $Category; path = $Path; exists = $exists }
  if (-not $exists) { return [pscustomobject]$row }
  $isDir = (Get-Item -LiteralPath $Path -Force).PSIsContainer
  $parent = Split-Path -Parent $Path
  foreach ($k in $tokens.Keys) {
    $e = Get-Effective $Path $tokens[$k]
    if ($e.error) { $row["$k"] = "ACL-UNREADABLE: $($e.error)"; continue }
    $p = if ($parent) { Get-Effective $parent $tokens[$k] } else { @{ mask = 0 } }
    $m = $e.mask
    $canRead   = [bool]($m -band 0x1)
    $canWrite  = [bool]($m -band 0x6)
    $canDelete = [bool](($m -band 0x10000) -or ($p.mask -band 0x40))
    $canDac    = [bool]($m -band 0xC0000)
    $row["$k"] = Format-Rights $m $isDir
    $row["${k}_read"] = $canRead; $row["${k}_write"] = $canWrite; $row["${k}_delete_or_rename"] = $canDelete; $row["${k}_dac"] = $canDac
    if ($k -eq 'batch') { $row.owner = $e.owner; $row.protected = $e.protected; $row.label = $e.label; $row.sddl = $e.sddl }
  }
  [pscustomobject]$row
}

$prof = 'C:\Users\Roman'
$prodHome = Join-Path $prof 'AppData\Local\ElevariqAgent'
$targets = @(
  @('E:\','volume-root'), @('F:\','volume-root'), @('D:\','volume-root'), @('C:\','volume-root'),
  @('E:\Agent','agent-root'),
  @('E:\Agent\Personal-agent','prod-checkout'),
  @('E:\Agent\Personal-agent\.env','prod-secret'),
  @('E:\Agent\Personal-agent\.env.bak-20261107','prod-secret'),
  @('E:\Agent\Personal-agent\.git','prod-repo'),
  @('E:\Agent\Personal-agent\.git\hooks','prod-repo'),
  @('E:\Agent\Personal-agent\.git\config','prod-repo'),
  @('E:\Agent\Personal-agent\dist','prod-executable'),
  @('E:\Agent\Personal-agent\dist\index.js','prod-executable'),
  @('E:\Agent\Personal-agent\node_modules','prod-executable'),
  @('E:\Agent\Personal-agent\scripts\windows\run-supervisor.ps1','prod-task-action'),
  @('E:\Agent\Personal-agent\package.json','prod-executable'),
  @('E:\Agent\Personal-agent\.npmrc','prod-executable'),
  @('E:\Agent\Personal-agent\.claude','prod-config'),
  @('E:\Agent\.claude','agent-config'),
  @('E:\Agent\Personal-agent-merge','other-checkout'),
  @('E:\Agent\Personal-agent-v2','other-checkout'),
  @('E:\Agent\pa-v2-integrate','other-checkout'),
  @('E:\Agent\pa-v2-a2','other-checkout'),
  @('E:\Agent\pa-v2-qa','other-checkout'),
  @('E:\Agent\pilot-evidence','evidence'),
  @('E:\Agent\pilot-evidence\elevariq-retail-operations-portal\closeout','evidence-db-backup'),
  @('E:\Agent\v2-staging','staging'),
  @('E:\Agent\v2-staging\rc','release-artifact'),
  @('E:\Agent\v2-staging\deploy','deploy-record'),
  @('E:\Agent\v2-staging\v21-trusted-20261110-0223\repo','staging-repo (broker source)'),
  @('E:\Agent\v2-staging\v21-trusted-20261110-0223\repo\src\security\broker','broker-source'),
  @('E:\Agent\v2-staging\trusted-execution-20261110-0249\admin-scripts','admin-scripts'),
  @('E:\Agent\v2-staging\trusted-execution-20261110-0249\admin-scripts\02-configure-acls.ps1','admin-scripts'),
  @('E:\Agent\v2-staging\trusted-execution-20261110-0249\admin-scripts\_common.ps1','admin-scripts'),
  @('E:\Agent\v2-staging\worker-isolation','staging-evidence'),
  @('E:\Agent\v2-staging\release-readiness','staging-evidence'),
  @('E:\Agent\v2-staging\hardening','staging-evidence'),
  @($prof,'owner-profile'),
  @("$prof\.claude",'owner-credential'),
  @("$prof\.claude\.credentials.json",'owner-credential'),
  @("$prof\.claude.json",'owner-credential'),
  @("$prof\.ssh",'owner-credential'),
  @("$prof\.gitconfig",'owner-credential'),
  @("$prof\.git-credentials",'owner-credential'),
  @("$prof\AppData\Roaming\Microsoft\Credentials",'owner-credential'),
  @("$prof\AppData\Local\Microsoft\Credentials",'owner-credential'),
  @("$prof\AppData\Roaming\Microsoft\Protect",'owner-credential (DPAPI master keys)'),
  @("$prof\.local\bin",'owner-PATH'),
  @("$prof\AppData\Roaming\npm",'owner-PATH'),
  @($prodHome,'prod-home'),
  @("$prodHome\agent.db",'prod-db'),
  @("$prodHome\backups",'prod-backups'),
  @("$prodHome\workspaces",'prod-workspaces'),
  @("$prodHome\logs",'prod-logs'),
  @('C:\Program Files\nodejs','runtime'),
  @('C:\Program Files\nodejs\node.exe','runtime'),
  @('C:\Program Files\Git\cmd','runtime'),
  @('C:\Windows\System32\WindowsPowerShell\v1.0','runtime'),
  @('C:\ProgramData','shared'),
  @('C:\Windows\Temp','shared'),
  @('C:\Users\Public','shared'),
  @('C:\Download','c-root-dir'),
  @('C:\Intel','c-root-dir'),
  @('C:\inetpub','c-root-dir'),
  @('C:\ElevariqStaging','staging-root (not yet created)')
)
# Add discovered prod-home children (db files, backups) so nothing is missed.
if (Test-Path2 $prodHome) {
  Get-ChildItem -LiteralPath $prodHome -Force -ErrorAction SilentlyContinue | ForEach-Object { $targets += ,@($_.FullName, 'prod-home-child') }
}
foreach ($d in 'D:\','F:\') { Get-ChildItem -LiteralPath $d -Force -Directory -ErrorAction SilentlyContinue | ForEach-Object { $targets += ,@($_.FullName, 'other-volume-top') } }
Get-ChildItem -LiteralPath 'E:\' -Force -ErrorAction SilentlyContinue | ForEach-Object { $targets += ,@($_.FullName, 'e-root-child') }

$seen = @{}
$rows = foreach ($t in $targets) { if ($seen[$t[0]]) { continue }; $seen[$t[0]] = 1; Measure-Object2 $t[0] $t[1] }
$rows | Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $OutDir 'effective-access.csv')
$rows | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $OutDir 'effective-access.json')

# Sweep: every file/dir under E:\Agent whose DACL is NOT simply inherited (explicit ACEs or protected) = exceptions.
$exceptions = New-Object System.Collections.ArrayList
$sensitive  = New-Object System.Collections.ArrayList
$pattern = '(^\.env)|(\.db$)|(\.db-wal$)|(\.sqlite)|(\.pem$)|(\.key$)|(credential)|(secret)|(\.bundle$)|(id_rsa)|(id_ed25519)|(token)'
Get-ChildItem -LiteralPath 'E:\Agent' -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.git\\objects\\' } |
  ForEach-Object {
    $fp = $_.FullName
    try { $a = Get-Acl -LiteralPath $fp -ErrorAction Stop } catch { [void]$exceptions.Add([pscustomobject]@{ path = $fp; issue = 'ACL unreadable' }); return }
    $explicit = @($a.Access | Where-Object { -not $_.IsInherited }).Count
    if ($a.AreAccessRulesProtected -or $explicit -gt 0) { [void]$exceptions.Add([pscustomobject]@{ path = $fp; protected = $a.AreAccessRulesProtected; explicitAces = $explicit; sddl = $a.Sddl }) }
    if (-not $_.PSIsContainer -and $_.Name -match $pattern) {
      $e = Get-Effective $fp $tokens['batch']
      [void]$sensitive.Add([pscustomobject]@{ path = $fp; size = $_.Length; worker = (Format-Rights $e.mask $false) })
    }
  }
$exceptions | Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $OutDir 'e-agent-acl-exceptions.csv')
$sensitive  | Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $OutDir 'e-agent-sensitive-files.csv')

# Escalation surface: scheduled tasks and services whose executable/script resides in a worker-writable location.
function Get-PathCandidates([string]$s) {
  if (-not $s) { return @() }
  $s = [Environment]::ExpandEnvironmentVariables($s)
  [regex]::Matches($s, '([A-Za-z]:\\[^"*?<>|]+?\.(exe|ps1|cmd|bat|js|cjs|mjs|vbs|dll))', 'IgnoreCase') | ForEach-Object { $_.Groups[1].Value }
}
$esc = New-Object System.Collections.ArrayList
Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
  $task = $_
  foreach ($act in @($task.Actions)) {
    foreach ($c in (Get-PathCandidates "$($act.Execute) $($act.Arguments)")) {
      foreach ($probe in @($c, (Split-Path -Parent $c))) {
        if (-not (Test-Path2 $probe)) { continue }
        $e = Get-Effective $probe $tokens['batch']
        if ($e.mask -band 0x50006) {
          [void]$esc.Add([pscustomobject]@{ kind = 'scheduled-task'; name = "$($task.TaskPath)$($task.TaskName)"; runsAs = $task.Principal.UserId; runLevel = $task.Principal.RunLevel; state = $task.State; writablePath = $probe; workerRights = (Format-Rights $e.mask (Test-Path -LiteralPath $probe -PathType Container)) })
        }
      }
    }
  }
}
Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | ForEach-Object {
  $svc = $_
  foreach ($c in (Get-PathCandidates $svc.PathName)) {
    foreach ($probe in @($c, (Split-Path -Parent $c))) {
      if (-not (Test-Path2 $probe)) { continue }
      $e = Get-Effective $probe $tokens['batch']
      if ($e.mask -band 0x50006) {
        [void]$esc.Add([pscustomobject]@{ kind = 'service'; name = $svc.Name; runsAs = $svc.StartName; runLevel = $svc.StartMode; state = $svc.State; writablePath = $probe; workerRights = (Format-Rights $e.mask (Test-Path -LiteralPath $probe -PathType Container)) })
      }
    }
  }
}
foreach ($rk in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run') {
  $props = Get-ItemProperty $rk -ErrorAction SilentlyContinue
  if (-not $props) { continue }
  foreach ($p in $props.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' }) {
    foreach ($c in (Get-PathCandidates "$($p.Value)")) {
      foreach ($probe in @($c, (Split-Path -Parent $c))) {
        if (-not (Test-Path2 $probe)) { continue }
        $e = Get-Effective $probe $tokens['batch']
        if ($e.mask -band 0x50006) { [void]$esc.Add([pscustomobject]@{ kind = 'run-key'; name = "$rk\$($p.Name)"; runsAs = $(if ($rk -like 'HKCU*') {'Roman (logon)'} else {'each user (logon)'}); writablePath = $probe; workerRights = (Format-Rights $e.mask (Test-Path -LiteralPath $probe -PathType Container)) }) }
      }
    }
  }
}
# PATH directories (binary planting for any process that searches PATH).
$pathDirs = @(([Environment]::GetEnvironmentVariable('Path','Machine') -split ';') | ForEach-Object { @{ scope='machine'; dir=$_ } }) +
            @(([Environment]::GetEnvironmentVariable('Path','User') -split ';') | ForEach-Object { @{ scope='user(Roman)'; dir=$_ } })
foreach ($pd in $pathDirs) {
  if (-not $pd.dir -or -not (Test-Path2 $pd.dir)) { continue }
  $e = Get-Effective $pd.dir $tokens['batch']
  if ($e.mask -band 0x6) { [void]$esc.Add([pscustomobject]@{ kind = "PATH-$($pd.scope)"; name = $pd.dir; writablePath = $pd.dir; workerRights = (Format-Rights $e.mask $true) }) }
}
$esc | Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $OutDir 'escalation-surface.csv')

"rows=$(@($rows).Count) exceptions=$($exceptions.Count) sensitive=$($sensitive.Count) escalation=$($esc.Count)"
