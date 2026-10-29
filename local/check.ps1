<#
.SYNOPSIS
Runs one Launch Tracker image with PostgreSQL and Blob storage (Azurite), then runs the smoke test
from the same image. Works with Docker Desktop or Podman, in Windows PowerShell 5.1 or PowerShell 7.

.DESCRIPTION
Everything it starts is named launch-tracker-check-*. Only the app is published, on 127.0.0.1.
The database and storage start empty with throwaway passwords, so no real data is involved.

.PARAMETER Image
The image to check, by digest: <name>@sha256:<digest>. Without it, the newest image that passed CI on main.

.PARAMETER Port
The port on this computer where the app is published. Default 8080.

.PARAMETER Engine
docker or podman. Without it, whichever is installed and running.

.PARAMETER ExpectCommit
Fail unless the app reports this commit.

.PARAMETER Stop
Stop and remove everything this script started.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\check.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\check.ps1 -Stop
#>
[CmdletBinding()]
param(
  [string]$Image = '',
  [int]$Port = 8080,
  [string]$Engine = '',
  [string]$ExpectCommit = '',
  [switch]$Stop
)

# Windows PowerShell 5.1 turns a program's error output into a terminating error under 'Stop',
# so each step checks $LASTEXITCODE itself instead.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0

$Repository = 'muttonkodibiriyani/launch-tracker'
$PostgresImage = 'docker.io/library/postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab'
$AzuriteImage = 'mcr.microsoft.com/azure-storage/azurite:3.37.0@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5'
$Name = 'launch-tracker-check'
$Shell = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh' } else { 'powershell' }
$StopCommand = "$Shell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Stop"

function Show-Step([string]$Message) {
  Write-Host "==> $Message"
}

function Show-Failure([string]$Message) {
  Write-Host ''
  Write-Host "Check failed: $Message" -ForegroundColor Red
  exit 1
}

function Test-Engine([string]$Candidate) {
  if (-not (Get-Command $Candidate -ErrorAction SilentlyContinue)) { return $false }
  & $Candidate info *> $null
  return $LASTEXITCODE -eq 0
}

function Clear-Check {
  & $Engine rm -f -v "$Name-smoke" "$Name-app" "$Name-storage" "$Name-postgres" *> $null
  & $Engine network rm $Name *> $null
}

if ($Port -lt 1 -or $Port -gt 65535) { Show-Failure "-Port must be a number from 1 to 65535, not $Port." }

if (-not $Engine) {
  if (Test-Engine 'docker') { $Engine = 'docker' }
  elseif (Test-Engine 'podman') { $Engine = 'podman' }
  elseif (Get-Command docker -ErrorAction SilentlyContinue) {
    Show-Failure 'Docker is installed but not running. Start Docker Desktop, wait until it says it is running, and run this again.'
  }
  elseif (Get-Command podman -ErrorAction SilentlyContinue) {
    Show-Failure "Podman is installed but its machine is not running. Run 'podman machine start', then run this again."
  }
  else {
    Show-Failure 'neither Docker nor Podman is installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or Podman Desktop (https://podman-desktop.io/), then run this again.'
  }
}
if ($Engine -ne 'docker' -and $Engine -ne 'podman') { Show-Failure "-Engine must be docker or podman, not '$Engine'." }
if (-not (Test-Engine $Engine)) { Show-Failure "$Engine is not running. Start it, then run this again." }

if ($Stop) {
  Clear-Check
  Show-Step 'Stopped and removed the Launch Tracker check containers.'
  exit 0
}

if (-not $Image) {
  Show-Step 'Finding the newest image that passed CI on main'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  try {
    $token = (Invoke-RestMethod -UseBasicParsing -ErrorAction Stop "https://ghcr.io/token?scope=repository:${Repository}:pull").token
  }
  catch {
    Show-Failure 'could not reach ghcr.io. Check the internet connection (and any proxy), then run this again.'
  }
  $found = ''
  try {
    $accept = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
    $response = Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -Method Head -Headers @{ Authorization = "Bearer $token"; Accept = $accept } "https://ghcr.io/v2/$Repository/manifests/main"
    # Windows PowerShell gives each header as a string, PowerShell 7 as a list of strings.
    $found = [string]($response.Headers.GetEnumerator() | Where-Object { $_.Key -eq 'Docker-Content-Digest' } | ForEach-Object { $_.Value } | Select-Object -First 1)
  }
  catch {
    $found = ''
  }
  if (-not $found) { Show-Failure "ghcr.io has no image tagged main for $Repository, or it is not public. Pass one with -Image <name>@sha256:<digest>." }
  $Image = "ghcr.io/$Repository@$found"
}
if ($Image -cnotmatch '@(sha256:[0-9a-f]{64})$') {
  Show-Failure "give the image by digest (<name>@sha256:<digest>) so you check exactly what CI built, not '$Image'."
}
$digest = $Matches[1]
Show-Step "Image $Image"

Clear-Check
$client = New-Object System.Net.Sockets.TcpClient
try {
  $client.Connect('127.0.0.1', $Port)
  $inUse = $true
}
catch {
  $inUse = $false
}
finally {
  $client.Close()
}
if ($inUse) { Show-Failure "port $Port is already in use on this computer. Close what uses it, or run with -Port <another number>." }

Show-Step 'Downloading the images (the first run takes a few minutes)'
foreach ($ref in @($Image, $PostgresImage, $AzuriteImage)) {
  & $Engine pull --quiet $ref | Out-Null
  if ($LASTEXITCODE -ne 0) { Show-Failure "could not download $ref. Check the internet connection, then run this again." }
}

Show-Step 'Starting PostgreSQL and Blob storage (empty, with throwaway passwords)'
$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$dbPassword = -join ($bytes[0..15] | ForEach-Object { $_.ToString('x2') })
$storageKey = [Convert]::ToBase64String($bytes, 16, 32)
& $Engine network create $Name | Out-Null
if ($LASTEXITCODE -ne 0) { Show-Failure "could not create the $Name network; the $Engine message above says why." }
& $Engine run -d --name "$Name-postgres" --network $Name --tmpfs /var/lib/postgresql/data `
  -e POSTGRES_USER=launchtracker -e POSTGRES_DB=launchtracker -e "POSTGRES_PASSWORD=$dbPassword" `
  $PostgresImage | Out-Null
if ($LASTEXITCODE -ne 0) { Show-Failure "could not start PostgreSQL; the $Engine message above says why." }
& $Engine run -d --name "$Name-storage" --network $Name -e "AZURITE_ACCOUNTS=launchtracker:$storageKey" `
  $AzuriteImage azurite-blob --blobHost 0.0.0.0 --inMemoryPersistence --skipApiVersionCheck | Out-Null
if ($LASTEXITCODE -ne 0) { Show-Failure "could not start Blob storage; the $Engine message above says why." }

$waited = 0
while ($true) {
  & $Engine exec "$Name-postgres" pg_isready -q -h 127.0.0.1 -U launchtracker -d launchtracker *> $null
  if ($LASTEXITCODE -eq 0) { break }
  if ($waited -ge 60) {
    & $Engine logs --tail 30 "$Name-postgres"
    Show-Failure 'PostgreSQL did not start within 60 seconds; its log is above.'
  }
  Start-Sleep -Seconds 1
  $waited++
}

Show-Step 'Starting Launch Tracker'
$storage = "DefaultEndpointsProtocol=http;AccountName=launchtracker;AccountKey=$storageKey;BlobEndpoint=http://$Name-storage:10000/launchtracker;"
& $Engine run -d --name "$Name-app" --network $Name -p "127.0.0.1:${Port}:8080" `
  -e "PGHOST=$Name-postgres" -e PGDATABASE=launchtracker -e PGUSER=launchtracker -e "PGPASSWORD=$dbPassword" -e PGSSLMODE=disable `
  -e "BLOB_CONNECTION_STRING=$storage" -e BLOB_CONTAINER=launch-tracker -e "IMAGE_DIGEST=$digest" `
  $Image | Out-Null
if ($LASTEXITCODE -ne 0) { Show-Failure "could not start Launch Tracker; the $Engine message above says why." }

Show-Step 'Running the smoke test'
$smoke = @('dist/smoke.js', "http://$Name-app:8080", '--expect-digest', $digest, '--wait', '90')
if ($ExpectCommit) { $smoke += @('--expect-commit', $ExpectCommit) }
& $Engine run --rm --name "$Name-smoke" --network $Name $Image @smoke
if ($LASTEXITCODE -ne 0) {
  Show-Step 'The app log:'
  & $Engine logs --tail 40 "$Name-app"
  Show-Failure "the smoke test failed; the lines marked FAIL above say what to fix. Remove everything with: $StopCommand"
}
try {
  Invoke-WebRequest -UseBasicParsing -ErrorAction Stop "http://127.0.0.1:$Port/healthz" | Out-Null
}
catch {
  Show-Failure "the app answers inside $Engine but not at http://127.0.0.1:$Port. Check that nothing else (a VPN or firewall) holds that port."
}

Write-Output ''
Write-Output "Launch Tracker is running at http://127.0.0.1:$Port"
Write-Output "Stop it with: $StopCommand"
