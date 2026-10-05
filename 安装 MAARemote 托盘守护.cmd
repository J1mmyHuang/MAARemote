@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1

if not "%~1%~2%~3%~4%~5%~6%~7%~8%~9"=="" (
    echo [Error] This entry point does not accept arguments.
    echo [Hint] Right-click this file and choose Run as administrator.
    set "EXIT_CODE=2"
    goto :failed
)

set "REPO_ROOT=%~dp0"
if not exist "%REPO_ROOT%install-tray-guard.ps1" (
    echo [Error] Could not find "%REPO_ROOT%install-tray-guard.ps1".
    echo [Hint] Confirm this file is in the MAARemote repository root.
    set "EXIT_CODE=1"
    goto :failed
)

where.exe pwsh.exe >nul 2>&1
if errorlevel 1 (
    echo [Error] Could not find pwsh.exe.
    echo [Hint] Install PowerShell 7 and add pwsh.exe to PATH.
    set "EXIT_CODE=1"
    goto :failed
)

echo [Install] Running the project task manager.
echo [Install] This entry point does not start the tray or Node service.
pwsh.exe -NoLogo -NoProfile -File "%REPO_ROOT%install-tray-guard.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto :failed
exit /b 0

:failed
echo.
echo [Hint] Operation failed. Keep this window open with RESULT_JSON and errors.
echo [Hint] Press any key to close this window.
pause >nul
exit /b %EXIT_CODE%
