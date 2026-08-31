[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = [IO.Path]::GetFullPath($RepositoryRoot)
$output = [IO.Path]::GetFullPath($OutputDirectory)
$files = @(
    'README.md',
    'capture-core.js',
    'capture-page.js',
    'icons/icon-128.png',
    'icons/icon-16.png',
    'icons/icon-32.png',
    'icons/icon-48.png',
    'manifest.json',
    'popup.css',
    'popup.html',
    'popup.js',
    'service-worker.js'
)

$resolved = foreach ($relative in $files) {
    $source = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $source.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Package entry escapes repository root: $relative"
    }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required package file is missing: $relative"
    }
    [pscustomobject]@{ Relative = $relative.Replace('\', '/'); Source = $source }
}

New-Item -ItemType Directory -Path $output -Force | Out-Null
$zipPath = Join-Path $output 'whole-page-capture.zip'
$checksumPath = "$zipPath.sha256"
foreach ($artifact in @($zipPath, $checksumPath)) {
    if (Test-Path -LiteralPath $artifact) {
        Remove-Item -LiteralPath $artifact -Force
    }
}

$stream = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew)
try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($item in $resolved) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                $item.Source,
                $item.Relative,
                [IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    }
    finally {
        $archive.Dispose()
    }
}
finally {
    $stream.Dispose()
}

$verification = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $actualEntries = @($verification.Entries.FullName | Sort-Object)
}
finally {
    $verification.Dispose()
}
$expectedEntries = @($files | ForEach-Object { $_.Replace('\', '/') } | Sort-Object)
if (Compare-Object -ReferenceObject $expectedEntries -DifferenceObject $actualEntries) {
    throw 'Packaged ZIP entries do not match the production allowlist.'
}

$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($checksumPath, "$hash  whole-page-capture.zip`n", $utf8)
Write-Output "Created $zipPath"
Write-Output "SHA-256 $hash"
