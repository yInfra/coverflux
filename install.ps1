# Coverflux – installs the extension into Spicetify and applies it to Spotify.
# Usage:  powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = "Stop"
$src = Join-Path $PSScriptRoot "dist\coverflux.js"
$ext = Join-Path $env:APPDATA "spicetify\Extensions"
New-Item -ItemType Directory -Force $ext | Out-Null
Copy-Item $src (Join-Path $ext "coverflux.js") -Force
Write-Host "coverflux.js -> $ext"

$cli = (Get-Command spicetify -ErrorAction SilentlyContinue).Source
if (-not $cli) {
  $local = Join-Path $env:LOCALAPPDATA "spicetify\spicetify.exe"
  if (Test-Path $local) { $cli = $local }
}
if (-not $cli) {
  Write-Host ""
  Write-Host "Spicetify CLI nicht gefunden. Installiere sie zuerst (offizieller Installer):" -ForegroundColor Yellow
  Write-Host '  iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex'
  Write-Host "Danach dieses Skript erneut ausfuehren."
  exit 1
}

& $cli config extensions coverflux.js
# backup apply works both for a fresh Spotify (no backup yet) and after Spotify updates
& $cli backup apply
if ($LASTEXITCODE -ne 0) { & $cli apply }
Write-Host "Fertig. Spotify neu starten -> Knopf rechts in der Playbar neben dem Lyrics-Knopf." -ForegroundColor Green
