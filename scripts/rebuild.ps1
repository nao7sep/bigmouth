Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptExitCode = 0

# rebuild: produce a fresh PRODUCTION build of bigmouth and launch it.
# Slow — run this after changing source. Frees the server port, installs
# dependencies, cleans and rebuilds the client and server, then starts the
# production server (:3141) with NODE_ENV=production. In production the Node
# server serves the built client from the same port, so the browser opens at
# the SERVER port — there is no separate client dev server. run-built is the
# fast, no-build launcher for everything after this.

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

    Write-Step "Installing root dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install")

    Write-Step "Installing server dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install", "--prefix", $serverDir)

    Write-Step "Installing client dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install", "--prefix", $clientDir)

    # Remove stale output so a build that fails to emit a file can't be masked by
    # a leftover artifact from a previous run.
    Write-Step "Cleaning previous production build"
    if (Test-Path "client/dist") { Remove-Item -Recurse -Force "client/dist" }
    if (Test-Path "server/dist") { Remove-Item -Recurse -Force "server/dist" }

    Write-Step "Building production bundle"
    Invoke-Native -FilePath "npm" -ArgumentList @("run", "build")

    Write-Step "Waiting to open the browser when the production server responds"
    $browserJob = Start-Job -ScriptBlock {
        param([string]$ServerUrl, [string]$OpenUrl)
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            try {
                Invoke-WebRequest -Uri $ServerUrl -UseBasicParsing -TimeoutSec 2 | Out-Null
                Start-Process $OpenUrl
                return
            }
            catch {
                Start-Sleep -Seconds 1
            }
        }
    } -ArgumentList "http://127.0.0.1:3141/api/health", "http://localhost:3141"

    # The production server serves the built client from the same origin on :3141.
    # NODE_ENV=production enables production behavior. The root has no `start`
    # script, so the server's own start script is invoked via the prefix form.
    Write-Step "Starting the production server (NODE_ENV=production)"
    $env:NODE_ENV = "production"
    Invoke-Native -FilePath "npm" -ArgumentList @("--prefix", "server", "run", "start") -AllowedExitCodes @(0, 130, -1073741510)
}
catch {
    Write-Host ""
    Write-Host "bigmouth rebuild failed: $($_.Exception.Message)" -ForegroundColor Red
    $scriptExitCode = 1
}
finally {
    if ($browserJob) {
        Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    }
    Read-Host "Press Enter to close" | Out-Null
}

exit $scriptExitCode
