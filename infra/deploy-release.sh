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
# The Flutter web app shipped with the release must be built from this very commit.
test "$(cat "$source/apps/web/public/app/COMMIT")" = "$revision"
# Preflight: stop before anything is built, backed up or replaced, so a predictable problem
# cannot leave the running site down (M6). The home entrance listens on this exact address.
lan=192.168.1.105
if ! ip -4 -o addr show | grep -q " $lan/"; then
  echo "PREFLIGHT FAIL: у NAS нет адреса домашней сети $lan." >&2
  echo "Закрепите $lan за NAS в роутере (резервирование DHCP) или задайте его в UGOS и повторите выпуск." >&2
  echo "Ничего не изменено, рабочая версия продолжает работать." >&2
  exit 1
fi
free_kb=$(df -Pk "$root" | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt 5242880 ]; then
  echo "PREFLIGHT FAIL: на диске NAS свободно меньше 5 ГБ. Ничего не изменено." >&2
  exit 1
fi
mkdir -p "$root/deployments"
chmod 700 "$root/deployments"
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
record="$root/deployments/$stamp"
mkdir -m 700 "$record"
export RELEASE_TAG="$revision"
# Own domain (docs/M7.1-DOMAIN.md): the Cloudflare tunnel runs only once its token is in the secrets.
domain=$(sed -n 's/^PUBLIC_DOMAIN=//p' "$secret" | tail -n 1 | tr -d "\"'")
domain=${domain:-ijara360.uz}
if grep -q '^CLOUDFLARE_TUNNEL_TOKEN=..' "$secret"; then export COMPOSE_PROFILES=tunnel; else export COMPOSE_PROFILES=; fi
# Build first, so the backup is fresh when migrate deploy starts.
docker compose --env-file "$secret" -f "$source/compose.yaml" build
sh "$source/scripts/backup-nas.sh" > "$record/backup-path"
chmod 600 "$record/backup-path"
sh "$source/scripts/verify-backup-nas.sh" "$(cat "$record/backup-path")"
sh "$source/scripts/verify-migration-nas.sh" "$(cat "$record/backup-path")" "ijara360-api:$revision"
docker exec -i ijara360-db-1 psql -X -q -t -A -v ON_ERROR_STOP=1 -U ijara_owner -d ijara360 < "$source/scripts/production-fingerprint.sql" > "$record/before.txt"
chmod 644 "$source/infra/init-db.sql" "$source/infra/Caddyfile" "$source/infra/Caddyfile.lan" "$source/infra/common.caddy" "$source/scripts/backup-service.sh"
docker compose --env-file "$secret" -f "$source/compose.yaml" up -d --wait --wait-timeout 240
docker exec -i ijara360-db-1 psql -X -q -t -A -v ON_ERROR_STOP=1 -U ijara_owner -d ijara360 < "$source/scripts/production-fingerprint.sql" > "$record/after.txt"
diff -u "$record/before.txt" "$record/after.txt"
# UGOS itself does not resolve MagicDNS; retain TLS hostname verification.
curl --fail --silent --show-error --max-time 30 --resolve mynas.tail4bf75c.ts.net:8446:100.126.164.29 https://mynas.tail4bf75c.ts.net:8446/api/health
# Public surface (Funnel upstream): the whole site, with the bot webhook and health check closed,
# and the internet marker set by Caddy whatever the client sends.
# Home network entrance (own gateway, local certificate authority): healthy and marked private whatever the client sends.
curl --fail --silent --show-error --max-time 30 --insecure https://$lan:8446/api/health
curl --fail --silent --max-time 30 --insecure -H 'X-Ijara-Channel: public' https://$lan:8446/api/auth/channel | grep -q '"internet":false'
code() { curl --silent --output /dev/null --max-time 30 --write-out '%{http_code}' "$@"; }
for path in /apply /login /invite /api/public/applications/config /api/auth/setup-status; do
  test "$(code "http://127.0.0.1:8448$path")" = 200 || { echo "Public surface does not serve $path" >&2; exit 1; }
done
for path in /app /app/main.dart.js /app/ijara360.apk; do
  test "$(code "http://127.0.0.1:8448$path")" = 200 || { echo "Public surface does not serve $path" >&2; exit 1; }
done
for path in /api/health /api/telegram/webhook; do
  test "$(code "http://127.0.0.1:8448$path")" = 404 || { echo "Public surface exposes $path" >&2; exit 1; }
done
test "$(code -X POST -H 'Content-Type: application/json' -H 'X-Ijara-Request: 1' -H 'X-Ijara-Channel: private' --data '{}' http://127.0.0.1:8448/api/telegram/webhook)" = 404
# A client cannot pretend to be inside: the public listener always says internet, the tailnet one never does.
curl --fail --silent --max-time 30 -H 'X-Ijara-Channel: private' http://127.0.0.1:8448/api/auth/channel | grep -q '"internet":true'
curl --fail --silent --max-time 30 -H 'X-Ijara-Channel: public' http://127.0.0.1:8447/api/auth/channel | grep -q '"internet":false'
# Own-domain listener: same public rules, staff pages only on admin.<domain>.
docker compose --env-file "$secret" -f "$source/compose.yaml" exec -T api node scripts/check-domain.cjs "$domain"
if [ "$COMPOSE_PROFILES" = tunnel ]; then
  # The real way in from the internet: Cloudflare -> tunnel -> gateway. The tunnel needs a few seconds to connect.
  ok=''
  for i in $(seq 1 30); do
    if [ "$(code "https://$domain/apply")" = 200 ]; then ok=1; break; fi
    sleep 3
  done
  test -n "$ok" || { echo "https://$domain/apply не открывается через Cloudflare Tunnel" >&2; exit 1; }
  test "$(code "https://$domain/api/health")" = 404 || { echo "https://$domain exposes /api/health" >&2; exit 1; }
  echo "domain ok: https://$domain"
fi
printf '%s' "$revision" > "$root/DEPLOYED_COMMIT.new"
mv "$root/DEPLOYED_COMMIT.new" "$root/DEPLOYED_COMMIT"
docker compose --env-file "$secret" -f "$source/compose.yaml" ps
printf '\nDEPLOY VERIFIED %s evidence=%s\n' "$revision" "$record"
