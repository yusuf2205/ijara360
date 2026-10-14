#!/bin/sh
# Offsite copies (compose service "offsite", infra/offsite.Dockerfile), see docs/M6-OFFSITE.md.
# Picks up the latest successful nightly backup (status/backup.json), packs the dump, the documents
# archive and their checksums into one tar, encrypts it HERE with the owner's age public key and sends it
#   cloud  to the rclone remote OFFSITE_REMOTE (Google Drive, scope drive.file), md5 compared after upload
#   usb    to every drive under USB_ROOT that has an "Ijara360-backup" folder in its root (the owner's consent)
# Daily copies are kept 30 days, the first copy of each month 12 months. The age secret key never
# exists on the NAS, so nothing here can decrypt a copy. Status files carry no personal data.
#   loop        check every OFFSITE_INTERVAL seconds (default 600)
#   once        one round
#   cloud|usb <package> <name>   internal: one target, run as a separate process so "set -e" applies
set -eu
umask 077
backups=${BACKUP_DIR:-/backups}
status_dir=${STATUS_DIR:-/status}
usb_root=${USB_ROOT:-/usb}
remote=${OFFSITE_REMOTE:-gdrive:Ijara360-backup}
work=${WORK_DIR:-/tmp/ijara360-offsite}
recipient=${OFFSITE_AGE_RECIPIENT:-}
folder=Ijara360-backup

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
field() { sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p" "$1" 2>/dev/null; }

# Per-target status: {"ok":true|false|null,"at":"…","source":"ijara360-….dump","detail":"…","everOk":true|false}
write_target() {
  target=$1 ok=$2 detail=$3 source=${4:-}
  file="$status_dir/offsite-$target.json"
  ever=false
  if [ "$ok" = true ] || grep -q '"everOk":true' "$file" 2>/dev/null; then ever=true; fi
  [ -n "$source" ] || source=$(field "$file" source)
  tmp="$status_dir/.offsite-$target.json.tmp"
  printf '{"ok":%s,"at":"%s","source":"%s","detail":"%s","everOk":%s}\n' "$ok" "$(date -u +%FT%TZ)" "$source" "$detail" "$ever" > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$file"
}

shipped() { # target source -> true when this source already went out successfully
  file="$status_dir/offsite-$1.json"
  grep -q '"ok":true' "$file" 2>/dev/null && [ "$(field "$file" source)" = "$2" ]
}

month_of() { echo "$1" | sed -n 's/^ijara360-\([0-9]\{4\}\)\([0-9]\{2\}\).*/\1-\2/p'; }

cloud() {
  pkg=$1 name=$2
  md5=$(md5sum "$pkg" | cut -d' ' -f1)
  rclone copyto "$pkg" "$remote/daily/$name.tar.age"
  got=$(rclone md5sum "$remote/daily/$name.tar.age" | cut -d' ' -f1)
  test "$got" = "$md5"
  monthly="$remote/monthly/ijara360-$(month_of "$name").tar.age"
  if [ -z "$(rclone lsf "$monthly" 2>/dev/null)" ]; then rclone copyto "$pkg" "$monthly"; fi
  rclone delete "$remote/daily" --min-age 30d --include 'ijara360-*.tar.age'
  rclone delete "$remote/monthly" --min-age 365d --include 'ijara360-*.tar.age'
}

usb() {
  pkg=$1 name=$2
  sha=$(sha256sum "$pkg" | cut -d' ' -f1)
  count=0
  for dir in "$usb_root"/*/"$folder"; do
    [ -d "$dir" ] || continue
    mkdir -p "$dir/daily" "$dir/monthly"
    cp "$pkg" "$dir/daily/.$name.tar.age.partial"
    test "$(sha256sum "$dir/daily/.$name.tar.age.partial" | cut -d' ' -f1)" = "$sha"
    mv "$dir/daily/.$name.tar.age.partial" "$dir/daily/$name.tar.age"
    monthly="$dir/monthly/ijara360-$(month_of "$name").tar.age"
    [ -f "$monthly" ] || cp "$dir/daily/$name.tar.age" "$monthly"
    find "$dir/daily" -maxdepth 1 -type f -name 'ijara360-*.tar.age' -mtime +30 -delete
    find "$dir/monthly" -maxdepth 1 -type f -name 'ijara360-*.tar.age' -mtime +365 -delete
    count=$((count + 1))
  done
  test "$count" -gt 0 || exit 3
  echo "$count"
}

round() {
  if [ -z "$recipient" ]; then
    write_target cloud null 'не задан ключ шифрования'
    write_target usb null 'не задан ключ шифрования'
    return 0
  fi
  grep -q '"ok":true' "$status_dir/backup.json" 2>/dev/null || return 0
  source=$(field "$status_dir/backup.json" file)
  case "$source" in ijara360-*.dump) ;; *) return 0 ;; esac
  name=${source%.dump}
  cloud_on=yes
  case "$remote" in gdrive:*) [ -n "${RCLONE_CONFIG_GDRIVE_TOKEN:-}" ] || cloud_on=no ;; esac
  need=''
  if [ "$cloud_on" = no ]; then write_target cloud null 'Google Drive не подключён'; elif ! shipped cloud "$source"; then need="$need cloud"; fi
  shipped usb "$source" || need="$need usb"
  [ -n "$need" ] || return 0

  mkdir -p "$work"
  pkg="$work/$name.tar.age"
  # round runs under "||", where "set -e" is off: every packing step is checked explicitly.
  # Checksums first: never ship a copy that no longer matches what the backup recorded.
  if ! (cd "$backups" && sha256sum -c --quiet "$name.dump.sha256" "$name.kyc.tar.sha256") \
    || ! tar -cf "$work/$name.tar" -C "$backups" "$name.dump" "$name.dump.sha256" "$name.kyc.tar" "$name.kyc.tar.sha256" \
    || ! age -r "$recipient" -o "$pkg" "$work/$name.tar" || ! [ -s "$pkg" ]; then
    rm -f "$work/$name.tar" "$pkg"
    for target in $need; do write_target "$target" false 'не удалось подготовить копию'; done
    log "pack FAILED for $name"
    return 1
  fi
  rm -f "$work/$name.tar"
  size=$(awk -v b="$(wc -c < "$pkg")" 'BEGIN { printf "%.1f МБ", b / 1048576 }' | tr . ,)
  for target in $need; do
    if out=$(sh "$0" "$target" "$pkg" "$name" 2>&1); then
      if [ "$target" = usb ]; then write_target usb true "$size, дисков: $(echo "$out" | tail -n 1)" "$source"
      else write_target cloud true "$size" "$source"; fi
      log "$target: sent $name.tar.age ($size)"
    else
      code=$?
      if [ "$target" = usb ] && [ "$code" = 3 ]; then
        detail="нет USB-диска с папкой $folder"
        if grep -q '"everOk":true' "$status_dir/offsite-usb.json" 2>/dev/null; then write_target usb false "$detail"; else write_target usb null "$detail"; fi
      else
        write_target "$target" false 'не удалось отправить'
      fi
      log "$target: FAILED for $name ($(echo "$out" | tail -n 1 | cut -c1-160))"
    fi
  done
  rm -f "$pkg"
}

case "${1:-loop}" in
  cloud) cloud "$2" "$3" ;;
  usb) usb "$2" "$3" ;;
  once) round ;;
  loop)
    log "offsite started; cloud remote ${remote%%:*}, key $( [ -n "$recipient" ] && echo set || echo missing )"
    while true; do
      round || log 'round failed'
      sleep "${OFFSITE_INTERVAL:-600}"
    done ;;
  *) echo 'usage: offsite-service.sh loop|once' >&2; exit 2 ;;
esac
