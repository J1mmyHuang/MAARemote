# MAARemote P2: tray guard process
#
# This script only supervises tray.ps1; it never starts, stops, or restarts Node.
# The task action passes -ProjectMarker; the marker is for identity verification, not a credential.
# The guard runs with the current user's token and stores no password.

[CmdletBinding()]
param(
    [string]$RootPath = '',
    [string]$TrayScriptPath = '',
    [string]$ProjectMarker = '',
    [ValidateRange(50, 5000)]
    [int]$PollMilliseconds = 250
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ExitCode = 1
$script:Outcome = [ordered]@{
    component       = 'tray-guard'
    action          = 'run'
    ok              = $false
    reason          = 'not_started'
    exit_code       = 1
    guard_pid       = $PID
    child_pid       = 0
    child_exit_code = 'unknown'
    session_id      = ''
    started_at      = ''
    root            = ''
    tray_script     = ''
    pwsh_path       = ''
}
$script:Root = ''
$script:TrayPath = ''
$script:GuardScriptPath = ''
$script:PwshPath = ''
$script:ProjectMarkerValue = ''
$script:RootHash = ''
$script:LogsDir = ''
$script:TrayStatePath = ''
$script:GuardStatePath = ''
$script:GuardEventLog = ''
$script:GuardControlPath = ''
$script:SessionId = ([guid]::NewGuid()).ToString('N')
$script:GuardMutex = $null
$script:GuardMutexHeld = $false
$script:RuntimeStarted = $false
$script:GuardProcessIdentity = $null
$script:EventLogWriteFailed = $false
$script:StateWriteFailed = $false
$script:StateWriteError = ''
$script:LastAtomicWriteError = ''
$script:ControlFileCorrupt = $false
$script:PreviousGuardStateCorrupt = $false
$script:PreviousTrayStateCorrupt = $false
$script:Child = $null
$script:ChildExitEvent = $null
$script:ChildPid = 0
$script:ChildStartedAt = $null
$script:ChildSessionId = ''
$script:RequestedExitReason = ''
$script:RequestedExitMessage = ''
$script:RestartCount = 0
$script:RestartLimit = 3
$script:RestartIntervalSeconds = 60

function Get-FullPath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'Path cannot be empty.'
    }
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    return [System.IO.Path]::GetFullPath($resolved.Path)
}

function Get-CanonicalRoot {
    param([Parameter(Mandatory)][string]$Path)

    $full = Get-FullPath -Path $Path
    return $full.TrimEnd([char]92).ToLowerInvariant()
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)][string]$Value)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        $hash = $sha.ComputeHash($bytes)
        return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $sha.Dispose()
    }
}

function Get-PropertyValue {
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $Object) { return $null }
    if ($null -eq $Object.PSObject.Properties[$Name]) { return $null }
    return $Object.PSObject.Properties[$Name].Value
}

function Get-ProcessIdentity {
    param([Parameter(Mandatory)][int]$ProcessId)

    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        $startTicks = [int64]$process.StartTime.ToUniversalTime().Ticks
        $path = ''
        try { $path = [string]$process.MainModule.FileName } catch { }
        $cim = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $ProcessId) -ErrorAction Stop | Select-Object -First 1
        $commandLine = if ($cim) { [string]$cim.CommandLine } else { '' }
        return [ordered]@{
            pid                 = $ProcessId
            process_start_ticks = $startTicks
            process_name        = [string]$process.ProcessName
            process_path        = $path
            process_command_line = $commandLine
        }
    } catch {
        return $null
    }
}

function Read-JsonDocument {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{
            Exists = $false
            Valid  = $true
            Data   = $null
            Error  = ''
        }
    }

    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            ([System.IO.FileShare]::Read -bor [System.IO.FileShare]::Write -bor [System.IO.FileShare]::Delete)
        )
        try {
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false, $true), $true)
            try { $raw = $reader.ReadToEnd() } finally { $reader.Dispose() }
        } finally {
            if ($stream) { $stream.Dispose() }
        }
        if ([string]::IsNullOrWhiteSpace($raw)) {
            throw 'The JSON file is empty.'
        }
        $data = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
        if ($null -eq $data) {
            throw 'The JSON file does not contain an object.'
        }
        return [pscustomobject]@{
            Exists = $true
            Valid  = $true
            Data   = $data
            Error  = ''
        }
    } catch {
        return [pscustomobject]@{
            Exists = $true
            Valid  = $false
            Data   = $null
            Error  = $_.Exception.Message
        }
    }
}

function Write-JsonAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Value
    )

    $tempPath = '{0}.{1}.{2}.tmp' -f $Path, $PID, ([guid]::NewGuid().ToString('N'))
    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $stream = $null
        try {
            $parent = Split-Path -Parent $Path
            if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
                New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop | Out-Null
            }
            $json = ConvertTo-Json -InputObject $Value -Compress -Depth 12 -ErrorAction Stop
            $bytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes($json)
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
    $script:LastAtomicWriteError = if ($lastError) { [string]$lastError.Message } else { 'Atomic write failed.' }
    return $false
}

function Write-GuardEvent {
    param(
        [Parameter(Mandatory)][string]$Event,
        [string]$Reason = '',
        [object]$ExitCode = $null,
        [int]$ChildPid = 0,
        [string]$Message = ''
    )

    try {
        if (-not (Test-Path -LiteralPath $script:LogsDir -PathType Container)) {
            New-Item -ItemType Directory -Path $script:LogsDir -Force -ErrorAction Stop | Out-Null
        }
        $record = [ordered]@{
            timestamp  = (Get-Date).ToUniversalTime().ToString('o')
            event      = $Event
            pid        = $PID
            session_id = $script:SessionId
        }
        if ($Reason) { $record.reason = $Reason }
        if ($null -ne $ExitCode) { $record.exit_code = $ExitCode }
        if ($ChildPid -gt 0) { $record.child_pid = $ChildPid }
        if ($Message) { $record.message = $Message }
        $line = ConvertTo-Json -InputObject $record -Compress -Depth 8 -ErrorAction Stop
        Add-Content -LiteralPath $script:GuardEventLog -Value $line -Encoding UTF8 -ErrorAction Stop
        return $true
    } catch {
        $script:EventLogWriteFailed = $true
        return $false
    }
}

function Write-GuardState {
    param(
        [Parameter(Mandatory)][ValidateSet('running', 'stopped')][string]$Status,
        [string]$Reason = '',
        [object]$ExitCode = $null,
        [int]$ChildPid = 0,
        [object]$ChildExitCode = $null,
        [string]$Message = ''
    )

    try {
        $state = [ordered]@{
            schema          = 2
            component       = 'MAARemote-P2'
            project_marker  = $script:ProjectMarkerValue
            root            = $script:Root
            guard_script    = $script:GuardScriptPath
            tray_script     = $script:TrayPath
            pwsh_path       = $script:PwshPath
            pid             = $PID
            process_start_ticks = if ($script:GuardProcessIdentity) { [int64]$script:GuardProcessIdentity.process_start_ticks } else { $null }
            process_name    = if ($script:GuardProcessIdentity) { [string]$script:GuardProcessIdentity.process_name } else { '' }
            process_path    = if ($script:GuardProcessIdentity) { [string]$script:GuardProcessIdentity.process_path } else { '' }
            process_command_line = if ($script:GuardProcessIdentity) { [string]$script:GuardProcessIdentity.process_command_line } else { '' }
            session_id      = $script:SessionId
            status          = $Status
            started_at      = if ($Status -eq 'running') { $script:Outcome.started_at } else { $script:Outcome.started_at }
            updated_at      = (Get-Date).ToUniversalTime().ToString('o')
            child_pid       = $ChildPid
            child_process_start_ticks = if ($script:ChildStartedAt) { [int64]$script:ChildStartedAt.UtcTicks } else { $null }
            child_session_id = $script:ChildSessionId
            restart_count   = $script:RestartCount
            child_exit_code = if ($Status -eq 'stopped') { $ChildExitCode } else { $null }
            exit_reason     = if ($Status -eq 'stopped') { $Reason } else { $null }
            exit_code       = if ($Status -eq 'stopped') { $ExitCode } else { $null }
            message         = if ($Status -eq 'stopped') { $Message } else { $null }
        }
        if (-not (Write-JsonAtomic -Path $script:GuardStatePath -Value $state)) {
            $script:StateWriteFailed = $true
    $script:StateWriteError = if ($script:LastAtomicWriteError) { $script:LastAtomicWriteError } else { 'Atomic write failed.' }
            return $false
        }
        return $true
    } catch {
        $script:StateWriteFailed = $true
        $script:StateWriteError = $_.Exception.Message
        return $false
    }
}

function Resolve-PwshPath {
    $fromHome = Join-Path -Path $PSHOME -ChildPath 'pwsh.exe'
    if (Test-Path -LiteralPath $fromHome -PathType Leaf) {
        return [System.IO.Path]::GetFullPath($fromHome)
    }
    $command = Get-Command -Name 'pwsh.exe' -ErrorAction Stop
    if (-not $command.Source) { throw 'Could not resolve an absolute path for pwsh.exe.' }
    $full = [System.IO.Path]::GetFullPath([string]$command.Source)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        throw "pwsh.exe does not exist: $full"
    }
    return $full
}

function Get-ProcessCim {
    param([Parameter(Mandatory)][int]$ProcessId)

    try {
        return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop | Select-Object -First 1
    } catch {
        return $null
    }
}

function Get-NormalizedPath {
    param([AllowNull()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    try { return ([System.IO.Path]::GetFullPath($Path)).TrimEnd([char]92).ToLowerInvariant() } catch { return '' }
}

function Test-CommandLineContainsScript {
    param(
        [AllowNull()][string]$CommandLine,
        [Parameter(Mandatory)][string]$ExpectedScript
    )

    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    $line = $CommandLine.Trim()
    $match = [regex]::Match($line, '(?i)(?:^|\s)(?:-file|-f)\s+(?:"(?<script>[^"]+)"|(?<script>\S+))(?<tail>.*)$')
    if (-not $match.Success) { return $false }
    if (-not [string]::IsNullOrWhiteSpace([string]$match.Groups['tail'].Value)) { return $false }

    $candidate = [string]$match.Groups['script'].Value
    $expected = Get-NormalizedPath -Path $ExpectedScript
    if ([IO.Path]::IsPathRooted($candidate)) {
        return ($expected -and (Get-NormalizedPath -Path $candidate) -eq $expected)
    }

    # CIM has no reliable working-directory field; a relative path cannot prove project ownership.
    return $false
}

function Convert-ToUtcDateTimeOffset {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime() }
    if ($Value -is [DateTime]) { return [DateTimeOffset]$Value.ToUniversalTime() }
    try {
        return [DateTimeOffset]::Parse(
            [string]$Value,
            [Globalization.CultureInfo]::InvariantCulture,
            ([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
        )
    } catch {
        return $null
    }
}

function Test-ProcessMatchesTray {
    param(
        [int]$ProcessId,
        [AllowNull()][object]$StartedAt,
        [AllowNull()][object]$ExpectedStartTicks,
        [Parameter(Mandatory)][string]$ExpectedTrayPath,
        [Parameter(Mandatory)][string]$ExpectedPwshPath
    )

    if ($ProcessId -le 0) { return $false }
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $false }
    $cim = Get-ProcessCim -ProcessId $ProcessId
    if ($null -eq $cim) { return $false }

    $exe = Get-NormalizedPath -Path ([string](Get-PropertyValue -Object $cim -Name 'ExecutablePath'))
    $expectedExe = Get-NormalizedPath -Path $ExpectedPwshPath
    if (-not $exe -or -not $expectedExe -or $exe -ne $expectedExe) { return $false }

    $commandLine = [string](Get-PropertyValue -Object $cim -Name 'CommandLine')
    if (-not (Test-CommandLineContainsScript -CommandLine $commandLine -ExpectedScript $ExpectedTrayPath)) { return $false }

    $storedStart = Convert-ToUtcDateTimeOffset -Value $StartedAt
    if ($null -eq $storedStart) { return $false }
    try {
        $actualStart = [DateTimeOffset]$process.StartTime.ToUniversalTime()
        $expectedTicks = 0L
        if (-not [int64]::TryParse([string]$ExpectedStartTicks, [ref]$expectedTicks) -or $expectedTicks -le 0) { return $false }
        if ([int64]$actualStart.Ticks -ne $expectedTicks) { return $false }
        $delta = [math]::Abs(($actualStart - $storedStart.ToUniversalTime()).TotalSeconds)
        # tray.ps1 writes running state after process start; PID reuse is unlikely in this window.
        if ($delta -gt 45) { return $false }
    } catch {
        return $false
    }
    return $true
}

function Stop-VerifiedTrayChild {
    param(
        [Parameter(Mandatory)][int]$ProcessId,
        [Parameter(Mandatory)][int64]$ExpectedStartTicks,
        [Parameter(Mandatory)][string]$ExitEventName
    )

    if ($ProcessId -le 0) { return $false }
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $true }
    try {
        if ([int64]$process.StartTime.ToUniversalTime().Ticks -ne $ExpectedStartTicks) { return $false }
    } catch {
        return $false
    }
    $cim = Get-ProcessCim -ProcessId $ProcessId
    if ($null -eq $cim) { return $false }
    $exe = Get-NormalizedPath -Path ([string](Get-PropertyValue -Object $cim -Name 'ExecutablePath'))
    $expectedExe = Get-NormalizedPath -Path $script:PwshPath
    $commandLine = [string](Get-PropertyValue -Object $cim -Name 'CommandLine')
    if (-not $exe -or $exe -ne $expectedExe -or -not (Test-CommandLineContainsScript -CommandLine $commandLine -ExpectedScript $script:TrayPath)) {
        return $false
    }
    if ([string]::IsNullOrWhiteSpace($script:ChildSessionId) -or $ExitEventName -cne ('Local\MAARemoteTray.Exit.' + $script:ChildSessionId)) { return $false }
    try {
        $exitEvent = [System.Threading.EventWaitHandle]::OpenExisting($ExitEventName)
        try {
            if (-not $exitEvent.Set()) { return $false }
        } finally { $exitEvent.Dispose() }
        return $true
    } catch {
        return $false
    }
}

function Request-ChildGracefulExit {
    if ($null -eq $script:Child -or $script:Child.HasExited) { return $true }
    try {
        if ($null -ne $script:ChildExitEvent) {
            return [bool]$script:ChildExitEvent.Set()
        }
        if ([string]::IsNullOrWhiteSpace($script:ChildSessionId)) { return $false }
        return (Stop-VerifiedTrayChild -ProcessId $script:ChildPid -ExpectedStartTicks ([int64]$script:ChildStartedAt.Ticks) -ExitEventName ('Local\MAARemoteTray.Exit.' + $script:ChildSessionId))
    } catch {
        return $false
    }
}

function Drain-ChildWithoutForce {
    param([int]$InitialWaitMilliseconds = 5000)

    if ($null -eq $script:Child) { return $true }
    [void](Request-ChildGracefulExit)
    try { if ($script:Child.WaitForExit($InitialWaitMilliseconds)) { return $true } } catch { }

    # Keep the guard mutex and child supervision relationship when state is unobservable.
    # Never publish a live child as stopped and never use TerminateProcess. The finally block
    # releases ownership only after the child actually exits.
    while ($true) {
        try { if ($script:Child.HasExited) { return $true } } catch { return $false }
        Start-Sleep -Milliseconds $PollMilliseconds
        [void](Request-ChildGracefulExit)
    }
}

function Test-JsonTrayStateShape {
    param([AllowNull()][object]$State)

    if ($null -eq $State) { return $false }
    $status = [string](Get-PropertyValue -Object $State -Name 'status')
    if (@('running', 'stopped') -notcontains $status) { return $false }
    $pidValue = 0
    if (-not [int]::TryParse([string](Get-PropertyValue -Object $State -Name 'pid'), [ref]$pidValue)) { return $false }
    if ($pidValue -le 0) { return $false }
    $startTicks = 0L
    if (-not [int64]::TryParse([string](Get-PropertyValue -Object $State -Name 'process_start_ticks'), [ref]$startTicks) -or $startTicks -le 0) { return $false }
    if ([string]::IsNullOrWhiteSpace([string](Get-PropertyValue -Object $State -Name 'session_id'))) { return $false }
    if ([string]::IsNullOrWhiteSpace([string](Get-PropertyValue -Object $State -Name 'process_name'))) { return $false }
    if ([string]::IsNullOrWhiteSpace([string](Get-PropertyValue -Object $State -Name 'process_path'))) { return $false }
    if ([string]::IsNullOrWhiteSpace([string](Get-PropertyValue -Object $State -Name 'process_command_line'))) { return $false }
    if ($null -eq (Convert-ToUtcDateTimeOffset -Value (Get-PropertyValue -Object $State -Name 'started_at'))) { return $false }
    if ($null -eq (Convert-ToUtcDateTimeOffset -Value (Get-PropertyValue -Object $State -Name 'updated_at'))) { return $false }
    if ($status -eq 'running' -and [string]::IsNullOrWhiteSpace([string](Get-PropertyValue -Object $State -Name 'exit_event_name'))) { return $false }
    return $true
}

function Convert-ToExitCodeOrUnknown {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return 'unknown' }
    $text = [string]$Value
    if ($text -eq 'unknown') { return 'unknown' }
    $number = 0
    if ([int]::TryParse($text, [ref]$number)) { return $number }
    return 'unknown'
}

function Test-NormalTrayExitReason {
    param([AllowNull()][string]$Reason)

    return (@('manual', 'normal', 'duplicate', 'idempotent', 'active_stop', 'active_uninstall') -contains $Reason)
}

function Test-ConfirmedAbnormalTrayExit {
    param([AllowNull()][string]$Reason)

    return (@('initialization_exception', 'runtime_exception') -contains $Reason)
}

function Get-TrayExitAssessment {
    param(
        [Parameter(Mandatory)][int]$ChildPid,
        [Parameter(Mandatory)][object]$ChildExitCode,
        [Parameter(Mandatory)][DateTimeOffset]$ChildStartedAt,
        [AllowNull()][object]$PreState,
        [AllowNull()][string]$ExpectedSessionId = ''
    )

    $document = Read-JsonDocument -Path $script:TrayStatePath
    if (-not $document.Valid) {
        return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'tray_state_corrupt'; ChildExitCode = 'unknown'; Message = $document.Error }
    }
    if (-not $document.Exists) {
        return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'tray_state_missing'; ChildExitCode = (Convert-ToExitCodeOrUnknown $ChildExitCode); Message = 'tray-state.json is missing; the exit reason cannot be confirmed, so recovery is disabled.' }
    }
    if (-not (Test-JsonTrayStateShape -State $document.Data)) {
        return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'tray_state_invalid'; ChildExitCode = 'unknown'; Message = 'tray-state.json fields are invalid; recovery is disabled.' }
    }

    $state = $document.Data
    $status = [string](Get-PropertyValue -Object $state -Name 'status')
    $statePid = 0
    [void][int]::TryParse([string](Get-PropertyValue -Object $state -Name 'pid'), [ref]$statePid)
    $childCode = Convert-ToExitCodeOrUnknown -Value $ChildExitCode

    if ($status -eq 'running') {
        $otherAlive = $false
        if ($statePid -gt 0 -and $statePid -ne $ChildPid) {
            $otherAlive = Test-ProcessMatchesTray -ProcessId $statePid -StartedAt (Get-PropertyValue -Object $state -Name 'started_at') -ExpectedStartTicks (Get-PropertyValue -Object $state -Name 'process_start_ticks') -ExpectedTrayPath $script:TrayPath -ExpectedPwshPath $script:PwshPath
        }
        if ($otherAlive -and $childCode -eq 0) {
            return [pscustomobject]@{ Ok = $true; ExitCode = 0; Reason = 'duplicate_running_instance'; ChildExitCode = 0; Message = 'Another verified tray instance is still running.' }
        }
        return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'running_state_after_exit'; ChildExitCode = $childCode; Message = 'The tray state is still running after process exit; the exit reason cannot be confirmed, so recovery is disabled.' }
    }

    $reason = [string](Get-PropertyValue -Object $state -Name 'last_exit_reason')
    $stateCode = Convert-ToExitCodeOrUnknown -Value (Get-PropertyValue -Object $state -Name 'last_exit_code')
    $updatedAt = Convert-ToUtcDateTimeOffset -Value (Get-PropertyValue -Object $state -Name 'updated_at')
    if ($null -eq $updatedAt) {
        return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'tray_state_timestamp_invalid'; ChildExitCode = $childCode; Message = 'tray-state.json updated_at cannot be parsed; recovery is disabled.' }
    }
    if ($updatedAt -lt $ChildStartedAt.AddSeconds(-2)) {
        return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'tray_state_stale'; ChildExitCode = $childCode; Message = "The exit state predates this guard and cannot be attributed to the current tray; recovery is disabled. state=$updatedAt child=$ChildStartedAt" }
    }
    if ($statePid -ne $ChildPid) {
        return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'tray_state_pid_mismatch'; ChildExitCode = $childCode; Message = 'The exit-state PID does not match the current tray PID; recovery is disabled.' }
    }
    $stateTicks = 0L
    if (-not [int64]::TryParse([string](Get-PropertyValue -Object $state -Name 'process_start_ticks'), [ref]$stateTicks) -or $stateTicks -ne [int64]$ChildStartedAt.UtcTicks) {
        return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'tray_state_process_identity_mismatch'; ChildExitCode = $childCode; Message = 'The exit-state process start time does not match the current tray; recovery is disabled.' }
    }
    $stateSession = [string](Get-PropertyValue -Object $state -Name 'session_id')
    if ([string]::IsNullOrWhiteSpace($ExpectedSessionId) -or [string]::IsNullOrWhiteSpace($stateSession) -or $stateSession -ne $ExpectedSessionId) {
        return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'tray_state_session_mismatch'; ChildExitCode = $childCode; Message = 'The exit-state session does not match the current tray or could not be verified; recovery is disabled.' }
    }
    $stateStarted = Convert-ToUtcDateTimeOffset -Value (Get-PropertyValue -Object $state -Name 'started_at')
    if ($null -eq $stateStarted -or [math]::Abs(($stateStarted.ToUniversalTime() - $ChildStartedAt.ToUniversalTime()).TotalSeconds) -gt 45) {
        return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'tray_state_start_time_mismatch'; ChildExitCode = $childCode; Message = 'The exit-state start time does not match the current tray; recovery is disabled.' }
    }
    if ($childCode -eq 'unknown' -or $stateCode -eq 'unknown') {
        return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'tray_exit_unverified'; ChildExitCode = $childCode; Message = 'The exit code is unknown, so abnormal exit cannot be confirmed; recovery is disabled.' }
    }
    if ($childCode -ne $stateCode) {
        return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'tray_exit_code_mismatch'; ChildExitCode = $childCode; Message = 'The tray exit code does not match the state record; recovery is disabled.' }
    }
    if (Test-NormalTrayExitReason -Reason $reason -and $childCode -eq 0 -and $stateCode -eq 0) {
        return [pscustomobject]@{ Ok = $true; ExitCode = 0; Reason = $reason; ChildExitCode = 0; Message = [string](Get-PropertyValue -Object $state -Name 'last_message') }
    }
    if (Test-ConfirmedAbnormalTrayExit -Reason $reason -and $childCode -ne 0 -and $stateCode -ne 0) {
        return [pscustomobject]@{ Ok = $false; ExitCode = 1; Reason = $reason; ChildExitCode = $childCode; Message = [string](Get-PropertyValue -Object $state -Name 'last_message') }
    }
    return [pscustomobject]@{ Ok = $false; ExitCode = 0; Reason = 'tray_exit_unverified'; ChildExitCode = $childCode; Message = 'The exit state does not satisfy the confirmed-abnormal-exit conditions; recovery is disabled.' }
}

function Read-CurrentControlRequest {
    $document = Read-JsonDocument -Path $script:GuardControlPath
    if (-not $document.Exists) { return $null }
    if (-not $document.Valid) {
        $script:ControlFileCorrupt = $true
        return $null
    }
    $session = [string](Get-PropertyValue -Object $document.Data -Name 'session_id')
    $action = [string](Get-PropertyValue -Object $document.Data -Name 'action')
    if ($session -ne $script:SessionId -or @('stop', 'uninstall') -notcontains $action) { return $null }
    return $document.Data
}

function Write-GuardResult {
    param([Parameter(Mandatory)][object]$Result)

    try {
        Write-Output ('RESULT_JSON=' + (ConvertTo-Json -InputObject $Result -Compress -Depth 12))
    } catch {
        Write-Output 'RESULT_JSON={"component":"tray-guard","ok":false,"reason":"result_serialization_failed","exit_code":2}'
    }
}

try {
    $rawRoot = if ([string]::IsNullOrWhiteSpace($RootPath)) { $PSScriptRoot } else { $RootPath }
    $script:Root = Get-CanonicalRoot -Path $rawRoot
    $script:GuardScriptPath = Get-FullPath -Path $PSCommandPath
    $script:TrayPath = if ([string]::IsNullOrWhiteSpace($TrayScriptPath)) { Join-Path $script:Root 'tray.ps1' } else { Get-FullPath -Path $TrayScriptPath }
    if (-not (Test-Path -LiteralPath $script:TrayPath -PathType Leaf)) { throw "tray.ps1 not found: $script:TrayPath" }
    $script:PwshPath = Resolve-PwshPath
    $script:GuardProcessIdentity = Get-ProcessIdentity -ProcessId $PID
    if ($null -eq $script:GuardProcessIdentity) { throw 'Could not read the guard process identity; refusing to start an unsupervised tray.' }
    $script:RootHash = (Get-Sha256Hex -Value $script:Root).Substring(0, 12)
    $expectedMarker = "MAARemote-P2-TrayGuard-$($script:RootHash)"
    if ([string]::IsNullOrWhiteSpace($ProjectMarker)) { $script:ProjectMarkerValue = $expectedMarker } else { $script:ProjectMarkerValue = $ProjectMarker }
    if ($script:ProjectMarkerValue -ne $expectedMarker) { throw 'The project identity marker does not match.' }

    $script:LogsDir = Join-Path $script:Root 'logs'
    $script:TrayStatePath = Join-Path $script:LogsDir 'tray-state.json'
    $script:GuardStatePath = Join-Path $script:LogsDir 'tray-guard-state.json'
    $script:GuardEventLog = Join-Path $script:LogsDir 'tray-guard-events.log'
    $script:GuardControlPath = Join-Path $script:LogsDir 'tray-guard-control.json'
    $script:Outcome.root = $script:Root
    $script:Outcome.tray_script = $script:TrayPath
    $script:Outcome.pwsh_path = $script:PwshPath
    $script:Outcome.session_id = $script:SessionId

    $preTray = Read-JsonDocument -Path $script:TrayStatePath
    if ($preTray.Exists -and (-not $preTray.Valid -or -not (Test-JsonTrayStateShape -State $preTray.Data))) {
        $script:PreviousTrayStateCorrupt = $true
        [void](Write-GuardEvent -Event 'previous_tray_state_invalid' -Reason 'state_corrupt' -Message $preTray.Error)
    }
    $preGuard = Read-JsonDocument -Path $script:GuardStatePath
    if ($preGuard.Exists -and (-not $preGuard.Valid)) {
        $script:PreviousGuardStateCorrupt = $true
        [void](Write-GuardEvent -Event 'previous_guard_state_invalid' -Reason 'state_corrupt' -Message $preGuard.Error)
    }

    $mutexName = "Local\MAARemoteP2TrayGuard_$($script:RootHash)"
    $script:GuardMutex = [System.Threading.Mutex]::new($false, $mutexName)
    try {
        $script:GuardMutexHeld = $script:GuardMutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $script:GuardMutexHeld = $true
    }

    if (-not $script:GuardMutexHeld) {
        $script:ExitCode = 0
        $script:Outcome.ok = $true
        $script:Outcome.reason = 'duplicate_guard_instance'
        $script:Outcome.exit_code = 0
        [void](Write-GuardEvent -Event 'guard_duplicate' -Reason 'duplicate_guard_instance' -ExitCode 0)
    } else {
        # The old snapshot is diagnostic only before acquiring the mutex. Identity,
        # duplicate-instance, and startup decisions must reread state under the lock.
        $preTray = Read-JsonDocument -Path $script:TrayStatePath
        $preGuard = Read-JsonDocument -Path $script:GuardStatePath
        if ($preTray.Exists -and (-not $preTray.Valid -or -not (Test-JsonTrayStateShape -State $preTray.Data))) {
            $script:PreviousTrayStateCorrupt = $true
            [void](Write-GuardEvent -Event 'previous_tray_state_invalid' -Reason 'state_corrupt' -Message $preTray.Error)
        }
        if ($preGuard.Exists -and (-not $preGuard.Valid)) {
            $script:PreviousGuardStateCorrupt = $true
            [void](Write-GuardEvent -Event 'previous_guard_state_invalid' -Reason 'state_corrupt' -Message $preGuard.Error)
        }
        $script:Outcome.started_at = (Get-Date).ToUniversalTime().ToString('o')
        $previousGuardRunning = $false
        if ($preGuard.Valid -and $preGuard.Exists -and [string](Get-PropertyValue -Object $preGuard.Data -Name 'status') -eq 'running') {
            $previousGuardRunning = $true
            [void](Write-GuardEvent -Event 'previous_guard_not_verified' -Reason 'stale_running_state' -Message 'The old state was still running after this guard acquired the mutex; it is not treated as a normal exit.')
        }
        if (-not (Write-GuardState -Status 'running' -Reason 'started' -ChildPid 0 -Message 'The guard process started.')) {
            throw "Could not write tray-guard-state.json; refusing to start the tray: $($script:StateWriteError)"
        }
        $script:RuntimeStarted = $true
        $guardStartReason = if ($previousGuardRunning) { 'recover_previous_guard' } else { 'start' }
        [void](Write-GuardEvent -Event 'guard_start' -Reason $guardStartReason)

        $preStatus = [string](Get-PropertyValue -Object $preTray.Data -Name 'status')
        $prePid = 0
        [void][int]::TryParse([string](Get-PropertyValue -Object $preTray.Data -Name 'pid'), [ref]$prePid)
        $existingTrayAlive = $false
        if ($preTray.Valid -and $preTray.Exists -and $preStatus -eq 'running') {
            $existingTrayAlive = Test-ProcessMatchesTray -ProcessId $prePid -StartedAt (Get-PropertyValue -Object $preTray.Data -Name 'started_at') -ExpectedStartTicks (Get-PropertyValue -Object $preTray.Data -Name 'process_start_ticks') -ExpectedTrayPath $script:TrayPath -ExpectedPwshPath $script:PwshPath
        }

        if ($existingTrayAlive) {
            $script:ExitCode = 0
            $script:Outcome.ok = $true
            $script:Outcome.reason = 'duplicate_tray_instance'
            $script:Outcome.exit_code = 0
            $script:Outcome.child_pid = $prePid
            $script:Outcome.child_exit_code = 0
            [void](Write-GuardEvent -Event 'tray_duplicate' -Reason 'duplicate_tray_instance' -ExitCode 0 -ChildPid $prePid)
        } else {
          do {
            $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
            $startInfo.FileName = $script:PwshPath
            $startInfo.WorkingDirectory = $script:Root
            $startInfo.UseShellExecute = $false
            $startInfo.CreateNoWindow = $true
            [void]$startInfo.ArgumentList.Add('-NoLogo')
            [void]$startInfo.ArgumentList.Add('-NoProfile')
            [void]$startInfo.ArgumentList.Add('-Sta')
            [void]$startInfo.ArgumentList.Add('-WindowStyle')
            [void]$startInfo.ArgumentList.Add('Hidden')
            [void]$startInfo.ArgumentList.Add('-File')
            [void]$startInfo.ArgumentList.Add($script:TrayPath)
            # Capture the session before starting the child so even a fast initialization
            # failure can be checked with PID and start time.
            $script:ChildSessionId = [guid]::NewGuid().ToString('N')
            $childExitEventName = 'Local\MAARemoteTray.Exit.' + $script:ChildSessionId
            $childEventCreated = $false
            $script:ChildExitEvent = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::ManualReset, $childExitEventName, [ref]$childEventCreated)
            if ($null -eq $script:ChildExitEvent) { throw 'Could not create the graceful tray-exit event; refusing to start the child.' }
            $startInfo.Environment['MAAREMOTE_TRAY_SESSION_ID'] = $script:ChildSessionId
            $script:Child = [System.Diagnostics.Process]::Start($startInfo)
            if ($null -eq $script:Child) { throw 'Could not start tray.ps1.' }
            $script:ChildPid = $script:Child.Id
            $script:Outcome.child_pid = $script:ChildPid
            $script:ChildStartedAt = [DateTimeOffset]$script:Child.StartTime.ToUniversalTime()
            if (-not (Write-GuardState -Status 'running' -Reason 'supervise' -ChildPid $script:ChildPid)) {
                $script:StateWriteFailed = $true
                [void](Drain-ChildWithoutForce -InitialWaitMilliseconds 5000)
                throw 'Could not publish the started child identity; a graceful tray exit was requested.'
            }
            [void](Write-GuardEvent -Event 'tray_start' -Reason 'supervise' -ChildPid $script:ChildPid)

            $stopRequested = $false
            while (-not $script:Child.HasExited) {
                $control = Read-CurrentControlRequest
                if ($null -ne $control) {
                    $stopRequested = $true
                    $script:RequestedExitReason = [string](Get-PropertyValue -Object $control -Name 'action')
                    if ($script:RequestedExitReason -eq 'stop') { $script:RequestedExitReason = 'active_stop' }
                    if ($script:RequestedExitReason -eq 'uninstall') { $script:RequestedExitReason = 'active_uninstall' }
                    $script:RequestedExitMessage = 'Received a verified intentional stop request.'
                    [void](Write-GuardEvent -Event 'guard_control_request' -Reason $script:RequestedExitReason -ExitCode 0 -ChildPid $script:ChildPid)
                    $trayDocument = Read-JsonDocument -Path $script:TrayStatePath
                    $exitEventName = if ($script:ChildSessionId) { 'Local\MAARemoteTray.Exit.' + $script:ChildSessionId } else { '' }
                    if ($trayDocument.Valid -and $trayDocument.Exists -and [string](Get-PropertyValue -Object $trayDocument.Data -Name 'status') -eq 'running') {
                        $trayPid = 0
                        [void][int]::TryParse([string](Get-PropertyValue -Object $trayDocument.Data -Name 'pid'), [ref]$trayPid)
                        if ($trayPid -eq $script:ChildPid) { $exitEventName = [string](Get-PropertyValue -Object $trayDocument.Data -Name 'exit_event_name') }
                    }
                    if (-not (Stop-VerifiedTrayChild -ProcessId $script:ChildPid -ExpectedStartTicks ([int64]$script:ChildStartedAt.Ticks) -ExitEventName $exitEventName)) {
                        $script:RequestedExitReason = 'active_stop_unverified'
                        $script:RequestedExitMessage = 'The tray child identity or graceful-exit event could not be verified; process termination and recovery are disabled.'
                    } else {
                        $exited = $false
                        try { $exited = [bool]$script:Child.WaitForExit(5000) } catch { }
                        if (-not $exited) {
                            $script:RequestedExitReason = 'active_stop_unverified'
                            $script:RequestedExitMessage = 'The tray did not exit gracefully within 5 seconds; force-kill and recovery are disabled.'
                        }
                    }
                    break
                }
                Start-Sleep -Milliseconds $PollMilliseconds
            }

            if ($stopRequested) {
                # An unverified intentional stop must still exit 0; otherwise Scheduler
                # could mistake an observation failure for a tray crash and restart it.
                $script:ExitCode = 0
                $script:Outcome.ok = ($script:RequestedExitReason -ne 'active_stop_unverified')
                $script:Outcome.reason = $script:RequestedExitReason
                $script:Outcome.exit_code = $script:ExitCode
                $script:Outcome.child_exit_code = if ($script:Child.HasExited) { $script:Child.ExitCode } else { 'unknown' }
            } else {
                $childExit = 'unknown'
                try { $childExit = $script:Child.ExitCode } catch { }
                $assessment = Get-TrayExitAssessment -ChildPid $script:ChildPid -ChildExitCode $childExit -ChildStartedAt $script:ChildStartedAt -PreState $preTray.Data -ExpectedSessionId $script:ChildSessionId
                $script:ExitCode = [int]$assessment.ExitCode
                $script:Outcome.ok = [bool]$assessment.Ok
                $script:Outcome.reason = [string]$assessment.Reason
                $script:Outcome.exit_code = $script:ExitCode
                $script:Outcome.child_exit_code = $assessment.ChildExitCode
                [void](Write-GuardEvent -Event 'tray_exit' -Reason ([string]$assessment.Reason) -ExitCode $assessment.ChildExitCode -ChildPid $script:ChildPid -Message ([string]$assessment.Message))
            }
            if ($script:ExitCode -eq 0 -or $stopRequested -or $script:EventLogWriteFailed -or $script:StateWriteFailed) { break }
            if ($script:RestartCount -ge $script:RestartLimit) {
                $script:Outcome.reason = 'retry_limit_reached'
                $script:Outcome.restart_count = $script:RestartCount
                break
            }
            $script:RestartCount++
            $script:Outcome.restart_count = $script:RestartCount
            [void](Write-GuardEvent -Event 'tray_retry_pending' -Reason $script:Outcome.reason -ExitCode $script:ExitCode -ChildPid $script:ChildPid -Message ('Confirmed tray failure; recovery attempt {1}/{2} starts in {0} seconds.' -f $script:RestartIntervalSeconds, $script:RestartCount, $script:RestartLimit))
            if ($script:EventLogWriteFailed) { break }
            $retryAt = [DateTimeOffset]::UtcNow.AddSeconds($script:RestartIntervalSeconds)
            while ([DateTimeOffset]::UtcNow -lt $retryAt) {
                $control = Read-CurrentControlRequest
                if ($null -ne $control) {
                    $script:ExitCode = 0
                    $script:Outcome.exit_code = 0
                    $script:Outcome.ok = $true
                    $script:Outcome.reason = if ([string](Get-PropertyValue -Object $control -Name 'action') -eq 'uninstall') { 'active_uninstall' } else { 'active_stop' }
                    $stopRequested = $true
                    break
                }
                Start-Sleep -Milliseconds $PollMilliseconds
            }
            if ($stopRequested) { break }
            try { $script:Child.Dispose() } catch { }
            try { if ($script:ChildExitEvent) { $script:ChildExitEvent.Dispose() } } catch { }
            $script:ChildExitEvent = $null
            $script:Child = $null
          } while ($true)
        }

    }
} catch {
    $message = $_.Exception.Message
    if ($script:StateWriteFailed -and $null -eq $script:Child) {
        # An unwritable observation file is not a tray failure; do not start a
        # scheduled-task restart loop for it.
        $script:ExitCode = 0
        $script:Outcome.ok = $false
        $script:Outcome.reason = 'observability_unavailable'
    } else {
        $script:ExitCode = if ($script:ExitCode -eq 0) { 2 } else { $script:ExitCode }
        $script:Outcome.ok = $false
        $script:Outcome.reason = 'guard_error'
    }
    $script:Outcome.exit_code = $script:ExitCode
    $script:Outcome.message = $message
    [void](Write-GuardEvent -Event 'guard_error' -Reason 'guard_error' -ExitCode $script:ExitCode -ChildPid $script:ChildPid -Message $message)
} finally {
    if ($script:RuntimeStarted) {
        $childLive = $false
        if ($null -ne $script:Child) {
            try { $childLive = -not $script:Child.HasExited } catch { $childLive = $true }
        }
        if ($childLive) {
            [void](Drain-ChildWithoutForce -InitialWaitMilliseconds 5000)
            while ($true) {
                try { if ($script:Child.HasExited) { $childLive = $false; break } } catch { }
                Start-Sleep -Milliseconds $PollMilliseconds
                [void](Request-ChildGracefulExit)
            }
        }
        $stateReason = if ($script:Outcome.ok) { [string]$script:Outcome.reason } else { [string]$script:Outcome.reason }
        # exit_code represents the guard process only; the tray child code is stored
        # separately as child_exit_code. An unverified exit returns 0 so the child
        # code is never presented as a confirmed guard failure.
        $stateCode = $script:ExitCode
        $stateMessage = if ($script:Outcome.Contains('message')) { [string]$script:Outcome.message } else { $script:RequestedExitMessage }
        $stateWritten = Write-GuardState -Status 'stopped' -Reason $stateReason -ExitCode $stateCode -ChildPid $script:ChildPid -ChildExitCode $script:Outcome.child_exit_code -Message $stateMessage
        if (-not $stateWritten) {
            # If the final observation state cannot be written, no child exit code
            # can be confirmed; return 0 to prevent an incorrect task restart.
            $script:ExitCode = 0
            $script:Outcome.ok = $false
            $script:Outcome.reason = 'observability_unavailable'
            $script:Outcome.exit_code = 0
            $script:Outcome.message = if ($script:StateWriteError) { $script:StateWriteError } else { 'Could not write the final guard state; recovery is disabled.' }
        }
    }
    try { if ($script:ChildExitEvent) { $script:ChildExitEvent.Dispose() } } catch { }
    try { if ($script:Child) { $script:Child.Dispose() } } catch { }
    if ($script:GuardMutexHeld -and $null -ne $script:GuardMutex) {
        try { [void]$script:GuardMutex.ReleaseMutex() } catch { }
    }
    if ($null -ne $script:GuardMutex) {
        try { $script:GuardMutex.Dispose() } catch { }
    }
    $script:Outcome.exit_code = $script:ExitCode
}

Write-GuardResult -Result $script:Outcome
exit $script:ExitCode
