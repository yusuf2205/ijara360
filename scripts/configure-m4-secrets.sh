#!/bin/sh
# One-time M4 configuration of the private production.env. Run on the NAS as root:
#   sudo sh scripts/configure-m4-secrets.sh
# Never prints secret values. Existing values are kept; the KYC key is never rotated here.
set -eu
umask 077
secret=/volume1/docker/ijara360/secrets/production.env
public_origin=https://mynas.tail4bf75c.ts.net:8443
test "$(id -u)" = 0 || { echo 'Run with sudo: the secrets file belongs to root.' >&2; exit 1; }
test -f "$secret" || { echo "Missing $secret" >&2; exit 1; }
current() { sed -n "s/^$1=//p" "$secret" | tail -n 1; }
# Values travel through the environment, never through command-line arguments.
set_var() {
  NAME=$1 VALUE=$2 awk 'BEGIN{k=ENVIRON["NAME"];v=ENVIRON["VALUE"];done=0}
    index($0,k"=")==1{if(!done)print k"="v;done=1;next}{print}
    END{if(!done)print k"="v}' "$secret" > "$secret.new"
  chmod 600 "$secret.new"
  mv "$secret.new" "$secret"
}
cp -p "$secret" "$secret.before-m4-$(date -u +%Y%m%dT%H%M%SZ)"

key=$(current KYC_ENCRYPTION_KEY)
if printf '%s' "$key" | grep -Eq '^[0-9a-fA-F]{64}$'; then
  echo 'KYC_ENCRYPTION_KEY: already present, kept unchanged.'
else
  set_var KYC_ENCRYPTION_KEY "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  echo 'KYC_ENCRYPTION_KEY: generated (32 random bytes). Make an offline copy now.'
fi

origins=$(current ADDITIONAL_APP_ORIGINS)
case ",$origins," in
  *",$public_origin,"*) ;;
  *) set_var ADDITIONAL_APP_ORIGINS "${origins:+$origins,}$public_origin" ;;
esac
test -n "$(current PUBLIC_APP_ORIGIN)" || set_var PUBLIC_APP_ORIGIN "$public_origin"
test -n "$(current TELEGRAM_MODE)" || set_var TELEGRAM_MODE polling

if [ -n "$(current TELEGRAM_BOT_TOKEN)" ]; then
  echo 'TELEGRAM_BOT_TOKEN: already present, kept unchanged.'
elif [ -t 0 ]; then
  printf 'Telegram bot token from @BotFather (input hidden, empty = skip): '
  stty -echo; IFS= read -r token || token=''; stty echo; printf '\n'
  # Pasting can add spaces, a carriage return or bracketed-paste markers.
  token=$(printf '%s' "$token" | sed 's/\x1b\[20[01]~//g' | tr -d ' \t\r')
  if [ -n "$token" ]; then
    printf '%s' "$token" | grep -Eq '^[0-9]{5,}:[A-Za-z0-9_-]{30,}$' || { echo 'Token format is not valid; nothing saved.' >&2; exit 1; }
    # Confirms the token with Telegram; the URL is built inside curl's config, not argv.
    username=$(printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$token" | curl -sf --max-time 20 -K - | sed -n 's/.*"username":"\([A-Za-z0-9_]*\)".*/\1/p')
    test -n "$username" || { echo 'Telegram rejected the token; nothing saved.' >&2; exit 1; }
    set_var TELEGRAM_BOT_TOKEN "$token"
    set_var TELEGRAM_BOT_USERNAME "$username"
    echo "TELEGRAM_BOT_TOKEN: saved and confirmed for @$username."
  fi
  unset token
fi
chmod 600 "$secret"
echo "Configured keys: $(sed -n 's/^\(KYC_ENCRYPTION_KEY\|ADDITIONAL_APP_ORIGINS\|PUBLIC_APP_ORIGIN\|TELEGRAM_[A-Z_]*\)=.*/\1/p' "$secret" | tr '\n' ' ')"
