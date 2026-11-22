#!/usr/bin/env bash
# 验证 models.dev 快照的空闲释放是否真的反映到 cgroup anon。
# 用法：bash bench/docker-snapshot-test.sh [IDLE_MS]
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-tt:after}"
NAME=tt-snap-test
PORT=3000
DATA="$HERE/docker-data"
IDLE_MS="${1:-20000}"

source "$HERE/lib/env.sh"
bench_init_secrets
bench_guard_db "$DATA/token-tracker.db"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --network host \
  -v "$DATA:/app/data" \
  -e SQLITE_DATABASE_PATH=/app/data/token-tracker.db \
  -e ALLOW_PRIVATE_UPSTREAMS=true \
  -e GATEWAY_SECRET="$GATEWAY_SECRET" \
  -e ADMIN_API_KEY="$ADMIN_API_KEY" \
  -e MODELS_DEV_CACHE_IDLE_MS="$IDLE_MS" \
  "$IMAGE" >/dev/null

for i in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/session" || true)
  [[ "$code" == "401" ]] && break
  sleep 1
done
CPID=$(docker inspect -f '{{.State.Pid}}' "$NAME")
CGROUP="/sys/fs/cgroup$(awk -F: '{print $3}' "/proc/$CPID/cgroup" | head -1)"

anon() { awk '/^anon /{print int($2/1048576)}' "$CGROUP/memory.stat"; }
cur() { echo $(( $(cat "$CGROUP/memory.current") / 1048576 )); }

TOKEN=$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth/login" -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$ADMIN_API_KEY\"}" |
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).token||"")}catch{console.log("")}})')

echo "idle_ms=$IDLE_MS  env=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" | grep MODELS_DEV || echo MISSING)"
sleep 10
echo "baseline           anon=$(anon)MB current=$(cur)MB"
curl -s -o /dev/null -H "X-API-Key: $TOKEN" "http://127.0.0.1:$PORT/api/model-pricing"
curl -s -o /dev/null -H "X-API-Key: $TOKEN" "http://127.0.0.1:$PORT/api/admin/model-prices"
sleep 3
echo "after price load   anon=$(anon)MB current=$(cur)MB"

for t in 60 90 120 180; do
  sleep 30
  echo "t=+${t}s           anon=$(anon)MB current=$(cur)MB"
done

curl -s -o /dev/null -H "X-API-Key: $TOKEN" "http://127.0.0.1:$PORT/api/model-pricing"
sleep 3
echo "reload price       anon=$(anon)MB current=$(cur)MB"
