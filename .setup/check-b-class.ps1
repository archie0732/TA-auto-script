$ErrorActionPreference = 'Stop'

$root = 'D:\GitHub\archie0732\TA auto script'
$envPath = Join-Path $root '.env'
$map = @{}
Get-Content -LiteralPath $envPath | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
    $map[$matches[1].Trim()] = $matches[2].Trim()
  }
}

$account = $map['ACCOUNT']
$password = $map['PASSWORD']
if (-not $account -or -not $password) {
  throw 'ACCOUNT/PASSWORD missing'
}

$cookie = Join-Path $root '.tmp_cookie.txt'
$loginOut = Join-Path $root '.tmp_login_post.html'
$loginHdr = Join-Path $root '.tmp_login_post_headers.txt'
$coursePage = Join-Path $root '.tmp_course006.html'
$addPage = Join-Path $root '.tmp_course006_add.html'
$bOptionsPage = Join-Path $root '.tmp_course006_b_options.html'

if (Test-Path $cookie) {
  Remove-Item -LiteralPath $cookie -Force
}

curl.exe -sSL 'https://ta.pu.edu.tw/login.php' -c $cookie -o NUL
curl.exe -sS -L 'https://ta.pu.edu.tw/check_login.php' -b $cookie -c $cookie -D $loginHdr -o $loginOut `
  --data-urlencode 'do=login' `
  --data-urlencode ("rt_01=$account") `
  --data-urlencode ("rt_02=$password")

$courseUrl = 'https://ta.pu.edu.tw/pages/course006.php?mmmid=149'
curl.exe -sS -L $courseUrl -b $cookie -c $cookie -o $coursePage
curl.exe -sS -L 'https://ta.pu.edu.tw/pages/course006.php?mem_mode=add&mem_rid=-1&mem_page_size=20&mem_p=1&tareplymonth=2026-06&tareplyid=3389' -b $cookie -c $cookie -o $addPage
curl.exe -sS -L 'https://ta.pu.edu.tw/pages/r_course66.php' -b $cookie -c $cookie -o $bOptionsPage --data-urlencode 'oid=3390'

$loginContent = Get-Content -LiteralPath $loginOut -Raw
$courseContent = Get-Content -LiteralPath $coursePage -Raw
$addContent = Get-Content -LiteralPath $addPage -Raw
$bOptionsContent = Get-Content -LiteralPath $bOptionsPage -Raw

$optionMatches = [regex]::Matches($courseContent, '<option[^>]*value=["'']([^"'']*)["''][^>]*>([\s\S]*?)</option>', 'IgnoreCase')
$options = foreach ($m in $optionMatches) {
  [pscustomobject]@{
    value = $m.Groups[1].Value.Trim()
    label = ($m.Groups[2].Value -replace '<[^>]*>', ' ' -replace '\s+', ' ').Trim()
  }
}

$bMatches = $options | Where-Object { $_.label -match 'B班|Ｂ班|-B| B' }

$courseNameMatches = [regex]::Matches($addContent, '<select[^>]*(?:name|id)=["'']ryyTaCourseName["''][^>]*>([\s\S]*?)</select>', 'IgnoreCase')
$courseNameOptions = @()
if ($courseNameMatches.Count -gt 0) {
  $courseNameOptions = foreach ($m in [regex]::Matches($courseNameMatches[0].Groups[1].Value, '<option[^>]*value=["'']([^"'']*)["''][^>]*>([\s\S]*?)</option>', 'IgnoreCase')) {
    [pscustomobject]@{
      value = $m.Groups[1].Value.Trim()
      label = ($m.Groups[2].Value -replace '<[^>]*>', ' ' -replace '\s+', ' ').Trim()
    }
  }
}

$bCourseNumOptions = foreach ($m in [regex]::Matches($bOptionsContent, '<option[^>]*value=["'']([^"'']*)["''][^>]*>([\s\S]*?)</option>', 'IgnoreCase')) {
  [pscustomobject]@{
    value = $m.Groups[1].Value.Trim()
    label = ($m.Groups[2].Value -replace '<[^>]*>', ' ' -replace '\s+', ' ').Trim()
  }
}

Write-Output "LOGIN_OK=$([bool]($loginContent.Contains('logout') -or $loginContent.Contains('check_logout') -or $loginContent.Contains('登出')))"
Write-Output "COURSE_PAGE=$coursePage"
Write-Output "ADD_PAGE=$addPage"
Write-Output "B_OPTIONS_PAGE=$bOptionsPage"
Write-Output "OPTION_COUNT=$($options.Count)"
Write-Output 'COURSE_OPTIONS_BEGIN'
$options | ForEach-Object { Write-Output ("{0}`t{1}" -f $_.value, $_.label) }
Write-Output 'COURSE_OPTIONS_END'
Write-Output "B_MATCH_COUNT=$($bMatches.Count)"
if ($bMatches.Count -gt 0) {
  Write-Output 'B_MATCHES_BEGIN'
  $bMatches | ForEach-Object { Write-Output ("{0}`t{1}" -f $_.value, $_.label) }
  Write-Output 'B_MATCHES_END'
}
Write-Output "ADD_COURSE_NAME_COUNT=$($courseNameOptions.Count)"
Write-Output 'ADD_COURSE_NAME_BEGIN'
$courseNameOptions | ForEach-Object { Write-Output ("{0}`t{1}" -f $_.value, $_.label) }
Write-Output 'ADD_COURSE_NAME_END'
Write-Output "B_COURSE_NUM_COUNT=$($bCourseNumOptions.Count)"
Write-Output 'B_COURSE_NUM_BEGIN'
$bCourseNumOptions | ForEach-Object { Write-Output ("{0}`t{1}" -f $_.value, $_.label) }
Write-Output 'B_COURSE_NUM_END'
