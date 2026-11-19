$ErrorActionPreference = 'Stop'
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$metadata = Join-Path $env:WINDIR 'System32/WinMetadata'
$root = Split-Path $PSScriptRoot -Parent
$references = @(
    (Join-Path $framework 'System.Runtime.dll')
    (Join-Path $metadata 'Windows.Foundation.winmd')
    (Join-Path $metadata 'Windows.Media.winmd')
    (Join-Path $metadata 'Windows.Graphics.winmd')
    (Join-Path $metadata 'Windows.Storage.winmd')
)
$options = @('/nologo', '/target:exe', '/optimize+', '/platform:anycpu')
$options += $references | ForEach-Object { "/reference:$_" }
$options += "/out:$(Join-Path $root 'lib/windows-camera.exe')"
$options += Join-Path $root 'src/windows-camera.cs'
& (Join-Path $framework 'csc.exe') @options
exit $LASTEXITCODE
