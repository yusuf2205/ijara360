#!/bin/sh
# Yandex Maps key for the staff map (docs/M7-LOCATION.md). Run on the NAS as root, from the deployed release:
#   sudo sh scripts/configure-map-key.sh
# Asks for the JavaScript API key with hidden input, checks its format, saves it to production.env as
# YANDEX_MAPS_API_KEY. Never prints the key. Typing "удалить" removes it (the map goes back to
# "Карта не подключена"). Then run the deploy again so the API reads it.
set -eu
umask 077
root=/volume1/docker/ijara360
secret=$root/secrets/production.env
test "$(id -u)" = 0 || { echo 'Запустите через sudo: файл секретов принадлежит root.' >&2; exit 1; }
test -f "$secret" || { echo "Нет $secret" >&2; exit 1; }
test -t 0 || { echo 'Запустите в терминале: ключ вводится скрыто.' >&2; exit 1; }

current() { sed -n "s/^$1=//p" "$secret" | tail -n 1; }
set_var() {
  NAME=$1 VALUE=$2 awk 'BEGIN{k=ENVIRON["NAME"];v=ENVIRON["VALUE"];done=0}
    index($0,k"=")==1{if(!done)print k"="v;done=1;next}{print}
    END{if(!done)print k"="v}' "$secret" > "$secret.new"
  chmod 600 "$secret.new"
  mv "$secret.new" "$secret"
}

if [ -n "$(current YANDEX_MAPS_API_KEY)" ]; then
  printf 'Ключ карты уже задан. Вставьте новый, чтобы заменить, «удалить», чтобы убрать, или Enter, чтобы оставить (ввод скрыт): '
else
  printf 'Ключ JavaScript API Яндекс Карт (ввод скрыт): '
fi
stty -echo; IFS= read -r key || key=''; stty echo; printf '\n'
key=$(printf '%s' "$key" | sed 's/\x1b\[20[01]~//g' | tr -d ' \t\r\n')
case "$key" in
  '') echo 'Ничего не изменено.'; exit 0 ;;
  удалить) value='' ;;
  *)
    # Keys from the developer cabinet are UUIDs.
    printf '%s' "$key" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ||
      { echo 'Это не похоже на ключ Яндекса (вид xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Ничего не сохранено.' >&2; exit 1; }
    value=$key ;;
esac
unset key

cp -p "$secret" "$secret.before-map-$(date -u +%Y%m%dT%H%M%SZ)"
set_var YANDEX_MAPS_API_KEY "$value"
chmod 600 "$secret"
if [ -n "$value" ]; then
  echo 'Ключ сохранён. Теперь запустите выпуск ещё раз (Deploy-Nas.ps1), чтобы сервер приложения его прочитал.'
else
  echo 'Ключ удалён. Запустите выпуск ещё раз (Deploy-Nas.ps1): карта снова будет «не подключена».'
fi
