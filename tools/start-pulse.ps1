# Pulse one-room test on Windows: public tunnel + server + pages.
# Double-click tools\start-pulse.bat (runs from the repo root). See docs/test-log.md.
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
Start-Transcript -Path (Join-Path $repo 'start-pulse.log') -Force | Out-Null
Set-Location $repo
trap { Write-Host "ERROR: $_" -ForegroundColor Red; Stop-Transcript | Out-Null; Read-Host 'Press Enter to close'; exit 1 }
$room = '151'
$port = 8080
# An older Pulse server (or anything else) may already hold 8080: use the next free port.
function PortBusy($p) { [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }
while (PortBusy $port) {
  $owner = (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
  $name = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
  Write-Host "Port $port is already in use by '$name' (pid $owner), probably an older server. Using $($port + 1)." -ForegroundColor Yellow
  $port++
}

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host "=== Pulse one-room test ===" -ForegroundColor Cyan

if (-not (Have node)) { Write-Host "Node.js is not installed. Install it from https://nodejs.org (LTS), then run this again." -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }

if (Have git) {
  Write-Host "Updating to the latest poc/one-room..."
  & git pull --ff-only
  if ($LASTEXITCODE -ne 0) { Write-Host "(git pull skipped, using the files already here)" -ForegroundColor Yellow }
}
# Reinstall packages when package-lock.json changed since the last install (new branch or pull).
$lockHash = (Get-FileHash package-lock.json).Hash
$marker = Join-Path 'node_modules' '.pulse-lock-hash'
if (-not (Test-Path node_modules) -or -not (Test-Path $marker) -or (Get-Content $marker -ErrorAction SilentlyContinue) -ne $lockHash) {
  Write-Host "Installing packages..."
  & npm ci --no-audit --no-fund
  if ($LASTEXITCODE -eq 0) { Set-Content -Path $marker -Value $lockHash }
}

# cloudflared gives a free public https URL (no account) so phones on mobile data can open the page.
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
  foreach ($p in @("$env:ProgramFiles\cloudflared\cloudflared.exe", "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe")) { if (Test-Path $p) { $cf = $p } }
}
if (-not $cf) {
  $ans = Read-Host "cloudflared (Cloudflare's tunnel tool) is not installed. Install it now with winget? (Y/N)"
  if ($ans -notmatch '^[Yy]') { Write-Host "Can't make a public link without it. Closing."; Read-Host "Press Enter to close"; exit 1 }
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements | Out-Host
  foreach ($p in @("$env:ProgramFiles\cloudflared\cloudflared.exe", "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe")) { if (Test-Path $p) { $cf = $p } }
  if (-not $cf) { Write-Host "Installed, but this window can't see it yet. Close this window and double-click start-pulse.bat again." -ForegroundColor Yellow; Read-Host "Press Enter to close"; exit 1 }
}

# Fresh keys for this test run.
$chars = 'abcdefghjkmnpqrstuvwxyz23456789'.ToCharArray()
$speakerKey = -join (1..10 | ForEach-Object { $chars | Get-Random })
$techKey = -join (1..10 | ForEach-Object { $chars | Get-Random })

# 1) Tunnel first, so we know the public URL.
$log = Join-Path $env:TEMP "pulse-tunnel.log"
Remove-Item $log -ErrorAction SilentlyContinue
$tunnel = Start-Process -FilePath $cf -ArgumentList "tunnel --no-autoupdate --url http://localhost:$port" -RedirectStandardError $log -WindowStyle Minimized -PassThru
Write-Host "Starting the public tunnel..."
$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $log) { $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } }
}
if (-not $url) { Write-Host "The tunnel didn't give a URL. Log: $log" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }

# 2) Server.
$env:PORT = "$port"; $env:SPEAKER_KEY = $speakerKey; $env:TECH_KEY = $techKey; $env:PUBLIC_BASE_URL = $url; $env:ALERT_THRESHOLD = '1'
$server = Start-Process -FilePath node -ArgumentList "server/index.js" -WindowStyle Minimized -PassThru
$up = $false
for ($i = 0; $i -lt 20 -and -not $up; $i++) { Start-Sleep -Milliseconds 500; try { $up = (Invoke-WebRequest "http://localhost:$port/healthz" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop).Content -eq 'ok' } catch {} }
if (-not $up -or $server.HasExited) { Write-Host "The server didn't start on port $port." -ForegroundColor Red; Read-Host "Press Enter to close"; Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue; exit 1 }
Write-Host "Server is up on port $port." -ForegroundColor Green

# Wait until cloudflared reports a live connection to Cloudflare (DNS for the new name can lag a few seconds more).
Write-Host "Waiting for the tunnel to connect..."
for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 500; if (Select-String -Path $log -Pattern 'Registered tunnel connection' -Quiet) { break } }
Start-Sleep -Seconds 4

$mic = "$url/mic/$room`?key=$speakerKey&base=$url"
$tech = "$url/tech?key=$techKey&rooms=$room"
$relay = "$url/relay/$room`?key=$speakerKey"
$phone = "$url/r/$room"

$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($chrome) { Start-Process $chrome -ArgumentList "--new-window `"$mic`" `"$tech`" `"$relay`"" } else { Start-Process $mic; Start-Process $tech; Start-Process $relay }

@"
Pulse is running.
  Phone page (QR code):  $phone
  Podium mic page:       $mic
  Tech screen:           $tech
  Slide relay:           $relay   (open on the computer showing the slides)
  Speaker key: $speakerKey    Tech key: $techKey
Alert limit is 1 vote for this test.
"@ | Tee-Object -FilePath (Join-Path $env:TEMP 'pulse-test-urls.txt') | Write-Host -ForegroundColor Green

Read-Host "Leave this window open while testing. Press Enter to STOP the server and tunnel"
Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
Stop-Transcript | Out-Null
