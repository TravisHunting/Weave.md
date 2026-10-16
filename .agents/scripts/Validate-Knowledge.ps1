[CmdletBinding()]
param(
    [Parameter(Position=0)][string[]]$Path = @(),
    [string]$KnowledgeRoot
)
# Standalone Weave Markdown link and OKF frontmatter check; PowerShell 5.1+, no modules.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if (-not $KnowledgeRoot) {
    $KnowledgeRoot = Join-Path $repo 'knowledge'
    if (-not (Test-Path -LiteralPath $KnowledgeRoot -PathType Container)) { $KnowledgeRoot = Join-Path $repo 'knowledge-example' }
}
$root = (Get-Item -LiteralPath $KnowledgeRoot).FullName.TrimEnd('\','/')
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "Knowledge root is not a folder: $root" }
$prefix = $root + [IO.Path]::DirectorySeparatorChar
$issues = New-Object 'System.Collections.Generic.List[string]'
function Issue($file, $line, $message) { $issues.Add(('{0}:{1}: {2}' -f $file,$line,$message)) }
function JoinPath($base, $relative) {
    $parts = New-Object 'System.Collections.Generic.List[string]'
    if ($base) { foreach ($part in $base.Split('/')) { $parts.Add($part) } }
    foreach ($part in $relative.Split('/')) {
        if ($part -eq '..') { if ($parts.Count -eq 0) { return $null }; $parts.RemoveAt($parts.Count - 1) }
        elseif ($part -and $part -ne '.') { $parts.Add($part) }
    }
    return ($parts -join '/')
}
function MarkdownFiles($folder) {
    foreach ($item in Get-ChildItem -LiteralPath $folder -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        if ($item.PSIsContainer) {
            if ($item.Name -notin @('.weave','.git','.agents','.codex','node_modules')) { MarkdownFiles $item.FullName }
        } elseif ($item.Extension -ieq '.md') { $item }
    }
}
$files = @(MarkdownFiles $root)
$targets = @{}
foreach ($file in $files) { $targets[$file.FullName.Substring($prefix.Length).Replace('\','/')] = $true }
$selected = @{}
if ($Path.Count) {
    foreach ($requested in $Path) {
        $item = Get-Item -LiteralPath $requested
        if ($item.FullName -ne $root -and -not $item.FullName.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw "Path is outside knowledge root: $requested" }
        if ($item.PSIsContainer) { foreach ($file in (MarkdownFiles $item.FullName)) { $selected[$file.FullName] = $true } }
        elseif ($item.Extension -ieq '.md') { $selected[$item.FullName] = $true }
        else { throw "Not a Markdown article: $requested" }
    }
} else { foreach ($file in $files) { $selected[$file.FullName] = $true } }
$linkCount = 0
foreach ($file in $files) {
    if (-not $selected.ContainsKey($file.FullName)) { continue }
    $name = $file.FullName.Substring($prefix.Length).Replace('\','/')
    $text = [IO.File]::ReadAllText($file.FullName) -replace '\r\n?', [char]10
    # Mask comments while preserving line numbers.
    $text = [regex]::Replace($text, '(?s)<!--.*?(?:-->|$)', { param($m) [regex]::Replace($m.Value,'[^\n]',' ') })
    # OKF frontmatter: a leading --- block whose YAML needs a non-empty type.
    $text = $text.TrimStart([char]0xFEFF)
    $rows = $text -split '\n'; $frontmatterEnd = 0
    if ($rows[0] -match '^---\s*$') {
        for ($k = 1; $k -lt $rows.Count; $k++) { if ($rows[$k] -match '^(---|\.\.\.)\s*$') { $frontmatterEnd = $k + 1; break } }
        if (-not $frontmatterEnd) { Issue $name 1 'Unclosed YAML frontmatter; close it with --- on its own line.'; $frontmatterEnd = $rows.Count }
        elseif ($frontmatterEnd -le 2 -or -not @($rows[1..($frontmatterEnd - 2)] | Where-Object { $_ -match '^type:[ \t]*[^\s#]' }).Count) { Issue $name 1 'OKF frontmatter requires a non-empty type field.' }
    }
    $fence = ''; $fenceLine = 0; $inline = 0; $lineNumber = 0
    foreach ($row in $rows) {
        $lineNumber++
        if ($lineNumber -le $frontmatterEnd) { continue }
        if ($row -match ('^ {0,3}(' + [char]96 + '{3,}|~{3,})(.*)$')) {
            $marker = $Matches[1]; $tail = $Matches[2]
            if (-not $fence) { $fence = $marker; $fenceLine = $lineNumber; $inline = 0; continue }
            if ($marker[0] -eq $fence[0] -and $marker.Length -ge $fence.Length -and -not $tail.Trim()) { $fence = ''; continue }
        }
        if ($fence -or $row -match '^( {4}|\t)') { continue }
        # Ignore escaped characters and inline code using matching backtick runs.
        $chars = $row.ToCharArray()
        for ($i = 0; $i -lt $row.Length; $i++) {
            if ($row[$i] -eq '\' -and $inline -eq 0) { $chars[$i] = ' '; if ($i+1 -lt $row.Length) { $i++; $chars[$i] = ' ' }; continue }
            if ($row[$i] -eq [char]96) {
                $end = $i + 1
                while ($end -lt $row.Length -and $row[$end] -eq [char]96) { $end++ }
                $length = $end - $i
                if ($inline -eq 0) { $inline = $length } elseif ($inline -eq $length) { $inline = 0 }
                for ($j=$i; $j -lt $end; $j++) { $chars[$j] = ' ' }
                $i = $end - 1; continue
            }
            if ($inline -gt 0) { $chars[$i] = ' ' }
        }
        $clean = -join $chars
        if ($clean.Contains('[[')) { Issue $name $lineNumber 'Wiki links are not supported; use [Label](./relative/article.md "relationship").' }
        foreach ($link in [regex]::Matches($clean, '(?<!!)\[([^\[\]]*)\]\(([^()]*)\)')) {
            $destination = $link.Groups[2].Value.Trim(); $title = ''
            if ($destination -match '\s+("([^"]*)"|''([^'']*)'')$') { $title = $Matches[2] + $Matches[3]; $destination = $destination.Substring(0, $destination.Length - $Matches[0].Length).Trim() }
            if ($destination -match '^<(.*)>$') { $destination = $Matches[1] }
            $target = ($destination -split '[?#]')[0]
            try { $target = [Uri]::UnescapeDataString($target) } catch {}
            # External URLs and non-Markdown files are ordinary links, not graph edges.
            if ($destination -match '^[A-Za-z][A-Za-z0-9+.-]*:' -or $destination.StartsWith('//') -or $target -notmatch '\.md$') { continue }
            $linkCount++; $target = $target.Replace('\','/')
            $folder = if ($name.Contains('/')) { $name.Substring(0, $name.LastIndexOf('/')) } else { '' }
            # OKF links: /path is bundle-relative; other paths are relative to this article.
            # Write ./ or ../ paths; a bare path that only resolves from the root is flagged.
            if ($target -match '[:\x00-\x1f]') { $options = @() }
            elseif ($target.StartsWith('/')) { $options = @(JoinPath '' $target.TrimStart('/')) }
            else { $options = @(JoinPath $folder $target) }
            $options = @($options | Where-Object { $_ })
            if (-not $options.Count) { Issue $name $lineNumber "Invalid link target outside the workspace: $target" }
            elseif (-not @($options | Where-Object { $targets.ContainsKey($_) }).Count) {
                if ($target -notmatch '^\.\.?/' -and $targets.ContainsKey((JoinPath '' $target))) { Issue $name $lineNumber "Write a path relative to this article (./ or ../): $target" }
                else { Issue $name $lineNumber "Missing target: $target" }
            }
            if ($title -and $title -notmatch '^\s*[\p{L}\p{N}][\p{L}\p{N}_-]*\s*$' -and $title -match '^\s*\S+\s*$') { Issue $name $lineNumber "A relationship title uses letters/numbers, hyphens or underscores: $title" }
            $suffix = $clean.Substring($link.Index + $link.Length)
            if ($suffix -match '^\s*@@') { Issue $name $lineNumber 'Unsupported @@relationship suffix; put the relationship in the link title: [Label](./article.md "relationship").' }
        }
        if ($clean -match '(?<!!)\[[^\[\]]*\]\([^()]*$') { Issue $name $lineNumber 'Unclosed Markdown link; use [Label](./relative/article.md "relationship").' }
    }
    if ($fence) { Issue $name $fenceLine 'Unclosed Markdown code fence.' }
}
if ($issues.Count) {
    foreach ($issue in $issues) { Write-Output $issue }
    Write-Output ("{0} syntax issue(s)." -f $issues.Count)
    exit 1
}
Write-Output ("{0} articles, {1} filepath links: syntax valid" -f $selected.Count,$linkCount)
