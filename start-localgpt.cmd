@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "LOCALGPT_ROOT=%~dp0"
set "LOCALGPT_PID_FILE=%~dp0.localgpt.pid"
set "LOCALGPT_LOG_DIR=%~dp0logs"
set "LOCALGPT_MODE=local"
if /I "%~1"=="lan" set "LOCALGPT_MODE=lan"

if exist "%LOCALGPT_PID_FILE%" (
  set "LOCALGPT_OLD_PID="
  for /f "usebackq delims=" %%P in ("%LOCALGPT_PID_FILE%") do set "LOCALGPT_OLD_PID=%%P"
  if defined LOCALGPT_OLD_PID (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:LOCALGPT_OLD_PID) -ErrorAction SilentlyContinue; if($p -and $p.CommandLine -match 'server\.js' -and $p.CommandLine -match [regex]::Escape($env:LOCALGPT_ROOT.TrimEnd('\'))) { exit 0 } else { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
      echo MyGPT is already running. PID: !LOCALGPT_OLD_PID!
      echo Open: http://127.0.0.1:4317
      if /I "%LOCALGPT_MODE%"=="lan" echo For LAN mode, stop it first and run start-localgpt-lan.cmd.
      exit /b 0
    )
  )
  del /q "%LOCALGPT_PID_FILE%" >nul 2>&1
)

if not exist "%LOCALGPT_LOG_DIR%" mkdir "%LOCALGPT_LOG_DIR%" >nul 2>&1

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$root=[IO.Path]::GetFullPath($env:LOCALGPT_ROOT); $script=Join-Path $root 'server.js'; $node=(Get-Command node.exe -ErrorAction Stop).Source; $out=Join-Path $env:LOCALGPT_LOG_DIR 'server.out.log'; $err=Join-Path $env:LOCALGPT_LOG_DIR 'server.err.log'; $args=@($script); if($env:LOCALGPT_MODE -eq 'lan'){ $args += '--lan' }; $p=Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText($env:LOCALGPT_PID_FILE, [string]$p.Id); Start-Sleep -Milliseconds 700; if($p.HasExited){ exit 1 } else { Write-Output $p.Id }"
if errorlevel 1 (
  echo Failed to start MyGPT. Check logs\server.err.log.
  exit /b 1
)

set "LOCALGPT_PID="
for /f "delims=" %%P in ('type "%LOCALGPT_PID_FILE%"') do set "LOCALGPT_PID=%%P"
echo MyGPT started. PID: %LOCALGPT_PID%
if /I "%LOCALGPT_MODE%"=="lan" (
  echo LAN mode is enabled. See the terminal output or logs\server.out.log for the phone URL and password.
) else (
  echo Open: http://127.0.0.1:4317
)
exit /b 0
