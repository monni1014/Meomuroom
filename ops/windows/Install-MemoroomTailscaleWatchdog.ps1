$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$watchSource = Join-Path $PSScriptRoot "Watch-MemoroomTailscale.ps1"
$recoverySource = Join-Path $PSScriptRoot "Recover-MemoroomTailscale.ps1"
$destinationDirectory = "C:\ProgramData\Memoroom"
$stateDirectory = Join-Path $destinationDirectory "watchdog-state"
$watchDestination = Join-Path $destinationDirectory "Watch-MemoroomTailscale.ps1"
$recoveryDestination = Join-Path $destinationDirectory "Recover-MemoroomTailscale.ps1"
$watchTaskName = "Memoroom Tailscale Watchdog"
$recoveryTaskName = "Memoroom Tailscale Recovery"
$operatorUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $watchSource)) {
  throw "Watchdog source file not found: $watchSource"
}
if (-not (Test-Path -LiteralPath $recoverySource)) {
  throw "Recovery source file not found: $recoverySource"
}

New-Item -ItemType Directory -Force -Path $destinationDirectory, $stateDirectory | Out-Null
Copy-Item -LiteralPath $watchSource -Destination $watchDestination -Force
Copy-Item -LiteralPath $recoverySource -Destination $recoveryDestination -Force

$stateAcl = Get-Acl -LiteralPath $stateDirectory
$stateRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $operatorUser,
  "Modify",
  "ContainerInherit,ObjectInherit",
  "None",
  "Allow"
)
$stateAcl.SetAccessRule($stateRule)
Set-Acl -LiteralPath $stateDirectory -AclObject $stateAcl

Set-Service -Name Tailscale -StartupType Automatic
& sc.exe failure Tailscale reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Could not configure Tailscale service recovery actions."
}
& sc.exe failureflag Tailscale 1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Could not enable Tailscale service failure actions."
}

$watchAction = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchDestination`""
$watchTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$watchPrincipal = New-ScheduledTaskPrincipal -UserId $operatorUser -LogonType Interactive -RunLevel Limited
$recoveryAction = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$recoveryDestination`""
$recoveryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1)
$recoveryPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
$watchTask = New-ScheduledTask -Action $watchAction -Trigger $watchTrigger -Principal $watchPrincipal -Settings $settings
$recoveryTask = New-ScheduledTask -Action $recoveryAction -Trigger $recoveryTrigger -Principal $recoveryPrincipal -Settings $settings
Register-ScheduledTask -TaskName $watchTaskName -InputObject $watchTask -Force | Out-Null
Register-ScheduledTask -TaskName $recoveryTaskName -InputObject $recoveryTask -Force | Out-Null
Disable-ScheduledTask -TaskName $recoveryTaskName | Out-Null
Remove-Item -LiteralPath (Join-Path $stateDirectory "tailscale-recovery-request.json") -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $watchTaskName
Start-Sleep -Seconds 2
$watchDeadline = (Get-Date).AddSeconds(20)
do {
  Start-Sleep -Seconds 1
  $registeredWatchTask = Get-ScheduledTask -TaskName $watchTaskName -ErrorAction Stop
} while ($registeredWatchTask.State -eq "Running" -and (Get-Date) -lt $watchDeadline)
$watchInfo = Get-ScheduledTaskInfo -TaskName $watchTaskName -ErrorAction Stop
$requestPath = Join-Path $stateDirectory "tailscale-recovery-request.json"
if ($watchInfo.LastTaskResult -ne 0 -or (Test-Path -LiteralPath $requestPath)) {
  Disable-ScheduledTask -TaskName $watchTaskName | Out-Null
  throw "The user-level Tailscale route check failed; both watchdog tasks remain disabled."
}

Enable-ScheduledTask -TaskName $recoveryTaskName | Out-Null
Start-ScheduledTask -TaskName $recoveryTaskName
Start-Sleep -Seconds 3

$registeredWatchTask = Get-ScheduledTask -TaskName $watchTaskName -ErrorAction Stop
$registeredRecoveryTask = Get-ScheduledTask -TaskName $recoveryTaskName -ErrorAction Stop
if ($registeredWatchTask.State -eq "Disabled" -or $registeredRecoveryTask.State -eq "Disabled") {
  throw "A Tailscale watchdog task was registered in a disabled state."
}

Set-Content -LiteralPath (Join-Path $destinationDirectory "tailscale-watchdog-install.status") `
  -Value "installed split-watchdog $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')" -NoNewline
