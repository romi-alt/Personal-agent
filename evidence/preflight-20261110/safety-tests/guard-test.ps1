. (Join-Path $args[0] '_common.ps1')
$report = New-ElvReport 'guard-test'
$cases = @('E:\Agent\Personal-agent', 'E:\Agent\Personal-agent\dist\cli\index.js', (Join-Path $env:LOCALAPPDATA 'ElevariqAgent'), 'C:\Users\Roman\.ssh', 'C:\Windows\System32', 'D:\whatever', 'C:\ElevariqStagingEvil')
$pass = 0; $fail = 0
foreach ($c in $cases) {
  try { [void](Assert-StagingPath $report $c $true); Write-Host "FAIL (allowed): $c"; $fail++ }
  catch { Write-Host "OK (rejected): $c"; $pass++ }
}
# Positive: a real staging path must be ACCEPTED
foreach ($c in @('C:\ElevariqStaging', 'C:\ElevariqStaging\work\task1', 'C:\ElevariqStaging\broker')) {
  try { [void](Assert-StagingPath $report $c $true); Write-Host "OK (accepted): $c"; $pass++ }
  catch { Write-Host "FAIL (rejected a staging path): $c"; $fail++ }
}
# Known production path rejected EVEN when StagingOnly=$false:
try { [void](Assert-StagingPath $report 'E:\Agent\Personal-agent' $false); Write-Host "FAIL: prod allowed in prod-scope"; $fail++ }
catch { Write-Host "OK (prod always rejected, even non-staging): E:\Agent\Personal-agent"; $pass++ }
Write-Host "GUARD-TEST pass=$pass fail=$fail"
