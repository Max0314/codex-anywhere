[CmdletBinding()]
param([switch]$Background, [switch]$Bind)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$appRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $env:USERPROFILE '.codex-anywhere'
$configFile = Join-Path $stateRoot 'connector.json'
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $configFile)) {
    @{bridgeUrl='wss://codex.fribench.cn/ws/connector';deviceId=('pc-'+[Guid]::NewGuid().ToString('N'));deviceLabel=$env:COMPUTERNAME;allowedRoots=@();networkAccess=$false;allowFullAccess=$false;allowAnyFileDownload=$false} | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding UTF8
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
$env:BRIDGE_URL = 'wss://codex.fribench.cn/ws/connector'
$env:CODEX_ALLOWED_ROOTS_JSON = ConvertTo-Json -InputObject @($config.allowedRoots) -Compress
$env:CODEX_NETWORK_ACCESS = if($config.networkAccess){'1'}else{'0'}
$env:CODEX_ALLOW_FULL_ACCESS = if($config.allowFullAccess){'1'}else{'0'}
$env:CODEX_ALLOW_ANY_FILE_DOWNLOAD = if($config.allowAnyFileDownload){'1'}else{'0'}
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
$form = New-Object Windows.Forms.Form
$form.Text = 'Fribench Codex Connector'
$form.Width = 620
$form.Height = 460
$form.StartPosition = 'CenterScreen'
$label = New-Object Windows.Forms.Label
$label.Text = "电脑 $($config.deviceLabel)`r`n使用相同 Windows 用户下已登录的 Codex Desktop。"
$label.SetBounds(20,20,550,45)
$form.Controls.Add($label)
$list = New-Object Windows.Forms.ListBox
$list.SetBounds(20,90,550,150)
foreach($root in @($config.allowedRoots)){[void]$list.Items.Add($root)}
$form.Controls.Add($list)
$add = New-Object Windows.Forms.Button
$add.Text = '添加项目目录'
$add.SetBounds(20,250,150,32)
$add.Add_Click({$picker=New-Object Windows.Forms.FolderBrowserDialog; if($picker.ShowDialog() -eq 'OK' -and -not $list.Items.Contains($picker.SelectedPath)){[void]$list.Items.Add($picker.SelectedPath)}; $picker.Dispose()})
$form.Controls.Add($add)
$remove = New-Object Windows.Forms.Button
$remove.Text = '移除所选目录'
$remove.SetBounds(180,250,150,32)
$remove.Add_Click({if($list.SelectedIndex -ge 0){$list.Items.RemoveAt($list.SelectedIndex)}})
$form.Controls.Add($remove)
$save = New-Object Windows.Forms.Button
$save.Text = '保存目录'
$save.SetBounds(340,250,150,32)
$save.Add_Click({
    $config.allowedRoots = @($list.Items | ForEach-Object {[string]$_})
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath ($configFile+'.tmp') -Encoding UTF8
    Move-Item -LiteralPath ($configFile+'.tmp') -Destination $configFile -Force
    [Windows.Forms.MessageBox]::Show('目录已保存。新请求将使用新权限。')
})
$form.Controls.Add($save)
$connect = New-Object Windows.Forms.Button
$connect.Text = '连接 Fribench'
$connect.SetBounds(20,310,160,40)
$connect.Add_Click({
    $ps = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    Start-Process -FilePath $ps -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $PSScriptRoot 'connector-settings.ps1')+'"'),'-Bind') -WindowStyle Hidden
    [Windows.Forms.MessageBox]::Show('请在系统浏览器确认连接，完成后从手机查看电脑。')
})
$form.Controls.Add($connect)
$start = New-Object Windows.Forms.Button
$start.Text = '启动连接器'
$start.SetBounds(200,310,160,40)
$start.Add_Click({ Start-ScheduledTask -TaskName 'Codex Anywhere Connector'; [Windows.Forms.MessageBox]::Show('已请求启动。') })
$form.Controls.Add($start)
$download = New-Object Windows.Forms.LinkLabel
$download.Text = '检查并安装更新'
$download.SetBounds(390,322,150,30)
$download.Add_Click({
    $result = & $node (Join-Path $appRoot 'build/connector/owner-update.js') --install 2>&1 | Out-String
    [Windows.Forms.MessageBox]::Show($result)
})
$form.Controls.Add($download)
[void]$form.ShowDialog()
Remove-Item Env:BRIDGE_DEVICE_PRIVATE_KEY -ErrorAction SilentlyContinue
