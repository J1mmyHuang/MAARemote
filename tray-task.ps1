# SPDX-License-Identifier: MPL-2.0
# MAARemote P2: scheduled-task tray guard manager
#
# The default action is status. install / uninstall modify the current user's
# scheduled task or HKCU Run. Use -WhatIf, a unique temporary task name, or an
# isolated copy for validation. Loading this file never registers a task or edits the registry.
#
# The ScheduledTasks LogonType enum is Interactive; exported Task Scheduler XML
# uses InteractiveToken. The exported XML is checked explicitly.

[CmdletBinding()]
param(
    [string]$Action = 'status',
    [switch]$MigrateRun,
    [switch]$WhatIf,
    [string]$RootPath = '',
    [ValidateRange(1, 60)]
    [int]$GuardStopTimeoutSeconds = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Console]::IsOutputRedirected) {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
}

$script:ExitCode = 1
$script:Identity = [ordered]@{
    root            = ''
    root_hash       = ''
    project_marker  = ''
    task_name       = ''
    task_path       = '\'
    tray_script     = ''
    guard_script    = ''
    pwsh_path       = ''
    run_key         = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    run_value_name  = 'MAARemoteTray'
    current_user    = ''
}
$script:MigrationPath = ''
$script:LogsDir = ''
$script:CreatedTaskThisRun = $false
$script:TaskRegistrationAccessDenied = $false
$script:Result = [ordered]@{
    component = 'tray-task'
    action    = $Action
    ok        = $false
    reason    = 'not_started'
}

function Get-FullPath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Path cannot be empty.' }
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    return [System.IO.Path]::GetFullPath($resolved.Path)
}

function Get-CanonicalRoot {
    param([Parameter(Mandatory)][string]$Path)

    return (Get-FullPath -Path $Path).TrimEnd([char]92).ToLowerInvariant()
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

function Read-JsonDocument {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{ Exists = $false; Valid = $true; Data = $null; Error = '' }
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
        if ([string]::IsNullOrWhiteSpace($raw)) { throw 'The JSON file is empty.' }
        $data = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
        if ($null -eq $data) { throw 'The JSON file does not contain an object.' }
        return [pscustomobject]@{ Exists = $true; Valid = $true; Data = $data; Error = '' }
    } catch {
        return [pscustomobject]@{ Exists = $true; Valid = $false; Data = $null; Error = $_.Exception.Message }
    }
}

function Write-JsonAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Value
    )

    $temp = '{0}.{1}.{2}.tmp' -f $Path, $PID, ([guid]::NewGuid().ToString('N'))
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
            $stream = [System.IO.File]::Open($temp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
            $stream.Dispose()
            $stream = $null
            [System.IO.File]::Move($temp, $Path, $true)
            return $true
        } catch [System.IO.IOException] {
            $lastError = $_.Exception
            if ($attempt -lt 3) { Start-Sleep -Milliseconds (25 * $attempt) }
        } catch {
            $lastError = $_.Exception
            break
        } finally {
            if ($stream) { try { $stream.Dispose() } catch { } }
            if (Test-Path -LiteralPath $temp -PathType Leaf) {
                try { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue } catch { }
            }
        }
    }
    return $false
}

function Resolve-PwshPath {
    $candidates = [System.Collections.Generic.List[string]]::new()
    $traditional = Join-Path -Path ${env:ProgramFiles} -ChildPath 'PowerShell\7\pwsh.exe'
    if (Test-Path -LiteralPath $traditional -PathType Leaf) { [void]$candidates.Add($traditional) }

    # The Store pwsh PATH shim is not a stable task executable; use the installed package path.
    try {
        if (Get-Command -Name 'Get-AppxPackage' -ErrorAction SilentlyContinue) {
            $packages = @(Get-AppxPackage -Name 'Microsoft.PowerShell' -ErrorAction Stop | Sort-Object Version -Descending)
            foreach ($package in $packages) {
                if ($package.InstallLocation) {
                    [void]$candidates.Add((Join-Path ([string]$package.InstallLocation) 'pwsh.exe'))
                }
            }
        }
    } catch { }

    try {
        foreach ($command in @(Get-Command -Name 'pwsh.exe' -All -ErrorAction Stop)) {
            if ($command.Source) { [void]$candidates.Add([string]$command.Source) }
        }
    } catch { }
    [void]$candidates.Add((Join-Path -Path $PSHOME -ChildPath 'pwsh.exe'))

    foreach ($candidate in $candidates) {
        try {
            $full = [System.IO.Path]::GetFullPath($candidate)
            if (Test-Path -LiteralPath $full -PathType Leaf) { return $full }
        } catch { }
    }
    throw 'Could not resolve an executable absolute path for pwsh.exe.'
}

function Get-CurrentUserName {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity -or [string]::IsNullOrWhiteSpace($identity.Name)) { throw 'Could not read the current Windows user.' }
    return $identity.Name
}

function Get-NormalizedPath {
    param([AllowNull()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    try { return ([System.IO.Path]::GetFullPath($Path)).TrimEnd([char]92).ToLowerInvariant() } catch { return '' }
}

function Test-PathEqual {
    param(
        [AllowNull()][string]$Left,
        [AllowNull()][string]$Right
    )

    $a = Get-NormalizedPath -Path $Left
    $b = Get-NormalizedPath -Path $Right
    return ($a -and $b -and $a -eq $b)
}

function Quote-WindowsCommandLineArgument {
    param([AllowNull()][string]$Value)

    if ($null -eq $Value) { $Value = '' }
    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $slashCount = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]92) {
            $slashCount++
            continue
        }
        if ($character -eq [char]34) {
            if ($slashCount -gt 0) { [void]$builder.Append(('\' * (($slashCount * 2) + 1))) }
            [void]$builder.Append('"')
            $slashCount = 0
            continue
        }
        if ($slashCount -gt 0) { [void]$builder.Append(('\' * $slashCount)) }
        [void]$builder.Append($character)
        $slashCount = 0
    }
    if ($slashCount -gt 0) { [void]$builder.Append(('\' * ($slashCount * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function New-GuardArgumentString {
    $tokens = @(
        '-NoLogo',
        '-NoProfile',
        '-Sta',
        '-WindowStyle',
        'Hidden',
        '-File',
        (Quote-WindowsCommandLineArgument -Value $script:Identity.guard_script),
        '-ProjectMarker',
        (Quote-WindowsCommandLineArgument -Value $script:Identity.project_marker)
    )
    return ($tokens -join ' ')
}

function Get-ExpectedRunCommand {
    $pwsh = Quote-WindowsCommandLineArgument -Value $script:Identity.pwsh_path
    $tray = Quote-WindowsCommandLineArgument -Value $script:Identity.tray_script
    return "$pwsh -NoProfile -Sta -WindowStyle Hidden -File $tray"
}

function Get-RunValueSnapshot {
    $snapshot = [ordered]@{
        present = $false
        readable = $true
        value = ''
        error = ''
    }
    try {
        if (-not (Test-Path -LiteralPath $script:Identity.run_key -PathType Container)) { return [pscustomobject]$snapshot }
        $item = Get-ItemProperty -LiteralPath $script:Identity.run_key -Name $script:Identity.run_value_name -ErrorAction Stop
        $property = $item.PSObject.Properties[$script:Identity.run_value_name]
        if ($null -ne $property) {
            $snapshot.present = $true
            $snapshot.value = [string]$property.Value
        }
    } catch {
        if ($_.Exception.Message -match 'cannot find|\u627e\u4e0d\u5230|\u4e0d\u5b58\u5728|does not exist') {
            return [pscustomobject]$snapshot
        }
        $snapshot.readable = $false
        $snapshot.error = $_.Exception.Message
    }
    return [pscustomobject]$snapshot
}

function Test-ProjectRunValue {
    param([Parameter(Mandatory)][object]$RunSnapshot)

    if (-not $RunSnapshot.readable -or -not $RunSnapshot.present) { return $false }
    $value = [string]$RunSnapshot.value
    $match = [regex]::Match(
        $value,
        '^\s*(?:"(?<exe>[^"]+)"|(?<exe>\S+))\s+-noprofile\s+-sta\s+-windowstyle\s+hidden\s+-file\s+(?:"(?<tray>[^"]+)"|(?<tray>\S+))\s*$',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if (-not $match.Success) { return $false }
    $exe = [string]$match.Groups['exe'].Value
    $tray = [string]$match.Groups['tray'].Value
    if ([IO.Path]::GetFileName($exe) -notmatch '(?i)^pwsh(?:\.exe)?$') { return $false }
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $false }
    return (Test-PathEqual -Left $tray -Right $script:Identity.tray_script)
}

function Test-TaskNotFoundError {
    param([Parameter(Mandatory)][System.Management.Automation.ErrorRecord]$ErrorRecord)

            # ScheduledTasks messages are localized; prefer stable cmdlet error IDs.
            # Only an empty result for the requested Get-ScheduledTask query is absent.
    $category = [string]$ErrorRecord.CategoryInfo.Category
    if ($category -ne 'ObjectNotFound') { return $false }

    $fullyQualifiedId = [string]$ErrorRecord.FullyQualifiedErrorId
    if ($fullyQualifiedId -match '(?i)^(?:CmdletizationQuery_NotFound|CmdletizationQuery_NotFound_TaskName|NoMatchingScheduledTaskFound),Get-ScheduledTask(?:,|$)') {
        return $true
    }

    # Some Windows/PowerShell versions lack the stable IDs above. The fallback
    # still requires an explicit MSFT_ScheduledTask object-not-found message.
    $message = [string]$ErrorRecord.Exception.Message
    return ($message -match '(?i)(?:no matching|\u672a\u627e\u5230\u5339\u914d|\u6ca1\u6709\u627e\u5230\u5339\u914d).*MSFT_ScheduledTask')
}

function Test-TaskAccessDeniedError {
    param([Parameter(Mandatory)][System.Management.Automation.ErrorRecord]$ErrorRecord)

    $text = "{0} {1}" -f $ErrorRecord.FullyQualifiedErrorId, $ErrorRecord.Exception.Message
    $hResult = 0
    try { $hResult = [int]$ErrorRecord.Exception.HResult } catch { }
    return ($hResult -eq -2147024891 -or $text -match '(?i)access is denied|\u62d2\u7edd\u8bbf\u95ee|0x80070005')
}

function Get-TaskByExpectedName {
    try {
        return Get-ScheduledTask -TaskName $script:Identity.task_name -TaskPath $script:Identity.task_path -ErrorAction Stop | Select-Object -First 1
    } catch {
        if (Test-TaskNotFoundError -ErrorRecord $_) { return $null }
        throw "Could not read the scheduled task: $($_.Exception.Message)"
    }
}

function Get-TaskNameCollisions {
    try {
        return @(Get-ScheduledTask -TaskName $script:Identity.task_name -ErrorAction Stop)
    } catch {
        if (Test-TaskNotFoundError -ErrorRecord $_) { return @() }
        throw "Could not check same-name scheduled tasks: $($_.Exception.Message)"
    }
}

function Export-TaskXmlSafe {
    param([Parameter(Mandatory)][object]$Task)

    try {
        $raw = Export-ScheduledTask -TaskName ([string]$Task.TaskName) -TaskPath ([string]$Task.TaskPath) -ErrorAction Stop | Out-String
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return [xml]$raw
    } catch {
        return $null
    }
}

function Get-XmlNodeText {
    param(
        [AllowNull()][object]$Xml,
        [Parameter(Mandatory)][string]$XPath
    )

    if ($null -eq $Xml) { return '' }
    $documentElement = $Xml.DocumentElement
    if ($null -eq $documentElement) { return '' }
    $parts = @($XPath.Trim('/').Split('/') | Where-Object { $_ })
    if ($parts.Count -eq 0) { return '' }
    $query = '/' + (($parts | ForEach-Object { 't:' + $_ }) -join '/')
    $node = $null
    if (-not [string]::IsNullOrWhiteSpace([string]$documentElement.NamespaceURI)) {
        $manager = [System.Xml.XmlNamespaceManager]::new($Xml.NameTable)
        $manager.AddNamespace('t', [string]$documentElement.NamespaceURI)
        $node = $Xml.SelectSingleNode($query, $manager)
    } else {
        $node = $Xml.SelectSingleNode($XPath)
    }
    if ($null -eq $node) { return '' }
    return [string]$node.InnerText
}

function Test-XmlNodeExists {
    param(
        [AllowNull()][object]$Xml,
        [Parameter(Mandatory)][string]$XPath
    )

    if ($null -eq $Xml -or $null -eq $Xml.DocumentElement) { return $false }
    $parts = @($XPath.Trim('/').Split('/') | Where-Object { $_ })
    if ($parts.Count -eq 0) { return $false }
    $query = '/' + (($parts | ForEach-Object { 't:' + $_ }) -join '/')
    if (-not [string]::IsNullOrWhiteSpace([string]$Xml.DocumentElement.NamespaceURI)) {
        $manager = [System.Xml.XmlNamespaceManager]::new($Xml.NameTable)
        $manager.AddNamespace('t', [string]$Xml.DocumentElement.NamespaceURI)
        return ($null -ne $Xml.SelectSingleNode($query, $manager))
    }
    return ($null -ne $Xml.SelectSingleNode($XPath))
}

function Convert-XmlIntervalToSeconds {
    param([AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return -1 }
    try { return [int]([Xml.XmlConvert]::ToTimeSpan($Value).TotalSeconds) } catch { return -1 }
}

function Convert-TaskRunLevelToCanonical {
    param([AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    switch -Regex ($Value.Trim()) {
        '^(?i:Limited|LeastPrivilege|0)$' { return 'LeastPrivilege' }
        '^(?i:Highest|1)$' { return 'Highest' }
        default { return $Value.Trim() }
    }
}

function Get-TaskGenerationFingerprint {
    param([AllowNull()][object]$Xml)

    if ($null -eq $Xml) { return '' }
    $outerXml = [string]$Xml.OuterXml
    if ([string]::IsNullOrWhiteSpace($outerXml)) { return '' }
    return Get-Sha256Hex -Value $outerXml
}

function Get-TaskSnapshot {
    $task = Get-TaskByExpectedName
    if ($null -eq $task) {
        return [pscustomobject]@{
            exists = $false
            readable = $true
            task = $null
            xml = $null
            state = 'Absent'
            task_path = $script:Identity.task_path
            task_name = $script:Identity.task_name
            command = ''
            arguments = ''
            working_directory = ''
            description = ''
            trigger_type = ''
            trigger_user = ''
            principal_user = ''
            principal_logon_type = ''
            principal_run_level = ''
            multiple_instances = ''
            restart_count = ''
            restart_interval = ''
            execution_time_limit = ''
            allow_hard_terminate = ''
            task_generation = ''
            error = ''
        }
    }

    $xml = Export-TaskXmlSafe -Task $task
    $readable = $null -ne $xml
    $principalRunLevel = Get-XmlNodeText -Xml $xml -XPath '/Task/Principals/Principal/RunLevel'
    if ([string]::IsNullOrWhiteSpace($principalRunLevel)) {
        $principal = Get-PropertyValue -Object $task -Name 'Principal'
        $principalRunLevel = [string](Get-PropertyValue -Object $principal -Name 'RunLevel')
    }
    $multipleInstances = Get-XmlNodeText -Xml $xml -XPath '/Task/Settings/MultipleInstancesPolicy'
    if ([string]::IsNullOrWhiteSpace($multipleInstances)) {
        $multipleInstances = Get-XmlNodeText -Xml $xml -XPath '/Task/Settings/MultipleInstances'
    }
    [pscustomobject]@{
        exists = $true
        readable = $readable
        task = $task
        xml = $xml
        state = [string](Get-PropertyValue -Object $task -Name 'State')
        task_path = [string](Get-PropertyValue -Object $task -Name 'TaskPath')
        task_name = [string](Get-PropertyValue -Object $task -Name 'TaskName')
        command = Get-XmlNodeText -Xml $xml -XPath '/Task/Actions/Exec/Command'
        arguments = Get-XmlNodeText -Xml $xml -XPath '/Task/Actions/Exec/Arguments'
        working_directory = Get-XmlNodeText -Xml $xml -XPath '/Task/Actions/Exec/WorkingDirectory'
        description = Get-XmlNodeText -Xml $xml -XPath '/Task/RegistrationInfo/Description'
        trigger_type = if (Test-XmlNodeExists -Xml $xml -XPath '/Task/Triggers/LogonTrigger') { 'LogonTrigger' } else { '' }
        trigger_user = Get-XmlNodeText -Xml $xml -XPath '/Task/Triggers/LogonTrigger/UserId'
        principal_user = Get-XmlNodeText -Xml $xml -XPath '/Task/Principals/Principal/UserId'
        principal_logon_type = Get-XmlNodeText -Xml $xml -XPath '/Task/Principals/Principal/LogonType'
        principal_run_level = Convert-TaskRunLevelToCanonical -Value $principalRunLevel
        multiple_instances = $multipleInstances
        restart_count = Get-XmlNodeText -Xml $xml -XPath '/Task/Settings/RestartOnFailure/Count'
        restart_interval = Get-XmlNodeText -Xml $xml -XPath '/Task/Settings/RestartOnFailure/Interval'
        execution_time_limit = Get-XmlNodeText -Xml $xml -XPath '/Task/Settings/ExecutionTimeLimit'
        allow_hard_terminate = Get-XmlNodeText -Xml $xml -XPath '/Task/Settings/AllowHardTerminate'
        registration_date = Get-XmlNodeText -Xml $xml -XPath '/Task/RegistrationInfo/Date'
        task_generation = Get-TaskGenerationFingerprint -Xml $xml
        error = if ($readable) { '' } else { 'Could not export scheduled-task XML.' }
    }
}

function Test-CurrentUserValue {
    param([AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $candidate = $Value.Trim().ToLowerInvariant()
    if ($candidate -eq $script:Identity.current_user.Trim().ToLowerInvariant()) { return $true }
    try {
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value.ToLowerInvariant()
        return ($candidate -eq $sid)
    } catch { return $false }
}

function Test-ExactProcessCommandLine {
    param(
        [AllowNull()][string]$CommandLine,
        [Parameter(Mandatory)][string]$ExpectedExecutable,
        [Parameter(Mandatory)][string]$ExpectedArguments
    )
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    $match = [regex]::Match($CommandLine.Trim(), '^(?:"(?<exe>[^"]+)"|(?<exe>\S+))\s+(?<args>.*)$')
    if (-not $match.Success) { return $false }
    if (-not (Test-PathEqual -Left $match.Groups['exe'].Value -Right $ExpectedExecutable)) { return $false }
    return [string]::Equals($match.Groups['args'].Value.Trim(), $ExpectedArguments.Trim(), [StringComparison]::OrdinalIgnoreCase)
}

function Test-TaskArguments {
    param([AllowNull()][string]$Arguments)

    if ([string]::IsNullOrWhiteSpace($Arguments)) { return $false }
    return [string]::Equals($Arguments.Trim(), (New-GuardArgumentString).Trim(), [StringComparison]::OrdinalIgnoreCase)
}

function Test-TaskOwnership {
    param([Parameter(Mandatory)][object]$Snapshot)

    if (-not $Snapshot.exists) { return [pscustomobject]@{ Owned = $false; Reason = 'task_absent' } }
    if (-not $Snapshot.readable) { return [pscustomobject]@{ Owned = $false; Reason = 'task_xml_unreadable' } }
    if ([string]$Snapshot.task_path -ne $script:Identity.task_path -or [string]$Snapshot.task_name -ne $script:Identity.task_name) {
        return [pscustomobject]@{ Owned = $false; Reason = 'task_identity_mismatch' }
    }
    $description = [string]$Snapshot.description
    $legacyDescriptionSuffix = [string]::Concat(
        [char]0x5f53, [char]0x524d, [char]0x7528, [char]0x6237, [char]0x4ea4,
        [char]0x4e92, [char]0x767b, [char]0x5f55, [char]0x6258, [char]0x76d8,
        [char]0x5b88, [char]0x62a4, [char]0x3002
    )
    $expectedDescriptions = @(
        "MAARemote-P2-IDENTITY=$($script:Identity.project_marker); ROOT=$($script:Identity.root); Current-user interactive-logon tray guard.",
        "MAARemote-P2-IDENTITY=$($script:Identity.project_marker); ROOT=$($script:Identity.root); $legacyDescriptionSuffix"
    )
    if ($description -cnotin $expectedDescriptions) {
        return [pscustomobject]@{ Owned = $false; Reason = 'task_description_mismatch' }
    }
    if (-not (Test-PathEqual -Left $Snapshot.command -Right $script:Identity.pwsh_path)) {
        return [pscustomobject]@{ Owned = $false; Reason = 'task_command_mismatch' }
    }
    if (-not (Test-PathEqual -Left $Snapshot.working_directory -Right $script:Identity.root)) {
        return [pscustomobject]@{ Owned = $false; Reason = 'task_working_directory_mismatch' }
    }
    $actionCount = @($Snapshot.xml.SelectNodes('/*[local-name()="Task"]/*[local-name()="Actions"]/*')).Count
    $triggerCount = @($Snapshot.xml.SelectNodes('/*[local-name()="Task"]/*[local-name()="Triggers"]/*')).Count
    if ($actionCount -ne 1 -or $triggerCount -ne 1) {
        return [pscustomobject]@{ Owned = $false; Reason = 'task_action_or_trigger_count_mismatch' }
    }
    if (-not (Test-TaskArguments -Arguments $Snapshot.arguments)) {
        return [pscustomobject]@{ Owned = $false; Reason = 'task_arguments_mismatch' }
    }
    if ([string]$Snapshot.trigger_type -ne 'LogonTrigger' -or -not (Test-CurrentUserValue -Value $Snapshot.trigger_user)) {
        return [pscustomobject]@{ Owned = $false; Reason = 'task_trigger_mismatch' }
    }
    if (-not (Test-CurrentUserValue -Value $Snapshot.principal_user) -or [string]$Snapshot.principal_logon_type -ne 'InteractiveToken' -or [string]$Snapshot.principal_run_level -ne 'LeastPrivilege') {
        return [pscustomobject]@{ Owned = $false; Reason = 'task_principal_mismatch' }
    }
    if ([string]$Snapshot.multiple_instances -ne 'IgnoreNew') {
        return [pscustomobject]@{ Owned = $false; Reason = 'task_multiple_instances_mismatch' }
    }
    if (([string]$Snapshot.restart_count -notin @('', '0')) -or
        (([string]$Snapshot.restart_interval -ne '') -and [int](Convert-XmlIntervalToSeconds -Value $Snapshot.restart_interval) -ne 60)) {
        return [pscustomobject]@{ Owned = $false; Reason = 'task_restart_policy_mismatch' }
    }
    if ([string]$Snapshot.execution_time_limit -ne 'PT0S') {
        return [pscustomobject]@{ Owned = $false; Reason = 'task_execution_limit_mismatch' }
    }
    if ([string]$Snapshot.allow_hard_terminate -cne 'false') {
        return [pscustomobject]@{ Owned = $false; Reason = 'task_hard_terminate_policy_mismatch' }
    }
    return [pscustomobject]@{ Owned = $true; Reason = 'project_task' }
}

function New-ProjectTaskDefinition {
    foreach ($commandName in @('New-ScheduledTaskAction', 'New-ScheduledTaskTrigger', 'New-ScheduledTaskPrincipal', 'New-ScheduledTaskSettingsSet', 'New-ScheduledTask', 'Register-ScheduledTask', 'Get-ScheduledTask', 'Export-ScheduledTask', 'Unregister-ScheduledTask')) {
        if ($null -eq (Get-Command -Name $commandName -ErrorAction SilentlyContinue)) {
            throw "The current PowerShell does not provide the ScheduledTasks command: $commandName"
        }
    }

    $action = New-ScheduledTaskAction -Execute $script:Identity.pwsh_path -Argument (New-GuardArgumentString) -WorkingDirectory $script:Identity.root -ErrorAction Stop
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $script:Identity.current_user -ErrorAction Stop
    # Interactive is the ScheduledTasks module enum; exported XML must use InteractiveToken.
    $principal = New-ScheduledTaskPrincipal -UserId $script:Identity.current_user -LogonType Interactive -RunLevel Limited -ErrorAction Stop
    # PT0S removes the default 72-hour limit. Only confirmed tray failures are
    # retried inside the guard; the task itself does not recover unknown exits.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -DisallowHardTerminate -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -ErrorAction Stop
    $description = "MAARemote-P2-IDENTITY=$($script:Identity.project_marker); ROOT=$($script:Identity.root); Current-user interactive-logon tray guard."
    $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description -ErrorAction Stop
    return [pscustomobject]@{
        Definition = $definition
        Description = $description
        Arguments = New-GuardArgumentString
    }
}

function Get-GuardStateSnapshot {
    $path = Join-Path $script:LogsDir 'tray-guard-state.json'
    $document = Read-JsonDocument -Path $path
    if (-not $document.Valid) {
        return [pscustomobject]@{ status = 'unknown'; readable = $false; state = $null; error = $document.Error; path = $path }
    }
    if (-not $document.Exists) {
        return [pscustomobject]@{ status = 'stopped'; readable = $true; state = $null; error = ''; path = $path }
    }
    $state = $document.Data
    $status = [string](Get-PropertyValue -Object $state -Name 'status')
    if (@('running', 'stopped') -notcontains $status) {
        return [pscustomobject]@{ status = 'unknown'; readable = $false; state = $state; error = 'The state field is invalid.'; path = $path }
    }
    return [pscustomobject]@{ status = $status; readable = $true; state = $state; error = ''; path = $path }
}

function Get-ProcessCim {
    param([Parameter(Mandatory)][int]$ProcessId)

    try { return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop | Select-Object -First 1 } catch { return $null }
}

function Get-ProcessIdentity {
    param([Parameter(Mandatory)][int]$ProcessId)

    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        $startTicks = [int64]$process.StartTime.ToUniversalTime().Ticks
        $path = ''
        try { $path = [string]$process.MainModule.FileName } catch { }
        return [ordered]@{
            pid                 = $ProcessId
            process_start_ticks = $startTicks
            process_name        = [string]$process.ProcessName
            process_path        = $path
        }
    } catch {
        return $null
    }
}

function Test-GuardProcessIdentity {
    param([Parameter(Mandatory)][object]$State)

    $pidValue = 0
    if (-not [int]::TryParse([string](Get-PropertyValue -Object $State -Name 'pid'), [ref]$pidValue) -or $pidValue -le 0) { return $false }
    if ([string](Get-PropertyValue -Object $State -Name 'status') -ne 'running') { return $false }
    if ([string](Get-PropertyValue -Object $State -Name 'project_marker') -ne $script:Identity.project_marker) { return $false }
    if (-not (Test-PathEqual -Left ([string](Get-PropertyValue -Object $State -Name 'root')) -Right $script:Identity.root)) { return $false }
    if (-not (Test-PathEqual -Left ([string](Get-PropertyValue -Object $State -Name 'guard_script')) -Right $script:Identity.guard_script)) { return $false }
    if (-not (Test-PathEqual -Left ([string](Get-PropertyValue -Object $State -Name 'pwsh_path')) -Right $script:Identity.pwsh_path)) { return $false }

    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    $cim = Get-ProcessCim -ProcessId $pidValue
    if ($null -eq $process -or $null -eq $cim) { return $false }
    $expectedStartTicks = 0L
    if (-not [int64]::TryParse([string](Get-PropertyValue -Object $State -Name 'process_start_ticks'), [ref]$expectedStartTicks) -or $expectedStartTicks -le 0) { return $false }
    $identity = Get-ProcessIdentity -ProcessId $pidValue
    if ($null -eq $identity -or [int64]$identity.process_start_ticks -ne $expectedStartTicks) { return $false }
    $storedName = [string](Get-PropertyValue -Object $State -Name 'process_name')
    if ([string]::IsNullOrWhiteSpace($storedName) -or $storedName -ne [string]$identity.process_name) { return $false }
    $storedPath = [string](Get-PropertyValue -Object $State -Name 'process_path')
    if ([string]::IsNullOrWhiteSpace($storedPath) -or -not (Test-PathEqual -Left $storedPath -Right ([string]$identity.process_path))) { return $false }
    if (-not (Test-PathEqual -Left ([string](Get-PropertyValue -Object $cim -Name 'ExecutablePath')) -Right $script:Identity.pwsh_path)) { return $false }
    $commandLine = [string](Get-PropertyValue -Object $cim -Name 'CommandLine')
    if (-not (Test-ExactProcessCommandLine -CommandLine $commandLine -ExpectedExecutable $script:Identity.pwsh_path -ExpectedArguments (New-GuardArgumentString))) { return $false }

    try {
        $owner = Invoke-CimMethod -InputObject $cim -MethodName GetOwner -ErrorAction Stop
        $ownerUser = [string](Get-PropertyValue -Object $owner -Name 'User')
        $lastSeparator = $script:Identity.current_user.LastIndexOf([char]92)
        $currentLeaf = if ($lastSeparator -ge 0) { $script:Identity.current_user.Substring($lastSeparator + 1) } else { $script:Identity.current_user }
        if ([string]::IsNullOrWhiteSpace($ownerUser) -or $ownerUser.ToLowerInvariant() -ne $currentLeaf.ToLowerInvariant()) { return $false }
    } catch {
        return $false
    }
    return $true
}

function Write-GuardStopRequest {
    param(
        [Parameter(Mandatory)][object]$State,
        [Parameter(Mandatory)][ValidateSet('stop', 'uninstall')][string]$RequestedAction
    )

    $request = [ordered]@{
        schema       = 1
        action       = $RequestedAction
        session_id   = [string](Get-PropertyValue -Object $State -Name 'session_id')
        project_marker = $script:Identity.project_marker
        root         = $script:Identity.root
        requested_at = (Get-Date).ToUniversalTime().ToString('o')
        requested_by = $script:Identity.current_user
    }
    $controlPath = Join-Path $script:LogsDir 'tray-guard-control.json'
    if (-not (Write-JsonAtomic -Path $controlPath -Value $request)) {
        throw 'Could not write tray-guard-control.json; no process was stopped.'
    }
    return $controlPath
}

function Request-GuardStop {
    param([Parameter(Mandatory)][ValidateSet('stop', 'uninstall')][string]$RequestedAction)

    $guard = Get-GuardStateSnapshot
    if (-not $guard.readable) {
        return [pscustomobject]@{ ok = $false; status = 'unknown'; reason = 'guard_state_corrupt'; message = $guard.error }
    }
    if ($guard.status -ne 'running') {
        return [pscustomobject]@{ ok = $true; status = $guard.status; reason = 'guard_not_running'; message = '' }
    }
    if (-not (Test-GuardProcessIdentity -State $guard.state)) {
        $pidValue = [string](Get-PropertyValue -Object $guard.state -Name 'pid')
        $process = $null
        try { $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue } catch { }
        if ($null -eq $process) {
            return [pscustomobject]@{ ok = $false; status = 'unknown'; reason = 'guard_running_state_without_verified_process'; message = 'The state is still running, but the process identity cannot be verified.' }
        }
        return [pscustomobject]@{ ok = $false; status = 'unknown'; reason = 'guard_process_identity_mismatch'; message = 'Refused to stop a PowerShell process with a mismatched identity.' }
    }

    if ($WhatIf) {
        return [pscustomobject]@{ ok = $true; status = 'running'; reason = 'would_request_guard_stop'; message = '' }
    }
    [void](Write-GuardStopRequest -State $guard.state -RequestedAction $RequestedAction)
    $pidValue = [int](Get-PropertyValue -Object $guard.state -Name 'pid')
    $deadline = (Get-Date).AddSeconds($GuardStopTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            $after = Get-GuardStateSnapshot
            if ($after.readable -and $after.status -eq 'stopped' -and [string](Get-PropertyValue -Object $after.state -Name 'session_id') -eq [string](Get-PropertyValue -Object $guard.state -Name 'session_id')) {
                $exitValue = [string](Get-PropertyValue -Object $after.state -Name 'exit_code')
                $reasonValue = [string](Get-PropertyValue -Object $after.state -Name 'exit_reason')
                if ($exitValue -eq '0' -and @('active_stop', 'active_uninstall') -contains $reasonValue) {
                    return [pscustomobject]@{ ok = $true; status = 'stopped'; reason = $reasonValue; message = '' }
                }
            }
            return [pscustomobject]@{ ok = $false; status = 'unknown'; reason = 'guard_exit_unverified'; message = 'The guard process disappeared without a verifiable intentional-exit record.' }
        }
        Start-Sleep -Milliseconds 250
    }
    return [pscustomobject]@{ ok = $false; status = 'running'; reason = 'guard_stop_timeout'; message = 'No intentional-exit record arrived before timeout; the process was not force-killed.' }
}

function Get-MigrationSnapshot {
    $document = Read-JsonDocument -Path $script:MigrationPath
    if (-not $document.Valid) { return [pscustomobject]@{ exists = $true; valid = $false; data = $null; error = $document.Error } }
    if (-not $document.Exists) { return [pscustomobject]@{ exists = $false; valid = $true; data = $null; error = '' } }
    return [pscustomobject]@{ exists = $true; valid = $true; data = $document.Data; error = '' }
}

function Copy-OrderedRecord {
    param([Parameter(Mandatory)][object]$Record)

    $copy = [ordered]@{}
    if ($Record -is [System.Collections.IDictionary]) {
        foreach ($key in $Record.Keys) { $copy[[string]$key] = $Record[$key] }
    } else {
        foreach ($property in $Record.PSObject.Properties) { $copy[$property.Name] = $property.Value }
    }
    return $copy
}

function Test-MigrationOwnership {
    param([Parameter(Mandatory)][object]$Snapshot)

    if (-not $Snapshot.exists) { return $false }
    if (-not $Snapshot.valid) { return $false }
    $data = $Snapshot.data
    return (
        [string](Get-PropertyValue -Object $data -Name 'project_marker') -eq $script:Identity.project_marker -and
        (Test-PathEqual -Left ([string](Get-PropertyValue -Object $data -Name 'root')) -Right $script:Identity.root) -and
        [string](Get-PropertyValue -Object $data -Name 'task_name') -eq $script:Identity.task_name -and
        @('prepared', 'migrated', 'restoring') -contains [string](Get-PropertyValue -Object $data -Name 'status') -and
        (Test-ProjectRunValue -RunSnapshot ([pscustomobject]@{
            readable = $true
            present = $true
            value = [string](Get-PropertyValue -Object $data -Name 'original_run_value')
        }))
    )
}

function Restore-MigratedRunValue {
    param(
        [AllowNull()][string]$TaskGeneration = '',
        [AllowNull()][string]$TaskRegistrationDate = ''
    )
    $migration = Get-MigrationSnapshot
    if (-not $migration.exists) { return [pscustomobject]@{ ok = $true; reason = 'no_migration_record'; restored = $false } }
    if (-not $migration.valid) {
        return [pscustomobject]@{ ok = $false; reason = 'migration_record_unverified'; restored = $false }
    }
    $migrationStatus = [string](Get-PropertyValue -Object $migration.data -Name 'status')
    if ($migrationStatus -eq 'restored') { return [pscustomobject]@{ ok = $true; reason = 'run_value_already_restored'; restored = $false } }
    if (-not (Test-MigrationOwnership -Snapshot $migration)) {
        return [pscustomobject]@{ ok = $false; reason = 'migration_record_unverified'; restored = $false }
    }
    $recordGeneration = [string](Get-PropertyValue -Object $migration.data -Name 'task_generation')
    $recordRegistrationDate = [string](Get-PropertyValue -Object $migration.data -Name 'task_registration_date')
    $generationVerified = if (-not [string]::IsNullOrWhiteSpace($recordGeneration)) {
        -not [string]::IsNullOrWhiteSpace($TaskGeneration) -and $recordGeneration -ceq $TaskGeneration
    } elseif (-not [string]::IsNullOrWhiteSpace($recordRegistrationDate)) {
        -not [string]::IsNullOrWhiteSpace($TaskRegistrationDate) -and $recordRegistrationDate -ceq $TaskRegistrationDate
    } else {
        $false
    }
    if (-not $generationVerified) {
        return [pscustomobject]@{ ok = $false; reason = 'migration_task_generation_unverified'; restored = $false }
    }
    $run = Get-RunValueSnapshot
    if (-not $run.readable) { return [pscustomobject]@{ ok = $false; reason = 'run_value_unreadable'; restored = $false } }
    $original = [string](Get-PropertyValue -Object $migration.data -Name 'original_run_value')
    if ($run.present) {
        if ([string]$run.value -eq $original) {
            $restoredRecord = $migration.data.PSObject.Copy()
            $restoredRecord.status = 'restored'
            $restoredRecord | Add-Member -NotePropertyName restored_at -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
            if (-not (Write-JsonAtomic -Path $script:MigrationPath -Value $restoredRecord)) {
                return [pscustomobject]@{ ok = $false; reason = 'restore_record_write_failed'; restored = $false }
            }
            return [pscustomobject]@{ ok = $true; reason = 'run_value_already_restored'; restored = $false }
        }
        return [pscustomobject]@{ ok = $false; reason = 'run_value_changed_by_other_owner'; restored = $false }
    }
    try {
        # Consume the rollback record first; an interruption must not let a later
        # uninstall blindly restore from an old record.
        $restoringRecord = $migration.data.PSObject.Copy()
        $restoringRecord.status = 'restoring'
        if (-not (Write-JsonAtomic -Path $script:MigrationPath -Value $restoringRecord)) { throw 'Could not write the restore intent; Run was not modified.' }
        if (-not (Test-Path -LiteralPath $script:Identity.run_key -PathType Container)) {
            New-Item -Path $script:Identity.run_key -Force -ErrorAction Stop | Out-Null
        }
        Set-ItemProperty -LiteralPath $script:Identity.run_key -Name $script:Identity.run_value_name -Value $original -Type String -ErrorAction Stop
        $after = Get-RunValueSnapshot
        if (-not $after.present -or [string]$after.value -ne $original) { throw 'The Run value did not match after restore.' }
        $restoredRecord = $migration.data.PSObject.Copy()
        $restoredRecord.status = 'restored'
        $restoredRecord | Add-Member -NotePropertyName restored_at -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
        if (-not (Write-JsonAtomic -Path $script:MigrationPath -Value $restoredRecord)) { throw 'Could not write the restore record; it is retained to prevent blind repetition.' }
        return [pscustomobject]@{ ok = $true; reason = 'run_value_restored'; restored = $true }
    } catch {
        return [pscustomobject]@{ ok = $false; reason = 'run_value_restore_failed'; restored = $false; message = $_.Exception.Message }
    }
}

function Remove-ConfirmedRunValue {
    param([Parameter(Mandatory)][string]$ExpectedValue)

    $run = Get-RunValueSnapshot
    if (-not $run.readable) { throw "Could not read HKCU Run: $($run.error)" }
    if (-not $run.present) { return $false }
    if ([string]$run.value -ne $ExpectedValue) { throw 'The HKCU Run value is present but is not the confirmed project value; deletion refused.' }
    Remove-ItemProperty -LiteralPath $script:Identity.run_key -Name $script:Identity.run_value_name -ErrorAction Stop
    $after = Get-RunValueSnapshot
    if ($after.present) { throw 'The HKCU Run value still exists after deletion.' }
    return $true
}

function Unregister-ConfirmedTask {
    param([Parameter(Mandatory)][object]$Snapshot)

    $ownership = Test-TaskOwnership -Snapshot $Snapshot
    if (-not $ownership.Owned) { throw "Refused to uninstall a task that failed identity verification: $($ownership.Reason)" }
    if ($WhatIf) { return }
    $latest = Get-TaskSnapshot
    $latestOwnership = Test-TaskOwnership -Snapshot $latest
    if (-not $latestOwnership.Owned) { throw "Task identity changed before uninstall; deletion refused: $($latestOwnership.Reason)" }
    Unregister-ScheduledTask -TaskName $script:Identity.task_name -TaskPath $script:Identity.task_path -Confirm:$false -ErrorAction Stop
    $after = Get-TaskSnapshot
    if ($after.exists) { throw 'The same-name scheduled task is still present after uninstall.' }
}

function Disable-ConfirmedTask {
    param([Parameter(Mandatory)][object]$Snapshot)

    $ownership = Test-TaskOwnership -Snapshot $Snapshot
    if (-not $ownership.Owned) { throw "Refused to disable a task that failed identity verification: $($ownership.Reason)" }
    if ($WhatIf) { return [pscustomobject]@{ ok = $true; changed = $false; reason = 'would_disable' } }
    $latest = Get-TaskSnapshot
    $latestOwnership = Test-TaskOwnership -Snapshot $latest
    if (-not $latestOwnership.Owned) { throw "Task identity changed before disable; operation refused: $($latestOwnership.Reason)" }
    Disable-ScheduledTask -TaskName $script:Identity.task_name -TaskPath $script:Identity.task_path -ErrorAction Stop | Out-Null
    $after = Get-TaskSnapshot
    if (-not $after.exists -or [string]$after.state -ne 'Disabled') { throw 'The disabled task state was not confirmed.' }
    return [pscustomobject]@{ ok = $true; changed = $true; reason = 'task_disabled' }
}

function Set-Result {
    param(
        [Parameter(Mandatory)][bool]$Ok,
        [Parameter(Mandatory)][string]$Reason,
        [hashtable]$Extra = @{}
    )

    $script:Result.ok = $Ok
    $script:Result.reason = $Reason
    foreach ($key in $Extra.Keys) { $script:Result[$key] = $Extra[$key] }
    $script:ExitCode = if ($Ok) { 0 } else { 1 }
}

function Write-TaskResult {
    try {
        Write-Output ('RESULT_JSON=' + (ConvertTo-Json -InputObject $script:Result -Compress -Depth 15))
    } catch {
        Write-Output 'RESULT_JSON={"component":"tray-task","ok":false,"reason":"result_serialization_failed"}'
        $script:ExitCode = 2
    }
}

try {
    if (@('install', 'status', 'uninstall', 'stop') -notcontains $Action) {
        throw "Unknown action: $Action. Available actions are install, status, uninstall, and stop."
    }
    if ($MigrateRun -and $Action -ne 'install') { throw '-MigrateRun can only be used with -Action install.' }

    $rawRoot = if ([string]::IsNullOrWhiteSpace($RootPath)) { $PSScriptRoot } else { $RootPath }
    $script:Identity.root = Get-CanonicalRoot -Path $rawRoot
    $script:Identity.root_hash = (Get-Sha256Hex -Value $script:Identity.root).Substring(0, 12)
    $script:Identity.project_marker = "MAARemote-P2-TrayGuard-$($script:Identity.root_hash)"
    $script:Identity.task_name = "MAARemote-P2-TrayGuard-$($script:Identity.root_hash)"
    $script:Identity.current_user = Get-CurrentUserName
    $script:Identity.pwsh_path = Resolve-PwshPath
    $script:Identity.tray_script = Join-Path $script:Identity.root 'tray.ps1'
    $script:Identity.guard_script = Join-Path $script:Identity.root 'tray-guard.ps1'
    if (-not (Test-Path -LiteralPath $script:Identity.tray_script -PathType Leaf)) { throw "tray.ps1 not found: $($script:Identity.tray_script)" }
    if (-not (Test-Path -LiteralPath $script:Identity.guard_script -PathType Leaf)) { throw "tray-guard.ps1 not found: $($script:Identity.guard_script)" }
    $script:LogsDir = Join-Path $script:Identity.root 'logs'
    $script:MigrationPath = Join-Path $script:LogsDir 'tray-task-migration.json'
    $script:Result.identity = [ordered]@{
        root = $script:Identity.root
        project_marker = $script:Identity.project_marker
        task_name = $script:Identity.task_name
        task_path = $script:Identity.task_path
        current_user = $script:Identity.current_user
        pwsh_path = $script:Identity.pwsh_path
        tray_script = $script:Identity.tray_script
        guard_script = $script:Identity.guard_script
    }

    $run = Get-RunValueSnapshot
    if (-not $run.readable) { throw "HKCU Run is unreadable: $($run.error)" }
    $runOwned = Test-ProjectRunValue -RunSnapshot $run
    $script:Result.run = [ordered]@{
        present = [bool]$run.present
        project_owned = [bool]$runOwned
        value = if ($run.present) { [string]$run.value } else { '' }
        expected = Get-ExpectedRunCommand
    }

    $collisions = @(Get-TaskNameCollisions)
    $unexpectedCollision = @($collisions | Where-Object { [string]$_.TaskPath -ne $script:Identity.task_path })
    if ($unexpectedCollision.Count -gt 0) {
        throw 'A same-name scheduled task exists in another path; overwrite and deletion are refused.'
    }
    $taskSnapshot = Get-TaskSnapshot
    $ownership = Test-TaskOwnership -Snapshot $taskSnapshot
    $script:Result.task = [ordered]@{
        exists = [bool]$taskSnapshot.exists
        readable = [bool]$taskSnapshot.readable
        owned = [bool]$ownership.Owned
        ownership_reason = [string]$ownership.Reason
        name = $script:Identity.task_name
        path = $script:Identity.task_path
        state = [string]$taskSnapshot.state
    }

    switch ($Action) {
        'status' {
            $guard = Get-GuardStateSnapshot
            $guardPid = 0
            if ($guard.state) { [void][int]::TryParse([string](Get-PropertyValue -Object $guard.state -Name 'pid'), [ref]$guardPid) }
            $guardVerified = $false
            if ($guard.readable -and $guard.status -eq 'running') { $guardVerified = Test-GuardProcessIdentity -State $guard.state }
            $script:Result.guard = [ordered]@{
                status = $guard.status
                readable = $guard.readable
                verified_process = $guardVerified
                pid = $guardPid
                exit_reason = if ($guard.state) { [string](Get-PropertyValue -Object $guard.state -Name 'exit_reason') } else { '' }
                exit_code = if ($guard.state) { Get-PropertyValue -Object $guard.state -Name 'exit_code' } else { $null }
                state_path = $guard.path
                error = $guard.error
            }
            $info = $null
            if ($taskSnapshot.exists) {
                $info = try { Get-ScheduledTaskInfo -TaskName $script:Identity.task_name -TaskPath $script:Identity.task_path -ErrorAction Stop | Select-Object State,LastRunTime,NextRunTime,LastTaskResult } catch { $null }
            }
            $script:Result.task_definition = [ordered]@{
                command = [string]$taskSnapshot.command
                arguments = [string]$taskSnapshot.arguments
                working_directory = [string]$taskSnapshot.working_directory
                trigger_type = [string]$taskSnapshot.trigger_type
                trigger_user = [string]$taskSnapshot.trigger_user
                principal_user = [string]$taskSnapshot.principal_user
                principal_logon_type = [string]$taskSnapshot.principal_logon_type
                principal_run_level = [string]$taskSnapshot.principal_run_level
                multiple_instances = [string]$taskSnapshot.multiple_instances
                restart_count = [string]$taskSnapshot.restart_count
                restart_interval = [string]$taskSnapshot.restart_interval
                execution_time_limit = [string]$taskSnapshot.execution_time_limit
                allow_hard_terminate = [string]$taskSnapshot.allow_hard_terminate
                task_generation = [string]$taskSnapshot.task_generation
                runtime = $info
            }
            if (-not $ownership.Owned -and $taskSnapshot.exists) {
                Set-Result -Ok:$false -Reason ([string]$ownership.Reason)
            } elseif (-not $guard.readable -or ($guard.status -eq 'running' -and -not $guardVerified)) {
                Set-Result -Ok:$false -Reason 'guard_state_unverified'
            } elseif ($run.present -and -not $runOwned) {
                Set-Result -Ok:$false -Reason 'run_value_unverified'
            } else {
                $statusReason = if ($taskSnapshot.exists) { 'status_read' } else { 'not_installed' }
                Set-Result -Ok:$true -Reason $statusReason
            }
        }
        'stop' {
            if ($taskSnapshot.exists -and -not $ownership.Owned) { throw "Refused to stop a non-project task: $($ownership.Reason)" }
            if ($taskSnapshot.exists) {
                $script:Result.task = Disable-ConfirmedTask -Snapshot $taskSnapshot
            }
            $guardResult = Request-GuardStop -RequestedAction 'stop'
            $script:Result.guard = $guardResult
            if ($guardResult.ok) { Set-Result -Ok:$true -Reason ([string]$guardResult.reason) } else { Set-Result -Ok:$false -Reason ([string]$guardResult.reason) }
        }
        'install' {
            if ($taskSnapshot.exists -and -not $ownership.Owned) { throw "Refused to overwrite a same-name non-project task: $($ownership.Reason)" }
            if ($taskSnapshot.exists -and $taskSnapshot.state -eq 'Disabled') { throw 'The project task is disabled; silent re-enabling is refused. Check status first.' }
            if ($run.present -and -not $runOwned) { throw 'The same-name HKCU Run value is not project-generated; overwrite, deletion, and restore are refused.' }
            if ($run.present -and -not $MigrateRun) { throw 'The project HKCU Run autostart is present; use -MigrateRun explicitly for the mutually exclusive migration.' }

            $definitionBundle = New-ProjectTaskDefinition
            if ($WhatIf) {
                Set-Result -Ok:$true -Reason 'would_install' -Extra @{
                    would_register = (-not $taskSnapshot.exists)
                    would_migrate_run = [bool]($run.present -and $MigrateRun)
                    action_arguments = $definitionBundle.Arguments
                    description = $definitionBundle.Description
                    restart_policy = [ordered]@{ task_restart_count = 0; tray_retry_count = 3; tray_retry_interval_seconds = 60; execution_time_limit = 'PT0S'; multiple_instances = 'IgnoreNew'; allow_hard_terminate = $false }
                }
                break
            }

            $createdTask = $false
            if (-not $taskSnapshot.exists) {
                # Identity was checked above; do not use -Force, so a concurrent
                # non-project task cannot be overwritten.
                try {
                    Register-ScheduledTask -TaskName $script:Identity.task_name -TaskPath $script:Identity.task_path -InputObject $definitionBundle.Definition -ErrorAction Stop | Out-Null
                } catch {
                    if (Test-TaskAccessDeniedError -ErrorRecord $_) { $script:TaskRegistrationAccessDenied = $true }
                    throw
                }
                $createdTask = $true
                $script:CreatedTaskThisRun = $true
                $afterRegister = Get-TaskSnapshot
                $afterOwnership = Test-TaskOwnership -Snapshot $afterRegister
                if (-not $afterOwnership.Owned) { throw "Identity verification failed after registration: $($afterOwnership.Reason)" }
                $taskSnapshot = $afterRegister
            }

            if ($run.present -and $MigrateRun) {
                $migrationPrepared = [ordered]@{
                    schema = 3
                    status = 'prepared'
                    project_marker = $script:Identity.project_marker
                    root = $script:Identity.root
                    task_name = $script:Identity.task_name
                    task_generation = [string](Get-PropertyValue -Object $taskSnapshot -Name 'task_generation')
                    task_registration_date = [string](Get-PropertyValue -Object $taskSnapshot -Name 'registration_date')
                    original_run_value = [string]$run.value
                    prepared_at = (Get-Date).ToUniversalTime().ToString('o')
                }
                if ([string]::IsNullOrWhiteSpace($migrationPrepared.task_generation)) { throw 'Could not obtain the task-definition fingerprint; Run deletion refused.' }
                if (-not (Write-JsonAtomic -Path $script:MigrationPath -Value $migrationPrepared)) { throw 'Could not write the migration rollback record; Run was retained and migration stopped.' }
                try {
                    [void](Remove-ConfirmedRunValue -ExpectedValue ([string]$run.value))
                    $migrationDone = Copy-OrderedRecord -Record $migrationPrepared
                    $migrationDone['status'] = 'migrated'
                    $migrationDone['migrated_at'] = (Get-Date).ToUniversalTime().ToString('o')
                    if (-not (Write-JsonAtomic -Path $script:MigrationPath -Value $migrationDone)) { throw 'Could not write the migration-complete record.' }
                } catch {
                    $rollbackRun = Get-RunValueSnapshot
                    if (-not $rollbackRun.present) {
                        try {
                            if (-not (Test-Path -LiteralPath $script:Identity.run_key -PathType Container)) { New-Item -Path $script:Identity.run_key -Force -ErrorAction Stop | Out-Null }
                            Set-ItemProperty -LiteralPath $script:Identity.run_key -Name $script:Identity.run_value_name -Value ([string]$run.value) -Type String -ErrorAction Stop
                        } catch {
                            throw "Run migration and rollback both failed: $($_.Exception.Message)"
                        }
                    } elseif ([string]$rollbackRun.value -ne [string]$run.value) {
                        throw 'Run migration failed; the current value is owned by another value and overwrite was refused.'
                    }
                    if ($createdTask) {
                        $rollbackTask = Get-TaskSnapshot
                        if ($rollbackTask.exists -and (Test-TaskOwnership -Snapshot $rollbackTask).Owned) {
                            Unregister-ScheduledTask -TaskName $script:Identity.task_name -TaskPath $script:Identity.task_path -Confirm:$false -ErrorAction Stop
                        }
                    }
                    throw
                }
            }
            $installReason = if ($MigrateRun -and $run.present) { 'installed_and_run_migrated' } elseif ($createdTask) { 'installed' } else { 'already_installed' }
            Set-Result -Ok:$true -Reason $installReason -Extra @{
                task_name = $script:Identity.task_name
                task_path = $script:Identity.task_path
                run_migrated = [bool]($MigrateRun -and $run.present)
            }
        }
        'uninstall' {
            if ($taskSnapshot.exists -and -not $ownership.Owned) { throw "Refused to uninstall a non-project task: $($ownership.Reason)" }
            $guardResult = Request-GuardStop -RequestedAction 'uninstall'
            $script:Result.guard = $guardResult
            if (-not $guardResult.ok) { throw "Could not safely stop the guard before uninstall: $($guardResult.reason)" }
            if ($WhatIf) {
                Set-Result -Ok:$true -Reason 'would_uninstall' -Extra @{ would_unregister = [bool]$taskSnapshot.exists }
                break
            }
            $restore = if ($taskSnapshot.exists) {
                Restore-MigratedRunValue -TaskGeneration ([string](Get-PropertyValue -Object $taskSnapshot -Name 'task_generation')) -TaskRegistrationDate ([string](Get-PropertyValue -Object $taskSnapshot -Name 'registration_date'))
            } else { [pscustomobject]@{ ok=$true; reason='task_absent_no_run_restore'; restored=$false } }
            $script:Result.run_restore = $restore
            if (-not $restore.ok) { throw "Run restore was not completed; the scheduled task was retained: $($restore.reason)" }
            if ($taskSnapshot.exists) { Unregister-ConfirmedTask -Snapshot $taskSnapshot }
            $uninstallReason = if ($taskSnapshot.exists) { 'uninstalled' } else { 'already_uninstalled' }
            Set-Result -Ok:$true -Reason $uninstallReason
        }
    }
} catch {
    if ($script:CreatedTaskThisRun) {
        try {
            $rollbackTask = Get-TaskSnapshot
            if ($rollbackTask.exists) {
                $rollbackOwnership = Test-TaskOwnership -Snapshot $rollbackTask
                if ($rollbackOwnership.Owned) {
                    Unregister-ScheduledTask -TaskName $script:Identity.task_name -TaskPath $script:Identity.task_path -Confirm:$false -ErrorAction Stop
                    $script:Result.rollback = 'new_task_removed'
                } else {
                    $script:Result.rollback = 'new_task_ownership_changed'
                }
            } else {
                $script:Result.rollback = 'new_task_absent'
            }
        } catch {
            $script:Result.rollback = 'new_task_cleanup_failed'
            $script:Result.rollback_error = $_.Exception.Message
        }
    }
    $accessDenied = ($Action -eq 'install' -and $script:TaskRegistrationAccessDenied)
    $script:Result.ok = $false
    $script:Result.reason = if ($accessDenied) { 'task_scheduler_access_denied' } else { 'error' }
    $script:Result.error = $_.Exception.Message
    if ($accessDenied) {
        $script:Result.error = 'The system refused scheduled-task registration (0x80070005); HKCU Run was not modified. Retry in a session that permits the current user to register an interactive task. Original error: ' + $_.Exception.Message
        if ($MigrateRun) { $script:Result.run_migrated = $false }
    }
    $script:ExitCode = 1
}

Write-TaskResult
exit $script:ExitCode
