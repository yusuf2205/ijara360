#!/bin/sh
set -eu
LC_ALL=C
export LC_ALL
file=${1:?Pass the absolute path of an Ijara360 backup}
case "$file" in /volume1/docker/ijara360/backups/ijara360-*.dump) ;; *) echo 'Unexpected backup path' >&2; exit 1;; esac
test "$(dirname "$file")" = /volume1/docker/ijara360/backups
test -s "$file"
(cd /volume1/docker/ijara360/backups; sha256sum -c "$(basename "$file").sha256")
archive="${file%.dump}.kyc.tar"
test -s "$archive"
(cd /volume1/docker/ijara360/backups; sha256sum -c "$(basename "$archive").sha256")
# Normalized member list ("applications/<id>/<kind>/<uuid>.enc"), compared after restore.
members=$(mktemp)
trap 'rm -f "$members"' EXIT HUP INT TERM
tar -tf "$archive" | sed -n 's#^\./##; /\.enc$/p' | sort > "$members"
name=ijara360-restore-verify-$(date -u +%Y%m%d%H%M%S)-$$
# Disposable, network-isolated database, no host data mounts or published ports.
docker run -d --name "$name" --network none -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=ijara_owner -e POSTGRES_DB=ijara360_restore postgres:17-bookworm >/dev/null
trap 'docker rm -f -v "$name" >/dev/null; rm -f "$members"' EXIT HUP INT TERM
ready=0
for i in $(seq 1 60); do
  # The image starts a temporary socket-only server during initialization.
  # TCP readiness waits for the final server, after initialization completes.
  if docker exec "$name" pg_isready -h 127.0.0.1 -U ijara_owner -d ijara360_restore >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
# Dumps may contain privileges granted to the application's restricted role.
docker exec "$name" createuser -h 127.0.0.1 -U ijara_owner ijara_app
docker exec -i "$name" pg_restore -h 127.0.0.1 -U ijara_owner -d ijara360_restore --exit-on-error < "$file"
docker exec "$name" pg_dump -h 127.0.0.1 -U ijara_owner -d ijara360_restore --schema-only >/dev/null
# Every document referenced by the restored database must be present in the archive.
# Backups taken before M4 have no application_documents table: check it in a separate query,
# because PostgreSQL resolves every table of a statement before evaluating any CASE branch.
query() { docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 -h 127.0.0.1 -U ijara_owner -d ijara360_restore -c "$1"; }
keys=''
if [ "$(query "SELECT to_regclass('public.application_documents') IS NOT NULL")" = t ]; then
  keys=$(query 'SELECT storage_key FROM application_documents ORDER BY storage_key')
fi
missing=$(printf '%s\n' "$keys" | sed '/^$/d' | sort | comm -23 - "$members" | wc -l)
test "$((missing))" = 0 || { echo "Restore verification FAIL: $((missing)) documents missing from $archive" >&2; exit 1; }
echo "Restore verification PASS: isolated database restored without errors; KYC archive has $(wc -l < "$members") encrypted files."
