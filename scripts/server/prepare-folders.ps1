<#
.SYNOPSIS
Prepares Windows folders for Weave Server in Docker Desktop and writes
compose.override.yaml so the container uses them instead of named volumes.

.DESCRIPTION
Defaults to .\weave\workspaces and .\weave\data beside compose.yaml. Each
direct child folder of the workspaces folder becomes a workspace; pass
-Workspaces to use an existing library. Keep the data folder private: it holds
accounts, indexes and Git deploy keys. Docker Desktop maps ownership for the
container's user (UID 10001), so no permission changes are needed.

.EXAMPLE
.\scripts\server\prepare-folders.ps1
.\scripts\server\prepare-folders.ps1 -Workspaces D:\Notes -Data D:\WeaveData
#>
param(
    [string]$Workspaces,
    [string]$Data,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Workspaces) { $Workspaces = Join-Path $root 'weave\workspaces' }
if (-not $Data) { $Data = Join-Path $root 'weave\data' }
foreach ($folder in @($Workspaces, $Data)) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
$Workspaces = (Resolve-Path $Workspaces).Path.TrimEnd('\')
$Data = (Resolve-Path $Data).Path.TrimEnd('\')
if (($Data + '\').StartsWith($Workspaces + '\', [StringComparison]::OrdinalIgnoreCase) -or ($Workspaces + '\').StartsWith($Data + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The workspaces and data folders must be separate, not inside one another.'
}

$override = Join-Path $root 'compose.override.yaml'
$yaml = @"
# Written by scripts/server/prepare-folders.ps1: host folders replace the named volumes.
services:
  weave:
    volumes: !override
      - "$($Workspaces -replace '\\', '/'):/workspaces"
      - "$($Data -replace '\\', '/'):/data"
"@
if ((Test-Path $override) -and -not $Force) {
    Write-Host "$override already exists; left unchanged (use -Force to replace it)."
} else {
    [IO.File]::WriteAllText($override, $yaml.Replace("`r`n", "`n") + "`n")
    Write-Host "Wrote $override"
}
$port = if ($env:WEAVE_PORT) { $env:WEAVE_PORT } else { '8765' }
Write-Host @"

Folders ready:
  workspaces  $Workspaces   (each direct child folder is a workspace)
  data        $Data   (private: accounts, indexes, Git deploy keys)

Start Weave:   docker compose up -d --build
Then open http://localhost:$port and create the administrator account.
"@
