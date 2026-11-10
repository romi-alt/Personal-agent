# Runs the r2 (reviewed, REJECTED) classification logic over a fixture, in its own process so the r2 _common.ps1 can be
# dot-sourced without clashing with r3. The filter expressions are copied VERBATIM from
# admin-scripts-r2-20261110\00-isolation-group-deny.ps1 lines 85-89 (hash 126d700c...). Prints JSON: per-path issues.
param([Parameter(Mandatory)][string]$FixtureRoot, [string]$R2Dir = 'E:\Agent\v2-staging\worker-isolation\admin-scripts-r2-20261110')
$ErrorActionPreference = 'Stop'
. (Join-Path $R2Dir '_common.ps1')
$out = @()
foreach ($item in @(Get-Item -LiteralPath $FixtureRoot -Force) + @(Get-ChildItem -LiteralPath $FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue)) {
    $fp = $item.FullName
    try {
        $acl = Get-Acl -LiteralPath $fp; $sddl = $acl.Sddl
        if ($sddl -match 'D:NO_ACCESS_CONTROL') { $out += [pscustomobject]@{ path = $fp; issue = 'null-dacl' }; continue }
        $aces = @(Get-ElvAces $fp -Sddl $sddl)
        # --- r2 verbatim ---
        $explicitBroad = @($aces | Where-Object { -not $_.Inherited -and -not $_.InheritOnly -and $_.Type -eq 'AccessAllowed' -and ($script:BroadSids -contains $_.Sid) })
        if ($explicitBroad.Count) { $out += [pscustomobject]@{ path = $fp; issue = 'explicit-broad-allow' } }
        if ($acl.AreAccessRulesProtected -and(Get-ElvEffectiveMask $fp $script:BroadSids -Aces $aces) -ne 0) { $out += [pscustomobject]@{ path = $fp; issue = 'protected-with-broad-access' } }
        # --- end r2 verbatim ---
    } catch { $out += [pscustomobject]@{ path = $fp; issue = 'unreadable' } }
}
$out | ConvertTo-Json -Compress
