function Start-ConnectorRuntime([string]$InstallBase) {
    $task = Get-ScheduledTask -TaskName 'Codex Anywhere Connector' -ErrorAction SilentlyContinue
    if($task) {
        try { Start-ScheduledTask -TaskName 'Codex Anywhere Connector' -ErrorAction Stop; return } catch { }
    }
    $fallback = Join-Path $InstallBase 'startup.vbs'
    if(Test-Path -LiteralPath $fallback) {
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/wscript.exe') -ArgumentList ('"'+$fallback+'"') -WindowStyle Hidden
    } else {
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -ArgumentList @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $InstallBase 'launch.ps1')+'"')) -WindowStyle Hidden
    }
}
