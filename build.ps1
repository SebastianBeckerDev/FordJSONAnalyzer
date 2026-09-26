param(
    [string]$OutputPath = (Join-Path $PSScriptRoot 'index.html')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$replacements = [ordered]@{
    '__APP_CSS__' = 'app.css'
    '__MAP_CSS__' = 'map.css'
    '__FIELD_DEFS__' = 'field-defs.json'
    '__GEOGRAPHY__' = 'geography.json'
    '__ENGINE_JS__' = 'engine.js'
    '__MAP_JS__' = 'map.js'
    '__APP_JS__' = 'app.js'
}

$templatePath = Join-Path $PSScriptRoot 'index.template.html'
$encoding = [System.Text.UTF8Encoding]::new($false)
$page = [System.IO.File]::ReadAllText($templatePath, $encoding)

foreach ($entry in $replacements.GetEnumerator()) {
    $token = [string]$entry.Key
    $sourcePath = Join-Path $PSScriptRoot ([string]$entry.Value)
    $content = [System.IO.File]::ReadAllText($sourcePath, $encoding).TrimEnd()
    if ($page.Split(@($token), [System.StringSplitOptions]::None).Length -ne 2) {
        throw "Expected exactly one $token placeholder in index.template.html."
    }
    if ($token -in @('__ENGINE_JS__', '__MAP_JS__', '__APP_JS__') -and
        $content.IndexOf('</script', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw "$($entry.Value) contains a script closing sequence that cannot be inlined safely."
    }
    if ($token -in @('__FIELD_DEFS__', '__GEOGRAPHY__')) {
        $content = $content.Replace('<', '\u003c')
    }
    $page = $page.Replace($token, $content)
}

[System.IO.File]::WriteAllText($OutputPath, $page, $encoding)
Write-Output "Built $OutputPath"
