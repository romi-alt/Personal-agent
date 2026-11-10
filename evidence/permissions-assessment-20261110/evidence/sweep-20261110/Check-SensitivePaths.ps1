# READ-ONLY priority check of sensitive ELEVARIQ / credential / audit locations (item 4).
# Reports BROAD-GROUP ACL EXPOSURE (Everyone, Users, Authenticated Users, ... from $script:BroadSids) evaluated over
# the DACL. This is configuration evidence ONLY: it is NOT the effective access of a real worker token (no
# privileges, integrity labels, or the future deny-group SID are modelled). Directories are walked up to $MaxItems.
param([string]$OutCsv, [int]$MaxItems = 3000)
$ErrorActionPreference = 'Stop'
. 'E:\Agent\v2-staging\worker-isolation\admin-scripts-r2-20261110\_common.ps1'
$o = Get-ElvOwnerContext; $pf = $o.Profile; $la = Join-Path $pf 'AppData\Local'; $ra = Join-Path $pf 'AppData\Roaming'
$co = $script:ProductionCheckout
$targets = [ordered]@{
  'P1 production config/secrets'   = @("$co\.env", "$co\.git\config", "$co\.git\hooks", "$co\.npmrc")
  'P1 production code run as admin'= @("$co\scripts\windows\run-supervisor.ps1", "$co\dist", "$co\node_modules\better-sqlite3")
  'P1 production DB + audit store' = @("$la\ElevariqAgent", "$la\ElevariqAgent\agent.db", "$la\ElevariqAgent\backups", "$la\ElevariqAgent\logs")
  'P1 owner Claude credentials'    = @("$pf\.claude", "$pf\.claude\.credentials.json", "$pf\.claude.json")
  'P1 Windows credential stores'   = @("$ra\Microsoft\Protect", "$ra\Microsoft\Credentials", "$la\Microsoft\Credentials", "$la\Microsoft\Vault")
  'P1 git/ssh/gh credentials'      = @("$pf\.ssh", "$pf\.git-credentials", "$pf\.gitconfig", "$ra\GitHub CLI")
  'P1 admin scripts + owner admin' = @('E:\Agent\v2-staging\worker-isolation\admin-scripts-r2-20261110', (Join-Path $pf 'ElevariqAdmin'))
  'P2 broker source + staging'     = @('E:\Agent\v2-staging\v21-trusted-20261110-0223\repo\src\security\broker', 'E:\Agent\v2-staging\v21-trusted-20261110-0223\repo\.git\config', 'E:\Agent\v2-staging\worker-isolation')
  'P2 Claude Code project memory'  = @('E:\Agent\.claude', "$pf\.claude\projects")
  'P2 evidence + DB copies'        = @('E:\Agent\v2-staging\hardening', 'E:\Agent\pilot-evidence')
}
$w = New-Object IO.StreamWriter($OutCsv, $false, (New-Object Text.UTF8Encoding($true)))
$w.WriteLine('"priority","target","path","exists","protected","broadRead","broadWrite","broadDelete","explicitBroadAllow","itemsWalked","itemsBroadWritable","firstBroadWritable","error"')
function Rights([long]$m) { [pscustomobject]@{ R = [bool]($m -band 0x1); W = [bool]($m -band 0x116); D = [bool]($m -band 0x10000) } }
function Csv($a) { ($a | ForEach-Object { '"' + ([string]$_ -replace '"', '""') + '"' }) -join ',' }
foreach ($k in $targets.Keys) {
  foreach ($p in $targets[$k]) {
    $row = [ordered]@{ priority = $k.Substring(0, 2); target = $k.Substring(3); path = $p; exists = (Test-Path -LiteralPath $p); protected = ''; broadRead = ''; broadWrite = ''; broadDelete = ''; explicitBroadAllow = ''; itemsWalked = 0; itemsBroadWritable = 0; firstBroadWritable = ''; error = '' }
    if ($row.exists) {
      try {
        $acl = Get-Acl -LiteralPath $p; $aces = @(Get-ElvAces $p -Sddl $acl.Sddl)
        $r = Rights (Get-ElvEffectiveMask $p $script:BroadSids -Aces $aces)
        $row.protected = $acl.AreAccessRulesProtected; $row.broadRead = $r.R; $row.broadWrite = $r.W; $row.broadDelete = $r.D
        $row.explicitBroadAllow = [bool]@($aces | Where-Object { -not $_.Inherited -and $_.Type -eq 'AccessAllowed' -and $script:BroadSids -contains $_.Sid }).Count
        if ((Get-Item -LiteralPath $p -Force).PSIsContainer) {
          Get-ChildItem -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable +ev | Select-Object -First $MaxItems | ForEach-Object {
            $row.itemsWalked++
            try { if ((Get-ElvBroadWriteMask $_.FullName) -ne 0) { $row.itemsBroadWritable++; if (-not $row.firstBroadWritable) { $row.firstBroadWritable = $_.FullName } } } catch {}
          }
          if ($ev) { $row.error = "enum errors: $(@($ev).Count)"; $ev = $null }
        }
      } catch { $row.error = $_.Exception.Message }
    }
    $w.WriteLine((Csv @($row.Values))); $w.Flush()
  }
}
$w.Close()
Import-Csv $OutCsv | Format-Table priority, path, exists, protected, broadRead, broadWrite, explicitBroadAllow, itemsWalked, itemsBroadWritable, error -AutoSize -Wrap
