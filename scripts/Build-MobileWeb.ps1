[CmdletBinding()]
param([string]$Revision = '')
# Builds apps/mobile for the web at /app and places it in apps/web/public/app (ignored by Git).
# The NAS has no Flutter SDK: releases carry this build, checked by sha256 and by the COMMIT stamp.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$flutter = if (Get-Command flutter -ErrorAction SilentlyContinue) { 'flutter' } else { 'C:\src\flutter\bin\flutter.bat' }
Push-Location (Join-Path $projectRoot 'apps/mobile')
try {
    & $flutter pub get | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'flutter pub get failed.' }
    & $flutter test
    if ($LASTEXITCODE -ne 0) { throw 'Flutter tests failed; the app is not published.' }
    & $flutter build web --release --base-href /app/ --no-web-resources-cdn
    if ($LASTEXITCODE -ne 0) { throw 'flutter build web failed.' }
} finally { Pop-Location }
# Signed Android build (key outside the repo, see apps/mobile/android/app/build.gradle.kts).
$keyProps = if ($env:IJARA_KEY_PROPERTIES) { $env:IJARA_KEY_PROPERTIES } else { Join-Path $env:USERPROFILE '.ijara360/android/key.properties' }
if (-not (Test-Path -LiteralPath $keyProps)) { throw "Release signing key not found ($keyProps); the APK would be debug-signed." }
Push-Location (Join-Path $projectRoot 'apps/mobile')
try {
    & $flutter build apk --release
    if ($LASTEXITCODE -ne 0) { throw 'flutter build apk failed.' }
} finally { Pop-Location }
$target = Join-Path $projectRoot 'apps/web/public/app'
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $projectRoot 'apps/mobile/build/web') -Destination $target -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'apps/mobile/build/app/outputs/flutter-apk/app-release.apk') -Destination (Join-Path $target 'ijara360.apk')
if (-not $Revision) { $Revision = (& git -C $projectRoot rev-parse HEAD) }
[IO.File]::WriteAllText((Join-Path $target 'COMMIT'), $Revision, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "BUILT apps/web/public/app for $Revision"
