#!/bin/sh
set -e

DATA_DIR=/app/data
ENV_FILE="$DATA_DIR/.b-node-env"

if [ ! -f "$ENV_FILE" ]; then
  GATEWAY_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  umask 077
  echo "GATEWAY_SECRET=$GATEWAY_SECRET" > "$ENV_FILE"
fi

chown node:node "$DATA_DIR" "$ENV_FILE"

exec gosu node sh -c 'set -a; . "$0"; set +a; exec node server.js' "$ENV_FILE"