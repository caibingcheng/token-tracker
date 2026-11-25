#!/usr/bin/env bash
# 打开查询缓存 DEBUG，打一次 /api/dashboard，dump 出所有 SQL 与 hit/miss
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
source "$HERE/lib/env.sh"
bench_init_secrets
export SQLITE_DATABASE_PATH="$HERE/data/bench.db"
export ALLOW_PRIVATE_UPSTREAMS=true
export NODE_ENV=production
export API_CACHE_DEBUG=true
PORT=3007

# cwd=仓库根（build/server.js 的 out/ 与 node_modules 相对 cwd），exec 让 SPID 指向 node
( cd "$ROOT" && PORT=$PORT HOSTNAME=127.0.0.1 exec node build/server.js >"$HERE/out/sqldebug-server.log" 2>&1 ) &
SPID=$!

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
