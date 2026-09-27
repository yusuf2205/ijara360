#!/bin/sh
set -eu
umask 077
backup=${1:?Backup required}
api_image=${2:?API image required}
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$backup" in /volume1/docker/ijara360/backups/ijara360-*.dump) ;; *) echo 'Unexpected backup path' >&2; exit 1;; esac
test -s "$backup"
case "$api_image" in ijara360-api:*) ;; *) echo 'Unexpected API image' >&2; exit 1;; esac
scratch=ijara360-migration-check-$(date -u +%Y%m%dT%H%M%SZ)-$$
work=/volume1/docker/ijara360/test/"$scratch"
mkdir -m 700 "$work"
cleanup() { docker rm -f -v "$scratch" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
# No network/ports/host data mounts. Migrator shares only this disposable network namespace.
docker run -d --name "$scratch" --network none -e POSTGRES_USER=ijara_owner -e POSTGRES_DB=ijara360_migration_test -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-bookworm >/dev/null
attempt=0
until docker exec "$scratch" pg_isready -h 127.0.0.1 -U ijara_owner -d ijara360_migration_test >/dev/null 2>&1; do
  attempt=$((attempt+1)); test "$attempt" -lt 60; sleep 1
done
docker exec "$scratch" psql -X -v ON_ERROR_STOP=1 -U ijara_owner -d ijara360_migration_test -c 'CREATE ROLE ijara_app' >/dev/null
docker exec -i "$scratch" pg_restore --exit-on-error --no-owner -U ijara_owner -d ijara360_migration_test < "$backup"
docker exec -i "$scratch" psql -X -q -t -A -v ON_ERROR_STOP=1 -U ijara_owner -d ijara360_migration_test < "$source_dir/scripts/production-fingerprint.sql" > "$work/before.txt"
docker run --rm --network "container:$scratch" -e DATABASE_URL=postgresql://ijara_owner@127.0.0.1:5432/ijara360_migration_test "$api_image" node node_modules/prisma/build/index.js migrate deploy
docker run --rm --network "container:$scratch" -e DATABASE_URL=postgresql://ijara_owner@127.0.0.1:5432/ijara360_migration_test "$api_image" node scripts/grant-runtime.cjs
docker exec -i "$scratch" psql -X -q -t -A -v ON_ERROR_STOP=1 -U ijara_owner -d ijara360_migration_test < "$source_dir/scripts/production-fingerprint.sql" > "$work/after.txt"
diff -u "$work/before.txt" "$work/after.txt"
echo "MIGRATION RESTORE VERIFICATION: PASS evidence=$work"
