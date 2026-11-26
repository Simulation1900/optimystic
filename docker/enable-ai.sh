#!/bin/sh
# Turns on "Refresh advice" (the Claude API) for Bill Planner on ZimaOS, and optionally moves to a new image.
# Run it on the server:   sudo sh enable-ai.sh [monthly cap in dollars, default 25] [image tag, e.g. 1.2.13]
# It asks for the key without showing it, saves it to .env (chmod 600), passes it to the app in compose.yml,
# and restarts the app. Run it again to change the key or the cap.
set -eu
cd /DATA/AppData/bill-planner
CAP="${1:-25}"
TAG="${2:-}"

printf 'Anthropic API key (it will not be shown): '
stty -echo; read -r KEY; stty echo; echo
[ -n "$KEY" ] || { echo 'No key entered; nothing changed.'; exit 1; }

sed -i '/^ANTHROPIC_API_KEY=/d;/^AI_MONTHLY_BUDGET_USD=/d' .env
printf 'ANTHROPIC_API_KEY=%s\nAI_MONTHLY_BUDGET_USD=%s\n' "$KEY" "$CAP" >> .env
chmod 600 .env

if ! grep -q 'ANTHROPIC_API_KEY:' compose.yml; then
  sed -i 's|^\( *\)SYNC_KEY: \${SYNC_KEY}.*|&\n\1ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}\n\1AI_MONTHLY_BUDGET_USD: ${AI_MONTHLY_BUDGET_USD:-25}|' compose.yml
fi
if [ -n "$TAG" ]; then
  sed -i -E "s|(ghcr.io/simulation1900/optimystic:)[0-9.]+|\1$TAG|" compose.yml
fi

/DATA/docker-compose up -d
echo "Done: Refresh advice is on, capped at \$$CAP a month."
