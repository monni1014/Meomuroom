$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$memoroomTailnetHost = "100.65.163.49"
$memoroomTailnetPort = 22
$stateDirectory = "C:\ProgramData\Memoroom\watchdog-state"
$logPath = Join-Path $stateDirectory "tailscale-watchdog-check.log"
$requestPath = Join-Path $stateDirectory "tailscale-recovery-request.json"
$mutex = New-Object System.Threading.Mutex($false, "Global\MemoroomTailscaleWatchdogCheck")

function Write-WatchdogLog([string]$message) {
  New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
  if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1MB) {
    Move-Item -LiteralPath $logPath -Destination "$logPath.previous" -Force
  }
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz') $message"
}

function Test-MemoroomTailnetRoute {
  $client = New-Object System.Net.Sockets.TcpClient
  $connect = $null
  try {
    $connect = $client.BeginConnect($memoroomTailnetHost, $memoroomTailnetPort, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(10000)) {
      return $false
    }
    $client.EndConnect($connect)
    return $client.Connected
  } catch {
    return $false
  } finally {
    if ($connect -and $connect.AsyncWaitHandle) {
      $connect.AsyncWaitHandle.Close()
    }
    $client.Dispose()
  }
}

if (-not $mutex.WaitOne(0)) {
  exit 0
}

try {
  $service = Get-Service -Name Tailscale -ErrorAction SilentlyContinue
  $routeAvailable = Test-MemoroomTailnetRoute
  if ($service -and $service.Status -eq "Running" -and $routeAvailable) {
    Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    exit 0
  }

  $serviceState = if ($service) { [string]$service.Status } else { "Missing" }
  $request = [ordered]@{
    requestedAt = (Get-Date).ToString("o")
    routeState = if ($routeAvailable) { "Reachable" } else { "Unreachable" }
    serviceState = $serviceState
  }
  New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
  $request | ConvertTo-Json -Compress | Set-Content -LiteralPath $requestPath -Encoding utf8
  Write-WatchdogLog "Unhealthy state detected: route=$($request.routeState) service=$serviceState. Recovery requested."
  exit 0
} catch {
  Write-WatchdogLog "Watchdog check error: $($_.Exception.Message)"
  exit 1
} finally {
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
