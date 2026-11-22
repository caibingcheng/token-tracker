#!/usr/bin/env bash
# 单独测量「空 node 进程」和「Next standalone 启动后」的内存映射构成，
# 用于判断 RSS 里有多少是运行时固定成本（换语言才能消掉的部分）。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
# 基准测试专用固定假密钥（非生产凭证）；可用环境变量覆盖
: "${GATEWAY_SECRET:=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
: "${ADMIN_API_KEY:=bench-admin-key-0123456789abcdef0123456789abcdef}"
export GATEWAY_SECRET ADMIN_API_KEY
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
echo "===== next standalone (idle 20s) ====="
STANDALONE="$ROOT/.next/standalone"
( cd "$STANDALONE" && PORT=3003 HOSTNAME=127.0.0.1 node server.js >/tmp/ns.log 2>&1 ) &
SPID=$!
sleep 20
grep -E 'VmRSS|RssAnon|RssFile' "/proc/$SPID/status" 2>/dev/null || pgrep -f "standalone/server.js" | head -1
REAL=$(pgrep -f "node server.js" | head -1)
grep -E 'VmRSS|RssAnon|RssFile' "/proc/$REAL/status"
bash "$HERE/maps.sh" "$REAL" "next-standalone-idle"
kill "$SPID" "$REAL" 2>/dev/null
