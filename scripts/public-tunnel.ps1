param([ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$runtimeRoot = Join-Path $projectRoot 'storage/app/tunnel'
$statePath = Join-Path $runtimeRoot 'state.json'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

function Get-State {
    if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json }
}
function Get-OwnedProcess($entry) {
    $process = Get-Process -Id $entry.Id -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().ToString('o') -eq $entry.StartTime) { $process }
}
function Stop-Owned($state) {
    # Stop ingress first. PID and creation time must match our recorded child.
    foreach ($entry in $state.Processes) {
        if (Get-OwnedProcess $entry) {
            & taskkill.exe /PID $entry.Id /T /F 2>$null | Out-Null
        }
    }
}

$previous = Get-State
if ($Action -eq 'Status') {
    if (-not $previous) { Write-Host 'No recorded public tunnel.'; exit 0 }
    Write-Host $previous.Url
    foreach ($entry in $previous.Processes) { Write-Host ($entry.Name + ': ' + [bool](Get-OwnedProcess $entry)) }
    exit 0
}
if ($Action -eq 'Stop') {
    if ($previous) {
        $previous | Add-Member -NotePropertyName StopRequested -NotePropertyValue $true -Force
        $previous | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $statePath
        Stop-Owned $previous
    }
    Write-Host 'Public tunnel and its dedicated runtime stopped. Local development services were not stopped.'
    exit 0
}
if ($previous) {
    foreach ($entry in $previous.Processes) {
        if (Get-OwnedProcess $entry) { throw 'A recorded public runtime is still running. Use -Action Status or -Action Stop first.' }
    }
}
foreach ($port in @(18000, 18080, 18090)) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    try { $listener.Start() } finally { $listener.Stop() }
}
$cloudflared = Join-Path $projectRoot 'tools/tunnel/cloudflared.exe'
$caddy = Join-Path $projectRoot 'tools/tunnel/caddy.exe'
foreach ($tool in @($cloudflared, $caddy)) {
    if (-not (Test-Path -LiteralPath $tool)) { throw "Missing approved portable tool: $tool. Run scripts/install-tunnel-tools.ps1 after approving installation." }
}
$php = (Get-Command php.exe).Source
$children = [Collections.Generic.List[object]]::new()
$savedEnvironment = @{}
$runTag = [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path $runtimeRoot $runTag
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null

function Save-State($url) {
    @{ Url = $url; Processes = @($children.ToArray()) } | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $statePath
}
function Start-Child($name, $executable, $arguments) {
    $process = Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $runRoot "$name.out.log") -RedirectStandardError (Join-Path $runRoot "$name.err.log")
    $entry = @{ Name = $name; Id = $process.Id; StartTime = $process.StartTime.ToUniversalTime().ToString('o') }
    $children.Add($entry)
    Save-State $script:publicUrl
    return $process
}
function Set-RuntimeEnvironment($name, $value) {
    if (-not $savedEnvironment.ContainsKey($name)) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    [Environment]::SetEnvironmentVariable($name, [string]$value, 'Process')
}

$publicUrl = $null
try {
    Push-Location $projectRoot
    & $php tests/Support/check-services.php
    if ($LASTEXITCODE -ne 0) { throw 'Redis must be running first. Keep scripts/start-redis.ps1 open in another terminal.' }
    Set-RuntimeEnvironment 'DRIFT_BUILD_DIRECTORY' 'tunnel-build'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Public asset build failed.' }

    # No account, named tunnel, config file, inbound firewall rule or purchased domain.
    $tunnel = Start-Child 'cloudflared' $cloudflared 'tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:18090'
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        Start-Sleep -Milliseconds 500
        if ($tunnel.HasExited) { throw "cloudflared exited. See $runRoot/cloudflared.err.log" }
        $output = Get-Content (Join-Path $runRoot 'cloudflared.err.log') -Raw -ErrorAction SilentlyContinue
        $match = [regex]::Match([string]$output, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($match.Success) { $publicUrl = $match.Value; break }
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $publicUrl) { throw "No Quick Tunnel URL received. See $runRoot/cloudflared.err.log" }
    $publicHost = ([Uri]$publicUrl).Host
    $sessionRoot = Join-Path $runRoot 'sessions'
    New-Item -ItemType Directory -Force -Path $sessionRoot | Out-Null
    $overrides = @{
        APP_ENV = 'production'; APP_DEBUG = 'false'; APP_URL = $publicUrl
        APP_CONFIG_CACHE = (Join-Path $runRoot 'uncached-config.php')
        DRIFT_PUBLIC_TUNNEL = 'true'; DRIFT_TUNNEL_HOST = $publicHost
        DRIFT_PROJECT_PUBLIC = (Join-Path $projectRoot 'public').Replace('\', '/')
        SESSION_DRIVER = 'file'; SESSION_FILES = $sessionRoot; SESSION_COOKIE = 'drift_public_session'
        SESSION_DOMAIN = 'null'; SESSION_SECURE_COOKIE = 'true'; SESSION_HTTP_ONLY = 'true'; SESSION_SAME_SITE = 'lax'
        CACHE_STORE = 'file'; CACHE_PREFIX = "drift-public-$runTag`:"; CHAT_STORE = 'redis'
        BROADCAST_CONNECTION = 'reverb'; REVERB_HOST = '127.0.0.1'; REVERB_PORT = '18080'; REVERB_SCHEME = 'http'
        REVERB_SERVER_HOST = '127.0.0.1'; REVERB_SERVER_PORT = '18080'; REVERB_ALLOWED_ORIGINS = $publicHost
        REVERB_SCALING_ENABLED = 'false'; REVERB_APP_ACCEPT_CLIENT_EVENTS_FROM = 'none'
        REVERB_MAX_REQUEST_SIZE = '131072'; REVERB_APP_MAX_MESSAGE_SIZE = '131072'
        REVERB_APP_RATE_LIMITING_ENABLED = 'true'; REVERB_APP_RATE_LIMIT_MAX_ATTEMPTS = '120'
        REVERB_APP_MAX_CONNECTIONS = '100'; PHP_CLI_SERVER_WORKERS = '1'
    }
    foreach ($name in $overrides.Keys) { Set-RuntimeEnvironment $name $overrides[$name] }
    & $caddy validate --config (Join-Path $PSScriptRoot 'tunnel.Caddyfile') --adapter caddyfile
    if ($LASTEXITCODE -ne 0) { throw 'Reverse proxy configuration validation failed.' }
    $null = Start-Child 'laravel' $php 'artisan serve --host=127.0.0.1 --port=18000 --no-reload'
    $null = Start-Child 'reverb' $php 'artisan reverb:start --host=127.0.0.1 --port=18080'
    $null = Start-Child 'proxy' $caddy ('run --config "' + (Join-Path $PSScriptRoot 'tunnel.Caddyfile') + '" --adapter caddyfile')
    Save-State $publicUrl
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $ready = $false
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri http://127.0.0.1:18090 -Headers @{ Host = $publicHost }
            $ready = $response.StatusCode -eq 200
        } catch { Start-Sleep -Milliseconds 500 }
    } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
    if (-not $ready) { throw "Public runtime did not become healthy. Logs: $runRoot" }
    Write-Host "Public URL: $publicUrl"
    Write-Host 'Keep this terminal and the Redis terminal open. Ctrl+C stops this public runtime.'
    Write-Host 'Video requires HTTPS, browser camera/microphone permission, and a reachable peer route (TURN may be required on restrictive networks).'
    Write-Host 'From another terminal: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/public-tunnel.ps1 -Action Stop'
    while ($true) {
        Start-Sleep -Seconds 2
        if ((Get-State).StopRequested) { break }
        foreach ($entry in $children) {
            if (-not (Get-OwnedProcess $entry)) { throw "$($entry.Name) stopped; closing public access. Logs: $runRoot" }
        }
    }
} finally {
    Stop-Owned @{ Processes = @($children.ToArray()) }
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    Pop-Location
}
