$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "Memoroom - Proxy-Seller setup"

function Read-PlainSecret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Quote-DotEnv([string]$Value) {
    if ($Value.Contains("`r") -or $Value.Contains("`n")) {
        throw "Environment values cannot contain line breaks."
    }
    $escaped = $Value.Replace("\", "\\").Replace('"', '\"')
    return '"' + $escaped + '"'
}

function Set-DotEnvValue([System.Collections.Generic.List[string]]$Lines, [string]$Name, [string]$Value) {
    $line = $Name + "=" + (Quote-DotEnv $Value)
    for ($index = 0; $index -lt $Lines.Count; $index++) {
        if ($Lines[$index] -match ('^' + [regex]::Escape($Name) + '=')) {
            $Lines[$index] = $line
            return
        }
    }
    $Lines.Add($line)
}

$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root ".env"
$lines = [System.Collections.Generic.List[string]]::new()
if (Test-Path $envPath) {
    foreach ($line in [IO.File]::ReadAllLines($envPath)) {
        $lines.Add($line)
    }
}

Write-Host "Enter the values shown in Proxy-Seller order details. Secrets will not be echoed."
$hostName = (Read-Host "Proxy host or IP").Trim()
$port = (Read-Host "HTTP proxy port").Trim()
$username = (Read-Host "Proxy username").Trim()
$password = Read-PlainSecret "Proxy password"
$apiKey = Read-PlainSecret "Proxy-Seller API key (optional; press Enter to skip)"

if (-not $hostName -or $hostName -match '://') {
    throw "Enter only a proxy hostname or IP, without http://."
}
if ($port -notmatch '^\d{1,5}$' -or [int]$port -lt 1 -or [int]$port -gt 65535) {
    throw "Proxy port is invalid."
}
if (-not $username -or -not $password) {
    throw "Proxy username and password are required."
}

Set-DotEnvValue $lines "RPA_PROXY_PROVIDER" "proxyseller"
Set-DotEnvValue $lines "RPA_PROXY_HOST" $hostName
Set-DotEnvValue $lines "RPA_PROXY_PORT" $port
Set-DotEnvValue $lines "RPA_PROXY_PROTOCOL" "http"
Set-DotEnvValue $lines "RPA_PROXY_USER" $username
Set-DotEnvValue $lines "RPA_PROXY_PASS" $password
Set-DotEnvValue $lines "RPA_USE_PROXY" "true"
Set-DotEnvValue $lines "RPA_PROXY_DIRECT_FALLBACK" "false"
if ($apiKey) {
    Set-DotEnvValue $lines "PROXYSELLER_API_KEY" $apiKey
}

[IO.File]::WriteAllLines($envPath, $lines, [Text.UTF8Encoding]::new($false))
Write-Host "Saved to .env (excluded from Git)."
Write-Host "Next command: npm.cmd run rpa:test-proxy"
