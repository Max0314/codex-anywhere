$ErrorActionPreference = 'Stop'
$installBase = Join-Path $env:LOCALAPPDATA 'Fribench/CodexConnector'
$pointerPath = Join-Path $installBase 'current.json'
$pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
$appRoot = [IO.Path]::GetFullPath($pointer.current)
$versionsBase = [IO.Path]::GetFullPath((Join-Path $installBase 'versions')) + [IO.Path]::DirectorySeparatorChar
if(-not $appRoot.StartsWith($versionsBase,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid installed version path'}
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$settingsScript = Join-Path $appRoot 'scripts/connector-settings.ps1'
$process = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$settingsScript+'"'),'-Background') -WindowStyle Hidden -PassThru
if($pointer.pending){
    $healthy = $false
    for($attempt=0;$attempt -lt 30;$attempt++){
        Start-Sleep -Seconds 1
        $process.Refresh()
        if($process.HasExited){break}
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = Join-Path $appRoot 'runtime/node.exe'
        $info.Arguments = '"'+(Join-Path $appRoot 'build/connector/owner-status.js')+'"'
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
        $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
        $probe = [Diagnostics.Process]::Start($info)
        $status = $probe.StandardOutput.ReadToEndAsync()
        $errors = $probe.StandardError.ReadToEndAsync()
        $probe.WaitForExit()
        $code = $probe.ExitCode
        $probe.Dispose()
        if($code -eq 0){
            $observed=$status.Result | ConvertFrom-Json
            $expected=Get-Content -LiteralPath (Join-Path $appRoot 'connector-release.json') -Raw | ConvertFrom-Json
            if($observed.version -eq $expected.version -and ($observed.installRoot -eq $appRoot -or ([int]$expected.releaseSeq -lt 3 -and -not $observed.installRoot))){$healthy=$true;break}
        }
    }
    if($healthy){
        $pointer.pending=$false
        $pointer | ConvertTo-Json | Set-Content -LiteralPath ($pointerPath+'.tmp') -Encoding UTF8
        Move-Item -LiteralPath ($pointerPath+'.tmp') -Destination $pointerPath -Force
    } elseif($pointer.previous -and (Test-Path -LiteralPath (Join-Path $pointer.previous 'scripts/connector-settings.ps1'))){
        $process.Refresh()
        if(-not $process.HasExited){ Stop-Process -Id $process.Id -Force }
        $compiled = [IO.Path]::GetFullPath((Join-Path $appRoot 'build/connector/index.js'))
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($compiled,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        $pointer.current=$pointer.previous
        $pointer.pending=$false
        $pointer | ConvertTo-Json | Set-Content -LiteralPath ($pointerPath+'.tmp') -Encoding UTF8
        Move-Item -LiteralPath ($pointerPath+'.tmp') -Destination $pointerPath -Force
        & $powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
        exit $LASTEXITCODE
    }
}
$process.WaitForExit()
exit $process.ExitCode
