#!/bin/sh
set -eu
umask 077
revision=${1:?Git revision required}
test "${#revision}" = 40
case "$revision" in *[!a-f0-9]*) exit 1;; esac
root=/volume1/docker/ijara360
source="$root/releases/$revision/source"
secret="$root/secrets/production.env"
test -f "$root/releases/$revision/COMPLETE"
test -f "$secret"
cd "$root/releases/$revision"
sha256sum -c manifest.sha256
mkdir -p "$root/deployments"
chmod 700 "$root/deployments"
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
record="$root/deployments/$stamp"
mkdir -m 700 "$record"
export RELEASE_TAG="$revision"
# Build first, so the backup is fresh when migrate deploy starts.
docker compose --env-file "$secret" -f "$source/compose.yaml" build
sh "$source/scripts/backup-nas.sh" > "$record/backup-path"
chmod 600 "$record/backup-path"
sh "$source/scripts/verify-backup-nas.sh" "$(cat "$record/backup-path")"
docker exec -i ijara360-db-1 psql -X -q -t -A -v ON_ERROR_STOP=1 -U ijara_owner -d ijara360 < "$source/scripts/production-fingerprint.sql" > "$record/before.txt"
chmod 644 "$source/infra/init-db.sql" "$source/infra/Caddyfile"
docker compose --env-file "$secret" -f "$source/compose.yaml" up -d --wait --wait-timeout 240
docker exec -i ijara360-db-1 psql -X -q -t -A -v ON_ERROR_STOP=1 -U ijara_owner -d ijara360 < "$source/scripts/production-fingerprint.sql" > "$record/after.txt"
diff -u "$record/before.txt" "$record/after.txt"
curl --fail --silent --show-error --max-time 30 https://mynas.tail4bf75c.ts.net:8446/api/health
printf '%s' "$revision" > "$root/DEPLOYED_COMMIT.new"
mv "$root/DEPLOYED_COMMIT.new" "$root/DEPLOYED_COMMIT"
docker compose --env-file "$secret" -f "$source/compose.yaml" ps
printf '\nDEPLOY VERIFIED %s evidence=%s\n' "$revision" "$record"
