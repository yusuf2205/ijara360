#!/bin/sh
# NAS test of scripts/backup-service.sh against a throwaway database (never production data):
# a good backup is restore-verified and recorded, a missing document fails verification and is
# recorded as a failure, retention removes only old Ijara360 backup files, the schedule uses Tashkent time.
set -eu
cd "$(dirname "$0")/.."
src=$(pwd)
id=$(date -u +%Y%m%d%H%M%S)-$$
work=/volume1/docker/ijara360/test/m6-backup-$id
net=ijara360-backup-test-$id
db=ijara360-backup-test-db-$id
mkdir -m 777 "$work" "$work/kyc" "$work/backups" "$work/status"
cleanup() {
  docker rm -f -v "$db" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  # Files written by the container belong to root: remove them from a container too.
  docker run --rm --network none -v "$work:/w" postgres:17-bookworm sh -c 'rm -rf /w/*' >/dev/null 2>&1 || true
  rmdir "$work" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
docker network create --internal "$net" >/dev/null
docker run -d --name "$db" --network "$net" --network-alias db -e POSTGRES_USER=ijara_owner -e POSTGRES_PASSWORD=backup-test-only -e POSTGRES_DB=ijara360 postgres:17-bookworm >/dev/null
for i in $(seq 1 60); do docker exec "$db" pg_isready -h 127.0.0.1 -U ijara_owner -d ijara360 >/dev/null 2>&1 && break; sleep 1; done
docker exec "$db" psql -X -q -v ON_ERROR_STOP=1 -U ijara_owner -d ijara360 -c "
  CREATE ROLE ijara_app;
  CREATE TABLE _prisma_migrations (id text PRIMARY KEY, migration_name text);
  INSERT INTO _prisma_migrations VALUES ('1','202601010000_test');
  CREATE TABLE application_documents (storage_key text PRIMARY KEY);
  GRANT SELECT ON application_documents TO ijara_app;
  INSERT INTO application_documents VALUES ('applications/a1/passport/d1.enc');"
mkdir -p "$work/kyc/applications/a1/passport"
printf 'encrypted-test-bytes' > "$work/kyc/applications/a1/passport/d1.enc"
chmod -R a+rX "$work/kyc"
# Old files: Ijara360 backups older than 14 days go, anything else stays.
touch -d '20 days ago' "$work/backups/ijara360-20200101T000000Z-1.dump" "$work/backups/ijara360-20200101T000000Z-1.dump.sha256" "$work/backups/other-file.dump"
run() {
  docker run --rm --network "$net" -e PGPASSWORD=backup-test-only -e TZ=Asia/Tashkent \
    -v "$src/scripts/backup-service.sh:/opt/ijara360/backup-service.sh:ro" -v "$work/kyc:/kyc:ro" -v "$work/backups:/backups" -v "$work/status:/status" \
    postgres:17-bookworm sh /opt/ijara360/backup-service.sh "$@"
}
status() { docker run --rm --network none -v "$work/status:/s:ro" postgres:17-bookworm cat /s/backup.json; }

run attempt
s=$(status); echo "status after good run: $s"
echo "$s" | grep -q '"ok":true' || { echo 'FAIL: good backup not recorded'; exit 1; }
echo "$s" | grep -q '"documents":1' || { echo 'FAIL: document count'; exit 1; }
listing=$(docker run --rm --network none -v "$work/backups:/b:ro" postgres:17-bookworm sh -c 'cd /b && ls && sha256sum -c --quiet *-nightly.dump.sha256 *-nightly.kyc.tar.sha256 && stat -c "%a %U" *-nightly.dump')
echo "$listing"
echo "$listing" | grep -q '^600 root$' || { echo 'FAIL: backup file must be private (600 root)'; exit 1; }
echo "$listing" | grep -q '^ijara360-20200101T000000Z-1.dump$' && { echo 'FAIL: retention kept an old backup'; exit 1; }
echo "$listing" | grep -q '^other-file.dump$' || { echo 'FAIL: retention removed a foreign file'; exit 1; }
echo "$s" | grep -Eq '[0-9]{11}|\+998' && { echo 'FAIL: status carries personal data'; exit 1; }

# A document referenced by the database but missing from storage must fail the check.
docker exec "$db" psql -X -q -v ON_ERROR_STOP=1 -U ijara_owner -d ijara360 -c "INSERT INTO application_documents VALUES ('applications/a2/selfie/d2.enc')"
run attempt
s=$(status); echo "status after broken run: $s"
echo "$s" | grep -q '"ok":false' || { echo 'FAIL: failure not recorded'; exit 1; }
echo "$s" | grep -q '"step":"verify"' || { echo 'FAIL: failing step not recorded'; exit 1; }

# The database is unreachable: the dump step fails and is recorded.
docker stop "$db" >/dev/null
run attempt
s=$(status); echo "status with the database down: $s"
echo "$s" | grep -q '"step":"dump"' || { echo 'FAIL: dump failure not recorded'; exit 1; }
docker run --rm --network none -v "$work/backups:/b:ro" postgres:17-bookworm sh -c 'ls /b' | grep -q partial && { echo 'FAIL: partial files left behind'; exit 1; }

zone=$(docker run --rm --network none -e TZ=Asia/Tashkent postgres:17-bookworm date +%z)
test "$zone" = +0500 || { echo "FAIL: Tashkent time zone missing in the image ($zone)"; exit 1; }
echo 'BACKUP SERVICE TEST: PASS'
