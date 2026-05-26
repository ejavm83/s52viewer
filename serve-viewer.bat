@echo off
:: serve-viewer.bat — 사용 중이 아닌 포트를 찾아 node serve.js 실행
::
:: Usage:
::   serve-viewer.bat
::       기본 시작 포트 8000부터 비어 있는 포트를 찾습니다.
::   serve-viewer.bat 3000
::       3000부터 순차로 탐색합니다.
::
:: 요구: PATH에 node.exe, Windows PowerShell 5.1+ (Get-NetTCPConnection)
setlocal EnableExtensions
cd /d "%~dp0" || exit /b 1

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node.exe not found in PATH.
  exit /b 1
)

set "STARTPORT=8000"
if not "%~1"=="" set "STARTPORT=%~1"

set /a PORT=%STARTPORT%
set /a ENDPORT=%STARTPORT%+99
if %ENDPORT% gtr 65535 set /a ENDPORT=65535

:findfree
call :port_is_listening %PORT%
if errorlevel 1 goto :run
echo Port %PORT% is in use, trying next...
set /a PORT+=1
if %PORT% gtr %ENDPORT% (
  echo [ERROR] No free TCP port from %STARTPORT% to %ENDPORT%.
  exit /b 1
)
goto :findfree

:run
echo.
echo S-52 viewer: http://localhost:%PORT%/
echo Press Ctrl+C to stop.
echo.
node serve.js %PORT%
exit /b %errorlevel%

:: port_is_listening — LISTEN 중이면 errorlevel 0, 비어 있으면 1
:port_is_listening
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %~1 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
exit /b %errorlevel%
