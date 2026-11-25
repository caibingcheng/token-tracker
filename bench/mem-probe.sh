#!/usr/bin/env bash
# 单独测量「空 node 进程」和「Hono bundle 启动后」的内存映射构成，
# 用于判断 RSS 里有多少是运行时固定成本（换语言才能消掉的部分）。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
source "$HERE/lib/env.sh"
bench_init_secrets
export SQLITE_DATABASE_PATH="$HERE/data/bench.db"
export ALLOW_PRIVATE_UPSTREAMS=true

echo "===== bare node (idle) ====="
node -e 'setInterval(()=>{},60000)' >/dev/null 2>&1 &
NPID=$!
sleep 3
grep -E 'VmRSS|RssAnon|RssFile' "/proc/$NPID/status"
bash "$HERE/maps.sh" "$NPID" "bare-node"
kill "$NPID" 2>/dev/null
wait "$NPID" 2>/dev/null

echo
echo "===== hono bundle (idle 20s) ====="
# exec：SPID 直接指向 node 进程
( cd "$ROOT" && PORT=3003 HOSTNAME=127.0.0.1 exec node build/server.js >/tmp/ns.log 2>&1 ) &
SPID=$!
sleep 20
grep -E 'VmRSS|RssAnon|RssFile' "/proc/$SPID/status"
REAL=$SPID
bash "$HERE/maps.sh" "$REAL" "hono-bundle-idle"
kill "$SPID" 2>/dev/null
