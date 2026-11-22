#!/usr/bin/env bash
# 打开查询缓存 DEBUG，打一次 /api/dashboard，dump 出所有 SQL 与 hit/miss
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
# 基准测试专用固定假密钥（非生产凭证）；可用环境变量覆盖
: "${GATEWAY_SECRET:=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
: "${ADMIN_API_KEY:=bench-admin-key-0123456789abcdef0123456789abcdef}"
export GATEWAY_SECRET ADMIN_API_KEY
export SQLITE_DATABASE_PATH="$HERE/data/bench.db"
export ALLOW_PRIVATE_UPSTREAMS=true
export NODE_ENV=production
export API_CACHE_DEBUG=true
PORT=3007

pushd "$ROOT/.next/standalone" >/dev/null
PORT=$PORT HOSTNAME=127.0.0.1 node server.js >"$HERE/out/sqldebug-server.log" 2>&1 &
SPID=$!
popd >/dev/null

for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/session" || true)
  [[ "$code" == "401" ]] && break
  sleep 1
done

TOKEN=$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$ADMIN_API_KEY\"}" |
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).token||"")}catch{console.log("")}})')

: >"$HERE/out/sqldebug-server.log"
curl -s -o /dev/null -H "X-API-Key: $TOKEN" "http://127.0.0.1:$PORT/api/dashboard"
sleep 2
kill "$SPID" 2>/dev/null
wait "$SPID" 2>/dev/null

grep -c "MISS" "$HERE/out/sqldebug-server.log" || true
grep "MISS" "$HERE/out/sqldebug-server.log" | sed 's/\[Cache\] MISS //' | sort | uniq -c | sort -rn | head -30
