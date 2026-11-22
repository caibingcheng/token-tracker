#!/usr/bin/env bash
# 启动一个探针网关实例，跑逐接口内存归因，然后退出。
# 用法：bash bench/probe-endpoints.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
source "$HERE/lib/env.sh"
bench_init_secrets
export SQLITE_DATABASE_PATH="$HERE/data/bench.db"
export ALLOW_PRIVATE_UPSTREAMS=true
export NODE_ENV=production
PORT=3005

pushd "$ROOT/.next/standalone" >/dev/null
PORT=$PORT HOSTNAME=127.0.0.1 \
  NODE_OPTIONS="--require $HERE/probe.cjs --max-old-space-size=256 --expose-gc --max-semi-space-size=8" \
  PROBE_OUT="$HERE/out/probe-endpoints.jsonl" \
  node server.js >"$HERE/out/probe-endpoints-server.log" 2>&1 &
SPID=$!
popd >/dev/null

for i in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/session" || true)
  [[ "$code" == "401" ]] && break
  sleep 1
done

TOKEN=$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$ADMIN_API_KEY\"}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).token||"")}catch{console.log("")}})')

sleep 15
bash "$HERE/endpoint-probe.sh" "http://127.0.0.1:$PORT" "$TOKEN" "$SPID"
bash "$HERE/maps.sh" "$SPID" "after-endpoints"
kill "$SPID" 2>/dev/null
wait "$SPID" 2>/dev/null
