[CmdletBinding()]
param([ValidateSet('192.168.1.105', '100.126.164.29')][string]$NasHost = '192.168.1.105')
# New owner password when nobody can sign in (scripts/reset-owner-password.sh in the deployed release).
# sudo asks for the NAS password on this terminal; the new app password is typed hidden on the NAS side.
$ErrorActionPreference = 'Stop'
$root = '/volume1/docker/ijara360'
$command = "sudo sh $root/releases/`$(cat $root/DEPLOYED_COMMIT)/source/scripts/reset-owner-password.sh"
& ssh -t -o BatchMode=yes -o StrictHostKeyChecking=yes "Joseph@$NasHost" $command
if ($LASTEXITCODE -ne 0) { throw 'Пароль не изменён.' }
