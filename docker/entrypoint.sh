#!/bin/sh
# merc bot               → the Telegram bot (default)
# merc cli <command> …   → the command line, e.g. `merc cli due`, `merc cli import --max 5`
# anything else          → run as a command (e.g. `merc sh`)
set -e
APP="${MERC_APP:-/app}"
TSX="$APP/node_modules/.bin/tsx"

# Started as root (the image's default): run as whoever owns /data, so files in the mounted folder keep their
# owner on the host. A folder Docker created itself (owned by root) is handed to the unprivileged "node" user.
# MERC_UID / MERC_GID override the choice. Root is only used for these few lines – never for the app.
number() { case "$2" in ''|*[!0-9]*) echo "✗ $1 must be a number (got '$2')" >&2; exit 1 ;; esac; }
if [ "$(id -u)" = 0 ]; then
  if [ -n "${MERC_DROPPED:-}" ]; then echo "✗ still root after dropping privileges – refusing to run the app as root" >&2; exit 1; fi
  uid=$(stat -c %u /data); gid=$(stat -c %g /data)
  if [ -n "${MERC_UID:-}" ]; then
    number MERC_UID "$MERC_UID"; uid=$MERC_UID; gid=${MERC_GID:-$MERC_UID}
    number MERC_GID "$gid"
    if [ "$uid" -eq 0 ]; then echo "✗ MERC_UID=0 would run the app as root – use your own uid (id -u)" >&2; exit 1; fi
  fi
  if [ "$uid" -eq 0 ]; then
    # /data belongs to root – usually a folder Docker just created. Hand an EMPTY one to the "node" user (1000);
    # never take over a folder that already has data in it (on a shared host 1000 may be someone else).
    if [ -z "$(ls -A /data 2>/dev/null)" ]; then
      uid=1000; gid=1000
      chown "$uid:$gid" /data
    else
      echo "✗ /data is owned by root and not empty. Either: sudo chown -R \$(id -u):\$(id -g) data   or set MERC_UID in .env" >&2
      exit 1
    fi
  fi
  # never group 0 (root's group): fall back to a group named after the user's own id
  if [ "$gid" -eq 0 ]; then gid=$uid; fi
  export HOME=/tmp MERC_DROPPED=1
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups -- "$0" "$@"
fi
[ -w "${HOME:-/nonexistent}" ] || export HOME=/tmp

# /data must be writable by the user the container runs as – say so clearly instead of failing later
if ! ( : > /data/.write-test ) 2>/dev/null; then
  echo "✗ /data isn't writable by uid $(id -u):$(id -g)." >&2
  echo "  On the host: sudo chown -R \$(id -u):\$(id -g) data   (the container then runs as you)" >&2
  exit 1
fi
rm -f /data/.write-test
for f in /data/history.json /data/.session.json /data/.basket.json; do
  if [ -e "$f" ] && [ ! -w "$f" ]; then
    echo "✗ $f isn't writable by uid $(id -u) – on the host: sudo chown -R \$(id -u):\$(id -g) data" >&2
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
