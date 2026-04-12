Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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
        throw "Command failed with exit code $exitCode: $FilePath $($ArgumentList -join ' ')"
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
$serverDistDir = Join-Path $serverDir "dist"
$clientDistDir = Join-Path $clientDir "dist"

try {
    Set-Utf8Console
    Require-Command node
    Require-Command npm

    Set-Location $repoDir

    Write-Step "Stopping stale BigMouth listeners"
    Stop-Port 3141
    Stop-Port 5173

    Write-Step "Installing root dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install")

    Write-Step "Updating root packages"
    Invoke-Native -FilePath "npm" -ArgumentList @("update")

    Write-Step "Installing server dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install", "--prefix", $serverDir)

    Write-Step "Updating server packages"
    Invoke-Native -FilePath "npm" -ArgumentList @("update", "--prefix", $serverDir)

    Write-Step "Installing client dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install", "--prefix", $clientDir)

    Write-Step "Updating client packages"
    Invoke-Native -FilePath "npm" -ArgumentList @("update", "--prefix", $clientDir)

    Write-Step "Cleaning previous build outputs"
    if (Test-Path $serverDistDir) {
        Remove-Item -Recurse -Force $serverDistDir
    }
    if (Test-Path $clientDistDir) {
        Remove-Item -Recurse -Force $clientDistDir
    }

    Write-Step "Building server and client"
    Invoke-Native -FilePath "npm" -ArgumentList @("run", "build")
}
catch {
    Write-Host ""
    Write-Host "bigmouth update-packages failed: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host "Press Enter to close" | Out-Null
    exit 1
}
