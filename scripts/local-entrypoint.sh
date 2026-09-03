#!/bin/sh
set -e

DATA_DIR=/app/data
ENV_FILE="$DATA_DIR/.b-node-env"
DB_FILE="$DATA_DIR/token-tracker.db"

if [ -f "$DB_FILE" ] && [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: database exists but $ENV_FILE is missing." >&2
  echo "GATEWAY_SECRET encrypts virtual keys / upstream keys / sync tokens; a new secret" >&2
  echo "would make them permanently undecryptable. Refusing to start." >&2
  echo "Recovery options:" >&2
  echo "  1. Restore the secret file from a backup of ~/.token-tracker/" >&2
  echo "  2. Intentional reset: stop the container, back up token-tracker.db," >&2
  echo "     then start again to generate a fresh secret and re-set up everything" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  GATEWAY_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  umask 077
  echo "GATEWAY_SECRET=$GATEWAY_SECRET" > "$ENV_FILE"
fi

chown node:node "$DATA_DIR" "$ENV_FILE"

exec gosu node sh -c 'set -a; . "$0"; set +a; exec node server.js' "$ENV_FILE"