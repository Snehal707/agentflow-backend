# Load CLOUDSMITH_TOKEN from .env and run npm install.
# Usage: from project root, run: .\scripts\setup.ps1
# Or: powershell -ExecutionPolicy Bypass -File scripts/setup.ps1

$projectRoot = Join-Path $PSScriptRoot ".."
$envFile = Join-Path $projectRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Error ".env not found at $envFile"
    exit 1
}

$line = Get-Content $envFile | Select-String "CLOUDSMITH_TOKEN"
if ($line) {
    $token = ($line -replace "CLOUDSMITH_TOKEN=", "").Trim()
    $env:CLOUDSMITH_TOKEN = $token
    Write-Host "CLOUDSMITH_TOKEN set from .env"
} else {
    Write-Warning "CLOUDSMITH_TOKEN not found in .env"
}

Set-Location $projectRoot
npm install
exit $LASTEXITCODE
