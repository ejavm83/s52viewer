@echo off
:: commit-push.bat - git add -A, commit, push to origin
::
:: Usage:
::   commit-push.bat
::       Prompts for commit message.
::   commit-push.bat your message here
::       Example: commit-push.bat "fix: parser edge case"
::   Use quotes if the message has & ^ | etc.
::
:: If commit fails with "tell me who you are", pick one:
::   git config --global user.name "Your Name"
::   git config --global user.email "you@example.com"
:: Or set env vars for this run only (no git config written):
::   set COMMIT_PUSH_NAME=Your Name
::   set COMMIT_PUSH_EMAIL=you@example.com
setlocal EnableExtensions
cd /d "%~dp0" || exit /b 1

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] git.exe not found in PATH.
  exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Not a git repository. Put this .bat next to a .git folder.
  exit /b 1
)

echo === git status ===
git status -sb
echo.

git diff HEAD --quiet 2>nul
if errorlevel 1 goto :have_local_changes
echo No local changes to commit. Trying push only.
echo.
goto :git_push

:have_local_changes
if "%~1"=="" goto :prompt_commit_msg
set "COMMIT_MSG=%*"
goto :after_commit_msg
:prompt_commit_msg
set /p "COMMIT_MSG=Commit message: "
:after_commit_msg
if not defined COMMIT_MSG (
  echo [ABORT] Empty commit message.
  exit /b 1
)

echo === git add -A ===
git add -A
if errorlevel 1 exit /b 1

echo === git commit ===
if defined COMMIT_PUSH_NAME if defined COMMIT_PUSH_EMAIL (
  git -c "user.name=%COMMIT_PUSH_NAME%" -c "user.email=%COMMIT_PUSH_EMAIL%" commit -m "%COMMIT_MSG%"
) else (
  git commit -m "%COMMIT_MSG%"
)
if errorlevel 1 (
  echo [ERROR] git commit failed: nothing to commit, hooks, or missing user.name/email.
  exit /b 1
)

:git_push
echo === git push ===
git push
if errorlevel 1 (
  echo [ERROR] git push failed.
  exit /b 1
)

echo.
echo Done.
exit /b 0
