@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

:: Ziskat aktualni datum a cas z WMIC pro stabilni format
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set datetime=%%I
set "YY=%datetime:~0,4%"
set "MM=%datetime:~4,2%"
set "DD=%datetime:~6,2%"
set "HH=%datetime:~8,2%"
set "MIN=%datetime:~10,2%"
set "SEC=%datetime:~12,2%"

set "DEPLOY_TIME=%DD%.%MM%.%YY% %HH%:%MIN%"

echo Zapisuji cas deploye: %DEPLOY_TIME% do index.html

:: Pouziti powershell pro spolehlive modifikovani textu v UTF-8 a nahrazeni textu v divu
powershell -Command "$path='index.html'; $content=[System.IO.File]::ReadAllText($path); $content=$content -replace '(?s)<div id=\"deploy-time-footer\">.*?</div>', '<div id=\"deploy-time-footer\">v2.4.0 | RBAC Scoped Engine Ready | Aktualizace: %DEPLOY_TIME%</div>'; [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))"

echo.
echo Spoustim clasp push...
echo.
call clasp push
if %ERRORLEVEL% neq 0 (
    echo.
    echo Clasp push SELHAL!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo Deploy byl uspesne dokoncen.
pause
