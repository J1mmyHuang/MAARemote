@echo off
REM SPDX-License-Identifier: MPL-2.0
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1

if not "%~1%~2%~3%~4%~5%~6%~7%~8%~9"=="" (
    echo [参数错误] 此入口不接受参数，请直接双击运行。
    set "EXIT_CODE=2"
    goto :failed
)

set "REPO_ROOT=%~dp0"
if not exist "%REPO_ROOT%tray.ps1" (
    echo [启动失败] 未找到 "%REPO_ROOT%tray.ps1"。
    echo [提示] 请确认此文件位于 MAARemote 仓库根目录。
    set "EXIT_CODE=1"
    goto :failed
)

where.exe pwsh.exe >nul 2>&1
if errorlevel 1 (
    echo [启动失败] 未找到 pwsh.exe。
    echo [提示] 请安装 PowerShell 7，并确认 pwsh.exe 已加入 PATH。
    set "EXIT_CODE=1"
    goto :failed
)

where.exe node.exe >nul 2>&1
if errorlevel 1 (
    echo [启动失败] 未找到 node.exe。
    echo [提示] 请安装 Node.js 18 或更高版本，并确认 node.exe 已加入 PATH。
    set "EXIT_CODE=1"
    goto :failed
)

set "MAAREMOTE_ENTRY_DIR=%REPO_ROOT%"
echo [启动] 正在后台交接 tray.ps1，窗口将在托盘进程确认后关闭。
pwsh.exe -NoLogo -NoProfile -Command "$ErrorActionPreference = 'Stop'; try { $startInfo = [Diagnostics.ProcessStartInfo]::new(); $startInfo.FileName = 'pwsh.exe'; $startInfo.WorkingDirectory = $env:MAAREMOTE_ENTRY_DIR; $startInfo.UseShellExecute = $false; $startInfo.CreateNoWindow = $true; [void]$startInfo.ArgumentList.Add('-NoLogo'); [void]$startInfo.ArgumentList.Add('-NoProfile'); [void]$startInfo.ArgumentList.Add('-Sta'); [void]$startInfo.ArgumentList.Add('-WindowStyle'); [void]$startInfo.ArgumentList.Add('Hidden'); [void]$startInfo.ArgumentList.Add('-Command'); [void]$startInfo.ArgumentList.Add('$ErrorActionPreference = ''Stop''; & (Join-Path -Path $env:MAAREMOTE_ENTRY_DIR -ChildPath ''tray.ps1'')'); $child = [Diagnostics.Process]::Start($startInfo); Start-Sleep -Seconds 3; if ($child.HasExited) { exit 1 }; exit 0 } catch { exit 1 }"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo [启动失败] tray.ps1 未能保持运行，可能已快速退出。
    echo [提示] 请直接运行 pwsh -NoProfile -Sta -File tray.ps1 查看详细错误。
    goto :failed
)

exit /b 0

:failed
echo.
echo [提示] 按任意键关闭窗口。
pause >nul
exit /b %EXIT_CODE%
