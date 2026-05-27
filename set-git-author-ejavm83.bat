@echo off
:: 이 저장소에만 user.name=ejavm83, user.email=지정값 설정 (git config --local)
::
:: 사용법:
::   set-git-author-ejavm83.bat
::       이메일을 입력 프롬프트로 묻습니다.
::   set-git-author-ejavm83.bat "your@email.com"
::   set-git-author-ejavm83.bat "12345678+ejavm83@users.noreply.github.com"
::       GitHub noreply 주소는 설정 ^> 이메일에서 확인:
::       https://github.com/settings/emails
::
setlocal EnableExtensions
cd /d "%~dp0" || exit /b 1

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] git.exe 가 PATH 에 없습니다.
  exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [ERROR] git 저장소가 아닙니다. .bat 을 프로젝트 루트에 두세요.
  exit /b 1
)

set "AUTHOR_NAME=ejavm83"

if not "%~1"=="" (
  set "AUTHOR_EMAIL=%~1"
  goto :apply
)

echo GitHub 이메일 확인: https://github.com/settings/emails
set /p "AUTHOR_EMAIL=커밋에 사용할 Email: "

:apply
if not defined AUTHOR_EMAIL (
  echo [중단] Email 이 비어 있습니다.
  exit /b 1
)

echo.
echo === 적용: user.name=%AUTHOR_NAME%  user.email=%AUTHOR_EMAIL% ===
git config --local user.name "%AUTHOR_NAME%"
if errorlevel 1 exit /b 1
git config --local user.email "%AUTHOR_EMAIL%"
if errorlevel 1 exit /b 1

echo.
echo --- 현재 이 저장소 로컬 사용자 설정 ---
git config --local --get user.name
git config --local --get user.email
echo.
echo 완료. 전역으로 쓰려면: git config --global user.name "%AUTHOR_NAME%" ^&^& git config --global user.email "%AUTHOR_EMAIL%"
exit /b 0
