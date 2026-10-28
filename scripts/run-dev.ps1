Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptExitCode = 0

# run-dev: run the app from source with live reload, in its loosest configuration.
# For active coding and debugging. The strict, production-faithful launchers are
# run-built (launch the existing packaged app bundle without rebuilding) and
# rebuild (build and package a fresh bundle, then launch).

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

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
$appName = "BigMouth"
$runtimeHelper = Join-Path $scriptDir "launcher-runtime.mjs"
$appPid = $null
# The renderer dev server's fixed endpoint. The electron-vite config owns it;
# a test keeps this copy equal to it.
$rendererHost = "127.0.0.1"
$rendererPort = "26263"
$rendererUrl = "http://${rendererHost}:$rendererPort"

try {
    Set-Utf8Console
    Require-Command node
    Require-Command npm

    Set-Location $repoDir

    Write-Step "Replacing any existing $appName runtime"
    Invoke-Native -FilePath "node" -ArgumentList @($runtimeHelper, "stop", $appName)
    Invoke-Native -FilePath "node" -ArgumentList @($runtimeHelper, "check-endpoint", $rendererHost, $rendererPort)

    Write-Step "Installing dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install", "--no-audit", "--no-fund")

    # Electron's package has no install script: it downloads its binary the first
    # time something requires it, and electron-vite only reads the path that
    # download records. Its installer returns at once when the binary is there.
    Write-Step "Ensuring the Electron binary"
    Invoke-Native -FilePath "node" -ArgumentList @("node_modules/electron/install.js")

    Write-Step "Starting $appName in development mode"
    $devProcess = Start-Process -FilePath (Get-Command "npm.cmd").Source -ArgumentList @("run", "dev") -NoNewWindow -PassThru
    Invoke-Native -FilePath "node" -ArgumentList @($runtimeHelper, "wait-http", $rendererUrl, "60000")
    $appPid = & node $runtimeHelper record-wrapped $devProcess.Id (Join-Path $repoDir "node_modules/electron/dist/electron.exe") $appName
    if ($LASTEXITCODE -ne 0) { throw "$appName did not start." }
    Write-Step "$appName is ready at $rendererUrl"
    $devProcess.WaitForExit()
    if ($devProcess.ExitCode -notin @(0, 130, -1073741510)) {
        throw "$appName development runtime failed with exit code $($devProcess.ExitCode)."
    }
}
catch {
    Write-Host ""
    Write-Host "bigmouth run-dev failed: $($_.Exception.Message)" -ForegroundColor Red
    $scriptExitCode = 1
}
finally {
    # Closing this launcher closes the app it started, unless a later launcher has replaced it.
    if ($appPid) { & node $runtimeHelper stop-if-recorded $appPid $appName *> $null }
    Read-Host "Press Enter to close" | Out-Null
}

exit $scriptExitCode
