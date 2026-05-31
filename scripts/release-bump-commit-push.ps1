#Requires -Version 5.1
<#
  package.json 마지막 세그먼트(패치) +1, index.html 크레딧·main.js 캐시 v+1,
  오늘 날짜로 표기 후 git commit & push.
  저장소 루트에서 실행되거나, bat이 루트로 cd한 뒤 -File로 호출됩니다.
#>
$ErrorActionPreference = "Stop"
$repoRoot = if ($PSScriptRoot) { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path } else { (Get-Location).Path }
Set-Location $repoRoot

$todayIso = Get-Date -Format "yyyy-MM-dd"
$todayDot = Get-Date -Format "yyyy.MM.dd"

$pkgPath = Join-Path $repoRoot "package.json"
$rawPkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8
if ($rawPkg -notmatch '"version"\s*:\s*"([^"]+)"') {
  Write-Error "package.json에서 version 필드를 찾을 수 없습니다."
}
$oldVer = $Matches[1].Trim()
$parts = $oldVer -split "\."
if ($parts.Count -lt 1) { Write-Error "버전 형식이 올바르지 않습니다: $oldVer" }
$last = $parts[$parts.Count - 1]
if ($last -notmatch '^\d+$') { Write-Error "버전 마지막 세그먼트가 숫자가 아닙니다: $oldVer" }
$parts[$parts.Count - 1] = [string]([int]$last + 1)
$newVer = $parts -join "."
$rawPkg2 = [regex]::Replace($rawPkg, '("version"\s*:\s*")[^"]+(")', {
  $m = $args[0]
  $m.Groups[1].Value + $newVer + $m.Groups[2].Value
}, 1)
if ($rawPkg2 -eq $rawPkg) { Write-Error "package.json version 치환에 실패했습니다." }
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($pkgPath, $rawPkg2, $utf8)

$htmlPath = Join-Path $repoRoot "index.html"
$html = Get-Content -LiteralPath $htmlPath -Raw -Encoding UTF8
$html2 = [regex]::Replace($html, 'v\d+\.\d+\.\d+ \(\d{4}\.\d{2}\.\d{2}\)', "v$newVer ($todayDot)", 1)
if ($html2 -eq $html) {
  Write-Warning "index.html에서 vX.Y.Z (yyyy.MM.dd) 패턴을 찾지 못했습니다. app-credit 줄을 확인하세요."
}
$html3 = [regex]::Replace($html2, '(src="js/main\.js\?v=)(\d+)(")', {
  $m = $args[0]
  $n = [int]$m.Groups[2].Value + 1
  $m.Groups[1].Value + [string]$n + $m.Groups[3].Value
}, 1)
[System.IO.File]::WriteAllText($htmlPath, $html3, $utf8)

Write-Host "Version: $oldVer -> $newVer"
Write-Host "Date:    $todayIso ($todayDot)"

git add -A
$st = git status --porcelain
if (-not $st) {
  Write-Host "커밋할 변경이 없습니다."
  exit 0
}

$msg = "Release v$newVer ($todayIso)"
git commit -m $msg
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git push
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Done: pushed v$newVer"
