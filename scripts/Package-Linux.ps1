#Requires -Version 5.1
# Builds the Linux packages from Windows by running scripts/linux/package-linux.sh
# in the WSL build distro (see docs/LINUX.md). Packages land in dist\linux.
#   npm run package:linux
#   npm run package:linux -- -Commit v1.0.0 -VerifyReproducible
[CmdletBinding()]
param([string]$Distro = 'Ubuntu-22.04', [string]$Commit, [switch]$SkipChecks, [switch]$VerifyReproducible, [switch]$Arm64)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($projectRoot -notmatch '^([A-Za-z]):\\(.*)$') { throw "The repository must be on a local drive for WSL to reach it: $projectRoot" }
$linuxRoot = '/mnt/' + $Matches[1].ToLower() + '/' + ($Matches[2] -replace '\\', '/')
$arguments = @('-d', $Distro, '--', 'bash', "$linuxRoot/scripts/linux/package-linux.sh", '--repo', $linuxRoot)
if ($Commit) { $arguments += @('--commit', $Commit) }
if ($SkipChecks) { $arguments += '--skip-checks' }
if ($VerifyReproducible) { $arguments += '--verify-reproducible' }
if ($Arm64) { $arguments += @('--arch', 'arm64') }
& wsl.exe @arguments
if ($LASTEXITCODE -ne 0) { throw "Linux packaging failed with exit code $LASTEXITCODE." }
