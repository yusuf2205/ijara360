#!/bin/sh
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
root=/volume1/docker/ijara360
mkdir -p "$root/backups/logs"
chmod 700 "$root/backups" "$root/backups/logs"
# The kernel releases this lock even if the process is interrupted.
exec 9>"$root/backups/daily.lock"
chmod 600 "$root/backups/daily.lock"
flock -n 9 || exit 0
log="$root/backups/logs/backup-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
touch "$log"
chmod 600 "$log"
exec >>"$log" 2>&1
trap 'result=$?; printf "%s BACKUP RESULT exit=%s\n" "$(date -u +%FT%TZ)" "$result"' EXIT
printf '%s BACKUP START\n' "$(date -u +%FT%TZ)"
revision=$(cat "$root/DEPLOYED_COMMIT")
test "${#revision}" = 40
case "$revision" in *[!a-f0-9]*) exit 1;; esac
source="$root/releases/$revision/source"
test -f "$root/releases/$revision/COMPLETE"
backup=$(sh "$source/scripts/backup-nas.sh")
printf '%s DUMP OK %s bytes=%s\n' "$(date -u +%FT%TZ)" "$backup" "$(wc -c < "$backup")"
sh "$source/scripts/verify-backup-nas.sh" "$backup"
printf '%s RESTORE VERIFIED\n' "$(date -u +%FT%TZ)"
find "$root/backups/logs" -maxdepth 1 -type f -name 'backup-*.log' -mtime +60 -delete
