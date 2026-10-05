# SPDX-License-Identifier: MPL-2.0
# ============================================================================
# MAARemote 一键启动脚本（PowerShell 7）
# ----------------------------------------------------------------------------
# 用法（两种均支持，无需先手动 cd）：
#   pwsh -NoProfile -File start.ps1
#   pwsh -NoProfile -Command "& .\start.ps1"
# 行为：定位 server\ 目录 → 前置检查 → 端口占用检测 → 按需准备依赖 →
#       前台启动 node src\index.js（Ctrl+C 交给 node 的优雅退出处理，无 wrapper）。
# 端口：以 server/config.json 的 port 字段为准（非法/缺失回落默认 24325），
#       首次运行时服务端会自动生成 config.json 与 server/data\maa.db。
# ============================================================================

$ErrorActionPreference = 'Stop'

# ---- 1. 定位脚本所在目录（-File 与 -Command "&" 两种调用均取得到）----
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$serverDir = Join-Path $scriptDir 'server'

if (-not (Test-Path (Join-Path $serverDir 'package.json'))) {
    Write-Host "[启动失败] 未找到 $serverDir\package.json —— 请将本脚本放在仓库根目录下运行。" -ForegroundColor Red
    exit 1
}

Push-Location $serverDir
try {
    # ---- 2. 前置检查：Node ≥18 ----
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "[启动失败] 未找到 node 命令，请先安装 Node.js ≥18（https://nodejs.org 或 winget install OpenJS.NodeJS.LTS）。" -ForegroundColor Red
        exit 1
    }
    $nodeVersion = (& node --version).TrimStart('v')   # 例如 22.14.0
    $nodeMajor = 0
    if (-not [int]::TryParse(($nodeVersion -split '\.')[0], [ref]$nodeMajor)) { $nodeMajor = 0 }
    if ($nodeMajor -lt 18) {
        Write-Host "[启动失败] 检测到 Node $nodeVersion，本项目要求 ≥18（server/package.json engines 约束）。" -ForegroundColor Red
        exit 1
    }
    Write-Host "[环境] Node v$nodeVersion 检查通过。"

    # ---- 3. 计算服务端口（与 server/src/config.js 同规则：整数 1-65535，否则默认 24325）----
    $port = 24325
    $configPath = Join-Path $serverDir 'config.json'
    if (Test-Path $configPath) {
        try {
            $cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if (($cfg.port -is [int] -or $cfg.port -is [long]) -and $cfg.port -ge 1 -and $cfg.port -le 65535) {
                $port = [int]$cfg.port
            }
        } catch {
            # config.json 解析失败不阻断启动：服务端会自行校验并回落默认端口
        }
    }

    # ---- 4. 端口占用检测：被占用则提示并退出，绝不重复启动 ----
    $conns = $null
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    } catch {
        # Get-NetTCPConnection 不可用时跳过检测（不阻断启动，由 node 监听报错兜底）
    }
    if ($conns) {
        Write-Host "[端口占用] 端口 $port 已被监听，本脚本不重复启动。占用进程信息：" -ForegroundColor Yellow
        foreach ($ownPid in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
            $proc = Get-Process -Id $ownPid -ErrorAction SilentlyContinue
            $procName = if ($proc) { $proc.ProcessName } else { '未知(进程已退出或无权限查看)' }
            Write-Host ("           PID={0}  进程名={1}" -f $ownPid, $procName) -ForegroundColor Yellow
        }
        # 探测是否本服务在跑：MAARemote 的 /api/overview 无 token 恒返回 401
        $probeCode = & curl.exe -s -o NUL -w "%{http_code}" --max-time 3 ("http://127.0.0.1:{0}/api/overview" -f $port)
        if ($probeCode -eq '401') {
            Write-Host "[提示] 探测 http://127.0.0.1:$port/api/overview 返回 401 —— 很可能 MAARemote 服务已在运行，无需再启动，直接访问仪表盘即可。" -ForegroundColor Green
        } else {
            Write-Host "[提示] 该端口被其他程序占用（探测返回 HTTP $probeCode）。确认是残留的旧服务进程后，可用 Stop-Process -Id <PID> 结束再重试；否则请修改 server/config.json 的 port 换端口。" -ForegroundColor Yellow
        }
        exit 1
    }

    # ---- 5. 只在依赖缺失、清单变化或加载检查失败时准备依赖 ----
    $dependencyScript = Join-Path $scriptDir 'prepare-dependencies.ps1'
    if (-not (Test-Path -LiteralPath $dependencyScript -PathType Leaf)) {
        Write-Host "[启动失败] 未找到依赖准备脚本 $dependencyScript。" -ForegroundColor Red
        exit 66
    }
    & $dependencyScript -ServerDir $serverDir
    $dependencyExitCode = $LASTEXITCODE
    if ($dependencyExitCode -ne 0) {
        Write-Host ("[启动失败] 依赖准备未完成（退出码 {0}），服务未启动。" -f $dependencyExitCode) -ForegroundColor Red
        exit $dependencyExitCode
    }

    # ---- 6. 前台启动（不加 wrapper，保证 Ctrl+C 信号直达 node 触发优雅退出）----
    Write-Host "[启动] node src\index.js （前台运行，监听 http://127.0.0.1:$port ，Ctrl+C 优雅退出）"
    & node src/index.js
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
