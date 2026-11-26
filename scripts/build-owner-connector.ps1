[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$ReleasePublicKey,
    [Parameter(Mandatory)][string]$MakeNsis,
    [string]$Version='0.5.0-fribench.1',
    [int]$ReleaseSequence=1
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$output=[IO.Path]::GetFullPath($OutputDirectory)
if($output.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Use a build directory outside the source checkout'}
$package=Join-Path $output 'package'
New-Item -ItemType Directory -Path $package -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'package.json'),(Join-Path $root 'package-lock.json') -Destination $package
& npm.cmd ci --omit=dev --no-audit --prefix $package
if($LASTEXITCODE -ne 0){throw 'Production dependency preparation failed'}
Push-Location $root
try { & npm.cmd run build:node; if($LASTEXITCODE -ne 0){throw 'Connector compilation failed'}; $sha=(& git rev-parse HEAD).Trim() } finally {Pop-Location}
Copy-Item -LiteralPath (Join-Path $root 'build') -Destination $package -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $package
New-Item -ItemType Directory -Path (Join-Path $package 'runtime'),(Join-Path $package 'scripts') -Force | Out-Null
Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $package 'runtime/node.exe')
foreach($name in @('connector-settings.ps1','connector-supervisor.ps1','install-owner-connector.ps1')){
    $text=[IO.File]::ReadAllText((Join-Path $PSScriptRoot $name))
    [IO.File]::WriteAllText((Join-Path $package ('scripts/'+$name)),$text,[Text.UTF8Encoding]::new($true))
}
Copy-Item -LiteralPath $ReleasePublicKey -Destination (Join-Path $package 'release.pub')
$metadata=@{version=$Version;releaseSeq=$ReleaseSequence;sourceSha=$sha;protocol=5}|ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $package 'connector-release.json'),$metadata,[Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'connector.nsi') -Destination $output
Push-Location $output
try { & $MakeNsis ('/DVERSION='+$Version) 'connector.nsi'; if($LASTEXITCODE -ne 0){throw 'NSIS compilation failed'} } finally {Pop-Location}
Get-Item -LiteralPath (Join-Path $output 'Fribench-Codex-Connector-x64.exe') | Select-Object FullName,Length
