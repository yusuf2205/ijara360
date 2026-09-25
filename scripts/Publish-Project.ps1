[CmdletBinding()]
param([switch]$SkipGitea, [ValidateSet('192.168.1.105', '100.126.164.29')][string]$NasHost = '192.168.1.105')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function Invoke-Git {
    param([string[]]$GitArgs)
    $result = & git @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "git failed: $($GitArgs -join ' ')" }
    return $result
}

$branch = Invoke-Git -GitArgs @('branch', '--show-current')
if ($branch -ne 'main') { throw 'Switch to main before publishing.' }
$changes = Invoke-Git -GitArgs @('status', '--porcelain', '--untracked-files=normal')
if ($changes) { throw 'Commit project changes before publishing. Ignored local secrets are excluded.' }
$revision = Invoke-Git -GitArgs @('rev-parse', 'HEAD')
if ($revision -notmatch '^[a-f0-9]{40}$') { throw 'Unexpected commit ID.' }

$transferDir = Join-Path $projectRoot ".local/publish/$revision"
New-Item -ItemType Directory -Force -Path $transferDir | Out-Null
$archive = Join-Path $transferDir 'source.tar'
$bundle = Join-Path $transferDir 'repository.bundle'
$manifest = Join-Path $transferDir 'manifest.sha256'
Invoke-Git -GitArgs @('archive', '--format=tar', "--output=$archive", $revision) | Out-Null
Invoke-Git -GitArgs @('bundle', 'create', $bundle, 'main') | Out-Null
Invoke-Git -GitArgs @('bundle', 'verify', $bundle) | Out-Null
$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$bundleHash = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant()
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($manifest, "$archiveHash  source.tar`n$bundleHash  repository.bundle`n", $utf8)

$failures = New-Object 'System.Collections.Generic.List[string]'
$remotes = @('github')
if (-not $SkipGitea) { $remotes += 'mygithub' }
foreach ($remote in $remotes) {
    try {
        Invoke-Git -GitArgs @('push', $remote, "${revision}:refs/heads/main") | Out-Null
        $ref = Invoke-Git -GitArgs @('ls-remote', $remote, 'refs/heads/main')
        if (-not $ref -or ($ref -split '\s+')[0] -ne $revision) {
            throw "Remote $remote does not point to $revision."
        }
        Write-Output "VERIFIED $remote main $revision"
    } catch {
        $failures.Add("${remote}: $($_.Exception.Message)")
        Write-Warning $failures[$failures.Count - 1]
    }
}

# Fixed, user-authorized target. No deployment, deletion, sudo or container changes.
$nasTarget = "Joseph@$NasHost"
$release = "/volume1/docker/ijara360/releases/$revision"
$sshOptions = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15')
try {
    $state = & ssh @sshOptions $nasTarget "if test -d $release; then echo existing; else echo absent; fi"
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect NAS release directory.' }
    if ($state -eq 'absent') {
        & ssh @sshOptions $nasTarget "set -eu; mkdir -p /volume1/docker/ijara360/releases; mkdir $release; mkdir $release/source"
        if ($LASTEXITCODE -ne 0) { throw 'Cannot create new NAS release directory.' }
        # UGOS SFTP exposes a different root; legacy SCP uses the verified SSH path.
        & scp -O @sshOptions $archive $bundle $manifest "${nasTarget}:${release}/"
        if ($LASTEXITCODE -ne 0) { throw 'NAS transfer failed; incomplete directory retained for inspection.' }
        & ssh @sshOptions $nasTarget "set -eu; cd $release; sha256sum -c manifest.sha256; tar -xf source.tar -C source; touch COMPLETE"
        if ($LASTEXITCODE -ne 0) { throw 'NAS checksum or extraction failed.' }
    } elseif ($state -ne 'existing') {
        throw 'Unexpected NAS response.'
    }
    # A repeated publish never overwrites an existing release or silently repairs it.
    & ssh @sshOptions $nasTarget "set -eu; cd $release; test -f COMPLETE; sha256sum -c manifest.sha256"
    if ($LASTEXITCODE -ne 0) { throw 'Existing NAS release is incomplete or corrupted; inspect before repair.' }
    $remoteHash = & ssh @sshOptions $nasTarget "sha256sum $release/source.tar"
    if ($LASTEXITCODE -ne 0 -or ($remoteHash -split '\s+')[0] -ne $archiveHash) {
        throw 'NAS source archive differs from the local commit archive.'
    }
    Write-Output "VERIFIED NAS $release"
} catch {
    $failures.Add("NAS: $($_.Exception.Message)")
    Write-Warning $failures[$failures.Count - 1]
}

if ($SkipGitea) {
    Write-Warning 'PARTIAL publication: mygithub intentionally skipped.'
}
if ($failures.Count -gt 0) { throw ($failures -join "`n") }
if (-not $SkipGitea) { Write-Output "All three destinations verified at $revision" }
