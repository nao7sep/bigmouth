Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptExitCode = 0

# rebuild: produce a fresh production build, package it into a real app bundle,
# and launch it. Slow — run this after changing source. The build runs the
# production type checks and re-bundles from clean, so type, import, CSP, and
# packaged-layout errors that run-dev hides surface here; packaging then gives the
# app its own identity. run-built is the fast, no-build launcher after this.

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
$runtimeHelper = Join-Path $scriptDir "launcher-runtime.mjs"
$appName = "BigMouth"
$outDir = "dist"
$exePath = Join-Path $repoDir "$outDir/win-unpacked/$appName.exe"

try {
    Set-Utf8Console
    Require-Command node
    Require-Command npm

    Set-Location $repoDir

    Write-Step "Installing dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install", "--no-audit", "--no-fund")

    # Build into a clean candidate so a build that fails to emit a file can't be
    # masked by a leftover artifact; the previous package stays runnable until the
    # candidate is complete.
    Write-Step "Preparing clean build output"
    $candidate = & node $runtimeHelper prepare-candidate $outDir
    if ($LASTEXITCODE -ne 0) { throw "Could not prepare the build output." }

    # `npm run build` is the one definition of the release build (type-check the
    # shipped sources, then bundle), which CI runs through `npm run dist`; calling
    # it keeps this launcher on the same pipeline.
    Write-Step "Type-checking and building production sources"
    Invoke-Native -FilePath "npm.cmd" -ArgumentList @("run", "build")

    # Package the built output into a real app bundle — the unpacked app only, no
    # installer. This is what gives the app its own identity (correct name)
    # instead of running under the generic Electron runtime.
    Write-Step "Packaging the app bundle"
    Invoke-Native -FilePath "node_modules/.bin/electron-builder.cmd" -ArgumentList @("--dir", "--config.directories.output=$candidate")

    # Windows locks the packaged executable while it runs, so the running app
    # closes before the candidate replaces its package.
    Write-Step "Publishing the verified package"
    Invoke-Native -FilePath "node" -ArgumentList @($runtimeHelper, "stop", $appName)
    Invoke-Native -FilePath "node" -ArgumentList @($runtimeHelper, "publish-candidate", $outDir, $appName)

    Write-Step "Launching the packaged app"
    Invoke-Native -FilePath "node" -ArgumentList @($runtimeHelper, "launch-exe", $exePath, $appName)
}
catch {
    Write-Host ""
    Write-Host "bigmouth rebuild failed: $($_.Exception.Message)" -ForegroundColor Red
    $scriptExitCode = 1
}
finally {
    Read-Host "Press Enter to close" | Out-Null
}

exit $scriptExitCode
