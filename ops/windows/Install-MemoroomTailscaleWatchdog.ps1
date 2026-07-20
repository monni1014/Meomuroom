$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$source = Join-Path $PSScriptRoot "Watch-MemoroomTailscale.ps1"
$destinationDirectory = "C:\ProgramData\Memoroom"
$destination = Join-Path $destinationDirectory "Watch-MemoroomTailscale.ps1"
$taskName = "Memoroom Tailscale Watchdog"

if (-not (Test-Path -LiteralPath $source)) {
  throw "Watchdog source file not found: $source"
}

New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -Force

Set-Service -Name Tailscale -StartupType Automatic
& sc.exe failure Tailscale reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Could not configure Tailscale service recovery actions."
}
& sc.exe failureflag Tailscale 1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Could not enable Tailscale service failure actions."
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$destination`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

$registeredTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if ($registeredTask.State -eq "Disabled") {
  throw "The watchdog task was registered in a disabled state."
}

Set-Content -LiteralPath (Join-Path $destinationDirectory "tailscale-watchdog-install.status") `
  -Value "installed $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')" -NoNewline
