#!/bin/sh
# Nightly encrypted backup of every NAS project to the USB drive, so a failed NVMe or hard disk
# loses at most one day. restic: encrypted (password file), deduplicated, versioned.
#
#   /projects  NVMe projects (/volume3/projects): code, settings, .env, uploads kept inside
#   /storage   hard-disk storage (/volume1/storage): backups, documents, files
#   /volumes   Docker named volumes on the NVMe (MinIO files, Vaultly, Grafana, Tailscale state)
#   /archive   /volume1/DocumentsArchive
# Live database folders are skipped; their consistent dumps go to /storage/_db-dumps first.
#
#   backup.sh          run every night at $BACKUP_AT (container command)
#   backup.sh once     one backup now
#   backup.sh init     create the repository on /usb/$USB_DRIVE (first time only)
set -u
set -o pipefail
NAME=NAS-projects-restic
DUMPS=/storage/_db-dumps
STATUS=/storage/_usb-backup-status
export RESTIC_PASSWORD_FILE=/run/restic-password RESTIC_CACHE_DIR=/cache
AT=${BACKUP_AT:-04:30}
# named volumes with files worth keeping (databases are dumped, caches skipped)
VOLUMES=''
for v in top-procurement_minio_data top-procurement-staging_minio_data top-procurement_backup_data top-procurement_proxy_certs   vaultly_vaultly-data vaultly_vaultly-backups byteforge_byteforge-data nut-ups_grafana-data nut-ups_prom-data tailscale_tailscale-state suhbat_tgbridge-data; do
  [ -d "/volumes/$v" ] && VOLUMES="$VOLUMES /volumes/$v"
done

log() { echo "$(date '+%F %T') $*"; }
repo() { for d in /usb/*/"$NAME"; do [ -f "$d/config" ] && { echo "$d"; return 0; }; done; return 1; }

pg() { # container
  docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q true || { log "skip $1: not running"; return 0; }
  docker exec "$1" sh -c 'pg_dumpall -U "$POSTGRES_USER"' | gzip > "$DUMPS/$1.sql.gz.partial" \
    && mv "$DUMPS/$1.sql.gz.partial" "$DUMPS/$1.sql.gz" && log "dump $1 ok"
}
maria() {
  docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q true || { log "skip $1: not running"; return 0; }
  docker exec "$1" sh -c 'exec mariadb-dump -uroot -p"$MYSQL_ROOT_PASSWORD" --all-databases --single-transaction' \
    | gzip > "$DUMPS/$1.sql.gz.partial" && mv "$DUMPS/$1.sql.gz.partial" "$DUMPS/$1.sql.gz" && log "dump $1 ok"
}
lite() { # name file
  [ -f "$2" ] || { log "skip $1: no $2"; return 0; }
  sqlite3 "file:$2?mode=ro" ".backup '$DUMPS/$1.db.partial'" && mv "$DUMPS/$1.db.partial" "$DUMPS/$1.db" && log "dump $1 ok"
}

once() {
  R=$(repo) || { log 'FAIL: no USB drive with the backup repository is plugged in'; return 1; }
  export RESTIC_REPOSITORY=$R
  mkdir -p "$DUMPS" && chmod 700 "$DUMPS"
  rm -f "$DUMPS"/*.partial
  bad=''
  pg ijara360-db-1 || bad="$bad ijara360-db"
  pg yusmus-postgres-1 || bad="$bad yusmus-db"
  pg top-procurement-postgres-1 || bad="$bad top-db"
  pg top-procurement-staging-postgres-1 || bad="$bad top-staging-db"
  pg yordam-postgres || bad="$bad yordam-db"
  maria wordpress-wordpressdb-1 || bad="$bad wordpress-db"
  lite gitea /projects/gitea/data/gitea/gitea.db || bad="$bad gitea-db"
  lite suhbat /suhbat-db/suhbat.db || bad="$bad suhbat-db"
  log "backup to $R"
  restic backup --tag nightly --exclude-caches \
    --exclude '/projects/*/data/postgres' --exclude /projects/yusmus/data/redis \
    --exclude /projects/wordpress/mariadb/data --exclude /projects/ijara360/releases \
    --exclude /projects/ijara360/test --exclude /projects/usb-backup/cache \
    --exclude "$STATUS" \
    /projects /storage /archive $VOLUMES || bad="$bad restic-backup"
  restic forget --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6 || bad="$bad restic-forget"
  # on Sundays read a tenth of the data back to prove the copy can be restored
  [ "$(date +%u)" = 7 ] && { restic check --read-data-subset=10% || bad="$bad restic-check"; }
  mkdir -p "$STATUS"
  if [ -z "$bad" ]; then
    date -Iseconds > "$STATUS/last-success"; rm -f "$STATUS/last-error" /tmp/failed
    restic snapshots --latest 1 --compact | tail -n 3
    log 'DONE'
  else
    echo "$(date -Iseconds)$bad" > "$STATUS/last-error"; touch /tmp/failed
    log "FAIL:$bad"; return 1
  fi
}

case "${1:-loop}" in
  init)
    d=/usb/${USB_DRIVE:?set USB_DRIVE, e.g. sdd1}
    [ -d "$d" ] || { echo "no drive $d"; exit 1; }
    repo >/dev/null && { echo "repository already exists: $(repo)"; exit 0; }
    RESTIC_REPOSITORY=$d/$NAME restic init ;;
  once) once ;;
  loop)
    log "nightly USB backup at $AT"
    while true; do
      touch /tmp/alive
      if [ "$(date +%H:%M)" = "$AT" ]; then once || true; sleep 61; fi
      sleep 30
    done ;;
esac
