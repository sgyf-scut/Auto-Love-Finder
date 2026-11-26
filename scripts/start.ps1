param([switch]$PrepareOnly, [switch]$Hidden, [int]$DiagnosticsPort = 0)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw '此版本需要 64 位 Windows。' }
    $config = Get-Content -LiteralPath (Join-Path $root 'runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.version -ne '37.2.6' -or $config.sha256 -notmatch '^[a-f0-9]{64}$') { throw '运行环境配置不完整，请重新下载源码 ZIP。' }
    $runtimeDirectory = Join-Path $root ('.runtime/electron-' + $config.version + '-win32-x64')
    $exe = Join-Path $runtimeDirectory 'electron.exe'
    if (-not (Test-Path -LiteralPath $exe)) {
        Write-Host '首次启动：正在准备运行环境。无需安装 Node、Python 或 Git。' -ForegroundColor Cyan
        $cache = Join-Path $root '.cache'
        New-Item -ItemType Directory -Path $cache -Force | Out-Null
        $zip = Join-Path $cache $config.filename
        $valid = (Test-Path -LiteralPath $zip) -and ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -eq $config.sha256)
        if (-not $valid) {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $part = $zip + '.partial'
            $downloaded = $false
            foreach ($url in $config.urls) {
                try {
                    Write-Host ('下载运行环境：' + ([Uri]$url).Host)
                    Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing -TimeoutSec 180
                    if ((Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.sha256) { throw '下载文件的校验值不匹配。' }
                    Move-Item -LiteralPath $part -Destination $zip -Force
                    $downloaded = $true
                    break
                } catch { Write-Host ('此下载源未成功：' + $_.Exception.Message) -ForegroundColor Yellow }
            }
            if (-not $downloaded) { throw '运行环境下载失败。请确认能访问 GitHub 或备用下载源，网络恢复后重新双击启动；账号数据不会被清空。' }
        }
        Write-Host '下载校验通过，正在解压运行环境……'
        New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
        Expand-Archive -LiteralPath $zip -DestinationPath $runtimeDirectory -Force
        if (-not (Test-Path -LiteralPath $exe)) { throw '运行环境解压不完整，请重新准备 .runtime 目录。' }
    }
    if ($PrepareOnly) { Write-Host '运行环境已就绪。'; exit 0 }
    $appDirectory = Join-Path $root 'app-source'
    if (-not (Test-Path -LiteralPath (Join-Path $appDirectory 'electron/main.cjs'))) { throw '源码不完整。请解压整个 ZIP，不要只取启动脚本。' }
    $env:DOUYIN_ASSISTANT_DATA_DIR = Join-Path $root 'data'
    $env:DOUYIN_ASSISTANT_DEV_TOOLS = '0'
    $env:ELECTRON_RUN_AS_NODE = $null
    $env:NODE_OPTIONS = $null
    New-Item -ItemType Directory -Path $env:DOUYIN_ASSISTANT_DATA_DIR -Force | Out-Null
    $arguments = @(('"' + $appDirectory + '"'), ('--user-data-dir="' + $env:DOUYIN_ASSISTANT_DATA_DIR + '"'))
    if ($Hidden) { $arguments += '--hidden' }
    if ($DiagnosticsPort -gt 0) {
        $arguments += '--remote-debugging-address=127.0.0.1'
        $arguments += ('--remote-debugging-port=' + $DiagnosticsPort)
    }
    Write-Host '正在启动 Auto Love Finder……'
    $instance = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
    if ($DiagnosticsPort -gt 0) { Write-Output ('DIAGNOSTIC_PID=' + $instance.Id) }
} catch {
    Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
