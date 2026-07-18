@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "LOCALGPT_ROOT=%~dp0"
set "LOCALGPT_PID_FILE=%~dp0.localgpt.pid"
if not exist "%LOCALGPT_PID_FILE%" (
  echo LocalGPT is not running or its PID file is missing.
  exit /b 0
)

set "LOCALGPT_PID="
for /f "usebackq delims=" %%P in ("%LOCALGPT_PID_FILE%") do set "LOCALGPT_PID=%%P"
if not defined LOCALGPT_PID (
  del /q "%LOCALGPT_PID_FILE%" >nul 2>&1
  echo Removed an empty PID file.
  exit /b 0
)

set "LOCALGPT_PID_CHECK=%LOCALGPT_PID%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:LOCALGPT_PID_CHECK) -ErrorAction SilentlyContinue; if(-not $p){ exit 2 }; if($p.CommandLine -notmatch 'server\.js' -or $p.CommandLine -notmatch [regex]::Escape($env:LOCALGPT_ROOT.TrimEnd('\'))){ exit 3 }; & taskkill.exe /PID $env:LOCALGPT_PID_CHECK /T /F | Out-Null; exit $LASTEXITCODE"
set "LOCALGPT_STOP_CODE=%ERRORLEVEL%"
del /q "%LOCALGPT_PID_FILE%" >nul 2>&1

if "%LOCALGPT_STOP_CODE%"=="0" (
  echo LocalGPT stopped. PID: %LOCALGPT_PID%
) else if "%LOCALGPT_STOP_CODE%"=="2" (
  echo Process %LOCALGPT_PID% is already gone. Removed the PID file.
) else if "%LOCALGPT_STOP_CODE%"=="3" (
  echo PID file does not point to this LocalGPT server. It was not stopped.
) else (
  echo Failed to stop process %LOCALGPT_PID%. Exit code: %LOCALGPT_STOP_CODE%
  exit /b %LOCALGPT_STOP_CODE%
)
exit /b 0
