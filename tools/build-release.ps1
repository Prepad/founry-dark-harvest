param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputPath = Join-Path $projectRoot 'dist'
$manifestPath = Join-Path $projectRoot 'module.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

if ($manifest.id -notmatch '^[a-z0-9-]+$' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$') {
    throw 'Invalid module ID or version.'
}
if ($manifest.compatibility.minimum -ne '13' -or $manifest.compatibility.verified -ne '14' -or $manifest.socket -ne $true) {
    throw 'Expected v13/v14 compatibility and a module socket.'
}

$files = @(
    'module.json',
    'scripts/orel-death-aura.js',
    'templates/config.hbs',
    'README.md',
    'CHANGELOG.md',
    'COMPATIBILITY.md'
)
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $file) -PathType Leaf)) {
        throw "Missing release file: $file"
    }
}

& node --check (Join-Path $projectRoot 'scripts/orel-death-aura.js')
if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax check failed.' }
& node --test (Join-Path $projectRoot 'tests/orel-death-aura.test.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Regression tests failed.' }

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$archiveName = "$($manifest.id)-$($manifest.version).zip"
$archivePath = Join-Path $outputPath $archiveName
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$stream = [IO.File]::Open($archivePath, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
try {
    foreach ($file in $files) {
        $sourcePath = Join-Path $projectRoot $file
        $entryName = "$($manifest.id)/$file"
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $sourcePath, $entryName, [IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
} finally {
    $archive.Dispose()
    $stream.Dispose()
}

$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    if ($archive.Entries.Count -ne $files.Count) { throw 'Unexpected ZIP contents.' }
    foreach ($file in $files) {
        $entry = $archive.GetEntry("$($manifest.id)/$file")
        if ($null -eq $entry) { throw "Missing ZIP entry: $file" }
        $entryStream = $entry.Open()
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $entryHash = [BitConverter]::ToString($sha.ComputeHash($entryStream)).Replace('-', '')
        } finally {
            $sha.Dispose()
            $entryStream.Dispose()
        }
        $sourceHash = (Get-FileHash -LiteralPath (Join-Path $projectRoot $file) -Algorithm SHA256).Hash
        if ($entryHash -ne $sourceHash) { throw "ZIP entry differs from source: $file" }
    }
} finally {
    $archive.Dispose()
}

Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $outputPath 'module.json') -Force
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$archivePath.sha256", "$hash  $archiveName`n", [Text.Encoding]::ASCII)
Write-Output "Built: $archivePath"
Write-Output "SHA-256: $hash"
