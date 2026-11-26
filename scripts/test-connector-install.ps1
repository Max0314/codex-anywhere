$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'connector-install-files.ps1')
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testRoot = Join-Path $workspace ('.codex-tmp/install-check-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
function Assert($Condition, $Message) { if(-not $Condition){throw $Message} }
function New-Payload($Version, $Text) {
    $root = Join-Path $testRoot ('staging/'+[Guid]::NewGuid().ToString('N'))
    foreach($path in @('runtime/node.exe','build/connector/index.js','scripts/connector-settings.ps1','release.pub')) {
        $file = Join-Path $root $path
        New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
        [IO.File]::WriteAllText($file,$Text)
    }
    [IO.File]::WriteAllText((Join-Path $root 'connector-release.json'),(@{version=$Version} | ConvertTo-Json))
    return $root
}
try {
    $state = Join-Path $testRoot 'preserved-user-state'
    New-Item -ItemType Directory -Path $state -Force | Out-Null
    foreach($name in @('connector.json','connector-device-key.dpapi','login-marker')){[IO.File]::WriteAllText((Join-Path $state $name),('keep-'+$name))}
    $before = @(Get-ChildItem -LiteralPath $state -File | Get-FileHash | Select-Object Path,Hash | ConvertTo-Json)
    $first = Install-ConnectorFiles (New-Payload '0.5.0-test.1' 'first') $testRoot
    Assert (Test-Path -LiteralPath $first.root) 'Fresh installation did not activate'
    Assert (-not $first.backup -and -not $first.old) 'Fresh installation fabricated a previous version'
    $repeat = Install-ConnectorFiles (New-Payload '0.5.0-test.1' 'repair') $testRoot
    Assert ($repeat.root -eq $first.root) 'Same-version repair changed canonical location'
    Assert ((Get-Content -LiteralPath (Join-Path $repeat.backup 'build/connector/index.js') -Raw) -eq 'first') 'Same-version repair lost rollback files'
    Assert ((Get-Content -LiteralPath (Join-Path $repeat.root 'build/connector/index.js') -Raw) -eq 'repair') 'Same-version repair failed'
    $upgrade = Install-ConnectorFiles (New-Payload '0.5.0-test.2' 'upgrade') $testRoot
    Assert ((Get-Content -LiteralPath $upgrade.pointer -Raw | ConvertFrom-Json).previous -eq $repeat.root) 'Cross-version update lost the previous pointer'
    Restore-ConnectorFiles $upgrade $testRoot
    Assert ((Get-Content -LiteralPath $upgrade.pointer -Raw | ConvertFrom-Json).current -eq $repeat.root) 'Failed update did not restore the previous pointer'
    Write-ConnectorPointer $upgrade.pointer @{current=$upgrade.root;previous=$repeat.root;pending=$true}
    $same = Install-ConnectorFiles $repeat.root $testRoot
    Assert ($same.root -eq $repeat.root -and -not $same.backup) 'Restoring an already installed version moved its files'
    Assert ((Get-Content -LiteralPath $upgrade.pointer -Raw | ConvertFrom-Json).current -eq $repeat.root) 'Restoring an installed version did not activate it'
    $after = @(Get-ChildItem -LiteralPath $state -File | Get-FileHash | Select-Object Path,Hash | ConvertTo-Json)
    Assert (($before -join '') -eq ($after -join '')) 'User identity/configuration changed'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'install-owner-connector.ps1'),[ref]$null,[ref]$null)
    $function = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-ConnectorCli'},$true)
    . ([scriptblock]::Create($function.Extent.Text))
    $encodingRoot = Join-Path $testRoot 'encoding-runtime'
    New-Item -ItemType Directory -Path (Join-Path $encodingRoot 'runtime'),(Join-Path $encodingRoot 'build/connector') -Force | Out-Null
    Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $encodingRoot 'runtime/node.exe')
    [IO.File]::WriteAllText((Join-Path $encodingRoot 'build/connector/owner-status.js'),'console.log(JSON.stringify({installRoot:"C:/Users/测试用户/Connector"}));',[Text.UTF8Encoding]::new($false))
    $status = Invoke-ConnectorCli $encodingRoot 'owner-status'
    Assert (($status.text | ConvertFrom-Json).installRoot -eq 'C:/Users/测试用户/Connector') 'UTF-8 status paths did not survive Windows PowerShell'
    Write-Output 'PASS: isolated first install, same-version repair, upgrade, rollback and preserved state'
} finally {
    $safe = Assert-ConnectorChildPath $testRoot (Join-Path $workspace '.codex-tmp')
    Remove-Item -LiteralPath $safe -Recurse -Force
}
