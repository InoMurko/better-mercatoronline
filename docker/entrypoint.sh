#!/bin/sh
# merc bot               → the Telegram bot (default)
# merc cli <command> …   → the command line, e.g. `merc cli due`, `merc cli import --max 5`
# anything else          → run as a command (e.g. `merc sh`)
set -e
APP="${MERC_APP:-/app}"
TSX="$APP/node_modules/.bin/tsx"

case "${1:-bot}" in
  bot) exec "$TSX" "$APP/src/bot.ts" ;;
  cli) shift; exec "$TSX" "$APP/src/cli.ts" "$@" ;;
  help|-h|--help)
    echo "usage: merc [bot | cli <command> [options] | <shell command>]"
    exec "$TSX" "$APP/src/cli.ts" ;;
  *) exec "$@" ;;
esac
