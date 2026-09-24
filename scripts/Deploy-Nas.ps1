[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$revision = & git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[a-f0-9]{40}$') { throw 'Cannot identify the Git revision.' }
if (& git status --porcelain) { throw 'Commit changes and run Publish-Project.ps1 before deploying.' }
$source = "/volume1/docker/ijara360/releases/$revision/source"
$secretFile = '/volume1/docker/ijara360/secrets/production.env'
# Only two public configuration files need container-readable permissions on UGOS.
# Runtime data/secrets and other projects are not modified by this script.
$command = "set -eu; test -f $source/compose.yaml; test -f $secretFile; chmod 644 $source/infra/init-db.sql $source/infra/Caddyfile; RELEASE_TAG=$revision docker compose --env-file $secretFile -f $source/compose.yaml up -d --build; printf %s $revision > /volume1/docker/ijara360/DEPLOYED_COMMIT; docker compose --env-file $secretFile -f $source/compose.yaml ps"
& ssh -o BatchMode=yes -o StrictHostKeyChecking=yes Joseph@192.168.1.105 $command
if ($LASTEXITCODE -ne 0) { throw 'NAS deployment failed; inspect the ijara360 service logs.' }
Write-Output "Deployed $revision to https://192.168.1.105:8446"
