#!/bin/sh
# Moves the Ijara360 project folder from the hard disk (/volume1) to the NVMe (/volume3), keeping
# storage (backups, resident documents) on the hard disk. Run on the NAS as the docker-group user;
# file work runs as root inside a throwaway container, so no sudo is needed.
#
#   /volume3/projects/ijara360          database, releases, secrets, settings (NVMe)
#   /volume1/storage/ijara360/backups   nightly and deploy backups (hard disk)
#   /volume1/storage/ijara360/kyc       encrypted resident documents (hard disk)
#   /volume1/docker/ijara360            symlink to the NVMe folder, so every existing path keeps working
#
# The old folder is kept as /volume1/docker/ijara360.hdd-old-<time> until the owner deletes it.
# Any failure after the stop puts everything back and starts the old containers.
set -eu
OLD=/volume1/docker/ijara360
NEW=/volume3/projects/ijara360
STORE=/volume1/storage/ijara360
STAMP=$(date +%Y%m%d-%H%M%S)
HELPER=ijara360-nvme-mover
START_ORDER="ijara360-db-1 ijara360-api-1 ijara360-web-1 ijara360-gateway-1 ijara360-gateway-lan-1 ijara360-backup-1 ijara360-offsite-1 ijara360-watchdog-1"
HEALTHY="ijara360-db-1 ijara360-api-1 ijara360-web-1 ijara360-gateway-1 ijara360-gateway-lan-1"

say() { printf '\n== %s\n' "$*"; }
root() { docker exec "$HELPER" sh -c "$1"; }

mountpoint -q /volume3 || { echo 'NVMe /volume3 is not mounted'; exit 1; }
[ -L "$OLD" ] && { echo "$OLD is already a link: $(readlink "$OLD")"; exit 0; }
[ -d "$OLD/data/postgres" ] || { echo "no $OLD/data/postgres"; exit 1; }

say 'helper container'
docker rm -f "$HELPER" >/dev/null 2>&1 || true
docker run -d --name "$HELPER" --network bridge -v /volume1:/volume1 -v /volume3:/volume3 alpine:3.22 sleep 86400 >/dev/null
trap 'docker rm -f "$HELPER" >/dev/null 2>&1 || true' EXIT
root 'apk add --no-cache rsync >/dev/null && rsync --version | head -1'
root "[ ! -e '$NEW' ] || [ -z \"\$(ls -A '$NEW' 2>/dev/null)\" ] || [ -f '$NEW/.nvme-precopy' ] || { echo '$NEW exists and is not ours'; exit 1; }"
root "[ ! -e '$STORE/backups' ] && [ ! -e '$STORE/kyc' ] || { echo 'storage folders already exist'; exit 1; }"

RS="rsync -aHAX --numeric-ids --delete --exclude=/backups/ --exclude=/data/kyc/"

say 'copy while running (most of the data)'
root "mkdir -p '$NEW' && touch '$NEW/.nvme-precopy' && $RS --exclude=/.nvme-precopy '$OLD/' '$NEW/' && du -sh '$NEW'"

say 'stop Ijara360'
RUNNING=$(docker ps --filter label=com.docker.compose.project=ijara360 --format '{{.Names}}' | grep -v -e tunnel || true)
echo "$RUNNING"
for c in ijara360-watchdog-1 ijara360-offsite-1 ijara360-backup-1 ijara360-gateway-lan-1 ijara360-gateway-1 ijara360-web-1 ijara360-api-1 ijara360-db-1; do
  if echo "$RUNNING" | grep -qx "$c"; then docker stop -t 60 "$c" >/dev/null; echo "stopped $c"; fi
done

start_all() {
  for c in $START_ORDER; do
    if echo "$RUNNING" | grep -qx "$c"; then docker start "$c" >/dev/null || return 1; echo "started $c"; fi
  done
}
wait_healthy() {
  for i in $(seq 1 90); do
    bad=''
    for c in $HEALTHY; do
      echo "$RUNNING" | grep -qx "$c" || continue
      [ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null)" = healthy ] || bad="$bad $c"
    done
    [ -z "$bad" ] && return 0
    sleep 2
  done
  echo "not healthy:$bad"; return 1
}
rollback() {
  say 'ROLLBACK: putting the hard-disk folder back'
  for c in $RUNNING; do docker stop -t 30 "$c" >/dev/null 2>&1 || true; done
  root "set -e
    if [ -L '$OLD' ]; then rm '$OLD'; fi
    if [ -d '$OLD.hdd-old-$STAMP' ]; then mv '$OLD.hdd-old-$STAMP' '$OLD'; fi
    if [ -d '$STORE/backups' ] && [ ! -e '$OLD/backups' ]; then mv '$STORE/backups' '$OLD/backups'; fi
    if [ -d '$STORE/kyc' ] && [ ! -e '$OLD/data/kyc' ]; then mv '$STORE/kyc' '$OLD/data/kyc'; fi" || true
  start_all; wait_healthy || true
  echo 'Rolled back: Ijara360 runs from the hard disk as before.'
  exit 1
}
trap 'rollback' INT TERM

say 'final copy and check'
root "$RS --exclude=/.nvme-precopy '$OLD/' '$NEW/'" || rollback
# every file by size and time; the database and secrets byte by byte
diff=$(root "$RS --exclude=/.nvme-precopy --dry-run --itemize-changes '$OLD/' '$NEW/' | grep -v '^\.d' || true
  for d in data secrets; do rsync -aHAX --numeric-ids --delete --exclude=/kyc/ --dry-run --itemize-changes --checksum '$OLD/'\$d/ '$NEW/'\$d/ | grep -v '^\.d' || true; done")
[ -z "$diff" ] || { echo "copy differs:"; echo "$diff" | head -20; rollback; }
root "du -sh '$OLD/data/postgres' '$NEW/data/postgres'"

say 'swap: storage stays on the hard disk, the rest comes from NVMe'
root "set -e
  mkdir -p '$STORE' && chmod 755 /volume1/storage '$STORE' 2>/dev/null || true
  mv '$OLD/backups' '$STORE/backups'
  mv '$OLD/data/kyc' '$STORE/kyc'
  rm -f '$NEW/.nvme-precopy'
  rm -rf '$NEW/backups' '$NEW/data/kyc'
  ln -s '$STORE/backups' '$NEW/backups'
  ln -s '$STORE/kyc' '$NEW/data/kyc'
  mv '$OLD' '$OLD.hdd-old-$STAMP'
  ln -s '$NEW' '$OLD'
  ls -la '$OLD' '$NEW' '$NEW/data'" || rollback

say 'start Ijara360'
start_all || rollback
wait_healthy || rollback

say 'check where the data is now'
docker exec ijara360-db-1 sh -c 'df -h /var/lib/postgresql/data | tail -1' || rollback
docker exec ijara360-db-1 sh -c 'df -h /var/lib/postgresql/data | tail -1 | grep -q bcache' && { echo 'database is still on the hard disk'; rollback; }
docker exec ijara360-backup-1 sh -c 'df -h /kyc /backups | tail -2' || rollback
docker inspect -f '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' $RUNNING
trap - INT TERM

say "DONE. Old hard-disk copy kept at $OLD.hdd-old-$STAMP (delete it once everything is checked)."
