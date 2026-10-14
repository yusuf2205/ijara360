[CmdletBinding()]
param(
    # An offsite copy downloaded from Google Drive or taken from the USB drive (ijara360-….tar.age).
    [Parameter(Mandatory)][string]$Copy,
    # The owner's age secret key file (AGE-SECRET-KEY-1…). Without it the key is asked with hidden input
    # and kept only in the drill's private temporary folder, which is deleted at the end.
    [string]$KeyFile,
    [string]$Age = (Join-Path $env:USERPROFILE '.ijara360/tools/age/age.exe')
)
# Restore drill for docs/M6-OFFSITE.md: proves an offsite copy can be decrypted and is intact.
# The decrypted dump holds personal data: it lives in a private temporary folder and is deleted at the end.
$ErrorActionPreference = 'Stop'
foreach ($path in @($Copy, $Age) + @($KeyFile | Where-Object { $_ })) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Файл не найден: $path" }
}
$work = Join-Path ([IO.Path]::GetTempPath()) ("ijara360-drill-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    if (-not $KeyFile) {
        $secure = Read-Host 'Вставьте секретный ключ AGE-SECRET-KEY-1… (ввод скрыт)' -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        if ($plain -notmatch '^AGE-SECRET-KEY-1[0-9A-Z]{58}$') { throw 'Это не секретный ключ age (строка AGE-SECRET-KEY-1… из 74 символов).' }
        $KeyFile = Join-Path $work 'key.txt'
        [IO.File]::WriteAllText($KeyFile, $plain + "`n")
        Remove-Variable plain
    }
    $tar = Join-Path $work 'copy.tar'
    & $Age --decrypt --identity $KeyFile --output $tar $Copy
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось расшифровать: ключ не подходит к этой копии или файл повреждён.' }
    & tar -xf $tar -C $work
    if ($LASTEXITCODE -ne 0) { throw 'Расшифрованный архив повреждён.' }
    $sums = Get-ChildItem -LiteralPath $work -Filter 'ijara360-*.sha256'
    if ($sums.Count -ne 2) { throw "Ожидались 2 файла контрольных сумм, найдено $($sums.Count)." }
    foreach ($sum in $sums) {
        $expected, $name = (Get-Content -LiteralPath $sum.FullName -Raw).Trim() -split '\s+', 2
        $actual = (Get-FileHash -LiteralPath (Join-Path $work $name.TrimStart('*')) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw "Контрольная сумма не совпала: $name" }
        $size = [math]::Round((Get-Item -LiteralPath (Join-Path $work $name.TrimStart('*'))).Length / 1MB, 1)
        Write-Output "OK  $name  ($size МБ)"
    }
    Write-Output 'УЧЕНИЯ ПРОЙДЕНЫ: копия расшифрована вашим ключом, база и документы целы.'
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
