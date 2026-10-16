#Requires -Version 5.1
# Builds every distributable from the current working tree, one after another:
#   1. Windows x64 portable app and zip     (scripts/Package-Windows.ps1 -> dist\windows)
#   2. Linux amd64 .deb and .tar.gz         (scripts/Package-Linux.ps1   -> dist\linux)
#   3. Linux arm64 .deb and .tar.gz         (scripts/Package-Linux.ps1 -Arm64)
# The Linux builds run in the WSL build distro described in docs/LINUX.md; arm64
# also needs its cross image (setup-build-env.sh --arm64). Stops at the first
# failure and names the stage.
#   npm run package:all
#   npm run package:all -- -SkipChecks          # skip the test suites in every stage
#   npm run package:all -- -SkipArm64           # Windows and Linux amd64 only
#   npm run package:all -- -SkipLinux           # Windows only
[CmdletBinding()]
param(
    [switch]$SkipChecks,
    [switch]$SkipLinux,
    [switch]$SkipArm64,
    [switch]$NoZip,
    [switch]$PrepareDependencies,
    [string]$Distro = 'Ubuntu-22.04'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows: it builds the Windows package and drives WSL for the Linux packages.' }

$stages = New-Object System.Collections.Generic.List[object]
$stages.Add([pscustomobject]@{ Name = 'Windows x64'; Script = 'Package-Windows.ps1'; Arguments = @{ SkipChecks = $SkipChecks; NoZip = $NoZip; PrepareDependencies = $PrepareDependencies } })
if (-not $SkipLinux) {
    $stages.Add([pscustomobject]@{ Name = 'Linux amd64'; Script = 'Package-Linux.ps1'; Arguments = @{ Distro = $Distro; SkipChecks = $SkipChecks } })
    if (-not $SkipArm64) { $stages.Add([pscustomobject]@{ Name = 'Linux arm64'; Script = 'Package-Linux.ps1'; Arguments = @{ Distro = $Distro; SkipChecks = $SkipChecks; Arm64 = $true } }) }
}

function Get-Newest([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    Get-ChildItem -LiteralPath $Path -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

if (-not $SkipLinux) {
    # Fail before the long Windows build when the Linux build machine is missing.
    $distros = (& wsl.exe --list --quiet 2>$null) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    if ($distros -notcontains $Distro) { throw "WSL distro '$Distro' was not found. Set it up as docs/LINUX.md describes, pass -Distro, or use -SkipLinux." }
}

$results = New-Object System.Collections.Generic.List[object]
$total = [Diagnostics.Stopwatch]::StartNew()
foreach ($stage in $stages) {
    Write-Host ''
    Write-Host "=== $($stage.Name) ===" -ForegroundColor Cyan
    $arguments = @{}
    foreach ($key in $stage.Arguments.Keys) {
        $value = $stage.Arguments[$key]
        if ($value -is [switch] -or $value -is [bool]) { if ($value) { $arguments[$key] = $true } } else { $arguments[$key] = $value }
    }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        & (Join-Path $PSScriptRoot $stage.Script) @arguments
    } catch {
        Write-Host ''
        Write-Host "$($stage.Name) failed after $([int]$clock.Elapsed.TotalMinutes) min: $($_.Exception.Message)" -ForegroundColor Red
        foreach ($done in $results) { Write-Host "  Finished earlier: $($done.Name) ($($done.Minutes) min)" }
        throw
    }
    $results.Add([pscustomobject]@{ Name = $stage.Name; Minutes = [math]::Round($clock.Elapsed.TotalMinutes, 1) })
}

Write-Host ''
Write-Host "=== All packages built in $([math]::Round($total.Elapsed.TotalMinutes, 1)) min ===" -ForegroundColor Green
foreach ($result in $results) { Write-Host "  $($result.Name): $($result.Minutes) min" }
$windows = Get-Newest (Join-Path $projectRoot 'dist\windows')
if ($windows) { Write-Host "  Windows: $($windows.FullName)" }
if (-not $SkipLinux) {
    $linux = Get-Newest (Join-Path $projectRoot 'dist\linux')
    if ($linux) { Write-Host "  Linux:   $($linux.FullName)" }
}
