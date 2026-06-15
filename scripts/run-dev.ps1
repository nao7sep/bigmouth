Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptExitCode = 0

# run-dev: run the app from source with live reload, in its loosest configuration.
# For active coding and debugging. The strict, production-faithful launchers are
# run-built (launch the existing production build without rebuilding) and rebuild
# (build from clean in release config, then launch).

function Set-Utf8Console {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    $global:OutputEncoding = $utf8NoBom
    if (Get-Command chcp.com -ErrorAction SilentlyContinue) {
        & chcp.com 65001 > $null
        $null = $LASTEXITCODE
    }
}

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int[]]$AllowedExitCodes = @(0)
    )

    & $FilePath @ArgumentList
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
    if ($AllowedExitCodes -notcontains $exitCode) {
        throw "Command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
    }
}

function Stop-Port {
    param([int]$Port)
    $pids = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($portPid in $pids) {
        if ($portPid -and $portPid -ne $PID) {
            Stop-Process -Id $portPid -Force -ErrorAction SilentlyContinue
        }
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
$serverDir = Join-Path $repoDir "server"
$clientDir = Join-Path $repoDir "client"
$browserJob = $null

try {
    Set-Utf8Console
    Require-Command node
    Require-Command npm

    Set-Location $repoDir

    Write-Step "Stopping stale BigMouth listeners"
    Stop-Port 3141
    Stop-Port 5273

    Write-Step "Installing root dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install")

    Write-Step "Installing server dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install", "--prefix", $serverDir)

    Write-Step "Installing client dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install", "--prefix", $clientDir)

    Write-Step "Waiting to open the browser when the server and client respond"
    $browserJob = Start-Job -ScriptBlock {
        param([string]$ServerUrl, [string]$ClientUrl)
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            try {
                Invoke-WebRequest -Uri $ServerUrl -UseBasicParsing -TimeoutSec 2 | Out-Null
                Invoke-WebRequest -Uri $ClientUrl -UseBasicParsing -TimeoutSec 2 | Out-Null
                Start-Process $ClientUrl
                return
            }
            catch {
                Start-Sleep -Seconds 1
            }
        }
    } -ArgumentList "http://127.0.0.1:3141/api/health", "http://localhost:5273"

    Write-Step "Starting server and client in development mode"
    Invoke-Native -FilePath "npm" -ArgumentList @("run", "dev") -AllowedExitCodes @(0, 130, -1073741510)
}
catch {
    Write-Host ""
    Write-Host "bigmouth run-dev failed: $($_.Exception.Message)" -ForegroundColor Red
    $scriptExitCode = 1
}
finally {
    if ($browserJob) {
        Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    }
    Read-Host "Press Enter to close" | Out-Null
}

exit $scriptExitCode
