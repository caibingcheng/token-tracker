#!/bin/sh
set -e

DATA_DIR=/app/data
ENV_FILE="$DATA_DIR/.b-node-env"
DB_FILE="$DATA_DIR/token-tracker.db"

# 服务进程在容器内的 uid:gid（同时决定数据目录属主）。默认 1000 = 镜像内 node 用户。
# 宿主 uid 不是 1000（例如想让自己直接读写 ~/.token-tracker）时用 PUID/PGID 覆盖，
# gosu 接受数字形式，容器内无需存在同名用户。
PUID=${PUID:-1000}
PGID=${PGID:-1000}

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

# 递归 chown：既建目录属主，也能修复历史上被手工 chown 打乱的文件属主
# （属主不对时 SQLite 报 SQLITE_CANTOPEN，表现为登录接口 500）
chown -R "$PUID:$PGID" "$DATA_DIR"

exec gosu "$PUID:$PGID" sh -c 'set -a; . "$0"; set +a; exec node --optimize-for-size build/server.js' "$ENV_FILE"
