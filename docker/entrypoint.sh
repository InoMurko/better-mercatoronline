#!/bin/sh
# merc bot               → the Telegram bot (default)
# merc cli <command> …   → the command line, e.g. `merc cli due`, `merc cli import --max 5`
# anything else          → run as a command (e.g. `merc sh`)
set -e
APP="${MERC_APP:-/app}"
TSX="$APP/node_modules/.bin/tsx"

# /data must be writable by the user the container runs as – say so clearly instead of failing later
if ! ( : > /data/.write-test ) 2>/dev/null; then
  echo "✗ /data isn't writable by uid $(id -u):$(id -g)." >&2
  echo "  On the host, either put MERC_UID=\$(id -u) and MERC_GID=\$(id -g) in .env (docker compose),"  >&2
  echo "  or give the folder to that uid:  sudo chown -R $(id -u):$(id -g) data" >&2
  exit 1
fi
rm -f /data/.write-test
for f in /data/history.json /data/.session.json /data/.basket.json; do
  if [ -e "$f" ] && [ ! -w "$f" ]; then
    echo "✗ $f isn't writable by uid $(id -u) – on the host: sudo chown -R $(id -u):$(id -g) data" >&2
    exit 1
  fi
done

case "${1:-bot}" in
  bot) exec "$TSX" "$APP/src/bot.ts" ;;
  cli) shift; exec "$TSX" "$APP/src/cli.ts" "$@" ;;
  help|-h|--help)
    echo "usage: merc [bot | cli <command> [options] | <shell command>]"
    exec "$TSX" "$APP/src/cli.ts" ;;
  *) exec "$@" ;;
esac
