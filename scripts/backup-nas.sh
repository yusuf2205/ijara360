#!/bin/sh
set -eu
umask 077
directory=/volume1/docker/ijara360/backups
kyc=/volume1/docker/ijara360/data/kyc
mkdir -p "$directory"
chmod 700 "$directory"
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
file="$directory/ijara360-$stamp.dump"
archive="$directory/ijara360-$stamp.kyc.tar"
docker exec ijara360-db-1 pg_dump -U ijara_owner -d ijara360 -Fc > "$file.partial"
test -s "$file.partial"
chmod 600 "$file.partial"
# Encrypted application documents, archived AFTER the dump: files are written before
# their database row commits and are never deleted, so the archive covers every
# storage_key in the dump. Files belong to the container user; read them as root
# in a disposable, network-isolated container. Before M4 the archive is empty.
if [ -d "$kyc" ]; then
  docker run --rm --network none -v "$kyc:/kyc:ro" postgres:17-bookworm tar -C /kyc -cf - . > "$archive.partial"
else
  docker run --rm --network none postgres:17-bookworm sh -c 'mkdir /kyc && tar -C /kyc -cf - .' > "$archive.partial"
fi
test -s "$archive.partial"
chmod 600 "$archive.partial"
mv "$file.partial" "$file"
mv "$archive.partial" "$archive"
(cd "$directory"; sha256sum "ijara360-$stamp.dump" > "ijara360-$stamp.dump.sha256"; sha256sum "ijara360-$stamp.kyc.tar" > "ijara360-$stamp.kyc.tar.sha256")
chmod 600 "$file.sha256" "$archive.sha256"
# Fixed project directory, exact backup filename pattern, retention 14 days.
find "$directory" -maxdepth 1 -type f -name 'ijara360-*.dump' -mtime +14 -delete
find "$directory" -maxdepth 1 -type f -name 'ijara360-*.dump.sha256' -mtime +14 -delete
find "$directory" -maxdepth 1 -type f -name 'ijara360-*.kyc.tar' -mtime +14 -delete
find "$directory" -maxdepth 1 -type f -name 'ijara360-*.kyc.tar.sha256' -mtime +14 -delete
printf '%s\n' "$file"
