[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$TaskName = 'ElevariqPersonalAgent')
$ErrorActionPreference = 'Stop'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and unregister')) {
    # Ask the supervisor to stop gracefully first so in-flight work is checkpointed.
    try { Push-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)); npm run agent -- stop } catch { Write-Warning $_ } finally { Pop-Location }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed '$TaskName'."
  }
} else { Write-Output "Task '$TaskName' not found." }
