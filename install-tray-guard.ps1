# MAARemote P2 one-click scheduled-task installer.
# This script only calls tray-task.ps1; it does not duplicate task or HKCU Run logic.

[CmdletBinding()]
param(
    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([char]92)
$script:Manager = Join-Path $script:Root 'tray-task.ps1'
$script:Tray = Join-Path $script:Root 'tray.ps1'
$script:Guard = Join-Path $script:Root 'tray-guard.ps1'
$script:ExitCode = 1

function Get-AbsolutePwshPath {
    $candidate = Join-Path $PSHOME 'pwsh.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return [IO.Path]::GetFullPath($candidate)
    }
    $command = Get-Command -Name 'pwsh.exe' -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace([string]$command.Source)) {
        throw 'Could not locate pwsh.exe.'
    }
    return [IO.Path]::GetFullPath([string]$command.Source)
}

function Test-IsElevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-DesktopBinding {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity.User) { throw 'Could not read the current user SID.' }
    $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $matches = [System.Collections.Generic.List[object]]::new()

    try {
        $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'explorer.exe'" -ErrorAction Stop)
        foreach ($process in $processes) {
            if ([int]$process.SessionId -ne $sessionId) { continue }
            try {
                $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwner -ErrorAction Stop
                $ownerName = if ([string]::IsNullOrWhiteSpace([string]$owner.Domain)) {
                    [string]$owner.User
                } else {
                    '{0}\{1}' -f $owner.Domain, $owner.User
                }
                if ([string]::IsNullOrWhiteSpace($ownerName)) { continue }
                $ownerSid = ([Security.Principal.NTAccount]$ownerName).Translate([Security.Principal.SecurityIdentifier]).Value
                if ($ownerSid -eq $identity.User.Value) {
                    [void]$matches.Add([pscustomobject]@{
                        process_id = [int]$process.ProcessId
                        session_id = [int]$process.SessionId
                        owner = $ownerName
                        owner_sid = $ownerSid
                    })
                }
            } catch {
                # Do not treat an explorer.exe as the current desktop when its identity is unverified.
            }
        }
    } catch {
        throw ('Could not read the current desktop explorer.exe identity: {0}' -f $_.Exception.Message)
    }

    if ($matches.Count -ne 1) {
        throw ('Could not uniquely identify the current interactive desktop: matching explorer.exe count is {0}.' -f $matches.Count)
    }
    return [pscustomobject]@{
        current_user = $identity.Name
        current_sid = $identity.User.Value
        session_id = $sessionId
        explorer = $matches[0]
    }
}

function Test-BuiltInAdministrator {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    return ($null -ne $sid -and $sid.Value -match '-500$')
}

function Invoke-TaskManager {
    param(
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = Get-AbsolutePwshPath
    $startInfo.WorkingDirectory = $script:Root
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in $Arguments) {
        [void]$startInfo.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Could not start the tray-task.ps1 child process.' }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        $jsonLine = @($stdout -split '\r?\n' | Where-Object { $_ -like 'RESULT_JSON=*' } | Select-Object -Last 1)
        $result = $null
        if ($jsonLine.Count -eq 1) {
            try { $result = ConvertFrom-Json -InputObject ([string]$jsonLine[0]).Substring(12) -ErrorAction Stop } catch { }
        }
        return [pscustomobject]@{
            exit_code = $process.ExitCode
            stdout = $stdout
            stderr = $stderr
            result = $result
        }
    } finally {
        $process.Dispose()
    }
}

function Show-ManagerOutput {
    param([Parameter(Mandatory)][object]$Invocation)

    if (-not [string]::IsNullOrWhiteSpace([string]$Invocation.stdout)) {
        Write-Output ([string]$Invocation.stdout).TrimEnd()
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Invocation.stderr)) {
        Write-Output ('[tray-task stderr] ' + ([string]$Invocation.stderr).Trim())
    }
}

function Assert-ManagerFiles {
    foreach ($path in @($script:Manager, $script:Tray, $script:Guard)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw ('Project file not found: {0}' -f $path)
        }
    }
}

try {
    Assert-ManagerFiles
    $desktop = Get-DesktopBinding
    $elevated = Test-IsElevated
    $builtInAdministrator = Test-BuiltInAdministrator

    $preview = Invoke-TaskManager -Arguments @(
        '-NoLogo', '-NoProfile', '-File', $script:Manager,
        '-Action', 'install', '-WhatIf', '-MigrateRun'
    )
    Show-ManagerOutput -Invocation $preview
    if ($preview.exit_code -ne 0 -or $null -eq $preview.result -or -not [bool]$preview.result.ok) {
        throw 'Installation preflight failed; no registration was performed.'
    }

    $previewIdentity = $preview.result.identity
    $previewRun = $preview.result.run
    Write-Output ('Current user: {0}; desktop session: {1}' -f $desktop.current_user, $desktop.session_id)
    Write-Output ('Scheduled task: {0}' -f $previewIdentity.task_name)
    Write-Output ('Task executable: {0}' -f $previewIdentity.pwsh_path)
    Write-Output ('Project Run autostart present: {0}; migration preview: {1}' -f $previewRun.present, $preview.result.would_migrate_run)
    if ($builtInAdministrator) {
        Write-Warning 'The current account is the built-in Windows Administrator (RID 500). Windows may ignore LeastPrivilege for this account; this entry point will not claim that the task runs at low privilege.'
    }

    if ($WhatIf) {
        $script:ExitCode = 0
    } elseif (-not $elevated) {
        throw 'The current PowerShell session is not elevated. Right-click the installer CMD and choose Run as administrator.'
    } else {
        Write-Output 'Registering the project scheduled task and migrating the confirmed project Run value...'
        $install = Invoke-TaskManager -Arguments @(
            '-NoLogo', '-NoProfile', '-File', $script:Manager,
            '-Action', 'install', '-MigrateRun'
        )
        Show-ManagerOutput -Invocation $install
        if ($install.exit_code -ne 0 -or $null -eq $install.result -or -not [bool]$install.result.ok) {
            throw 'Formal installation failed; use the RESULT_JSON above as the source of truth.'
        }

        $status = Invoke-TaskManager -Arguments @(
            '-NoLogo', '-NoProfile', '-File', $script:Manager,
            '-Action', 'status'
        )
        Show-ManagerOutput -Invocation $status
        $statusTask = if ($null -ne $status.result) { $status.result.task } else { $null }
        $statusRun = if ($null -ne $status.result) { $status.result.run } else { $null }
        if ($status.exit_code -ne 0 -or $null -eq $status.result -or -not [bool]$status.result.ok -or $null -eq $statusTask -or -not [bool]$statusTask.owned) {
            throw 'Post-install status verification failed; this installation is not reported as successful.'
        }
        if ([bool]$previewRun.present -and [bool]$statusRun.present) {
            throw 'The scheduled task is confirmed, but the post-migration Run state is unexpected; do not repeat installation, check status first.'
        }
        Write-Output 'Post-install verification passed: the task belongs to this project; the tray and Node service were not started.'
        Write-Output ('Rollback command: pwsh -NoProfile -File "{0}" -Action uninstall' -f $script:Manager)
        $script:ExitCode = 0
    }
} catch {
    Write-Output ('[Install failed] {0}' -f $_.Exception.Message)
    Write-Output 'The tray and Node service were not started. If registration partially completed, run tray-task.ps1 -Action status first; do not delete an unknown task.'
    $script:ExitCode = 1
}

exit $script:ExitCode
