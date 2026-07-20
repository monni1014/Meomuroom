$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$stateDirectory = "C:\ProgramData\Memoroom\watchdog-state"
$requestPath = Join-Path $stateDirectory "tailscale-recovery-request.json"
$lastRecoveryPath = Join-Path $stateDirectory "tailscale-last-recovery.txt"
$logPath = Join-Path $stateDirectory "tailscale-watchdog-recovery.log"
$mutex = New-Object System.Threading.Mutex($false, "Global\MemoroomTailscaleRecovery")

function Write-RecoveryLog([string]$message) {
  New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
  if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1MB) {
    Move-Item -LiteralPath $logPath -Destination "$logPath.previous" -Force
  }
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz') $message"
}

if (-not $mutex.WaitOne(0)) {
  exit 0
}

try {
  if (-not (Test-Path -LiteralPath $requestPath)) {
    exit 0
  }

  $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
  $requestedAt = [DateTimeOffset]::Parse([string]$request.requestedAt)
  if (([DateTimeOffset]::Now - $requestedAt).TotalMinutes -gt 15) {
    Remove-Item -LiteralPath $requestPath -Force
    Write-RecoveryLog "Discarded a stale recovery request."
    exit 0
  }

  if (Test-Path -LiteralPath $lastRecoveryPath) {
    $lastRecovery = [DateTimeOffset]::Parse((Get-Content -LiteralPath $lastRecoveryPath -Raw).Trim())
    if (([DateTimeOffset]::Now - $lastRecovery).TotalMinutes -lt 10) {
      Remove-Item -LiteralPath $requestPath -Force
      Write-RecoveryLog "Skipped recovery during the 10-minute cooldown."
      exit 0
    }
  }

  Remove-Item -LiteralPath $requestPath -Force
  Write-RecoveryLog "Recovery started: route=$($request.routeState) service=$($request.serviceState)."

  Stop-Service -Name Tailscale -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Get-Process -Name tailscaled -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-Service -Name Tailscale

  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Seconds 2
    $service = Get-Service -Name Tailscale -ErrorAction SilentlyContinue
  } while ((!$service -or $service.Status -ne "Running") -and (Get-Date) -lt $deadline)

  if (-not $service -or $service.Status -ne "Running") {
    Write-RecoveryLog "Recovery failed: the Tailscale service did not reach Running."
    exit 1
  }

  $completedAt = [DateTimeOffset]::Now.ToString("o")
  Set-Content -LiteralPath $lastRecoveryPath -Value $completedAt -NoNewline
  Write-RecoveryLog "Recovery completed; the user-level check will verify the backend on its next run."
  exit 0
} catch {
  Write-RecoveryLog "Recovery error: $($_.Exception.Message)"
  exit 1
} finally {
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
