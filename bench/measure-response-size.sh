#!/usr/bin/env bash
# 测量各管理接口的响应体大小（判断内存峰值是否来自响应序列化）
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
source "$HERE/lib/env.sh"
bench_init_secrets
export SQLITE_DATABASE_PATH="$HERE/data/bench.db"
export ALLOW_PRIVATE_UPSTREAMS=true
export NODE_ENV=production
PORT=3006

pushd "$ROOT/.next/standalone" >/dev/null
PORT=$PORT HOSTNAME=127.0.0.1 node server.js >/tmp/size-probe.log 2>&1 &
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

for p in "/api/dashboard" "/api/dashboard?range=30d" "/api/model-pricing" "/api/models" "/api/records?page=1&limit=200"; do
  bytes=$(curl -s -H "X-API-Key: $TOKEN" "http://127.0.0.1:$PORT$p" | wc -c)
  printf "%-45s %8d bytes (%.2f MB)\n" "$p" "$bytes" "$(echo "scale=2; $bytes/1048576" | bc -l)"
done

kill "$SPID" 2>/dev/null
wait "$SPID" 2>/dev/null
