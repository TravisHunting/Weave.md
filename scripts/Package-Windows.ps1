#Requires -Version 5.1
[CmdletBinding()]
# -QuickChecks swaps the full checks for the abridged ones used by Build-Debug.ps1 -Quick
# (test:quick, then verify-native.mjs --quick on the packaged Weave.exe): for trial
# releases during development, not for distribution.
param([switch]$PrepareDependencies, [switch]$SkipChecks, [switch]$QuickChecks, [switch]$NoZip)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($SkipChecks -and $QuickChecks) { throw 'Pass either -SkipChecks or -QuickChecks, not both.' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE." }
}
if ($env:OS -ne 'Windows_NT') { throw 'Windows x64 is required for this portable build.' }
Push-Location $projectRoot
try {
    if ($PrepareDependencies) {
        Invoke-Checked 'npm.cmd' @('ci', '--no-audit', '--no-fund')
        Invoke-Checked 'cargo' @('fetch', '--manifest-path', 'src-tauri/Cargo.toml', '--locked')
    }
    # The final runtime smoke drives Weave.exe through Playwright, a pinned
    # devDependency. Check for it now rather than failing after the release build.
    if (-not $SkipChecks) {
        & node --input-type=module -e "import {pathToFileURL} from 'node:url'; await import(process.env.WEAVE_PLAYWRIGHT ? pathToFileURL(process.env.WEAVE_PLAYWRIGHT).href : 'playwright');" 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Playwright is missing from node_modules. Run npm ci (or pass -PrepareDependencies), or -SkipChecks to skip tests and the runtime smoke.' }
    }
    Invoke-Checked 'npm.cmd' @('run', 'build')
    Invoke-Checked 'npm.cmd' @('run', 'build:desktop')
    Invoke-Checked 'npm.cmd' @('run', 'prepare:runtime')
    if (-not $SkipChecks) {
        if ($QuickChecks) { Invoke-Checked 'npm.cmd' @('run', 'test:quick') } else {
            Invoke-Checked 'npm.cmd' @('test')
            Invoke-Checked 'cargo' @('test', '--offline', '--locked', '--manifest-path', 'src-tauri/Cargo.toml')
        }
    }
    Invoke-Checked 'cargo' @('build', '--bin', 'weave', '--release', '--offline', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'custom-protocol')
    $version = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
    $suffix = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6)
    $output = Join-Path $projectRoot "dist\windows\Weave-$version-win-x64-$suffix"
    New-Item -ItemType Directory -Path $output | Out-Null
    $targetRoot = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $projectRoot 'src-tauri\target' }
    Copy-Item -LiteralPath (Join-Path $targetRoot 'release\weave.exe') -Destination (Join-Path $output 'Weave.exe')
    # Weave Lite, freshly built above by npm run build, ships beside Weave.exe.
    if (-not (Test-Path -LiteralPath 'weave_lite.html')) { throw 'npm run build did not produce weave_lite.html.' }
    Copy-Item -LiteralPath 'weave_lite.html' -Destination (Join-Path $output 'weave_lite.html')
    Copy-Item -LiteralPath 'README.md' -Destination (Join-Path $output 'README.md')
    # Licences of third-party data embedded in Weave.exe (spell-check dictionaries and nspell).
    $notices = foreach ($package in 'nspell', 'dictionary-en', 'dictionary-en-gb') { "===== $package =====`r`n" + (Get-Content -LiteralPath (Join-Path 'node_modules' (Join-Path $package 'license')) -Raw) }
    $notices -join "`r`n`r`n" | Set-Content -LiteralPath (Join-Path $output 'THIRD-PARTY-NOTICES.txt') -Encoding UTF8
    # Historical documents stay in the repository only.
    New-Item -ItemType Directory -Path (Join-Path $output 'docs') | Out-Null
    Copy-Item -LiteralPath 'docs\WEAVE_ARCHITECTURE.md' -Destination (Join-Path $output 'docs\WEAVE_ARCHITECTURE.md')
    Copy-Item -LiteralPath 'docs\PERFORMANCE.md' -Destination (Join-Path $output 'docs\PERFORMANCE.md')
    if ($QuickChecks) { Invoke-Checked 'node' @('app/weave/verify-native.mjs', (Join-Path $output 'Weave.exe'), '--quick') }
    elseif (-not $SkipChecks) { Invoke-Checked 'node' @('app/weave/tests/runtime-smoke.mjs', (Join-Path $output 'Weave.exe')) }
    @"
Weave for Windows x64
Run Weave.exe. No resources or Node runtime folder is required.
Open a Markdown workspace using Open workspace. No folder opens automatically.
Application data defaults to %LOCALAPPDATA%\Weave\.weave. Change its location in Settings; the full folder moves on the next launch.
Search uses chunk-based SQLite FTS5/BM25. No models or downloads are used.
Rust and SQLite are embedded in the executable. Git is installed separately.
Microsoft Edge WebView2 Runtime is required. This portable build is unsigned.
weave_lite.html is Weave Lite: open it in a web browser and choose a Markdown folder to read it, with nothing installed.
See README.md for an overview; docs/USER_GUIDE.md in the source repository covers recovery and first-run details, and scripts/README.md development.
"@ | Set-Content -LiteralPath (Join-Path $output 'START-HERE.txt') -Encoding UTF8
    if (-not $NoZip) { Compress-Archive -LiteralPath $output -DestinationPath "$output.zip"; Write-Host "Distribution zip: $output.zip" }
    Write-Host "Portable app: $output"
} finally { Pop-Location }
