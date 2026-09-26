[CmdletBinding()]
param([ValidateSet('192.168.1.105', '100.126.164.29')][string]$NasHost = '192.168.1.105')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$revision = & git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[a-f0-9]{40}$') { throw 'Cannot identify the Git revision.' }
if (& git status --porcelain) { throw 'Commit changes and run Publish-Project.ps1 before deploying.' }
$source = "/volume1/docker/ijara360/releases/$revision/source"
# The release script backs up and verifies existing data, deploys migrations,
# and records the revision only after service health and HTTPS checks pass.
$command = "sh $source/infra/deploy-release.sh $revision"
& ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "Joseph@$NasHost" $command
if ($LASTEXITCODE -ne 0) { throw 'NAS deployment failed; inspect the ijara360 service logs.' }
Write-Output "Deployed $revision to https://192.168.1.105:8446"
