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
if($task -and $task.State -eq 'Running') {
    & (Join-Path $appRoot 'runtime/node.exe') (Join-Path $appRoot 'build/connector/owner-maintenance.js')
    if($LASTEXITCODE -ne 0){throw '连接器正在执行任务，请稍后安装。'}
    Stop-ScheduledTask -TaskName 'Codex Anywhere Connector'
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'connector-supervisor.ps1') -Destination (Join-Path $installBase 'launch.ps1') -Force
@{current=$appRoot;previous=$previous;pending=$true} | ConvertTo-Json | Set-Content -LiteralPath ($pointerPath+'.tmp') -Encoding UTF8
Move-Item -LiteralPath ($pointerPath+'.tmp') -Destination $pointerPath -Force
$script = Join-Path $installBase 'launch.ps1'
$action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$script+'" -Background') -WorkingDirectory $appRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Codex Anywhere Connector' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
if(-not $NoStart){Start-ScheduledTask -TaskName 'Codex Anywhere Connector'}
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
