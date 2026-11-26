[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$ReleasePublicKey,
    [Parameter(Mandatory)][string]$MakeNsis,
    [string]$Version='0.5.0-fribench.4',
    [int]$ReleaseSequence=4,
    [string]$SignTool,
    [string]$SigningCertificateThumbprint,
    [string]$TimestampUrl='http://timestamp.digicert.com'
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$output=[IO.Path]::GetFullPath($OutputDirectory)
if($output.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Use a build directory outside the source checkout'}
$package=Join-Path $output 'package'
New-Item -ItemType Directory -Path $package -Force | Out-Null
if(Test-Path -LiteralPath (Join-Path $package 'build')){throw 'Use a new output directory for each package build'}
Push-Location $root
try { & node scripts/bundle-owner-connector.mjs $package; if($LASTEXITCODE -ne 0){throw 'Connector bundling failed'}; $sha=(& git rev-parse HEAD).Trim() } finally {Pop-Location}
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $package
New-Item -ItemType Directory -Path (Join-Path $package 'runtime'),(Join-Path $package 'scripts') -Force | Out-Null
Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $package 'runtime/node.exe')
foreach($name in @('connector-settings.ps1','connector-supervisor.ps1','install-owner-connector.ps1','connector-install-files.ps1','connector-start.ps1')){
    $text=[IO.File]::ReadAllText((Join-Path $PSScriptRoot $name))
    [IO.File]::WriteAllText((Join-Path $package ('scripts/'+$name)),$text,[Text.UTF8Encoding]::new($true))
}
Copy-Item -LiteralPath $ReleasePublicKey -Destination (Join-Path $package 'release.pub')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'assets/connector.ico') -Destination $package
$metadata=@{version=$Version;releaseSeq=$ReleaseSequence;sourceSha=$sha;protocol=5}|ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $package 'connector-release.json'),$metadata,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $output 'connector.nsi'),[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'connector.nsi')),[Text.UTF8Encoding]::new($true))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'assets') -Destination $output -Recurse
Push-Location $output
try { & $MakeNsis ('/DVERSION='+$Version) 'connector.nsi'; if($LASTEXITCODE -ne 0){throw 'NSIS compilation failed'} } finally {Pop-Location}
if($SigningCertificateThumbprint){
    if(-not $SignTool){throw 'Provide SignTool when selecting a signing certificate'}
    & $SignTool sign /sha1 $SigningCertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 (Join-Path $output 'Fribench-Codex-Connector-x64.exe')
    if($LASTEXITCODE -ne 0){throw 'Authenticode signing failed'}
}
Get-Item -LiteralPath (Join-Path $output 'Fribench-Codex-Connector-x64.exe') | Select-Object FullName,Length
