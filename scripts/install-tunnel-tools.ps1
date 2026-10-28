$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$toolRoot = Join-Path $projectRoot 'tools/tunnel'
New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
$headers = @{ 'User-Agent' = 'Drift-local-setup' }

function Get-Release($repository) {
    Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repository/releases/latest"
}
function Assert-Hash($path, $expected) {
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected.ToLowerInvariant()) {
        throw "SHA256 verification failed: $path"
    }
}

$cloudflareRelease = Get-Release 'cloudflare/cloudflared'
$cloudflareAsset = $cloudflareRelease.assets | Where-Object name -eq 'cloudflared-windows-amd64.exe'
if (-not $cloudflareAsset.digest -or $cloudflareAsset.digest -notmatch '^sha256:([a-f0-9]{64})$') {
    throw 'Official cloudflared release metadata does not contain a SHA256 digest.'
}
$cloudflareHash = $cloudflareAsset.digest.Substring(7)
$cloudflarePath = Join-Path $toolRoot 'cloudflared.exe'
Invoke-WebRequest -UseBasicParsing -Uri $cloudflareAsset.browser_download_url -OutFile $cloudflarePath
Assert-Hash $cloudflarePath $cloudflareHash

$caddyRelease = Get-Release 'caddyserver/caddy'
$caddyAsset = $caddyRelease.assets | Where-Object name -Match '_windows_amd64.zip$'
if ($caddyAsset.digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Official Caddy release digest was not found.' }
$caddyHash = $caddyAsset.digest.Substring(7)
$archive = Join-Path $toolRoot $caddyAsset.name
Invoke-WebRequest -UseBasicParsing -Uri $caddyAsset.browser_download_url -OutFile $archive
Assert-Hash $archive $caddyHash
Expand-Archive -LiteralPath $archive -DestinationPath $toolRoot -Force
& $cloudflarePath --version
& (Join-Path $toolRoot 'caddy.exe') version
Write-Host 'Official portable downloads verified with SHA256. No Windows services were installed.'
