[CmdletBinding()]
param([switch]$NoStart)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'connector-settings.ps1'
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$installBase = Join-Path $env:LOCALAPPDATA 'Fribench/CodexConnector'
New-Item -ItemType Directory -Path $installBase -Force | Out-Null
$mutex = New-Object Threading.Mutex($false,'Local\Fribench-Codex-Installer')
if(-not $mutex.WaitOne(0)){throw '另一安装任务正在进行'}
try {
$pointerPath = Join-Path $installBase 'current.json'
$previous = if(Test-Path -LiteralPath $pointerPath){(Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json).current}else{''}
$task = Get-ScheduledTask -TaskName 'Codex Anywhere Connector' -ErrorAction SilentlyContinue
if($task -and ($task.State -eq 'Running' -or ($task.Actions[0].WorkingDirectory -and (Test-Path -LiteralPath (Join-Path $task.Actions[0].WorkingDirectory 'scripts/watch-connector.ps1'))))) {
    $legacyRoot = $task.Actions[0].WorkingDirectory
    $legacy = $legacyRoot -and (Test-Path -LiteralPath (Join-Path $legacyRoot 'scripts/watch-connector.ps1'))
    if(-not $legacy) {
        & (Join-Path $appRoot 'runtime/node.exe') (Join-Path $appRoot 'build/connector/owner-maintenance.js')
        if($LASTEXITCODE -ne 0){throw '连接器正在执行任务，请稍后安装。'}
    }
    Stop-ScheduledTask -TaskName 'Codex Anywhere Connector'
    if($legacy) {
        $compiled = [IO.Path]::GetFullPath((Join-Path $legacyRoot 'build/connector/index.js'))
        $watcher = [IO.Path]::GetFullPath((Join-Path $legacyRoot 'scripts/watch-connector.ps1'))
        $processes = @(Get-CimInstance Win32_Process | Where-Object {
            $_.CommandLine -and ($_.CommandLine.IndexOf($compiled,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $_.CommandLine.IndexOf($watcher,[StringComparison]::OrdinalIgnoreCase) -ge 0)
        })
        foreach($ownedProcess in $processes){ Stop-Process -Id $ownedProcess.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds 1
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'connector-supervisor.ps1') -Destination (Join-Path $installBase 'launch.ps1') -Force
@{current=$appRoot;previous=$previous;pending=$true} | ConvertTo-Json | Set-Content -LiteralPath ($pointerPath+'.tmp') -Encoding UTF8
Move-Item -LiteralPath ($pointerPath+'.tmp') -Destination $pointerPath -Force
$script = Join-Path $installBase 'launch.ps1'
$action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$script+'" -Background') -WorkingDirectory $appRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$registered = $false
try {
    Register-ScheduledTask -TaskName 'Codex Anywhere Connector' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    $registered = $true
} catch {
    $fallback = Join-Path $installBase 'startup.vbs'
    $vbs = 'CreateObject("WScript.Shell").Run """'+$powershell+'"" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""'+$script+'""", 0, False'
    [IO.File]::WriteAllText($fallback,$vbs,[Text.UnicodeEncoding]::new($false,$true))
    $startup = New-Object -ComObject WScript.Shell
    $shortcut = $startup.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Fribench Codex Connector.lnk'))
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32/wscript.exe'
    $shortcut.Arguments = '"'+$fallback+'"'
    $shortcut.Save()
}
foreach($oldName in @('Codex Anywhere Connector.lnk','Personal Codex Bridge Connector.lnk')){
    $oldStartup = Join-Path ([Environment]::GetFolderPath('Startup')) $oldName
    if(Test-Path -LiteralPath $oldStartup){Remove-Item -LiteralPath $oldStartup -Force}
}
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Fribench Codex Connector.lnk'))
$shortcut.TargetPath = $powershell
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $installBase 'settings.ps1')+'"'
$shortcut.Save()
$launchSettings = '$p=Get-Content -LiteralPath "'+$pointerPath+'" -Raw | ConvertFrom-Json; & (Join-Path $p.current "scripts/connector-settings.ps1")'
[IO.File]::WriteAllText((Join-Path $installBase 'settings.ps1'),$launchSettings,[Text.UTF8Encoding]::new($true))
if(-not $NoStart){
    if($registered){Start-ScheduledTask -TaskName 'Codex Anywhere Connector'}
    else {Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/wscript.exe') -ArgumentList ('"'+$fallback+'"') -WindowStyle Hidden}
}
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
