Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptExitCode = 0

# run-built: launch the EXISTING production build of bigmouth without
# rebuilding, so it starts instantly. This is the daily-use launcher and the
# one that surfaces production-only failures (strict CSP, same-origin serving).
# It never installs or builds — if you changed source, run rebuild first. The
# production server serves the built client from the same port (:3141), so the
# browser opens at the SERVER port.

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
$browserJob = $null

try {
    Set-Utf8Console
    Require-Command node
    Require-Command npm

    Set-Location $repoDir

    # No build, no dependency install here: this launcher must start instantly. If
    # there is no usable build yet, stop and point at rebuild rather than launching
    # something stale or empty.
    if (-not ((Test-Path "client/dist/index.html") -and (Test-Path "server/dist/index.js"))) {
        throw "No production build found — run rebuild first."
    }

    $builtAt = (Get-Item "client/dist/index.html").LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
    Write-Step "Launching the existing production build (built: $builtAt)"
    Write-Host "If you changed source since then, run rebuild instead."

    Write-Step "Stopping stale BigMouth listeners"
    Stop-Port 3141

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
    Write-Host "bigmouth run-built failed: $($_.Exception.Message)" -ForegroundColor Red
    $scriptExitCode = 1
}
finally {
    if ($browserJob) {
        Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    }
    Read-Host "Press Enter to close" | Out-Null
}

exit $scriptExitCode
