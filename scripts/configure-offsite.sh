#!/bin/sh
# Offsite copies setup (docs/M6-OFFSITE.md). Run on the NAS as root, from the deployed release:
#   sudo sh scripts/configure-offsite.sh
# Asks for the owner's age PUBLIC key (age1…) and the Google Drive token printed by
# "rclone authorize" on the owner's computer, checks the token with a test file, saves both to
# production.env. Never prints the token; values never travel through command-line arguments.
# Then run the deploy again so the offsite service starts with them.
set -eu
umask 077
root=/volume1/docker/ijara360
secret=$root/secrets/production.env
test "$(id -u)" = 0 || { echo 'Запустите через sudo: файл секретов принадлежит root.' >&2; exit 1; }
test -f "$secret" || { echo "Нет $secret" >&2; exit 1; }
test -t 0 || { echo 'Запустите в терминале: токен вводится скрыто.' >&2; exit 1; }
revision=$(cat "$root/DEPLOYED_COMMIT")
image="ijara360-offsite:$revision"
docker image inspect "$image" >/dev/null 2>&1 || { echo "Нет образа $image: сначала выпустите версию с внешней копией." >&2; exit 1; }

current() { sed -n "s/^$1=//p" "$secret" | tail -n 1; }
set_var() {
  NAME=$1 VALUE=$2 awk 'BEGIN{k=ENVIRON["NAME"];v=ENVIRON["VALUE"];done=0}
    index($0,k"=")==1{if(!done)print k"="v;done=1;next}{print}
    END{if(!done)print k"="v}' "$secret" > "$secret.new"
  chmod 600 "$secret.new"
  mv "$secret.new" "$secret"
}
clean() { sed 's/\x1b\[20[01]~//g' | tr -d ' \t\r\n'; }

# 1. Public key: safe to show, it can only encrypt.
key=$(current OFFSITE_AGE_RECIPIENT)
if [ -n "$key" ]; then
  echo "Открытый ключ уже задан: $key"
  printf 'Заменить? Введите новый ключ age1… или нажмите Enter, чтобы оставить: '
else
  printf 'Открытый ключ age (начинается с age1…): '
fi
IFS= read -r input || input=''
input=$(printf '%s' "$input" | clean)
if [ -n "$input" ]; then
  printf '%s' "$input" | grep -Eq '^age1[02-9ac-hj-np-z]{58}$' || { echo 'Это не открытый ключ age (age1… из 62 символов). Ничего не сохранено.' >&2; exit 1; }
  key=$input
fi
test -n "$key" || { echo 'Без открытого ключа копии нельзя зашифровать. Ничего не сохранено.' >&2; exit 1; }

# 2. Google Drive token from "rclone authorize": JSON with a refresh_token. Hidden input.
token=''
if [ -n "$(current OFFSITE_GDRIVE_TOKEN)" ]; then
  printf 'Google Drive уже подключён. Вставьте новый токен, чтобы заменить, или нажмите Enter (ввод скрыт): '
else
  printf 'Токен Google Drive из rclone authorize, строка {"access_token":…} (ввод скрыт, Enter — пропустить): '
fi
stty -echo; IFS= read -r token || token=''; stty echo; printf '\n'
token=$(printf '%s' "$token" | sed 's/\x1b\[20[01]~//g' | tr -d '\r\n')
if [ -n "$token" ]; then
  printf '%s' "$token" | grep -q '"refresh_token":"' || { echo 'В токене нет refresh_token: скопируйте всю строку {…} из rclone authorize. Ничего не сохранено.' >&2; exit 1; }
  case "$token" in *"'"*) echo 'Неожиданный символ в токене. Ничего не сохранено.' >&2; exit 1 ;; esac
  # Test write and delete in the app's own folder; the token goes through a private env file.
  envfile=$(mktemp)
  trap 'rm -f "$envfile"' EXIT
  printf 'RCLONE_CONFIG_GDRIVE_TYPE=drive\nRCLONE_CONFIG_GDRIVE_SCOPE=drive.file\nRCLONE_CONFIG_GDRIVE_TOKEN=%s\n' "$token" > "$envfile"
  if ! docker run --rm --env-file "$envfile" "$image" sh -c 'echo ijara360 > /tmp/check && rclone copyto /tmp/check gdrive:Ijara360-backup/.connection-check && rclone deletefile gdrive:Ijara360-backup/.connection-check' >/dev/null 2>&1; then
    echo 'Google Drive не принял токен (пробная запись не удалась). Ничего не сохранено.' >&2; exit 1
  fi
  echo 'Google Drive: пробная запись в папку Ijara360-backup прошла.'
fi

cp -p "$secret" "$secret.before-offsite-$(date -u +%Y%m%dT%H%M%SZ)"
set_var OFFSITE_AGE_RECIPIENT "$key"
# Single quotes: Docker Compose reads the JSON literally.
[ -z "$token" ] || set_var OFFSITE_GDRIVE_TOKEN "'$token'"
unset token
chmod 600 "$secret"
echo 'Сохранено. Теперь запустите выпуск ещё раз (Deploy-Nas.ps1), чтобы сервис внешней копии получил настройки.'
