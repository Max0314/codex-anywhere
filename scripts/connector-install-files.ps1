function Write-ConnectorPointer($Path, $Value) {
    [IO.File]::WriteAllText(($Path+'.tmp'),($Value | ConvertTo-Json),[Text.UTF8Encoding]::new($true))
    Move-Item -LiteralPath ($Path+'.tmp') -Destination $Path -Force
}

function Assert-ConnectorChildPath([string]$Path, [string]$Parent) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid Connector installation path' }
    return $resolved
}

function Install-ConnectorFiles([string]$Payload, [string]$InstallBase) {
    $metadata = Get-Content -LiteralPath (Join-Path $Payload 'connector-release.json') -Raw | ConvertFrom-Json
    if ($metadata.version -notmatch '^\d+\.\d+\.\d+[-.a-zA-Z0-9]*$') { throw 'Invalid Connector version' }
    foreach ($file in @('runtime/node.exe','build/connector/index.js','scripts/connector-settings.ps1','release.pub')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Payload $file) -PathType Leaf)) { throw ('安装文件不完整：'+$file) }
    }
    $versions = Join-Path $InstallBase 'versions'
    New-Item -ItemType Directory -Path $versions -Force | Out-Null
    $destination = Assert-ConnectorChildPath (Join-Path $versions $metadata.version) $versions
    $pointerPath = Join-Path $InstallBase 'current.json'
    $old = if(Test-Path -LiteralPath $pointerPath){ Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json }else{ $null }
    $previous = if($old){ Assert-ConnectorChildPath $old.current $versions }else{ '' }
    if([IO.Path]::GetFullPath($Payload) -eq $destination) {
        Write-ConnectorPointer $pointerPath @{current=$destination;previous=if($previous -eq $destination){$old.previous}else{$previous};pending=$true}
        return @{root=$destination;pointer=$pointerPath;old=$old;backup='';version=$metadata.version}
    }
    $Payload = Assert-ConnectorChildPath $Payload (Join-Path $InstallBase 'staging')
    $backup = ''
    if(Test-Path -LiteralPath $destination) {
        $backup = Assert-ConnectorChildPath ($destination+'.previous-'+[Guid]::NewGuid().ToString('N')) $versions
        Move-Item -LiteralPath $destination -Destination $backup
        if($previous -eq $destination){ $previous = $backup }
    }
    try {
        Move-Item -LiteralPath $Payload -Destination $destination
        Write-ConnectorPointer $pointerPath @{current=$destination;previous=$previous;pending=$true}
        return @{root=$destination;pointer=$pointerPath;old=$old;backup=$backup;version=$metadata.version}
    } catch {
        Restore-ConnectorFiles @{root=$destination;pointer=$pointerPath;old=$old;backup=$backup} $InstallBase
        throw
    }
}

function Restore-ConnectorFiles($Transaction, [string]$InstallBase) {
    $versions = Join-Path $InstallBase 'versions'
    $destination = Assert-ConnectorChildPath $Transaction.root $versions
    if($Transaction.backup) {
        $backup = Assert-ConnectorChildPath $Transaction.backup $versions
        if(Test-Path -LiteralPath $destination) {
            $failed = Assert-ConnectorChildPath ($destination+'.failed-'+[Guid]::NewGuid().ToString('N')) $versions
            Move-Item -LiteralPath $destination -Destination $failed
        }
        Move-Item -LiteralPath $backup -Destination $destination
    }
    if($Transaction.old){ Write-ConnectorPointer $Transaction.pointer $Transaction.old }
    elseif(Test-Path -LiteralPath $Transaction.pointer){ Remove-Item -LiteralPath $Transaction.pointer -Force }
}
