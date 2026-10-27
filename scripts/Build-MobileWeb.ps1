[CmdletBinding()]
param([string]$Revision = '')
# Builds apps/mobile for the web at /app and places it in apps/web/public/app (ignored by Git).
# The NAS has no Flutter SDK: releases carry this build, checked by sha256 and by the COMMIT stamp.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$flutter = if (Get-Command flutter -ErrorAction SilentlyContinue) { 'flutter' } else { 'C:\src\flutter\bin\flutter.bat' }
# The release revision is baked into the app so it can tell when the server has a newer build (auto-update).
if (-not $Revision) { $Revision = (& git -C $projectRoot rev-parse HEAD).Trim() }
# Android only installs an update whose versionCode is not lower; the commit count only grows on main.
$build = (& git -C $projectRoot rev-list --count $Revision).Trim()
Push-Location (Join-Path $projectRoot 'apps/mobile')
try {
    & $flutter pub get | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'flutter pub get failed.' }
    & $flutter test
    if ($LASTEXITCODE -ne 0) { throw 'Flutter tests failed; the app is not published.' }
    & $flutter build web --release --base-href /app/ --no-web-resources-cdn --dart-define=BUILD_COMMIT=$Revision
    if ($LASTEXITCODE -ne 0) { throw 'flutter build web failed.' }
} finally { Pop-Location }
# Signed Android build (key outside the repo, see apps/mobile/android/app/build.gradle.kts).
$keyProps = if ($env:IJARA_KEY_PROPERTIES) { $env:IJARA_KEY_PROPERTIES } else { Join-Path $env:USERPROFILE '.ijara360/android/key.properties' }
if (-not (Test-Path -LiteralPath $keyProps)) { throw "Release signing key not found ($keyProps); the APK would be debug-signed." }
Push-Location (Join-Path $projectRoot 'apps/mobile')
try {
    $apkArgs = @('--release', "--build-number=$build", "--build-name=1.0.$build", "--dart-define=BUILD_COMMIT=$Revision", "--dart-define=BUILD_NUMBER=$build")
    # Universal APK (every processor, ~55 MB) for the first install from /download.
    & $flutter build apk @apkArgs
    if ($LASTEXITCODE -ne 0) { throw 'flutter build apk failed.' }
    $universal = Join-Path $env:TEMP "ijara360-universal-$build.apk"
    Copy-Item -LiteralPath 'build/app/outputs/flutter-apk/app-release.apk' -Destination $universal -Force
    # One small APK per processor (~20 MB) for background updates. Same versionCode as the universal one
    # (no ABI offset), so phones move freely between them from release to release.
    & $flutter build apk @apkArgs --split-per-abi -P force-version-code-ignoring-abi=true
    if ($LASTEXITCODE -ne 0) { throw 'flutter build apk --split-per-abi failed.' }
} finally { Pop-Location }
$target = Join-Path $projectRoot 'apps/web/public/app'
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $projectRoot 'apps/mobile/build/web') -Destination $target -Recurse
Copy-Item -LiteralPath $universal -Destination (Join-Path $target 'ijara360.apk')
Remove-Item -LiteralPath $universal -Force
foreach ($abi in 'arm64-v8a', 'armeabi-v7a', 'x86_64') {
    Copy-Item -LiteralPath (Join-Path $projectRoot "apps/mobile/build/app/outputs/flutter-apk/app-$abi-release.apk") -Destination (Join-Path $target "ijara360-$abi.apk")
}
[IO.File]::WriteAllText((Join-Path $target 'COMMIT'), $Revision, (New-Object System.Text.UTF8Encoding($false)))
# The Android versionCode of ijara360.apk; installed apps update only to a strictly higher number (never down).
[IO.File]::WriteAllText((Join-Path $target 'BUILD'), $build, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "BUILT apps/web/public/app for $Revision"
