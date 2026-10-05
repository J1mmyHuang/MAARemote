# SPDX-License-Identifier: MPL-2.0
# ============================================================================
# MAARemote 系统托盘常驻程序 + 命令行工具（tray.ps1，双形态一体）
# ----------------------------------------------------------------------------
# 用法：
#   托盘 GUI：pwsh -NoProfile -File tray.ps1               （无参数）
#   命令行  ：pwsh -NoProfile -File tray.ps1 -Action <start|stop|restart|status|autostart-on|autostart-off>
#             退出码：成功（含幂等无操作）= 0，失败 = 1。
#
# 状态判定（与 start.ps1 同一套真相源，三种状态）：
#   端口 = server/config.json 的 port（整数 1-65535 采纳，否则默认 24325）
#   running（运行中） = 端口被监听 且 curl 探测 /api/overview 返回 401（本服务确定性探针）
#   stopped（已停止） = 端口未被监听
#   foreign（被占用） = 端口被监听但探测非 401（其他程序）
#
# 限流红线：/api/* 的 401 失败限流为同 IP 60 秒 20 次（第 21 次起 429）。
#   本脚本：托盘周期轮询 10 秒一次、仅在端口被监听时才发探测、探测最小间隔 7 秒；
#   start 的就绪探测只在端口刚被监听后进行——正常使用不会把探测打到 429，
#   也就不会把限流响应误报成「端口被占用」。
#
# 行为要点：
#   - start 以隐藏窗口后台进程启动 node src/index.js（工作目录 = server\），
#     日志重定向 logs\service-out-<时间戳>.log / service-err-<时间戳>.log；
#     依赖清单、成功标记或原生加载检查不通过时才准备依赖。
#   - stop 为强制结束（Stop-Process）。SQLite 已开 WAL（server/src/db.js:70），
#     强杀不会损坏已提交数据，最坏丢失最后一次未提交写入（详见 reports/M6-report.md）。
#   - 托盘「退出」仅关闭托盘自身，不停止服务（服务是独立进程，MAA 轮询不中断）。
#   - 接管语义：状态/停止不依赖「服务是否由托盘启动」——start.ps1 或手动 node
#     先起的服务，托盘同样显示运行中、同样可停止（一切以端口 + 401 探测为准）。
# ============================================================================

param([string]$Action)

$ErrorActionPreference = 'Stop'

# ---- 脚本目录定位（-File 与 -Command 两种调用均取得到）----
$script:scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

# ============================================================================
# 核心函数源码（$script:CoreSrc）
#   CLI 在当前会话 Invoke-Expression 定义；托盘 GUI 把它注入后台 runspace 执行
#   （探测/动作不阻塞消息循环），一份代码三处共用、无重复维护。
#   约定：执行前 $scriptDir 已被定义（主脚本顶部或 GUI 注入段）。
# ============================================================================
$script:CoreSrc = @'
$serverDir  = Join-Path $scriptDir 'server'
$configPath = Join-Path $serverDir 'config.json'
$logsDir    = Join-Path $scriptDir 'logs'
$trayEventLog = Join-Path $logsDir 'tray-events.log'
$trayStatePath = Join-Path $logsDir 'tray-state.json'
$trayDefaultPort = 24325
$trayRunKey      = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$trayValueName   = 'MAARemoteTray'
$trayStateSchemaVersion = 2
$script:trayStateReadError = $false
$script:lastTrayStateWriteError = ''
$script:lastTrayProcessVerification = $null

function Write-TrayEvent {
    param(
        [Parameter(Mandatory)][string]$Event,
        [string]$Mode = 'gui',
        [string]$Action = '',
        [string]$Reason = '',
        [object]$ExitCode = $null,
        [string]$Message = '',
        [string]$SessionId = '',
        [object]$ProcessIdentity = $null
    )
    try {
        if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }
        $eventSessionId = $SessionId
        if (-not $eventSessionId -and $script:traySessionId) { $eventSessionId = [string]$script:traySessionId }
        $eventIdentity = $ProcessIdentity
        if (-not $eventIdentity -and $script:traySessionIdentity) { $eventIdentity = $script:traySessionIdentity }
        if ($eventSessionId -and (-not $eventIdentity -or [string]::IsNullOrWhiteSpace([string]$eventIdentity.process_start_ticks) -or [string]::IsNullOrWhiteSpace([string]$eventIdentity.process_name) -or [string]::IsNullOrWhiteSpace([string]$eventIdentity.process_path))) {
            return $false
        }
        $record = [ordered]@{
            timestamp           = (Get-Date).ToUniversalTime().ToString('o')
            event               = $Event
            pid                 = $PID
            mode                = $Mode
            session_id          = if ($eventSessionId) { [string]$eventSessionId } else { $null }
            process_start_ticks = if ($eventIdentity) { [int64]$eventIdentity.process_start_ticks } else { $null }
            process_name        = if ($eventIdentity) { [string]$eventIdentity.process_name } else { $null }
            process_path        = if ($eventIdentity) { [string]$eventIdentity.process_path } else { $null }
        }
        if ($Action) { $record.action = $Action }
        if ($Reason) { $record.reason = $Reason }
        if ($null -ne $ExitCode) { $record.exit_code = $ExitCode }
        if ($Message) { $record.message = $Message }
        $line = $record | ConvertTo-Json -Compress -Depth 8 -ErrorAction Stop
        Add-Content -LiteralPath $trayEventLog -Value $line -Encoding UTF8 -ErrorAction Stop
    } catch {
        return $false
    }
    return $true
}

function Get-TrayProcessIdentity {
    param([int]$ProcessId = $PID)
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        $startTicks = [int64]$process.StartTime.ToUniversalTime().Ticks
        $path = [string]$process.MainModule.FileName
        $processName = [string]$process.ProcessName
        $cim = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $ProcessId) -ErrorAction Stop | Select-Object -First 1
        $commandLine = if ($cim) { [string]$cim.CommandLine } else { '' }
        if ($startTicks -le 0 -or [string]::IsNullOrWhiteSpace($processName) -or [string]::IsNullOrWhiteSpace($path) -or [string]::IsNullOrWhiteSpace($commandLine)) { return $null }
        return [ordered]@{
            pid                 = [int]$ProcessId
            process_start_ticks = $startTicks
            process_name        = $processName
            process_path        = $path
            process_command_line = $commandLine
        }
    } catch {
        return $null
    }
}

function Read-TrayTextShared {
    param([Parameter(Mandatory)][string]$Path)

    $stream = $null
    $reader = $null
    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            ([System.IO.FileShare]::Read -bor [System.IO.FileShare]::Write -bor [System.IO.FileShare]::Delete)
        )
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false, $true), $true)
        return $reader.ReadToEnd()
    } finally {
        if ($reader) { $reader.Dispose() } elseif ($stream) { $stream.Dispose() }
    }
}

function Write-TrayUtf8Atomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Text
    )

    $script:lastTrayStateWriteError = ''
    $parent = Split-Path -Parent $Path
    $tempPath = '{0}.{1}.{2}.tmp' -f $Path, $PID, ([guid]::NewGuid().ToString('N'))
    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $stream = $null
        try {
            if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
                New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop | Out-Null
            }
            $bytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes($Text)
            $stream = [System.IO.File]::Open($tempPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
            $stream.Dispose()
            $stream = $null

            [System.IO.File]::Move($tempPath, $Path, $true)
            return $true
        } catch [System.IO.IOException] {
            $lastError = $_.Exception
            if ($attempt -lt 3) { Start-Sleep -Milliseconds (25 * $attempt) }
        } catch {
            $lastError = $_.Exception
            break
        } finally {
            if ($stream) { try { $stream.Dispose() } catch { } }
            if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
                try { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue } catch { }
            }
        }
    }
    $script:lastTrayStateWriteError = if ($lastError) { [string]$lastError.Message } else { '托盘状态原子写入失败。' }
    return $false
}

function Test-TrayCommandLineForScript {
    param(
        [AllowNull()][string]$CommandLine,
        [Parameter(Mandatory)][string]$ExpectedScript
    )

    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    $match = [regex]::Match($CommandLine.Trim(), '(?i)(?:^|\s)(?:-file|-f)\s+(?:"(?<script>[^"]+)"|(?<script>\S+))(?<tail>.*)$')
    if (-not $match.Success -or -not [string]::IsNullOrWhiteSpace([string]$match.Groups['tail'].Value)) { return $false }
    $candidate = [string]$match.Groups['script'].Value
    try {
        $expected = [IO.Path]::GetFullPath($ExpectedScript).TrimEnd([char]92)
        $actual = [IO.Path]::GetFullPath($candidate).TrimEnd([char]92)
        return [string]::Equals($expected, $actual, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Get-TrayState {
    $script:trayStateReadError = $false
    try {
        if (Test-Path $trayStatePath) {
            return (Read-TrayTextShared -Path $trayStatePath | ConvertFrom-Json -ErrorAction Stop)
        }
    } catch {
        $script:trayStateReadError = $true
    }
    return $null
}

function Convert-TrayTimestamp {
    param([object]$Value)
    if ($null -eq $Value) { return '' }
    if ($Value -is [DateTime]) { return $Value.ToUniversalTime().ToString('o') }
    return [string]$Value
}

function Write-TrayState {
    param(
        [ValidateSet('running', 'stopped')][string]$Status,
        [int]$ProcessId = $PID,
        [string]$Mode = 'gui',
        [string]$StartedAt = '',
        [string]$Reason = '',
        [object]$ExitCode = $null,
        [string]$Message = '',
        [string]$SessionId = '',
        [string]$ExpectedSessionId = '',
        [ValidateSet('running', 'stopped')][string]$ExpectedStatus = '',
        [object]$ProcessIdentity = $null,
        [string]$ExitEventName = ''
    )
    $mutex = $null
    $acquired = $false
    try {
        if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }
        $mutex = New-Object System.Threading.Mutex($false, 'Local\MAARemoteTray.State')
        try {
            $acquired = $mutex.WaitOne(5000)
        } catch [System.Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if (-not $acquired) { return $false }

        $current = $null
        if (Test-Path $trayStatePath) {
            try {
                $current = Read-TrayTextShared -Path $trayStatePath | ConvertFrom-Json -ErrorAction Stop
            } catch {
                if ($ExpectedSessionId) { return $false }
            }
        }
        if ($ExpectedSessionId -and (-not $current -or [string]$current.session_id -ne $ExpectedSessionId)) {
            return $false
        }
        if ($ExpectedStatus -and (-not $current -or [string]$current.status -ne $ExpectedStatus)) {
            return $false
        }
        if (-not $SessionId -and $current -and $current.session_id) {
            $SessionId = [string]$current.session_id
        }
        if (-not $ProcessIdentity) {
            $ProcessIdentity = Get-TrayProcessIdentity -ProcessId $ProcessId
        }
        $state = [ordered]@{
            schema_version      = $trayStateSchemaVersion
            session_id          = $SessionId
            status              = $Status
            pid                 = $ProcessId
            process_start_ticks = if ($ProcessIdentity) { [int64]$ProcessIdentity.process_start_ticks } else { $null }
            process_name        = if ($ProcessIdentity) { [string]$ProcessIdentity.process_name } else { '' }
            process_path        = if ($ProcessIdentity) { [string]$ProcessIdentity.process_path } else { '' }
            process_command_line = if ($ProcessIdentity) { [string]$ProcessIdentity.process_command_line } else { '' }
            mode                = $Mode
            exit_event_name     = $ExitEventName
            started_at          = $StartedAt
            updated_at          = (Get-Date).ToUniversalTime().ToString('o')
            last_exit_reason    = if ($Status -eq 'stopped') { $Reason } else { $null }
            last_exit_code      = if ($Status -eq 'stopped') { $ExitCode } else { $null }
            last_message        = if ($Status -eq 'stopped') { $Message } else { $null }
        }
        $json = $state | ConvertTo-Json -Compress -Depth 8 -ErrorAction Stop
        return (Write-TrayUtf8Atomic -Path $trayStatePath -Text $json)
    } catch {
        $script:lastTrayStateWriteError = $_.Exception.Message
        return $false
    } finally {
        if ($acquired -and $mutex) { try { $mutex.ReleaseMutex() } catch { } }
        if ($mutex) { try { $mutex.Dispose() } catch { } }
    }
}

function Get-TrayProcessVerification {
    param([object]$State)
    if (-not $State -or [string]$State.status -ne 'running') { return [pscustomobject]@{ Status = 'not_running'; Message = '' } }
    $schemaVersion = 0
    if (-not [int]::TryParse([string]$State.schema_version, [ref]$schemaVersion) -or $schemaVersion -lt 2) { return [pscustomobject]@{ Status = 'mismatch'; Message = '状态 schema 不受支持。' } }
    $sessionId = [string]$State.session_id
    $expectedName = [string]$State.process_name
    $expectedPath = [string]$State.process_path
    $storedCommandLine = [string]$State.process_command_line
    if ($sessionId -notmatch '^[0-9a-fA-F]{32}$' -or [string]::IsNullOrWhiteSpace($expectedName) -or [string]::IsNullOrWhiteSpace($expectedPath) -or [string]::IsNullOrWhiteSpace($storedCommandLine)) { return [pscustomobject]@{ Status = 'mismatch'; Message = '状态缺少完整进程身份。' } }
    $pidValue = 0
    if (-not [int]::TryParse([string]$State.pid, [ref]$pidValue) -or $pidValue -le 0) { return [pscustomobject]@{ Status = 'mismatch'; Message = '状态 PID 无效。' } }
    $expectedTicks = 0L
    if (-not [int64]::TryParse([string]$State.process_start_ticks, [ref]$expectedTicks) -or $expectedTicks -le 0) { return [pscustomobject]@{ Status = 'mismatch'; Message = '状态进程启动时间无效。' } }
    try {
        $process = Get-Process -Id $pidValue -ErrorAction Stop
    } catch {
        $cim = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $pidValue) -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cim) { return [pscustomobject]@{ Status = 'unknown'; Message = '无法读取现有 PID 的进程身份。' } }
        return [pscustomobject]@{ Status = 'absent'; Message = '记录的 PID 已不存在。' }
    }
    try {
        if ([int64]$process.StartTime.ToUniversalTime().Ticks -ne $expectedTicks) { return [pscustomobject]@{ Status = 'mismatch'; Message = 'PID 启动时间不匹配。' } }
        if ([string]$process.ProcessName -ne $expectedName) { return [pscustomobject]@{ Status = 'mismatch'; Message = '进程名不匹配。' } }
        $actualPath = [string]$process.MainModule.FileName
        if ([string]::IsNullOrWhiteSpace($actualPath)) { return [pscustomobject]@{ Status = 'unknown'; Message = '无法读取进程可执行路径。' } }
        $actualFullPath = [IO.Path]::GetFullPath($actualPath)
        $expectedFullPath = [IO.Path]::GetFullPath($expectedPath)
        if (-not [string]::Equals($actualFullPath, $expectedFullPath, [System.StringComparison]::OrdinalIgnoreCase)) { return [pscustomobject]@{ Status = 'mismatch'; Message = '进程可执行路径不匹配。' } }
        $cim = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $pidValue) -ErrorAction Stop | Select-Object -First 1
        if (-not $cim -or [string]::IsNullOrWhiteSpace([string]$cim.CommandLine)) { return [pscustomobject]@{ Status = 'unknown'; Message = '无法读取托盘命令行。' } }
        if (-not (Test-TrayCommandLineForScript -CommandLine ([string]$cim.CommandLine) -ExpectedScript (Join-Path $scriptDir 'tray.ps1'))) { return [pscustomobject]@{ Status = 'mismatch'; Message = '托盘命令行脚本路径或参数不匹配。' } }
        $eventName = [string]$State.exit_event_name
        if ($eventName -cne ('Local\MAARemoteTray.Exit.' + $sessionId)) { return [pscustomobject]@{ Status = 'mismatch'; Message = '托盘退出事件不匹配。' } }
        $eventHandle = [System.Threading.EventWaitHandle]::OpenExisting($eventName)
        $eventHandle.Dispose()
        return [pscustomobject]@{ Status = 'alive'; Message = '托盘进程身份已完整核验。' }
    } catch {
        return [pscustomobject]@{ Status = 'unknown'; Message = $_.Exception.Message }
    }
}

function Test-TrayProcessAlive {
    param([object]$State)
    return ((Get-TrayProcessVerification -State $State).Status -eq 'alive')
}

function Resolve-TrayPreviousSession {
    $state = Get-TrayState
    $verification = if ($state -and [string]$state.status -eq 'running') { Get-TrayProcessVerification -State $state } else { $null }
    $script:lastTrayProcessVerification = $verification
    if ($state -and [string]$state.status -eq 'running' -and $verification.Status -in @('absent', 'mismatch')) {
        $message = '上次托盘没有写入退出记录，现有 PID 已不存在或身份不匹配；退出码不可得。'
        $previousPid = 0
        [void][int]::TryParse([string]$state.pid, [ref]$previousPid)
        $stateWritten = Write-TrayState -Status 'stopped' -ProcessId $previousPid -Mode ([string]$state.mode) -StartedAt (Convert-TrayTimestamp $state.started_at) -Reason 'abnormal_exit_detected' -ExitCode 'unknown' -Message $message -SessionId ([string]$state.session_id) -ExpectedSessionId ([string]$state.session_id) -ExpectedStatus 'running' -ProcessIdentity $state
        if ($stateWritten) {
            [void](Write-TrayEvent -Event 'abnormal_exit_detected' -Mode ([string]$state.mode) -Reason 'missing_exit_record' -ExitCode 'unknown' -Message $message -SessionId ([string]$state.session_id) -ProcessIdentity $state)
        }
    }
    return (Get-TrayState)
}

function Get-TrayRuntimeStatus {
    $state = Resolve-TrayPreviousSession
    if ($script:trayStateReadError) {
        return [ordered]@{
            Status     = 'unknown'
            Pid        = 0
            StartedAt  = ''
            ExitReason = 'state_unreadable'
            ExitCode   = 'unknown'
        }
    }
    if ($state -and [string]$state.status -eq 'running' -and (Test-TrayProcessAlive -State $state)) {
        return [ordered]@{
            Status     = 'running'
            Pid        = [int]$state.pid
            StartedAt  = Convert-TrayTimestamp $state.started_at
            ExitReason = ''
            ExitCode   = $null
        }
    }
    if ($state -and [string]$state.status -eq 'running') {
        return [ordered]@{
            Status     = 'unknown'
            Pid        = [int]$state.pid
            StartedAt  = Convert-TrayTimestamp $state.started_at
            ExitReason = 'state_unverified'
            ExitCode   = 'unknown'
        }
    }
    return [ordered]@{
        Status     = 'stopped'
        Pid        = if ($state) { [int]$state.pid } else { 0 }
        StartedAt  = if ($state) { Convert-TrayTimestamp $state.started_at } else { '' }
        ExitReason = if ($state -and $state.last_exit_reason) { [string]$state.last_exit_reason } else { 'none' }
        ExitCode   = if ($state -and $null -ne $state.last_exit_code) { $state.last_exit_code } else { 'unknown' }
    }
}

function Start-TraySession {
    param([string]$Mode = 'gui')
    if (-not $script:trayInstanceMutexAcquired) {
        throw '未取得托盘单实例保护，拒绝写入托盘运行状态。'
    }
    $script:traySessionStatePublished = $false
    $null = Resolve-TrayPreviousSession
    $injectedSessionId = [string]$env:MAAREMOTE_TRAY_SESSION_ID
    if ($injectedSessionId -match '^[0-9a-fA-F]{32}$') {
        $script:traySessionId = $injectedSessionId.ToLowerInvariant()
    } else {
        $script:traySessionId = [guid]::NewGuid().ToString('N')
    }
    $script:traySessionIdentity = Get-TrayProcessIdentity -ProcessId $PID
    if (-not $script:traySessionIdentity) {
        throw '无法读取托盘进程身份，拒绝写入可被错误归因的运行状态。'
    }
    $script:traySessionStartedAt = (Get-Date).ToUniversalTime().ToString('o')
    $script:traySessionEnded = $false
    $script:trayExitEventName = 'Local\MAARemoteTray.Exit.{0}' -f $script:traySessionId
    $eventCreated = $false
    $script:trayExitEvent = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::ManualReset, $script:trayExitEventName, [ref]$eventCreated)
    if (-not $script:trayExitEvent) {
        throw '无法创建托盘优雅退出事件，拒绝进入无人监督的运行态。'
    }
    if (-not (Write-TrayState -Status 'running' -ProcessId $PID -Mode $Mode -StartedAt $script:traySessionStartedAt -SessionId $script:traySessionId -ProcessIdentity $script:traySessionIdentity -ExitEventName $script:trayExitEventName)) {
        throw '无法写入托盘运行状态，拒绝进入无人监督的运行态。'
    }
    $script:traySessionStatePublished = $true
    [void](Write-TrayEvent -Event 'tray_start' -Mode $Mode -Message '托盘进程启动。')
}

function Complete-TraySession {
    param(
        [string]$Reason = 'normal',
        [object]$ExitCode = 0,
        [string]$Message = ''
    )
    if ($script:traySessionEnded) { return }
    if (-not $script:trayInstanceMutexAcquired -or -not $script:traySessionStatePublished -or -not $script:traySessionId) { return }
    $script:traySessionEnded = $true
    $stateWritten = Write-TrayState -Status 'stopped' -ProcessId $PID -Mode 'gui' -StartedAt ([string]$script:traySessionStartedAt) -Reason $Reason -ExitCode $ExitCode -Message $Message -SessionId $script:traySessionId -ExpectedSessionId $script:traySessionId -ExpectedStatus 'running' -ProcessIdentity $script:traySessionIdentity -ExitEventName $script:trayExitEventName
    if ($stateWritten) {
        $exitEventWritten = Write-TrayEvent -Event 'tray_exit' -Mode 'gui' -Reason $Reason -ExitCode $ExitCode -Message $Message
        if (-not $exitEventWritten) {
            $script:trayExitCode = 1
            $script:trayExitReason = 'event_log_write_failed'
            $failureMessage = '托盘退出事件日志写入失败，无法确认正常退出。'
            $corrected = Write-TrayState -Status 'stopped' -ProcessId $PID -Mode 'gui' -StartedAt ([string]$script:traySessionStartedAt) -Reason $script:trayExitReason -ExitCode 1 -Message $failureMessage -SessionId $script:traySessionId -ExpectedSessionId $script:traySessionId -ExpectedStatus 'stopped' -ProcessIdentity $script:traySessionIdentity -ExitEventName $script:trayExitEventName
            if (-not $corrected) { $script:trayExitReason = 'state_write_failed' }
        }
    }
    if (-not $stateWritten) {
        if ($script:trayExitCode -eq 0) { $script:trayExitCode = 1 }
        $script:trayExitReason = 'state_write_failed'
        [void](Write-TrayEvent -Event 'tray_state_write_failed' -Mode 'gui' -Reason 'state_write_failed' -ExitCode 1 -Message '退出状态写入失败，无法确认本次退出为正常退出。')
    }
}

function Get-ServerPort {
    # 与 server/src/config.js / start.ps1 同规则：整数 1-65535 采纳，否则默认 24325
    $port = $trayDefaultPort
    if (Test-Path $configPath) {
        try {
            $cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if (($cfg.port -is [int] -or $cfg.port -is [long]) -and $cfg.port -ge 1 -and $cfg.port -le 65535) {
                $port = [int]$cfg.port
            }
        } catch {
            # 解析失败不阻断：回落默认端口
        }
    }
    return $port
}

function Get-ListenerInfo {
    param([int]$Port)
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    } catch {
        $conns = $null
    }
    if (-not $conns) { return $null }
    $ownPid = ($conns | Select-Object -ExpandProperty OwningProcess -Unique | Select-Object -First 1)
    if (-not $ownPid) { return $null }
    return @{ Pid = [int]$ownPid }
}

function Invoke-Probe401 {
    # 探测本服务确定性信号：/api/overview 无 token 恒 401。返回 '401' 或其他/空。
    param([int]$Port)
    try {
        return ((& curl.exe -s -o NUL -w "%{http_code}" --max-time 3 ("http://127.0.0.1:{0}/api/overview" -f $Port) | Out-String).Trim())
    } catch {
        return ''
    }
}

function Get-ServiceState {
    # 返回 @{ Status = running|stopped|foreign; Pid; ProcName; Port }
    $port = Get-ServerPort
    $listener = Get-ListenerInfo -Port $port
    if (-not $listener) {
        return @{ Status = 'stopped'; Pid = 0; ProcName = ''; Port = $port }
    }
    $code = Invoke-Probe401 -Port $port
    $proc = Get-Process -Id $listener.Pid -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { '' }
    if ($code -eq '401') {
        return @{ Status = 'running'; Pid = $listener.Pid; ProcName = $procName; Port = $port }
    }
    return @{ Status = 'foreign'; Pid = $listener.Pid; ProcName = $procName; Port = $port }
}

function Test-NodeReady {
    # 返回空串 = 就绪；非空 = 中文错误信息
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        return '未找到 node 命令，请先安装 Node.js >=18（https://nodejs.org 或 winget install OpenJS.NodeJS.LTS）。'
    }
    $nodeVersion = (& node --version).TrimStart('v')
    $nodeMajor = 0
    if (-not [int]::TryParse(($nodeVersion -split '\.')[0], [ref]$nodeMajor)) { $nodeMajor = 0 }
    if ($nodeMajor -lt 18) {
        return ("检测到 Node {0}，本项目要求 >=18（server/package.json engines 约束）。" -f $nodeVersion)
    }
    return ''
}

function Invoke-ServiceStart {
    # 返回 $true 成功（含幂等）；$false 失败。过程信息走 Write-Host。
    $script:lastServiceStartExitCode = 1
    $state = Get-ServiceState
    if ($state.Status -eq 'running') {
        Write-Host ("[启动] 服务已在运行（PID={0}），无需重复启动。" -f $state.Pid)
        $script:lastServiceStartExitCode = 0
        return $true
    }
    if ($state.Status -eq 'foreign') {
        Write-Host ("[启动失败] 端口 {0} 已被其他程序占用（PID={1} 进程名={2}），拒绝启动；请先释放端口或修改 server/config.json 的 port。" -f $state.Port, $state.Pid, $state.ProcName)
        return $false
    }
    $nodeErr = Test-NodeReady
    if ($nodeErr) { Write-Host ("[启动失败] {0}" -f $nodeErr); return $false }
    if (-not (Test-Path (Join-Path $serverDir 'package.json'))) {
        Write-Host ("[启动失败] 未找到 {0}\package.json —— 请把 tray.ps1 放在仓库根目录下运行。" -f $serverDir)
        return $false
    }

    # 依赖：与 start.ps1 共用集中准备逻辑；服务已运行/端口冲突已在上方提前返回。
    $dependencyScript = Join-Path $scriptDir 'prepare-dependencies.ps1'
    if (-not (Test-Path -LiteralPath $dependencyScript -PathType Leaf)) {
        Write-Host ("[启动失败] 未找到依赖准备脚本 {0}。" -f $dependencyScript)
        $script:lastServiceStartExitCode = 66
        return $false
    }
    & $dependencyScript -ServerDir $serverDir
    $dependencyExitCode = [int]$LASTEXITCODE
    if ($dependencyExitCode -ne 0) {
        Write-Host ("[启动失败] 依赖准备未完成（退出码 {0}），服务未启动。" -f $dependencyExitCode)
        $script:lastServiceStartExitCode = $dependencyExitCode
        return $false
    }

    if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }
    $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outLog = Join-Path $logsDir ("service-out-{0}.log" -f $stamp)
    $errLog = Join-Path $logsDir ("service-err-{0}.log" -f $stamp)
    $nodeExe = (Get-Command node).Source

    $sp = @{
        FilePath               = $nodeExe
        ArgumentList           = 'src/index.js'
        WorkingDirectory       = $serverDir
        WindowStyle            = 'Hidden'
        PassThru               = $true
        RedirectStandardOutput = $outLog
        RedirectStandardError  = $errLog
    }
    $proc = Start-Process @sp

    # 就绪轮询：<=15 秒；进程早退即失败；端口被监听后用 401 探测确认
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        try {
            if ($proc.HasExited) {
                Write-Host ("[启动失败] node 进程启动后随即退出（退出码 {0}），日志见 {1}" -f $proc.ExitCode, $errLog)
                return $false
            }
        } catch { }
        if (Get-ListenerInfo -Port $state.Port) {
            if ((Invoke-Probe401 -Port $state.Port) -eq '401') {
                Write-Host ("启动成功 PID={0}" -f $proc.Id)
                Write-Host ("[日志] {0} / {1}" -f $outLog, $errLog)
                $script:lastServiceStartExitCode = 0
                return $true
            }
        }
    }
    Write-Host ("[启动失败] 等待 15 秒后仍未就绪（端口未监听或探测未返回 401）。进程可能仍在启动中（PID={0}），可用 -Action status 复查；日志见 {1}" -f $proc.Id, $errLog)
    return $false
}

function Invoke-ServiceStop {
    # 返回 $true 成功（含幂等）；$false 失败（含拒绝杀非本服务进程）。
    $state = Get-ServiceState
    if ($state.Status -eq 'stopped') {
        Write-Host "[停止] 服务未在运行，无需停止。"
        return $true
    }
    if ($state.Status -eq 'foreign') {
        Write-Host ("[停止失败] 端口 {0} 被其他程序占用（PID={1} 进程名={2}），拒绝结束非本服务进程。" -f $state.Port, $state.Pid, $state.ProcName)
        return $false
    }
    $targetPid = $state.Pid
    Write-Host ("[停止] 正在结束服务进程 PID={0}（强制结束；SQLite 已开 WAL，已提交数据不受影响）..." -f $targetPid)
    try {
        Stop-Process -Id $targetPid -Force -ErrorAction Stop
    } catch {
        Write-Host ("[停止失败] 无法结束进程（{0}）。" -f $_.Exception.Message)
        return $false
    }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-ListenerInfo -Port $state.Port)) {
            Write-Host ("停止成功 PID={0}（端口 {1} 已释放）" -f $targetPid, $state.Port)
            return $true
        }
        Start-Sleep -Milliseconds 300
    }
    Write-Host "[停止失败] 进程已结束但端口 10 秒内仍未释放（可能存在其他监听者），请用 -Action status 复查。"
    return $false
}

function Invoke-ServiceRestart {
    # = stop（含幂等）+ start
    $stopped = Invoke-ServiceStop
    if (-not $stopped) { return $false }
    return Invoke-ServiceStart
}

function Get-AutostartCommand {
    $pwshPath = ''
    try { $pwshPath = (Get-Command pwsh -ErrorAction Stop).Source } catch { }
    if (-not $pwshPath) { return '' }
    $trayPath = Join-Path $scriptDir 'tray.ps1'
    # 绝对路径全部带引号（防空格）；-Sta 固定 STA 线程（WinForms 推荐）；-WindowStyle Hidden 无窗口
    return '"{0}" -NoProfile -Sta -WindowStyle Hidden -File "{1}"' -f $pwshPath, $trayPath
}

function Test-AutostartEnabled {
    try {
        $v = (Get-ItemProperty -Path $trayRunKey -Name $trayValueName -ErrorAction Stop).$trayValueName
        return [bool]$v
    } catch {
        return $false
    }
}

function Invoke-AutostartOn {
    # 写 HKCU Run 键（当前用户，无需管理员），写后回读核对
    try {
        $root = [IO.Path]::GetFullPath($scriptDir).TrimEnd([char]92).ToLowerInvariant()
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $hash = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root)) | ForEach-Object { $_.ToString('x2') }) -join ''
        } finally { $sha.Dispose() }
        $taskName = 'MAARemote-P2-TrayGuard-' + $hash.Substring(0, 12)
        $task = $null
        try {
            $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
        } catch {
            if ($_.Exception.Message -notmatch 'No MSFT_ScheduledTask objects|找不到.*MSFT_ScheduledTask|没有.*MSFT_ScheduledTask|0x80070002') { throw }
        }
        if ($null -ne $task) {
            Write-Host '[自启失败] 已存在该项目计划任务；请先卸载守护，避免与 Run 自启重复监督。'
            return $false
        }
    } catch {
        Write-Host ('[自启失败] 无法核验计划任务互斥状态，未写入 Run：{0}' -f $_.Exception.Message)
        return $false
    }
    $cmd = Get-AutostartCommand
    if (-not $cmd) {
        Write-Host "[自启失败] 未找到 pwsh.exe，无法写入开机自启。"
        return $false
    }
    try {
        if (-not (Test-Path $trayRunKey)) { New-Item -Path $trayRunKey -Force | Out-Null }
        Set-ItemProperty -Path $trayRunKey -Name $trayValueName -Value $cmd -Type String
    } catch {
        Write-Host ("[自启失败] 写注册表出错：{0}" -f $_.Exception.Message)
        return $false
    }
    $readback = ''
    try { $readback = (Get-ItemProperty -Path $trayRunKey -Name $trayValueName -ErrorAction Stop).$trayValueName } catch { }
    if ($readback -eq $cmd) {
        Write-Host ("开机自启已开启：{0}\{1}" -f $trayRunKey, $trayValueName)
        Write-Host ("值 = {0}" -f $readback)
        return $true
    }
    Write-Host "[自启失败] 写入后回读不一致。"
    return $false
}

function Invoke-AutostartOff {
    # 删除 HKCU Run 键值并核对；本就未开启视为幂等成功
    if (-not (Test-AutostartEnabled)) {
        Write-Host "[自启] 本就未开启（无注册表键值），视为已关闭。"
        return $true
    }
    try {
        Remove-ItemProperty -Path $trayRunKey -Name $trayValueName -ErrorAction Stop
    } catch {
        Write-Host ("[自启失败] 删除注册表值出错：{0}" -f $_.Exception.Message)
        return $false
    }
    if (-not (Test-AutostartEnabled)) {
        Write-Host ("开机自启已关闭（{0} 键值已删除）" -f $trayValueName)
        return $true
    }
    Write-Host "[自启失败] 删除后仍能读到键值。"
    return $false
}
'@

# ============================================================================
# CLI 模式：-Action <start|stop|restart|status|autostart-on|autostart-off>
# ============================================================================
if ($Action) {
    $validActions = @('start', 'stop', 'restart', 'status', 'autostart-on', 'autostart-off')
    if ($validActions -notcontains $Action) {
        Write-Host ("[错误] 未知动作 '{0}'。可用动作：{1}" -f $Action, ($validActions -join ' / '))
        exit 1
    }
    Invoke-Expression $script:CoreSrc
    [void](Write-TrayEvent -Event 'cli_action' -Mode 'cli' -Action $Action)

    $ok = $true
    switch ($Action) {
        'start'         { $ok = Invoke-ServiceStart }
        'stop'          { $ok = Invoke-ServiceStop }
        'restart'       { $ok = Invoke-ServiceRestart }
        'autostart-on'  { $ok = Invoke-AutostartOn }
        'autostart-off' { $ok = Invoke-AutostartOff }
        'status'        {
            $st = Get-ServiceState
            switch ($st.Status) {
                'running' {
                    Write-Host ("STATUS=running PID={0} PORT={1}" -f $st.Pid, $st.Port)
                    Write-Host ("说明：MAARemote 服务运行中（探测 /api/overview 返回 401，进程名={0}）。" -f $st.ProcName)
                }
                'stopped' {
                    Write-Host ("STATUS=stopped PORT={0}" -f $st.Port)
                    Write-Host "说明：端口未被监听，服务已停止。"
                }
                'foreign' {
                    Write-Host ("STATUS=foreign PID={0} PROC={1} PORT={2}" -f $st.Pid, $st.ProcName, $st.Port)
                    Write-Host "说明：端口被其他程序占用（探测非 401），不是本服务。"
                }
            }
            $trayStatus = Get-TrayRuntimeStatus
            if ($trayStatus.Status -eq 'running') {
                Write-Host ("TRAY_STATUS=running PID={0} STARTED_AT={1}" -f $trayStatus.Pid, $trayStatus.StartedAt)
            } elseif ($trayStatus.Status -eq 'unknown') {
                Write-Host ("TRAY_STATUS=unknown PID=0 STARTED_AT= LAST_EXIT_REASON={0} LAST_EXIT_CODE=unknown" -f $trayStatus.ExitReason)
            } else {
                Write-Host ("TRAY_STATUS=stopped PID={0} STARTED_AT={1} LAST_EXIT_REASON={2} LAST_EXIT_CODE={3}" -f $trayStatus.Pid, $trayStatus.StartedAt, $trayStatus.ExitReason, $trayStatus.ExitCode)
            }
        }
    }
    if ($ok) { exit 0 }
    if ($Action -eq 'start' -and $script:lastServiceStartExitCode -is [int] -and $script:lastServiceStartExitCode -gt 0) {
        exit $script:lastServiceStartExitCode
    }
    exit 1
}

# ============================================================================
# 托盘 GUI 模式（无参数）：NotifyIcon + 消息循环，探测与动作放后台 runspace
# ============================================================================
Invoke-Expression $script:CoreSrc
$script:trayExitCode = 0
$script:trayExitReason = 'normal'
$script:traySessionStartedAt = ''
$script:traySessionId = ''
$script:traySessionIdentity = $null
$script:traySessionEnded = $false
$script:trayExitEventName = ''
$script:trayExitEvent = $null
$script:runtimeFailureRecorded = $false
$script:trayMessageLoopStarted = $false
$script:trayInstanceMutexAcquired = $false
$script:traySessionStatePublished = $false

try {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
    } catch {
        throw ("加载 Windows Forms 失败：{0}" -f $_.Exception.Message)
    }

# ---- Win32 API（控制台隐藏 / 图标句柄释放）----
if (-not ('MAARemote.Native' -as [type])) {
    Add-Type -Namespace MAARemote -Name Native -MemberDefinition @"
[DllImport("user32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
"@
}

# ---- 隐藏控制台窗口：仅当宿主是经典 conhost（类名 ConsoleWindowClass）时才隐藏。
#      Windows Terminal 下 GetConsoleWindow 指向终端窗口/伪控制台，不动它，避免藏掉整个终端。----
try {
    $hwnd = [MAARemote.Native]::GetConsoleWindow()
    if ($hwnd -ne [IntPtr]::Zero) {
        $clsBuilder = New-Object System.Text.StringBuilder 256
        [void][MAARemote.Native]::GetClassName($hwnd, $clsBuilder, 256)
        if ($clsBuilder.ToString() -eq 'ConsoleWindowClass') {
            [void][MAARemote.Native]::ShowWindow($hwnd, 0)   # SW_HIDE
        }
    }
} catch { }

# ---- 单实例保护（named Mutex；重复启动直接静默退出，避免无人值守场景弹窗阻塞）----
$script:mutex = New-Object System.Threading.Mutex($false, 'Local\MAARemoteTray.Instance')
$acquired = $false
try { $acquired = $script:mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
if ($acquired) { $script:trayInstanceMutexAcquired = $true }
if (-not $acquired) { exit 0 }

# ---- 记录托盘会话；退出原因由手动菜单或外层异常路径填写 ----
Start-TraySession -Mode 'gui'

# ---- 托盘常量与状态 ----
$script:pollIntervalSec = 10    # 周期轮询间隔（限流红线要求 >=10 秒）
$script:minProbeGapSec  = 7     # 探测最小间隔护栏（含菜单打开触发的立即刷新，双实例同跑也不超 401 限流）
$script:busyPs          = $null   # 正在跑的后台 [powershell]
$script:busyHandle      = $null
$script:busyKind        = ''      # 'poll' | 'action'
$script:pendingAction   = ''      # 待执行动作：'' | start | stop | restart
$script:lastProbeAt     = [DateTime]::MinValue
$script:forceRefresh    = $true   # 启动后立即探测一次
$script:curState        = $null

# ---- 运行时生成托盘图标（System.Drawing，无 .ico 二进制入库），按状态缓存句柄防泄漏 ----
$script:iconCache = @{}
function Get-StateIcon {
    param([string]$Status)
    if ($script:iconCache.ContainsKey($Status)) { return $script:iconCache[$Status] }
    $color = switch ($Status) {
        'running' { [System.Drawing.Color]::FromArgb(39, 174, 96) }    # 绿 = 运行中
        'foreign' { [System.Drawing.Color]::FromArgb(192, 57, 43) }    # 红 = 端口被占用
        default   { [System.Drawing.Color]::FromArgb(127, 140, 141) }  # 灰 = 已停止
    }
    $glyph = switch ($Status) { 'running' { 'M' } 'foreign' { '!' } default { '-' } }
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush $color
    $g.FillEllipse($brush, 1, 1, 30, 30)
    $font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = New-Object System.Drawing.RectangleF(0, 1, 32, 30)
    $g.DrawString($glyph, $font, [System.Drawing.Brushes]::White, $rect, $fmt)
    $fmt.Dispose(); $font.Dispose(); $brush.Dispose(); $g.Dispose()
    $hicon = $bmp.GetHicon()
    $bmp.Dispose()
    $entry = @{ Icon = [System.Drawing.Icon]::FromHandle($hicon); Handle = $hicon }
    $script:iconCache[$Status] = $entry
    return $entry
}

# ---- 后台执行（独立 runspace，绝不阻塞消息循环）----
function Start-TrayRunspace {
    param([Parameter(Mandatory)][string]$Kind)   # 'poll' | 'action'
    $ps = [powershell]::Create()
    $escapedDir = $script:scriptDir.Replace("'", "''")
    [void]$ps.AddScript("`$scriptDir = '$escapedDir'")
    [void]$ps.AddScript($script:CoreSrc)
    if ($Kind -eq 'action') {
        $snippet = switch ($script:pendingAction) {
            'start' {
                '$ok = Invoke-ServiceStart; $st = Get-ServiceState; $msg = if ($ok) { if ($st.Status -eq "running") { "启动完成：运行中（PID {0}）" -f $st.Pid } else { "启动完成" } } else { "启动失败：详见菜单状态与 logs 日志" }; [pscustomobject]@{ Ok = [bool]$ok; Msg = $msg; State = $st }'
            }
            'stop' {
                '$ok = Invoke-ServiceStop; $st = Get-ServiceState; $msg = if ($ok) { "已停止" } else { "停止失败：详见菜单状态" }; [pscustomobject]@{ Ok = [bool]$ok; Msg = $msg; State = $st }'
            }
            'restart' {
                '$ok = Invoke-ServiceRestart; $st = Get-ServiceState; $msg = if ($ok) { if ($st.Status -eq "running") { "重启完成：运行中（PID {0}）" -f $st.Pid } else { "重启完成" } } else { "重启失败：详见菜单状态与 logs 日志" }; [pscustomobject]@{ Ok = [bool]$ok; Msg = $msg; State = $st }'
            }
        }
        [void]$ps.AddScript($snippet)
    } else {
        [void]$ps.AddScript('[pscustomobject]@{ State = Get-ServiceState }')
    }
    $script:busyPs     = $ps
    $script:busyHandle = $ps.BeginInvoke()
    $script:busyKind   = $Kind
}

# ---- UI 更新 ----
function Set-ActionMenuEnabled {
    param([bool]$Enabled)
    foreach ($mi in @($script:miStart, $script:miStop, $script:miRestart)) { $mi.Enabled = $Enabled }
}

function Apply-State {
    param($st)
    if (-not $st) { return }
    $script:curState = $st
    $script:notify.Icon = (Get-StateIcon -Status $st.Status).Icon
    switch ($st.Status) {
        'running' {
            $script:notify.Text = ("MAARemote 运行中 PID {0}（端口 {1}）" -f $st.Pid, $st.Port)
            $script:miStatus.Text = ("运行中 (PID {0})" -f $st.Pid)
        }
        'foreign' {
            $script:notify.Text = ("端口 {0} 被占用 PID {1}（非本服务）" -f $st.Port, $st.Pid)
            $script:miStatus.Text = ("端口被占用 (PID {0}，非本服务)" -f $st.Pid)
        }
        default {
            $script:notify.Text = ("MAARemote 已停止（端口 {0}）" -f $st.Port)
            $script:miStatus.Text = '已停止'
        }
    }
}

function Apply-Busy {
    param([string]$act)
    $label = switch ($act) {
        'start'   { '正在启动 Remote…' }
        'stop'    { '正在停止 Remote…' }
        'restart' { '正在重启 Remote…' }
        default   { '正在执行…' }
    }
    $script:miStatus.Text = $label
}

function Show-Balloon {
    param([string]$msg, [bool]$ok)
    $type = if ($ok) { [System.Windows.Forms.ToolTipIcon]::Info } else { [System.Windows.Forms.ToolTipIcon]::Error }
    try { $script:notify.ShowBalloonTip(3000, 'MAARemote', $msg, $type) } catch { }
}

function Register-TrayRuntimeFailure {
    param([string]$Reason = 'runtime_exception', [string]$Message = '')
    if ($script:runtimeFailureRecorded) { return }
    $script:runtimeFailureRecorded = $true
    $script:trayExitCode = 1
    $script:trayExitReason = $Reason
    [void](Write-TrayEvent -Event 'tray_runtime_failure' -Mode 'gui' -Reason $Reason -ExitCode 1 -Message $Message)
    try { if ($script:timer) { $script:timer.Stop() } } catch { }
    try { [System.Windows.Forms.Application]::Exit() } catch { }
}

function Close-TrayApplication {
    param(
        [Parameter(Mandatory)][string]$Reason,
        [Parameter(Mandatory)][object]$ExitCode
    )

    $script:trayExitReason = $Reason
    $script:trayExitCode = $ExitCode
    try {
        $script:timer.Stop()
        if ($script:busyPs) {
            try { $script:busyPs.Stop() } catch { }
            try { $script:busyPs.Dispose() } catch { }
            $script:busyPs = $null; $script:busyHandle = $null
        }
        $script:notify.Visible = $false
        $script:notify.Dispose()
        foreach ($k in @($script:iconCache.Keys)) {
            [void][MAARemote.Native]::DestroyIcon($script:iconCache[$k].Handle)
        }
        $script:iconCache.Clear()
        [System.Windows.Forms.Application]::Exit()
    } catch {
        Register-TrayRuntimeFailure -Reason 'runtime_exception' -Message $_.Exception.Message
    }
}

# ---- 主循环调度：单一 Timer（250ms）收割后台结果 + 发起新探测/动作 ----
function Update-Tray {
    try {
    if ($script:trayExitEvent -and $script:trayExitEvent.WaitOne(0)) {
        Close-TrayApplication -Reason 'active_stop' -ExitCode 0
        return
    }
    # 1) 收割已完成的后台 runspace
    if ($script:busyPs -and $script:busyHandle -and $script:busyHandle.IsCompleted) {
        $kind = $script:busyKind
        $result = $null
        $runspaceErrors = @()
        $endInvokeError = $null
        try {
            $out = $script:busyPs.EndInvoke($script:busyHandle)
            $runspaceErrors = @($script:busyPs.Streams.Error)
            if ($out.Count -gt 0) { $result = $out[0] }
        } catch { $endInvokeError = $_ }
        try { $script:busyPs.Dispose() } catch { }
        $script:busyPs = $null; $script:busyHandle = $null; $script:busyKind = ''
        if ($endInvokeError) { throw $endInvokeError }
        if ($runspaceErrors.Count -gt 0) {
            $errorMessage = (($runspaceErrors | ForEach-Object { $_.ToString() }) -join '; ')
            throw ("后台 runspace 非终止错误：{0}" -f $errorMessage)
        }
        $script:lastProbeAt = Get-Date
        if ($kind -eq 'action') {
            $script:pendingAction = ''
            Set-ActionMenuEnabled $true
            if ($result) {
                Apply-State $result.State
                Show-Balloon ([string]$result.Msg) ([bool]$result.Ok)
            }
            $script:forceRefresh = $true
        } else {
            if ($result -and $result.State) { Apply-State $result.State }
        }
    }

    # 2) 调度：动作优先，其次周期探测（10s）/立即刷新（7s 护栏内限频）
    if ($script:busyPs) { return }
    if ($script:pendingAction) {
        Set-ActionMenuEnabled $false   # 动作期间禁用启/停/重启，防连点
        Apply-Busy $script:pendingAction
        Start-TrayRunspace -Kind 'action'
        return
    }
    $sinceLast = ((Get-Date) - $script:lastProbeAt).TotalSeconds
    if (($script:forceRefresh -or $sinceLast -ge $script:pollIntervalSec) -and $sinceLast -ge $script:minProbeGapSec) {
        $script:forceRefresh = $false
        Start-TrayRunspace -Kind 'poll'
    }
    } catch {
        Register-TrayRuntimeFailure -Reason 'runtime_exception' -Message $_.Exception.Message
    }
}

# ---- 托盘图标 ----
$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = (Get-StateIcon -Status 'stopped').Icon
$script:notify.Text = 'MAARemote 托盘：正在检查状态…'
$script:notify.Visible = $true

# ---- 右键菜单 ----
$script:menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:miStatus = New-Object System.Windows.Forms.ToolStripMenuItem('正在检查状态…')
$script:miStatus.Enabled = $false                       # 状态行只读禁用
[void]$script:menu.Items.Add($script:miStatus)
[void]$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$script:miStart   = New-Object System.Windows.Forms.ToolStripMenuItem('启动 Remote')
$script:miStop    = New-Object System.Windows.Forms.ToolStripMenuItem('停止 Remote')
$script:miRestart = New-Object System.Windows.Forms.ToolStripMenuItem('重启 Remote')
[void]$script:menu.Items.Add($script:miStart)
[void]$script:menu.Items.Add($script:miStop)
[void]$script:menu.Items.Add($script:miRestart)
[void]$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$script:miAutostart = New-Object System.Windows.Forms.ToolStripMenuItem('开机自启')
$script:miAutostart.CheckOnClick = $true
$script:miAutostart.Checked = Test-AutostartEnabled     # 勾选状态 = 注册表现状
[void]$script:menu.Items.Add($script:miAutostart)
[void]$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$script:miExit = New-Object System.Windows.Forms.ToolStripMenuItem('退出')
[void]$script:menu.Items.Add($script:miExit)
$script:notify.ContextMenuStrip = $script:menu

# ---- 事件绑定 ----
$script:miStart.Add_Click({
    try {
        if (-not $script:busyPs -and -not $script:pendingAction) { $script:pendingAction = 'start' }
    } catch {
        Register-TrayRuntimeFailure -Reason 'runtime_exception' -Message ("WinForms 点击回调异常：{0}" -f $_.Exception.Message)
    }
})
$script:miStop.Add_Click({
    try {
        if (-not $script:busyPs -and -not $script:pendingAction) { $script:pendingAction = 'stop' }
    } catch {
        Register-TrayRuntimeFailure -Reason 'runtime_exception' -Message ("WinForms 点击回调异常：{0}" -f $_.Exception.Message)
    }
})
$script:miRestart.Add_Click({
    try {
        if (-not $script:busyPs -and -not $script:pendingAction) { $script:pendingAction = 'restart' }
    } catch {
        Register-TrayRuntimeFailure -Reason 'runtime_exception' -Message ("WinForms 点击回调异常：{0}" -f $_.Exception.Message)
    }
})
$script:miAutostart.Add_Click({
    try {
        # 注册表读写毫秒级，同步执行即可；失败时按操作结果回滚勾选
        if ($script:miAutostart.Checked) {
            if (-not (Invoke-AutostartOn)) { $script:miAutostart.Checked = $false }
        } else {
            if (-not (Invoke-AutostartOff)) { $script:miAutostart.Checked = $true }
        }
    } catch {
        Register-TrayRuntimeFailure -Reason 'runtime_exception' -Message ("WinForms 自启回调异常：{0}" -f $_.Exception.Message)
    }
})
$script:menu.Add_Opening({
    try {
        # 菜单打开时刷新：注册表勾选状态同步核对；状态探测仍走后台（不卡菜单弹出）
        if (-not $script:busyPs -and -not $script:pendingAction) {
            $script:miAutostart.Checked = Test-AutostartEnabled
            if (((Get-Date) - $script:lastProbeAt).TotalSeconds -ge 3) { $script:forceRefresh = $true }
        }
    } catch {
        Register-TrayRuntimeFailure -Reason 'runtime_exception' -Message ("WinForms 菜单回调异常：{0}" -f $_.Exception.Message)
    }
})
$script:miExit.Add_Click({
    try {
        # 仅关闭托盘，不停止服务（服务独立进程，MAA 轮询不中断）
        Close-TrayApplication -Reason 'manual' -ExitCode 0
    } catch {
        Register-TrayRuntimeFailure -Reason 'runtime_exception' -Message ("WinForms 退出回调异常：{0}" -f $_.Exception.Message)
    }
})

# ---- 状态轮询 Timer（250ms 调度一次；实际探测 10s 一次，见 Update-Tray）----
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 250
$script:timer.Add_Tick({
    try {
        Update-Tray
    } catch {
        Register-TrayRuntimeFailure -Reason 'runtime_exception' -Message ("WinForms Timer 回调异常：{0}" -f $_.Exception.Message)
    }
})
$script:timer.Start()

# ---- 消息循环（退出后兜底清理）----
$script:trayMessageLoopStarted = $true
[System.Windows.Forms.Application]::Run()
} catch {
    $script:trayExitCode = 1
    $script:trayExitReason = if ($script:trayMessageLoopStarted) { 'runtime_exception' } else { 'initialization_exception' }
    $message = $_.Exception.Message
    Write-Host ("[托盘异常] {0}" -f $message)
    if (-not $script:traySessionStartedAt) {
        Write-TrayEvent -Event 'tray_start_failed' -Mode 'gui' -Reason $script:trayExitReason -ExitCode 1 -Message $message
    }
} finally {
    try { $script:timer.Stop() } catch { }
    try { $script:notify.Visible = $false; $script:notify.Dispose() } catch { }
    if ($script:traySessionStartedAt -and -not $script:traySessionEnded) {
        Complete-TraySession -Reason $script:trayExitReason -ExitCode $script:trayExitCode -Message $message
    }
    try { if ($script:trayExitEvent) { $script:trayExitEvent.Dispose() } } catch { }
    # 最终状态先写入并以 session_id 校验成功，再释放单实例 Mutex；否则旧实例可能覆盖新实例状态。
    try { $script:mutex.ReleaseMutex() } catch { }
    try { $script:mutex.Dispose() } catch { }
}
exit $script:trayExitCode
