#!/bin/sh
set -eu
file=${1:?Pass the absolute path of an Ijara360 backup}
case "$file" in /volume1/docker/ijara360/backups/ijara360-*.dump) ;; *) echo 'Unexpected backup path' >&2; exit 1;; esac
test "$(dirname "$file")" = /volume1/docker/ijara360/backups
test -s "$file"
(cd /volume1/docker/ijara360/backups; sha256sum -c "$(basename "$file").sha256")
name=ijara360-restore-verify-$(date -u +%Y%m%d%H%M%S)-$$
# Disposable, network-isolated database, no host data mounts or published ports.
docker run -d --name "$name" --network none -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=ijara_owner -e POSTGRES_DB=ijara360_restore postgres:17-bookworm >/dev/null
trap 'docker rm -f -v "$name" >/dev/null' EXIT HUP INT TERM
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
echo 'Restore verification PASS: isolated database restored without errors.'
