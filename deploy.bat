@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

echo ====================================================
echo      LIDL DOCHÁZKA - DEPLOY ^& VERSIONING
echo ====================================================
echo.

:: Získání zprávy pro commit
set /p COMMIT_MSG="Zadejte popis změn (pro commit a changelog): "
if "%COMMIT_MSG%"=="" (
    echo Popis nesmí být prázdný!
    pause
    exit /b 1
)

:: Získání typu navýšení verze
echo.
echo Zvýšit verzi? 
echo [P] Patch (opravy, drobnosti)  -^> v2.4.x
echo [M] Minor (nové funkce)        -^> v2.x.0
echo [J] Major (velké změny)        -^> vx.0.0
echo [N] Nic   (jen commit ^& push)
set /p BUMP_TYPE="Vyberte [P/M/J/N] (výchozí P): "
if "%BUMP_TYPE%"=="" set BUMP_TYPE=P

echo.
echo Příprava verze...

:: Spuštění PowerShellu pro logiku verzování
for /f "delims=" %%v in ('powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$commitMsg = '%COMMIT_MSG%';" ^
    "$bumpType = '%BUMP_TYPE%';" ^
    "$versionFile = 'Version.gs';" ^
    "$indexFile = 'index.html';" ^
    "$content = [System.IO.File]::ReadAllText($versionFile, [System.Text.Encoding]::UTF8);" ^
    "$match = [regex]::Match($content, 'APP_VERSION = \"(.*?)\"');" ^
    "if (!$match.Success) { Write-Error 'Nepodařilo se najít verzi v Version.gs'; exit 1 }" ^
    "$currentVersion = $match.Groups[1].Value;" ^
    "$parts = $currentVersion -split '\.';" ^
    "[int]$major = $parts[0]; [int]$minor = $parts[1]; [int]$patch = $parts[2];" ^
    "if ($bumpType -ieq 'P') { $patch++ } " ^
    "elseif ($bumpType -ieq 'M') { $minor++; $patch = 0 } " ^
    "elseif ($bumpType -ieq 'J') { $major++; $minor = 0; $patch = 0 }" ^
    "$newVersion = \"$major.$minor.$patch\";" ^
    "$date = Get-Date -Format 'yyyy-MM-dd';" ^
    "$dateTimeTitle = Get-Date -Format 'dd.MM.yyyy HH:mm';" ^
    "if ($bumpType -ine 'N') {" ^
    "  $newEntry = \"  {`n    `\"version`\": `\"$newVersion`\",`n    `\"date`\": `\"$date`\",`n    `\"changes`\": [`n      `\"$commitMsg`\"`n    ]`n  },\";" ^
    "  $content = $content -replace 'APP_VERSION = \"(.*?)\"', \"APP_VERSION = `\"$newVersion`\"\";" ^
    "  $content = $content -replace 'const APP_CHANGELOG = \[', \"const APP_CHANGELOG = [`n$newEntry\";" ^
    "  [System.IO.File]::WriteAllText($versionFile, $content, [System.Text.UTF8Encoding]::new($false));" ^
    "  $indexContent = [System.IO.File]::ReadAllText($indexFile, [System.Text.Encoding]::UTF8);" ^
    "  $indexContent = $indexContent -replace 'v\d+\.\d+\.\d+', \"v$newVersion\";" ^
    "  $indexContent = $indexContent -replace 'Aktualizace: \d+\.\d+\.\d+ \d+:\d+', \"Aktualizace: $dateTimeTitle\";" ^
    "  [System.IO.File]::WriteAllText($indexFile, $indexContent, [System.Text.UTF8Encoding]::new($false));" ^
    "}" ^
    "Write-Output $newVersion"') do set NEW_VER=%%v

if %ERRORLEVEL% neq 0 (
    echo.
    echo Chyba při aktualizaci verze!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo Provádím Git commit pro v%NEW_VER%...
git add .
git commit -m "v%NEW_VER%: %COMMIT_MSG%"

echo.
echo Spouštím clasp push...
echo.
call clasp push
if %ERRORLEVEL% neq 0 (
    echo.
    echo Clasp push SELHAL!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ====================================================
echo    Nasazení v%NEW_VER% proběhlo úspěšně!
echo ====================================================
pause
