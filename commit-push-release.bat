@echo off
setlocal
cd /d "%~dp0"

echo [%date% %time%] Release bump, commit, push...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release-bump-commit-push.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo FAILED exit code %ERR%
  exit /b %ERR%
)
echo OK
exit /b 0
