#!/bin/sh
# Nightly backup service (compose service "backup", postgres:17-bookworm image), see docs/M6-RELIABILITY.md.
#   loop  wait for BACKUP_AT (local time, TZ), back up, repeat; catch up at start if the last good backup is stale
#   once     one backup: pg_dump, encrypted documents archive, checksums, restore check, 14-day retention
#   attempt  one backup as the nightly run does it, recording a failure in the status file
# Files match scripts/backup-nas.sh (ijara360-<stamp>.dump / .kyc.tar / .sha256), so
# verify-backup-nas.sh and verify-migration-nas.sh work on them too.
# The restore check runs in a private throwaway cluster inside this container: no Docker access, no network.
# Logs and the status file carry no personal data.
set -eu
umask 077
backups=${BACKUP_DIR:-/backups}
kyc=${KYC_DIR:-/kyc}
status_dir=${STATUS_DIR:-/status}
db_host=${DB_HOST:-db}
db_name=${DB_NAME:-ijara360}
step_file=/tmp/ijara360-backup-step

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
step() { printf '%s' "$1" > "$step_file"; }

# {"ok":true,"at":"…","file":"ijara360-….dump","bytes":N,"documents":N} or {"ok":false,"at":"…","step":"dump|documents|verify"}
write_status() {
  tmp="$status_dir/.backup.json.tmp"
  printf '%s\n' "$1" > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$status_dir/backup.json"
}

once() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)-nightly
  name="ijara360-$stamp"
  file="$backups/$name.dump"
  archive="$backups/$name.kyc.tar"
  step dump
  pg_dump -h "$db_host" -U ijara_owner -d "$db_name" -Fc -f "$file.partial"
  test -s "$file.partial"
  chmod 600 "$file.partial"
  # Documents after the dump: files are written before their row commits and never deleted,
  # so the archive covers every storage_key in the dump.
  step documents
  tar -C "$kyc" -cf "$archive.partial" .
  test -s "$archive.partial"
  chmod 600 "$archive.partial"
  mv "$file.partial" "$file"
  mv "$archive.partial" "$archive"
  (cd "$backups"; sha256sum "$name.dump" > "$name.dump.sha256"; sha256sum "$name.kyc.tar" > "$name.kyc.tar.sha256")
  chmod 600 "$file.sha256" "$archive.sha256"

  step verify
  (cd "$backups"; sha256sum -c --quiet "$name.dump.sha256" "$name.kyc.tar.sha256")
  members=$(mktemp)
  tar -tf "$archive" | sed -n 's#^\./##; /\.enc$/p' | sort > "$members"
  work=$(mktemp -d /tmp/ijara360-restore.XXXXXX)
  chown postgres "$work"
  trap 'gosu postgres pg_ctl -D "$work/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work" "$members"' EXIT
  gosu postgres initdb -D "$work/data" -U ijara_owner --auth=trust -E UTF8 >/dev/null
  gosu postgres pg_ctl -D "$work/data" -o "-c listen_addresses='' -k $work" -l "$work/server.log" -w start >/dev/null
  psql -X -q -v ON_ERROR_STOP=1 -h "$work" -U ijara_owner -d postgres -c 'CREATE DATABASE ijara360_restore' -c 'CREATE ROLE ijara_app'
  pg_restore -h "$work" -U ijara_owner -d ijara360_restore --exit-on-error "$file"
  query() { psql -X -q -t -A -v ON_ERROR_STOP=1 -h "$work" -U ijara_owner -d ijara360_restore -c "$1"; }
  test "$(query 'SELECT count(*) > 0 FROM _prisma_migrations')" = t
  keys=''
  if [ "$(query "SELECT to_regclass('public.application_documents') IS NOT NULL")" = t ]; then
    keys=$(query 'SELECT storage_key FROM application_documents ORDER BY storage_key')
  fi
  missing=$(printf '%s\n' "$keys" | sed '/^$/d' | sort | comm -23 - "$members" | wc -l)
  test "$((missing))" = 0 || { log "verify: $((missing)) documents missing from the archive"; exit 1; }
  documents=$(wc -l < "$members")

  # Retention: 14 days, exact names only (the deploy backups share this directory and rule).
  for pattern in 'ijara360-*.dump' 'ijara360-*.dump.sha256' 'ijara360-*.kyc.tar' 'ijara360-*.kyc.tar.sha256'; do
    find "$backups" -maxdepth 1 -type f -name "$pattern" -mtime +14 -delete
  done
  bytes=$(($(wc -c < "$file") + $(wc -c < "$archive")))
  write_status "{\"ok\":true,\"at\":\"$(date -u +%FT%TZ)\",\"file\":\"$name.dump\",\"bytes\":$bytes,\"documents\":$documents}"
  log "backup OK $name.dump bytes=$bytes documents=$documents (restore verified)"
}

attempt() {
  # A separate process, so "set -e" stops at the first failing step.
  if sh "$0" once; then return 0; fi
  failed=$(cat "$step_file" 2>/dev/null || echo unknown)
  rm -f "$backups"/ijara360-*-nightly.dump.partial "$backups"/ijara360-*-nightly.kyc.tar.partial
  write_status "{\"ok\":false,\"at\":\"$(date -u +%FT%TZ)\",\"step\":\"$failed\"}"
  log "backup FAILED at step $failed"
}

# True when the last recorded backup succeeded less than 26 hours ago.
fresh() {
  test -f "$status_dir/backup.json" || return 1
  grep -q '"ok":true' "$status_dir/backup.json" || return 1
  at=$(sed -n 's/.*"at":"\([^"]*\)".*/\1/p' "$status_dir/backup.json")
  test -n "$at" || return 1
  test $(($(date +%s) - $(date -d "$at" +%s))) -lt 93600
}

seconds_to_next() {
  now=$(date +%s)
  next=$(date -d "today ${BACKUP_AT:-03:30}" +%s)
  if [ "$next" -le "$now" ]; then next=$(date -d "tomorrow ${BACKUP_AT:-03:30}" +%s); fi
  echo $((next - now))
}

case "${1:-loop}" in
  once) once ;;
  attempt) attempt ;;
  loop)
    if ! fresh; then log "no fresh backup on record: backing up now"; attempt; fi
    while true; do
      wait_for=$(seconds_to_next)
      log "next backup at ${BACKUP_AT:-03:30} $(date +%Z), in ${wait_for}s"
      sleep "$wait_for"
      attempt
    done ;;
  *) echo "usage: backup-service.sh loop|once" >&2; exit 2 ;;
esac
