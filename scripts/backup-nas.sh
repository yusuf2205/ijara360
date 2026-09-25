#!/bin/sh
set -eu
umask 077
directory=/volume1/docker/ijara360/backups
mkdir -p "$directory"
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
file="$directory/ijara360-$stamp.dump"
docker exec ijara360-db-1 pg_dump -U ijara_owner -d ijara360 -Fc > "$file.partial"
test -s "$file.partial"
mv "$file.partial" "$file"
(cd "$directory"; sha256sum "ijara360-$stamp.dump" > "ijara360-$stamp.dump.sha256")
# Fixed project directory, exact backup filename pattern, retention 14 days.
find "$directory" -maxdepth 1 -type f -name 'ijara360-*.dump' -mtime +14 -delete
find "$directory" -maxdepth 1 -type f -name 'ijara360-*.dump.sha256' -mtime +14 -delete
printf '%s\n' "$file"
