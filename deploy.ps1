# deploy.ps1
# Full deployment and versioning logic in PowerShell to avoid Batch issues.
$chcp = chcp 65001 >$null # Set to UTF-8 for stable output

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "      LIDL DOCHÁZKA - DEPLOY A VERSIONING" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Get commit message
$commitMsg = Read-Host "Zadejte popis změn (pro commit a changelog)"
if ([string]::IsNullOrWhiteSpace($commitMsg)) {
    Write-Host "Popis nesmí být prázdný!" -ForegroundColor Red
    pause
    exit 1
}

# 2. Get bump type
Write-Host ""
Write-Host "Zvýšit verzi?"
Write-Host "[P] Patch (opravy, drobnosti)  -> v2.4.x"
Write-Host "[M] Minor (nové funkce)        -> v2.x.0"
Write-Host "[J] Major (velké změny)        -> vx.0.0"
Write-Host "[N] Nic   (jen commit & push)"
$bumpType = Read-Host "Vyberte [P/M/J/N] (výchozí P)"
if ([string]::IsNullOrWhiteSpace($bumpType)) { $bumpType = "P" }

Write-Host ""
Write-Host "Příprava verze..." -ForegroundColor Yellow

$versionFile = "Version.gs"
$indexFile = "index.html"

# Read version
$content = [System.IO.File]::ReadAllText($versionFile, [System.Text.Encoding]::UTF8)
$match = [regex]::Match($content, 'APP_VERSION = "(.*?)"')
if (!$match.Success) {
    Write-Host "Nepodařilo se najít verzi v Version.gs" -ForegroundColor Red
    pause
    exit 1
}

$currentVersion = $match.Groups[1].Value
$parts = $currentVersion -split '\.'
[int]$major = $parts[0]
[int]$minor = $parts[1]
[int]$patch = $parts[2]

# Bump
if ($bumpType -ieq 'P') { $patch++ }
elseif ($bumpType -ieq 'M') { $minor++; $patch = 0 }
elseif ($bumpType -ieq 'J') { $major++; $minor = 0; $patch = 0 }

$newVersion = "$major.$minor.$patch"
$date = Get-Date -Format "yyyy-MM-dd"
$dateTimeTitle = Get-Date -Format "dd.MM.yyyy HH:mm"

if ($bumpType -ine 'N') {
    Write-Host "Aktualizuji na verzi v$newVersion..." -ForegroundColor Yellow
    
    # Update Version.gs
    $newEntry = "  {`n    `"version`": `"$newVersion`",`n    `"date`": `"$date`",`n    `"changes`": [`n      `"$commitMsg`"`n    ]`n  },"
    $content = $content -replace "APP_VERSION = `"(.*?)\`"", "APP_VERSION = `"$newVersion`""
    $content = $content -replace "const APP_CHANGELOG = \[", "const APP_CHANGELOG = [`n$newEntry"
    [System.IO.File]::WriteAllText($versionFile, $content, [System.Text.UTF8Encoding]::new($false))
    
    # Update index.html
    $indexContent = [System.IO.File]::ReadAllText($indexFile, [System.Text.Encoding]::UTF8)
    $indexContent = $indexContent -replace 'v\d+\.\d+\.\d+', "v$newVersion"
    $indexContent = $indexContent -replace 'Aktualizace: \d+\.\d+\.\d+ \d+:\d+', "Aktualizace: $dateTimeTitle"
    [System.IO.File]::WriteAllText($indexFile, $indexContent, [System.Text.UTF8Encoding]::new($false))
}

# Git commit
Write-Host ""
Write-Host "Provádím Git commit pro v$newVersion..." -ForegroundColor Yellow
git add .
git commit -m "v${newVersion}: $commitMsg"

# Clasp push
Write-Host ""
Write-Host "Spouštím clasp push..." -ForegroundColor Yellow
clasp push
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Clasp push SELHAL!" -ForegroundColor Red
    pause
    exit $LASTEXITCODE
}

# Git push byl odstraněn na žádost uživatele (pouze lokální Git)

Write-Host ""
Write-Host "====================================================" -ForegroundColor Green
Write-Host "    Nasazení v$newVersion proběhlo úspěšně!" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host ""
# pause
