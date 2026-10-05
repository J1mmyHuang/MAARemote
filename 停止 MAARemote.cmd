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
    echo [停止失败] 未找到 "%REPO_ROOT%tray.ps1"。
    echo [提示] 请确认此文件位于 MAARemote 仓库根目录。
    set "EXIT_CODE=1"
    goto :failed
)

where.exe pwsh.exe >nul 2>&1
if errorlevel 1 (
    echo [停止失败] 未找到 pwsh.exe。
    echo [提示] 请安装 PowerShell 7，并确认 pwsh.exe 已加入 PATH。
    set "EXIT_CODE=1"
    goto :failed
)

echo [停止] 正在调用 tray.ps1 -Action stop。
pwsh.exe -NoLogo -NoProfile -File "%REPO_ROOT%tray.ps1" -Action stop
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo [停止失败] tray.ps1 已退出，退出码：%EXIT_CODE%。
    echo [提示] 请查看上面的错误信息后重试。
    goto :failed
)

exit /b 0

:failed
echo.
echo [提示] 按任意键关闭窗口。
pause >nul
exit /b %EXIT_CODE%
