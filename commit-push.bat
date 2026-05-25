@echo off
:: commit-push.bat — 스테이징(git add -A) 후 커밋, origin으로 푸시
::
:: 사용법
::   commit-push.bat
::       → 커밋 메시지를 입력 프롬프트로 묻습니다.
::   commit-push.bat 전체 메시지 한 줄
::       → 예: commit-push.bat "fix: 파서 오류 수정"
::   메시지에 & ^ | 등 특수문자가 있으면 큰따옴표로 감싸세요.
::
:: Git 사용자 설정이 없으면 커밋이 거절됩니다. 한번 설정:
::   git config --global user.name "이름"
::   git config --global user.email "이메일"
setlocal EnableExtensions
cd /d "%~dp0" || exit /b 1

where git >nul 2>&1
if errorlevel 1 (
  echo [오류] PATH에서 git.exe를 찾을 수 없습니다.
  exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [오류] Git 저장소가 아닙니다. ^(이 .bat과 같은 폴더에 .git이 있어야 합니다^)
  exit /b 1
)

echo === git status ===
git status -sb
echo.

git diff HEAD --quiet 2>nul
if errorlevel 1 (
  if "%~1"=="" (
    set /p "COMMIT_MSG=커밋 메시지: "
  ) else (
    set "COMMIT_MSG=%*"
  )
  if not defined COMMIT_MSG (
    echo [중단] 커밋 메시지가 비어 있습니다.
    exit /b 1
  )

  echo === git add -A ===
  git add -A
  if errorlevel 1 exit /b 1

  echo === git commit ===
  git commit -m "%COMMIT_MSG%"
  if errorlevel 1 (
    echo [오류] 커밋에 실패했습니다. ^(변경 없음이거나 훅 실패 등^)
    exit /b 1
  )
) else (
  echo 커밋할 로컬 변경이 없습니다. 푸시만 시도합니다.
  echo.
)

echo === git push ===
git push
if errorlevel 1 (
  echo [오류] 푸시에 실패했습니다.
  exit /b 1
)

echo.
echo 완료.
exit /b 0
