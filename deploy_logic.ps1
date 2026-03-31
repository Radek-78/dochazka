param(
    [string]$commitMsg,
    [string]$bumpType
)

$versionFile = "Version.gs"
$indexFile = "index.html"

# 1. Read Version.gs
$content = [System.IO.File]::ReadAllText($versionFile, [System.Text.Encoding]::UTF8)

# Extract version
$match = [regex]::Match($content, 'APP_VERSION = "(.*?)"')
if (!$match.Success) { 
    Write-Error "Nepodařilo se najít verzi v Version.gs"
    exit 1 
}

$currentVersion = $match.Groups[1].Value
$parts = $currentVersion -split '\.'
[int]$major = $parts[0]
[int]$minor = $parts[1]
[int]$patch = $parts[2]

# 2. Bump version
if ($bumpType -ieq 'P') { $patch++ }
elseif ($bumpType -ieq 'M') { $minor++; $patch = 0 }
elseif ($bumpType -ieq 'J') { $major++; $minor = 0; $patch = 0 }

$newVersion = "$major.$minor.$patch"
$date = Get-Date -Format "yyyy-MM-dd"
$dateTimeTitle = Get-Date -Format "dd.MM.yyyy HH:mm"

if ($bumpType -ine 'N') {
    Write-Host "Aktualizuji na verzi v$newVersion..." -ForegroundColor Cyan
    
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

# Output the new version for Batch to capture
Write-Output $newVersion
