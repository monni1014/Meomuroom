$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$tailscaleExe = "C:\Program Files\Tailscale\tailscale.exe"
$stateDirectory = "C:\ProgramData\Memoroom"
$logPath = Join-Path $stateDirectory "tailscale-watchdog.log"
$mutex = New-Object System.Threading.Mutex($false, "Global\MemoroomTailscaleWatchdog")

function Write-WatchdogLog([string]$message) {
  New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
  if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1MB) {
    Move-Item -LiteralPath $logPath -Destination "$logPath.previous" -Force
  }
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz') $message"
}

function Get-TailscaleBackendState {
  if (-not (Test-Path -LiteralPath $tailscaleExe)) {
    return "MissingExecutable"
  }

  $tempStem = Join-Path $env:TEMP "memoroom-tailscale-$PID-$([Guid]::NewGuid().ToString('N'))"
  $stdoutPath = "$tempStem.stdout"
  $stderrPath = "$tempStem.stderr"
  $process = $null
  try {
    $process = Start-Process -FilePath $tailscaleExe -ArgumentList @("status", "--json") `
      -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    if (-not $process.WaitForExit(12000)) {
      try { $process.Kill() } catch { }
      return "TimedOut"
    }
    if ($process.ExitCode -ne 0) {
      return "CommandFailed"
    }
    $status = Get-Content -LiteralPath $stdoutPath -Raw | ConvertFrom-Json
    return [string]$status.BackendState
  } catch {
    return "InvalidStatus"
  } finally {
    if ($process) { $process.Dispose() }
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Test-TailscaleHealthy {
  $service = Get-Service -Name Tailscale -ErrorAction SilentlyContinue
  if (-not $service -or $service.Status -ne "Running") {
    return $false
  }
  return (Get-TailscaleBackendState) -eq "Running"
}

if (-not $mutex.WaitOne(0)) {
  exit 0
}

try {
  if (Test-TailscaleHealthy) {
    exit 0
  }

  $initialState = Get-TailscaleBackendState
  Write-WatchdogLog "Unhealthy state detected: $initialState. Restarting the Tailscale service."

  Restart-Service -Name Tailscale -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5

  if (-not (Test-TailscaleHealthy)) {
    Write-WatchdogLog "Normal restart did not recover Tailscale. Cleaning residual daemon processes."
    Stop-Service -Name Tailscale -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Get-Process -Name tailscaled -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-Service -Name Tailscale
    Start-Sleep -Seconds 5
  }

  if (-not (Test-TailscaleHealthy)) {
    $finalState = Get-TailscaleBackendState
    Write-WatchdogLog "Automatic recovery failed. Final state: $finalState."
    exit 1
  }

  Write-WatchdogLog "Automatic recovery completed successfully."
  exit 0
} catch {
  Write-WatchdogLog "Watchdog error: $($_.Exception.Message)"
  exit 1
} finally {
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
