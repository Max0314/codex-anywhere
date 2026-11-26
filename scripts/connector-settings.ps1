[CmdletBinding()]
param([switch]$Background, [switch]$Bind)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$appRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $env:USERPROFILE '.codex-anywhere'
$configFile = Join-Path $stateRoot 'connector.json'
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $configFile)) {
    @{bridgeUrl='wss://codex.fribench.cn/ws/connector';deviceId=('pc-'+[Guid]::NewGuid().ToString('N'));deviceLabel=$env:COMPUTERNAME;networkAccess=$false;allowFullAccess=$false} | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding UTF8
}
$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$keyFile = Join-Path $stateRoot 'connector-device-key.dpapi'
if (-not (Test-Path -LiteralPath $keyFile)) {
    $key = [byte[]]::new(32)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($key)
    [IO.File]::WriteAllText($keyFile,[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($key,$null,'CurrentUser')))
    $rng.Dispose()
    [Array]::Clear($key,0,$key.Length)
}
$key = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([IO.File]::ReadAllText($keyFile)),$null,'CurrentUser')
$env:BRIDGE_DEVICE_PRIVATE_KEY = ([BitConverter]::ToString($key) -replace '-','').ToLowerInvariant()
[Array]::Clear($key,0,$key.Length)
$env:BRIDGE_DEVICE_ID = $config.deviceId
$env:BRIDGE_DEVICE_LABEL = $config.deviceLabel
$env:BRIDGE_OWNER_MODE = '1'
$env:BRIDGE_CONFIG_FILE = $configFile
$releaseFile = Join-Path $appRoot 'connector-release.json'
if(Test-Path -LiteralPath $releaseFile){$env:BRIDGE_INSTALL_VERSION = (Get-Content -LiteralPath $releaseFile -Raw | ConvertFrom-Json).version}
$env:BRIDGE_INSTALL_ROOT = $appRoot
$env:BRIDGE_URL = 'wss://codex.fribench.cn/ws/connector'
$env:CODEX_NETWORK_ACCESS = if($config.networkAccess){'1'}else{'0'}
$env:CODEX_ALLOW_FULL_ACCESS = if($config.allowFullAccess){'1'}else{'0'}
$node = Join-Path $appRoot 'runtime/node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node.exe).Source }
$codex = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI/Codex/bin') -Filter codex.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if($codex){$env:CODEX_BIN=$codex.FullName}
if($Background){
    # WinPS 5.1 can turn native stderr into terminating ErrorRecords under Stop.
    # Keep the child independent of PowerShell's native-command redirection.
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $node
    $info.Arguments = '"'+(Join-Path $appRoot 'build/connector/index.js')+'"'
    $info.WorkingDirectory = $appRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $outputLog = [IO.FileStream]::new((Join-Path $stateRoot 'connector-runtime.log'),'Create','Write','ReadWrite',1)
    $errorLog = [IO.FileStream]::new((Join-Path $stateRoot 'connector-errors.log'),'Create','Write','ReadWrite',1)
    try {
        $child = [Diagnostics.Process]::Start($info)
        Remove-Item Env:BRIDGE_DEVICE_PRIVATE_KEY -ErrorAction SilentlyContinue
        $output = $child.StandardOutput.BaseStream.CopyToAsync($outputLog)
        $errors = $child.StandardError.BaseStream.CopyToAsync($errorLog)
        $child.WaitForExit()
        $output.GetAwaiter().GetResult()
        $errors.GetAwaiter().GetResult()
        $code = $child.ExitCode
        $child.Dispose()
    } finally {
        $outputLog.Dispose()
        $errorLog.Dispose()
    }
    exit $code
}
if($Bind){
    & $node (Join-Path $appRoot 'build/connector/owner-bind.js')
    exit $LASTEXITCODE
}
Remove-Item Env:BRIDGE_DEVICE_PRIVATE_KEY -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = 'Fribench Codex Connector'
$form.StartPosition = 'CenterScreen'
$form.AutoScaleMode = 'Dpi'
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI',10)
$form.BackColor = [Drawing.Color]::White
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.ClientSize = New-Object Drawing.Size(440,245)
$form.Icon = New-Object Drawing.Icon((Join-Path $appRoot 'connector.ico'))
$layout = New-Object Windows.Forms.FlowLayoutPanel
$layout.Dock = 'Fill'
$layout.FlowDirection = 'TopDown'
$layout.WrapContents = $false
$layout.Padding = New-Object Windows.Forms.Padding(22,16,22,14)
$form.Controls.Add($layout)
function Add-StatusLabel([string]$Text,[int]$Size,[string]$Color) {
    $label = New-Object Windows.Forms.Label
    $label.AutoSize = $true
    $label.MaximumSize = New-Object Drawing.Size(388,0)
    $label.Text = $Text
    $label.ForeColor = [Drawing.ColorTranslator]::FromHtml($Color)
    $label.Font = New-Object Drawing.Font('Microsoft YaHei UI',$Size)
    $label.Margin = New-Object Windows.Forms.Padding(0,2,0,5)
    $layout.Controls.Add($label)
    return $label
}
$heading = Add-StatusLabel $config.deviceLabel 18 '#20242b'
$versionLabel = Add-StatusLabel ("Codex Connector   ·   " + $env:BRIDGE_INSTALL_VERSION) 9 '#596273'
$statusLabel = Add-StatusLabel '正在读取连接状态…' 11 '#244c72'
$detail = Add-StatusLabel '登录 Windows 后自动连接。' 9 '#596273'
$actions = New-Object Windows.Forms.FlowLayoutPanel
$actions.AutoSize = $true
$layout.Controls.Add($actions)
function Add-Action([string]$Text) {
    $button = New-Object Windows.Forms.Button
    $button.Text=$Text
    $button.AutoSize=$true
    $button.FlatStyle='Flat'
    $button.Padding=New-Object Windows.Forms.Padding(8,3,8,3)
    $button.Margin=New-Object Windows.Forms.Padding(0,7,10,0)
    $button.FlatAppearance.BorderColor=[Drawing.Color]::Gainsboro
    $actions.Controls.Add($button)
    return $button
}
$login = Add-Action '登录 Fribench'
$update = Add-Action '检查更新'
$login.BackColor = [Drawing.ColorTranslator]::FromHtml('#254e78')
$login.ForeColor = [Drawing.Color]::White
$update.Enabled = $false
$view = @{probe=$null; action=$null; kind=''; nextProbe=[datetime]::MinValue; install=$false; online=$false}
function Start-WindowCommand($File,$Arguments) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$File
    $info.Arguments=$Arguments
    $info.UseShellExecute=$false
    $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true
    $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    $child=[Diagnostics.Process]::Start($info)
    return @{process=$child; output=$child.StandardOutput.ReadToEndAsync(); errors=$child.StandardError.ReadToEndAsync()}
}
$settingsFile = $PSCommandPath
$login.Add_Click({
    $ps=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $view.kind='bind'
    $view.action=Start-WindowCommand $ps ('-NoProfile -ExecutionPolicy Bypass -File "'+$settingsFile+'" -Bind')
    $login.Enabled=$false
    $update.Enabled=$false
    $detail.Text='请在浏览器登录并确认这台电脑。'
})
$update.Add_Click({
    $flag=if($view.install){' --install'}else{''}
    $view.kind=if($view.install){'install'}else{'check'}
    $current=(Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'Fribench/CodexConnector/current.json') -Raw | ConvertFrom-Json).current
    $view.action=Start-WindowCommand (Join-Path $current 'runtime/node.exe') ('"'+(Join-Path $current 'build/connector/owner-update.js')+'"'+$flag)
    $login.Enabled=$false
    $update.Enabled=$false
    $detail.Text=if($view.install){'正在下载安装…'}else{'正在检查版本…'}
})
$timer=New-Object Windows.Forms.Timer
$timer.Interval=400
$timer.Add_Tick({
    if($view.action -and $view.action.process.HasExited){
        $ok=$view.action.process.ExitCode -eq 0
        $message=$view.action.output.Result.Trim()
        if(-not $ok){$message=$view.action.errors.Result.Trim()}
        $view.action.process.Dispose()
        $view.action=$null
        if($view.kind -eq 'bind'){
            $detail.Text=if($ok){'这台电脑已绑定，可以从手机选择。'}else{'登录未完成，请点击登录重试。'}
        }else{
            $detail.Text=$message
            $view.install=$ok -and $view.kind -eq 'check' -and $message.StartsWith('可更新至 ')
            $update.Text=if($view.install){'安装更新'}else{'检查更新'}
        }
        $view.nextProbe=[datetime]::MinValue
    }
    if($view.probe -and $view.probe.process.HasExited){
        $state=if($view.probe.process.ExitCode -eq 0){$view.probe.output.Result | ConvertFrom-Json}else{$null}
        $view.probe.process.Dispose()
        $view.probe=$null
        $view.online=$state -and $state.connected
        $statusLabel.Text=if($view.online -and $state.desktopReady){'已连接 · 手机可访问'}elseif($view.online){'已登录 · 等待 Codex Desktop'}elseif($state.needsLogin){'等待登录 Fribench'}else{'正在连接 Fribench…'}
        $login.Text=if($view.online){'已登录 Fribench'}else{'登录 Fribench'}
        if($state.version){$versionLabel.Text='Codex Connector   ·   '+$state.version}
        $view.nextProbe=[datetime]::UtcNow.AddSeconds(5)
    }
    $login.Enabled=-not $view.action -and -not $view.online
    $update.Enabled=-not $view.action -and $view.online
    if(-not $view.probe -and [datetime]::UtcNow -ge $view.nextProbe){
        # The running version can change while this window stays open.
        $pointer=Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'Fribench/CodexConnector/current.json') -Raw | ConvertFrom-Json
        $probeRoot=$pointer.current
        $view.probe=Start-WindowCommand (Join-Path $probeRoot 'runtime/node.exe') ('"'+(Join-Path $probeRoot 'build/connector/owner-status.js')+'" --display')
    }
})
$timer.Start()
try { [void]$form.ShowDialog() } finally { $timer.Dispose(); $form.Dispose() }
