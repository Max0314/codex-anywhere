[CmdletBinding()]
param([switch]$NoStart, [switch]$FilesOnly, [string]$InstallBase=(Join-Path $env:LOCALAPPDATA 'Fribench/CodexConnector'))
$ErrorActionPreference = 'Stop'
$payload = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'connector-install-files.ps1')
. (Join-Path $PSScriptRoot 'connector-start.ps1')
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$taskName = 'Codex Anywhere Connector'
$mutex = New-Object Threading.Mutex($false,'Local\Fribench-Codex-Installer')
if(-not $mutex.WaitOne(0)){throw '另一安装任务正在进行'}
$transaction = $null
$oldStopped = $false

function Invoke-ConnectorCli([string]$Root, [string]$Name) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $Root 'runtime/node.exe'
    $info.Arguments = '"'+(Join-Path $Root ('build/connector/'+$Name+'.js'))+'"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $child = [Diagnostics.Process]::Start($info)
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    $child.WaitForExit()
    $result = @{code=$child.ExitCode;text=$stdout.Result;error=$stderr.Result}
    $child.Dispose()
    return $result
}

function Wait-ConnectorExit([string]$Root) {
    $compiled = Join-Path (Assert-ConnectorChildPath $Root (Join-Path $InstallBase 'versions')) 'build/connector/index.js'
    for($attempt=0;$attempt -lt 50;$attempt++) {
        $remaining = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($compiled,[StringComparison]::OrdinalIgnoreCase) -ge 0 })
        if(-not $remaining.Count){ return $true }
        Start-Sleep -Milliseconds 200
    }
    return $false
}

try {
    New-Item -ItemType Directory -Path $InstallBase -Force | Out-Null
    $oldPointer = Join-Path $InstallBase 'current.json'
    $oldRoot = if(Test-Path -LiteralPath $oldPointer){(Get-Content -LiteralPath $oldPointer -Raw | ConvertFrom-Json).current}else{''}
    if(-not $FilesOnly) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $legacyRoot = if($task){$task.Actions[0].WorkingDirectory}else{''}
        $legacy = $legacyRoot -and (Test-Path -LiteralPath (Join-Path $legacyRoot 'scripts/watch-connector.ps1'))
        $status = Invoke-ConnectorCli $payload 'owner-status'
        if($status.code -eq 0) {
            $stopping = Invoke-ConnectorCli $payload 'owner-maintenance'
            if($stopping.code -ne 0){ throw '连接器正在执行任务或传输文件，请完成后再安装。' }
            $oldStopped = $true
        }
        elseif($task -and $task.State -eq 'Running' -and -not $legacy) { throw '暂时无法确认旧连接器是否空闲，请稍后重试安装。' }
        if($task){ Stop-ScheduledTask -TaskName $taskName }
        if($legacy) {
            $compiled = [IO.Path]::GetFullPath((Join-Path $legacyRoot 'build/connector/index.js'))
            $watcher = [IO.Path]::GetFullPath((Join-Path $legacyRoot 'scripts/watch-connector.ps1'))
            Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($compiled) -or $_.CommandLine.Contains($watcher)) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        }
        # Wait for the old Node process to unload its native DLLs before rename.
        if($oldRoot) {
            if(-not (Wait-ConnectorExit $oldRoot)){ throw '旧连接器尚未退出，请稍后重试。' }
        }
    }
    $transaction = Install-ConnectorFiles $payload $InstallBase
    $appRoot = $transaction.root
    $scriptRoot = Join-Path $appRoot 'scripts'
    if($FilesOnly){ Write-ConnectorPointer $transaction.pointer @{current=$appRoot;previous='';pending=$false}; exit 0 }
    Copy-Item -LiteralPath (Join-Path $scriptRoot 'connector-supervisor.ps1') -Destination (Join-Path $InstallBase 'launch.ps1') -Force
    $launchSettings = '$p=Get-Content -LiteralPath "'+(Join-Path $InstallBase 'current.json')+'" -Raw | ConvertFrom-Json; & (Join-Path $p.current "scripts/connector-settings.ps1")'
    [IO.File]::WriteAllText((Join-Path $InstallBase 'settings.ps1'),$launchSettings,[Text.UTF8Encoding]::new($true))
    foreach($entry in @(@('settings.vbs','settings.ps1'),@('startup.vbs','launch.ps1'))) {
        $command = 'CreateObject("WScript.Shell").Run """'+$powershell+'"" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""'+(Join-Path $InstallBase $entry[1])+'""", 0, False'
        [IO.File]::WriteAllText((Join-Path $InstallBase $entry[0]),$command,[Text.UnicodeEncoding]::new($false,$true))
    }
    $action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $InstallBase 'launch.ps1')+'"') -WorkingDirectory $InstallBase
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $registered = $false
    try { Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null; $registered = $true } catch { }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Fribench Codex Connector.lnk'))
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32/wscript.exe'
    $shortcut.Arguments = '"'+(Join-Path $InstallBase 'settings.vbs')+'"'
    $shortcut.IconLocation = Join-Path $appRoot 'connector.ico'
    $shortcut.Save()
    $startupPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Fribench Codex Connector.lnk'
    if(-not $registered) {
        $startup = $shell.CreateShortcut($startupPath)
        $startup.TargetPath = Join-Path $env:SystemRoot 'System32/wscript.exe'
        $startup.Arguments = '"'+(Join-Path $InstallBase 'startup.vbs')+'"'
        $startup.Save()
    } elseif(Test-Path -LiteralPath $startupPath) { Remove-Item -LiteralPath $startupPath -Force }
    foreach($name in @('Codex Anywhere Connector.lnk','Personal Codex Bridge Connector.lnk')) {
        $path = Join-Path ([Environment]::GetFolderPath('Startup')) $name
        if(Test-Path -LiteralPath $path){ Remove-Item -LiteralPath $path -Force }
    }
    if(-not $NoStart) {
        Start-ConnectorRuntime $InstallBase
        $healthy = $false
        for($attempt=0;$attempt -lt 30;$attempt++) {
            Start-Sleep -Seconds 1
            $probe = Invoke-ConnectorCli $appRoot 'owner-status'
            $pointer = Get-Content -LiteralPath $transaction.pointer -Raw | ConvertFrom-Json
            if($probe.code -eq 0) {
                $observed = $probe.text | ConvertFrom-Json
                if($observed.version -eq $transaction.version -and $observed.installRoot -eq $appRoot -and $pointer.current -eq $appRoot -and -not $pointer.pending){ $healthy=$true;break }
            }
        }
        if(-not $healthy){ throw '新版启动未通过检查，正在恢复原版本。' }
    }
    if(-not $NoStart) {
        $pointer = Get-Content -LiteralPath $transaction.pointer -Raw | ConvertFrom-Json
        foreach($directory in @(Get-ChildItem -LiteralPath (Join-Path $InstallBase 'versions') -Directory)) {
            if($directory.Name -notmatch '\.previous-[a-f0-9]{32}$' -or $directory.FullName -eq $pointer.current -or $directory.FullName -eq $pointer.previous){continue}
            $safe = Assert-ConnectorChildPath $directory.FullName (Join-Path $InstallBase 'versions')
            try { Remove-Item -LiteralPath $safe -Recurse -Force } catch { Write-Warning '历史修复副本稍后清理。' }
        }
    }
    Write-Output '安装完成。登录、设备身份和目录设置已保留。'
} catch {
    $failure = $_
    $alreadyRecovered = $false
    if($transaction) {
        if(-not $FilesOnly) {
            $pointer = Get-Content -LiteralPath $transaction.pointer -Raw | ConvertFrom-Json
            $probe = Invoke-ConnectorCli $transaction.root 'owner-status'
            if($probe.code -eq 0) {
                $observed = $probe.text | ConvertFrom-Json
                $alreadyRecovered = $pointer.current -ne $transaction.root -and -not $pointer.pending -and $observed.installRoot -eq $pointer.current
            }
            if(-not $alreadyRecovered) {
                if($probe.code -eq 0) {
                    $stopping = Invoke-ConnectorCli $transaction.root 'owner-maintenance'
                    if($stopping.code -ne 0){ throw '当前连接器仍在执行任务，未自动回退，请完成任务后重试。' }
                }
                Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
                if(-not (Wait-ConnectorExit $pointer.current)){ throw '连接器尚未退出，保留现有文件，请稍后重试。' }
            }
        }
        if(-not $alreadyRecovered){ Restore-ConnectorFiles $transaction $InstallBase }
    }
    if(-not $FilesOnly -and -not $alreadyRecovered -and ($oldStopped -or $transaction)) { Start-ConnectorRuntime $InstallBase }
    if($alreadyRecovered){ [Console]::Error.WriteLine('本次安装未通过启动检查，原版本仍在运行。') }
    else { [Console]::Error.WriteLine($failure.Exception.Message) }
    exit 1
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
