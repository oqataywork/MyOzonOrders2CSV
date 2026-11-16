$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$distRoot = Join-Path $repoRoot 'dist'
$extensionRoot = Join-Path $distRoot 'OzonMyOrders2csv'
$files = @('manifest.json', 'security.js', 'navigation.js', 'ui-model.js', 'background.js', 'content.js',
    'return-tools.js', 'popup.js', 'popup.html', 'popup.css',
    'README.md', 'README.txt', 'SECURITY-REVIEW.md')
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repoRoot 'manifest.json') | ConvertFrom-Json
$version = $manifest.version_name
if ($version -notmatch '^\d+\.\d+\.\d+(?:-security\.\d+)?$') { throw 'Unexpected release version' }

New-Item -ItemType Directory -Path $extensionRoot -Force | Out-Null
# Refuse to package stray files or user data from an existing output directory.
foreach ($entry in Get-ChildItem -Force -LiteralPath $extensionRoot) {
    if ($entry.PSIsContainer -or $entry.Name -notin $files) {
        throw "Unexpected file in package directory: $($entry.Name)"
    }
}
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $extensionRoot $file) -Force
}
$archivePath = Join-Path $distRoot "OzonMyOrders2csv_$version.zip"
Compress-Archive -LiteralPath @($files | ForEach-Object { Join-Path $extensionRoot $_ }) -DestinationPath $archivePath -Force
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
$checksumPath = "$archivePath.sha256"
[IO.File]::WriteAllText($checksumPath, "$hash  $([IO.Path]::GetFileName($archivePath))`n", [Text.UTF8Encoding]::new($false))
Write-Output "Unpacked extension: $extensionRoot"
Write-Output "Archive: $archivePath"
Write-Output "SHA-256: $hash"
