#!/bin/sh
# NAS test of scripts/offsite-service.sh with throwaway data (never production): the cloud is an rclone
# "local" remote, USB drives are folders. Checks encryption with an age key made for this test only,
# checksums, consent folders, no re-sending, retention, missing key/token, failures, corrupted backups.
set -eu
cd "$(dirname "$0")/.."
id=$(date -u +%Y%m%d%H%M%S)-$$
work=/volume1/docker/ijara360/test/m6-offsite-$id
image=ijara360-offsite:test
docker build -q -f infra/offsite.Dockerfile -t "$image" . >/dev/null
mkdir -m 777 "$work"
cleanup() {
  docker run --rm --network none -v "$work:/w" "$image" sh -c 'rm -rf /w/* /w/.[!.]*' >/dev/null 2>&1 || true
  rmdir "$work" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
box() { docker run --rm --network none -v "$work:/w" "$image" sh -c "$1"; }
box 'mkdir -p /w/backups /w/status /w/cloud /w/usb/drive1/Ijara360-backup /w/usb/drive2 && age-keygen -o /w/key.txt 2>/dev/null && chmod -R a+rwX /w'
recipient=$(box "sed -n 's/^# public key: //p' /w/key.txt")
# A fake nightly backup in the real file format, with a marker that must never appear unencrypted.
backup() { # stamp
  box "cd /w/backups && printf 'PLAINTEXT-MARKER %s' $1 > ijara360-$1.dump && tar -cf ijara360-$1.kyc.tar -C /w status \
    && sha256sum ijara360-$1.dump > ijara360-$1.dump.sha256 && sha256sum ijara360-$1.kyc.tar > ijara360-$1.kyc.tar.sha256 \
    && printf '{\"ok\":true,\"at\":\"2026-10-15T00:00:00Z\",\"file\":\"ijara360-$1.dump\",\"bytes\":1,\"documents\":0}' > /w/status/backup.json"
}
run() { # extra docker args…
  docker run --rm --network none -v "$work/backups:/backups:ro" -v "$work/status:/status" -v "$work/usb:/usb" -v "$work/cloud:/data" \
    -e OFFSITE_AGE_RECIPIENT="$recipient" -e OFFSITE_REMOTE=cloud:/data/Ijara360-backup -e RCLONE_CONFIG_CLOUD_TYPE=local "$@" \
    "$image" sh /opt/ijara360/offsite-service.sh once
}
status() { box "cat /w/status/offsite-$1.json"; }
expect() { echo "$2" | grep -q "$3" || { echo "FAIL: $1 ($2)"; exit 1; }; }

backup 20261014T223000Z-nightly
run
expect 'cloud sent' "$(status cloud)" '"ok":true'
expect 'readable size' "$(status cloud)" '"detail":"0,0 МБ"'
expect 'usb sent to the consenting drive only' "$(status usb)" 'дисков: 1'
files=$(box 'cd /w && find cloud usb -type f | sort')
echo "$files"
expect 'cloud daily' "$files" 'cloud/Ijara360-backup/daily/ijara360-20261014T223000Z-nightly.tar.age'
expect 'cloud monthly' "$files" 'cloud/Ijara360-backup/monthly/ijara360-2026-10.tar.age'
expect 'usb daily' "$files" 'usb/drive1/Ijara360-backup/daily/ijara360-20261014T223000Z-nightly.tar.age'
echo "$files" | grep -q drive2 && { echo 'FAIL: wrote to a drive without the consent folder'; exit 1; }
box 'grep -rl PLAINTEXT-MARKER /w/cloud /w/usb' && { echo 'FAIL: unencrypted data offsite'; exit 1; }
# The owner's secret key decrypts it and the checksums inside match.
box 'mkdir /w/restore && age -d -i /w/key.txt /w/usb/drive1/Ijara360-backup/daily/ijara360-20261014T223000Z-nightly.tar.age | tar -xf - -C /w/restore && cd /w/restore && sha256sum -c --quiet *.sha256 && rm -rf /w/restore'
echo 'decrypt + checksums: OK'

before=$(status cloud)
run
test "$(status cloud)" = "$before" || { echo 'FAIL: the same backup was sent twice'; exit 1; }

# Retention on the next backup: Ijara360 copies older than 30 days go, foreign files stay.
box "touch -d '40 days ago' /w/usb/drive1/Ijara360-backup/daily/ijara360-20200101T000000Z-nightly.tar.age /w/usb/drive1/Ijara360-backup/daily/notes.txt"
backup 20261015T223000Z-nightly
run
files=$(box 'cd /w && find usb -type f | sort')
echo "$files" | grep -q 20200101 && { echo 'FAIL: retention kept an old copy'; exit 1; }
expect 'foreign file kept' "$files" 'notes.txt'
expect 'one monthly copy per month' "$(box 'ls /w/cloud/Ijara360-backup/monthly | wc -l')" '^1$'

# The consent folder is gone after copies were made: red, not grey.
box 'rm -rf /w/usb/drive1/Ijara360-backup'
backup 20261016T223000Z-nightly
run
expect 'usb missing reported' "$(status usb)" '"ok":false,.*нет USB-диска с папкой Ijara360-backup'
expect 'cloud still sent' "$(status cloud)" '"ok":true'

# Cloud write fails (read-only target): red.
box 'mkdir -p /w/usb/drive1/Ijara360-backup'
backup 20261017T223000Z-nightly
docker run --rm --network none -v "$work/backups:/backups:ro" -v "$work/status:/status" -v "$work/usb:/usb" -v "$work/cloud:/data:ro" \
  -e OFFSITE_AGE_RECIPIENT="$recipient" -e OFFSITE_REMOTE=cloud:/data/Ijara360-backup -e RCLONE_CONFIG_CLOUD_TYPE=local \
  "$image" sh /opt/ijara360/offsite-service.sh once || true
expect 'cloud failure reported' "$(status cloud)" '"ok":false,.*не удалось отправить'
expect 'usb works again' "$(status usb)" '"ok":true'

# Google Drive without a token is grey ("не подключён"), never an attempt.
backup 20261018T223000Z-nightly
run -e OFFSITE_REMOTE=gdrive:Ijara360-backup
expect 'drive not connected' "$(status cloud)" '"ok":null,.*Google Drive не подключён'

# A backup whose checksum no longer matches is never shipped.
backup 20261019T223000Z-nightly
box 'printf x >> /w/backups/ijara360-20261019T223000Z-nightly.dump'
run || true
expect 'corrupted backup refused' "$(status usb)" '"ok":false,.*не удалось подготовить копию'
box 'ls /w/usb/drive1/Ijara360-backup/daily' | grep -q 20261019 && { echo 'FAIL: corrupted backup shipped'; exit 1; }

# No key: grey, nothing sent.
docker run --rm --network none -v "$work/status:/status" -e OFFSITE_AGE_RECIPIENT= "$image" sh /opt/ijara360/offsite-service.sh once
expect 'no key' "$(status usb)" '"ok":null,.*не задан ключ шифрования'
echo "$(status cloud)$(status usb)" | grep -Eq '\+998|[0-9]{11}' && { echo 'FAIL: status carries personal data'; exit 1; }
echo 'OFFSITE SERVICE TEST: PASS'
