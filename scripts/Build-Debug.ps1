#Requires -Version 5.1
[CmdletBinding()]
# -Quick adds about 25 seconds of checks for constant development: the quick unit
# tests before the Rust build, then one short native smoke of the new executable.
# It skips Git workflows, the Rust test host and the browser suites; run those
# (npm test, cargo test, test:* scripts) before relying on a change.
param([switch]$Quick)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE." }
}

Push-Location $projectRoot
try {
    Invoke-Checked 'npm.cmd' @('run', 'build:desktop')
    Invoke-Checked 'npm.cmd' @('run', 'prepare:runtime')
    if ($Quick) { Invoke-Checked 'npm.cmd' @('run', 'test:quick') }
    Invoke-Checked 'cargo' @('build', '--bin', 'weave', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'custom-protocol')

    $targetRoot = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $projectRoot 'src-tauri\target' }
    $executable = Join-Path $targetRoot 'debug\weave.exe'
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Debug executable was not found: $executable" }
    if ($Quick) { Invoke-Checked 'node' @('app/weave/verify-native.mjs', $executable, '--quick') }
    Write-Host "Debug build ready: $executable"
} finally {
    Pop-Location
}
