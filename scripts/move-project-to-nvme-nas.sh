#!/bin/sh
# Moves one NAS project folder from the hard disk to the NVMe (/volume3/projects/<name>) and keeps
# its storage folders (backups, uploads, files) on the hard disk (/volume1/storage/<name>/...).
# The old path becomes a symlink to the NVMe copy, so compose files, .env paths and scripts keep working.
#
#   sh move-project-to-nvme-nas.sh <name> <project folder> [storage subfolder ...]
#   e.g.  sh move-project-to-nvme-nas.sh yusmus /volume1/docker/yusmus backups data/minio
#
# Stops only the containers that mount something inside the folder or were started from it,
# copies while they still run, stops, copies the rest, checks every byte, swaps, starts
# (databases first, watchdogs last) and waits for health. Any failure after the stop puts the
# hard-disk folder back. Root file work runs in a throwaway alpine container: no sudo needed.
# The old copy stays as <folder>.hdd-old-<time> until the owner deletes it.
set -eu
NAME=$1; SRC=${2%/}; shift 2; STORAGE="$*"
case "$SRC" in /home/*) REAL=/volume1/@home/${SRC#/home/};; *) REAL=$SRC;; esac
NEW=/volume3/projects/$NAME
STORE=/volume1/storage/$NAME
STAMP=$(date +%Y%m%d-%H%M%S)
HELPER=nvme-mover-$NAME

say() { printf '\n== [%s] %s\n' "$NAME" "$*"; }
root() { docker exec "$HELPER" sh -c "$1"; }

mountpoint -q /volume3 || { echo 'NVMe /volume3 is not mounted'; exit 1; }
[ -L "$SRC" ] && { echo "$SRC is already a link to $(readlink "$SRC")"; exit 0; }
[ -d "$SRC" ] || { echo "no folder $SRC"; exit 1; }

say 'containers that use the folder'
AFFECTED=''
for c in $(docker ps --format '{{.Names}}'); do
  info=$(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$c")
  for p in ${info%%|*} ${info#*|}; do
    case "$p" in "$SRC"|"$SRC"/*|"$REAL"|"$REAL"/*) AFFECTED="$AFFECTED $c"; break;; esac
  done
done
# stop order: watchdogs and backups first (they restart or read the others), databases last
rank() { case "$1" in *watchdog*|*guard*|*permfix*|*backup*|*offsite*) echo 1;; *postgres*|*mariadb*|*wordpressdb*|*redis*|*minio*|*-db|*-db-*) echo 3;; *) echo 2;; esac; }
STOP=$(for c in $AFFECTED; do echo "$(rank "$c") $c"; done | sort -k1,1n -k2 | cut -d' ' -f2)
START=$(for c in $AFFECTED; do echo "$(rank "$c") $c"; done | sort -k1,1nr -k2 | cut -d' ' -f2)
echo "${STOP:-(none)}" | tr '\n' ' '; echo
HEALTH=''
for c in $AFFECTED; do [ -n "$(docker inspect -f '{{if .State.Health}}x{{end}}' "$c")" ] && HEALTH="$HEALTH $c"; done

say 'helper container'
docker rm -f "$HELPER" >/dev/null 2>&1 || true
docker run -d --name "$HELPER" -v /volume1:/volume1 -v /volume3:/volume3 alpine:3.22 sleep 86400 >/dev/null
trap 'docker rm -f "$HELPER" >/dev/null 2>&1 || true' EXIT
root 'apk add --no-cache rsync >/dev/null'
root "[ ! -e '$NEW' ] || [ -f '$NEW/.nvme-precopy' ] || [ -z \"\$(ls -A '$NEW')\" ] || { echo '$NEW exists and is not ours'; exit 1; }"
EXCL='--exclude=/.nvme-precopy'
for s in $STORAGE; do
  root "[ -e '$REAL/$s' ] || { echo 'no storage folder $s'; exit 1; }; [ ! -e '$STORE/$s' ] || { echo '$STORE/$s already exists'; exit 1; }"
  EXCL="$EXCL --exclude=/$s/"
done
# ug.archive_bit is a UGOS backup flag the filesystem rewrites by itself; it is not data
RS="rsync -aHAX --numeric-ids --delete --filter='-x ug.*' $EXCL"

say 'copy while running'
root "mkdir -p '$NEW' && touch '$NEW/.nvme-precopy' && $RS '$REAL/' '$NEW/' && du -sh '$NEW'"

start_all() {
  for c in $START; do
    docker start "$c" >/dev/null || return 1; echo "started $c"
    case "$(rank "$c")" in 3) for i in $(seq 1 60); do
      h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c")
      [ "$h" = healthy ] || [ "$h" = none ] && break; sleep 2; done;; esac
  done
}
check_all() {
  for i in $(seq 1 90); do
    bad=''
    for c in $HEALTH; do [ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" = healthy ] || bad="$bad $c"; done
    [ -z "$bad" ] && break; sleep 2
  done
  [ -z "$bad" ] || { echo "not healthy:$bad"; return 1; }
  sleep 15
  for c in $AFFECTED; do
    [ "$(docker inspect -f '{{.State.Running}} {{.State.Restarting}}' "$c")" = 'true false' ] || { echo "not running: $c"; return 1; }
  done
}
rollback() {
  say 'ROLLBACK: putting the hard-disk folder back'
  for c in $STOP; do docker stop -t 30 "$c" >/dev/null 2>&1 || true; done
  root "if [ -L '$REAL' ]; then rm '$REAL'; fi
    if [ -d '$REAL.hdd-old-$STAMP' ]; then mv '$REAL.hdd-old-$STAMP' '$REAL'; fi
    for s in $STORAGE; do if [ -e '$STORE/'\$s ] && [ ! -e '$REAL/'\$s ]; then mv '$STORE/'\$s '$REAL/'\$s; fi; done" || true
  start_all || true; check_all || true
  echo "[$NAME] Rolled back: runs from the hard disk as before."
  exit 1
}
trap 'rollback' INT TERM

say 'stop'
for c in $STOP; do docker stop -t 60 "$c" >/dev/null; echo "stopped $c"; done

say 'final copy and byte-by-byte check'
root "$RS '$REAL/' '$NEW/'" || rollback
diff=$(root "$RS --dry-run --itemize-changes --checksum '$REAL/' '$NEW/' | grep -v '^\.d' || true")
[ -z "$diff" ] || { echo 'copy differs:'; echo "$diff" | head -20; rollback; }

say 'swap'
root "set -e
  rm -f '$NEW/.nvme-precopy'
  for s in $STORAGE; do
    mkdir -p \"\$(dirname '$STORE/'\$s)\"
    mv '$REAL/'\$s '$STORE/'\$s
    rm -rf '$NEW/'\$s
    ln -s '$STORE/'\$s '$NEW/'\$s
  done
  mv '$REAL' '$REAL.hdd-old-$STAMP'
  ln -s '$NEW' '$REAL'
  ls -la '$REAL'" || rollback

say 'start'
start_all || rollback
check_all || rollback
trap - INT TERM
for c in $AFFECTED; do docker inspect -f '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c"; done
say "DONE. Old copy: $SRC.hdd-old-$STAMP"
