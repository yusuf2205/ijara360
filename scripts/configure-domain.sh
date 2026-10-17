#!/bin/sh
# Own domain through Cloudflare Tunnel (docs/M7.1-DOMAIN.md). Run on the NAS as root, from the deployed release:
#   sudo sh scripts/configure-domain.sh
# Asks for the tunnel token with hidden input. Before saving anything it starts a temporary tunnel and checks
# from the internet that https://<domain>/apply opens and that admin.<domain> answers (Cloudflare Access optional).
# Then saves the token, adds both addresses to the allowed origins and makes <domain> the address in invite
# and Telegram links. "удалить" turns the domain off again. Then run the deploy again.
set -eu
umask 077
root=/volume1/docker/ijara360
secret=$root/secrets/production.env
domain=ijara360.uz
admin=admin.$domain
tailnet_public=https://mynas.tail4bf75c.ts.net:8443
image=cloudflare/cloudflared:2026.9.3
test "$(id -u)" = 0 || { echo 'Запустите через sudo: файл секретов принадлежит root.' >&2; exit 1; }
test -f "$secret" || { echo "Нет $secret" >&2; exit 1; }
test -t 0 || { echo 'Запустите в терминале: токен вводится скрыто.' >&2; exit 1; }

current() { sed -n "s/^$1=//p" "$secret" | tail -n 1; }
set_var() {
  NAME=$1 VALUE=$2 awk 'BEGIN{k=ENVIRON["NAME"];v=ENVIRON["VALUE"];done=0}
    index($0,k"=")==1{if(!done)print k"="v;done=1;next}{print}
    END{if(!done)print k"="v}' "$secret" > "$secret.new"
  chmod 600 "$secret.new"
  mv "$secret.new" "$secret"
}
# Comma lists of origins: add without duplicates, or drop.
join() { awk 'NF && !seen[$0]++ {printf "%s%s", (n++ ? "," : ""), $0} END {print ""}'; }
origins_with() { { printf '%s\n' "$1" | tr ',' '\n'; shift; for o in "$@"; do echo "$o"; done; } | join; }
origins_without() { list=$1; shift; printf '%s\n' "$list" | tr ',' '\n' | awk -v drop="$*" 'BEGIN {n = split(drop, d, " "); for (i = 1; i <= n; i++) x[d[i]] = 1} !x[$0]' | join; }
code() { curl --silent --output /dev/null --max-time 15 --write-out '%{http_code}' "$@"; }

# The gateway of the deployed release must already have the domain entrance.
docker exec ijara360-api-1 node scripts/check-domain.cjs "$domain" >/dev/null 2>&1 ||
  { echo 'Сначала выпустите версию с поддержкой домена (Deploy-Nas.ps1), затем запустите этот скрипт.' >&2; exit 1; }

if [ -n "$(current CLOUDFLARE_TUNNEL_TOKEN)" ]; then
  printf 'Туннель уже подключён. Вставьте новый токен, «удалить», чтобы отключить домен, или Enter (ввод скрыт): '
else
  printf 'Токен туннеля Cloudflare (длинная строка eyJ…, ввод скрыт): '
fi
stty -echo; IFS= read -r token || token=''; stty echo; printf '\n'
# People often copy the whole install command ("cloudflared service install eyJ…"): the token is the last word.
token=$(printf '%s\n' "$token" | sed 's/\x1b\[20[01]~//g' | awk '{print $NF}' | tr -d '\r')

if [ -z "$token" ]; then echo 'Ничего не изменено.'; exit 0; fi

if [ "$token" = удалить ]; then
  cp -p "$secret" "$secret.before-domain-$(date -u +%Y%m%dT%H%M%SZ)"
  set_var CLOUDFLARE_TUNNEL_TOKEN ''
  set_var WATCH_DOMAIN ''
  set_var ADDITIONAL_APP_ORIGINS "$(origins_without "$(current ADDITIONAL_APP_ORIGINS)" "https://$domain" "https://$admin")"
  set_var PUBLIC_APP_ORIGIN "$tailnet_public"
  echo "Домен отключён: ссылки снова ведут на $tailnet_public. Запустите выпуск ещё раз (Deploy-Nas.ps1)."
  echo 'Контейнер туннеля остановите после выпуска: sudo docker rm -f ijara360-tunnel-1'
  exit 0
fi

# A tunnel token is base64 JSON {"a": account, "t": tunnel id, "s": secret}.
printf '%s' "$token" | base64 -d 2>/dev/null | grep -q '"t":"' ||
  { echo 'Это не токен туннеля Cloudflare (строка после --token в команде установки). Ничего не сохранено.' >&2; exit 1; }

# Live check with a temporary tunnel in the site's Docker network. The token goes through the environment,
# never through command-line arguments.
docker rm -f ijara360-tunnel-check >/dev/null 2>&1 || true
TUNNEL_TOKEN=$token docker run -d --name ijara360-tunnel-check --network ijara360_default -e TUNNEL_TOKEN "$image" tunnel --no-autoupdate run >/dev/null
trap 'docker rm -f ijara360-tunnel-check >/dev/null 2>&1 || true' EXIT
echo "Проверяю https://$domain через Cloudflare (до 2 минут)…"
ok=''
for i in $(seq 1 40); do
  if [ "$(code "https://$domain/apply")" = 200 ]; then ok=1; break; fi
  sleep 3
done
if [ -z "$ok" ]; then
  echo "https://$domain/apply не открывается. Проверьте в Cloudflare: туннель «Healthy»; Public hostname $domain → HTTP gateway:8082." >&2
  echo 'Последние строки туннеля (без токена):' >&2
  docker logs --tail 8 ijara360-tunnel-check 2>&1 | sed 's/token=[^ ]*/token=…/g' >&2
  echo 'Ничего не сохранено.' >&2; exit 1
fi
admin_answer=$(curl --silent --output /dev/null --max-time 15 --write-out '%{http_code} %{redirect_url}' "https://$admin/login")
case "$admin_answer" in
  30[0-9]\ https://*.cloudflareaccess.com/*) echo "$admin закрыт Cloudflare Access." ;;
  000*|404*|52[0-9]*) echo "$admin не отвечает ($admin_answer): добавьте Public hostname $admin → HTTP gateway:8082. Ничего не сохранено." >&2; exit 1 ;;
  # Owner's decision 2026-10-17: Access is optional; without it the cabinet relies on the password,
  # login rate limits and Telegram confirmation of new devices (public channel).
  200*) echo "$admin открыт без Cloudflare Access: вход по паролю и подтверждению нового устройства в Telegram." ;;
  *) echo "$admin отвечает неожиданно ($admin_answer). Ничего не сохранено." >&2; exit 1 ;;
esac
test "$(code "https://$domain/api/health")" = 404 || { echo "https://$domain открывает служебную проверку: шлюз не той версии. Ничего не сохранено." >&2; exit 1; }

cp -p "$secret" "$secret.before-domain-$(date -u +%Y%m%dT%H%M%SZ)"
set_var CLOUDFLARE_TUNNEL_TOKEN "'$token'"
unset token
set_var PUBLIC_DOMAIN "$domain"
set_var WATCH_DOMAIN "$domain"
set_var ADDITIONAL_APP_ORIGINS "$(origins_with "$(current ADDITIONAL_APP_ORIGINS)" "https://$domain" "https://$admin")"
set_var PUBLIC_APP_ORIGIN "https://$domain"
chmod 600 "$secret"
echo "Сохранено: https://$domain и $admin открываются."
echo 'Теперь запустите выпуск ещё раз (Deploy-Nas.ps1): туннель станет постоянным, ссылки в приглашениях и Telegram поведут на домен.'
