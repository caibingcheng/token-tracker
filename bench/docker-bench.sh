#!/usr/bin/env bash
# Docker 版对比压测：真实镜像 + cgroup v2 统计（与 docker stats 同口径）。
#
# 用法：IMAGE=tt:before LABEL=before-docker bash bench/docker-bench.sh
#   IDLE_BEFORE / LOAD_DURATION / IDLE_AFTER / CONCURRENCY / THINK_MS / ADMIN_RPS / SCENARIO
#
# 产出 bench/out/<LABEL>/
#   cgroup.jsonl   每秒 memory.current / memory.stat 原始值
#   loadgen.txt    压测结果
#   summary.json   分阶段聚合（含 docker stats 口径 current-inactive_file）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
LABEL="${LABEL:?LABEL required}"
IMAGE="${IMAGE:?IMAGE required}"
OUT="$HERE/out/$LABEL"
DATA="$HERE/docker-data"
PORT="${PORT:-3000}"
MOCK_PORT=18080
NAME="tt-bench-$LABEL"

source "$HERE/lib/env.sh"
bench_init_secrets

DAYS="${DAYS:-30}"
PER_DAY="${PER_DAY:-10000}"
IDLE_BEFORE="${IDLE_BEFORE:-40}"
LOAD_DURATION="${LOAD_DURATION:-300}"
IDLE_AFTER="${IDLE_AFTER:-120}"
CONCURRENCY="${CONCURRENCY:-8}"
THINK_MS="${THINK_MS:-0}"
ADMIN_RPS="${ADMIN_RPS:-4}"
SCENARIO="${SCENARIO:-all}"

mkdir -p "$OUT" "$DATA"
bench_guard_db "$DATA/token-tracker.db"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null
  [[ -n "${PROBE_PID:-}" ]] && kill "$PROBE_PID" 2>/dev/null
}
trap cleanup EXIT

echo "==> reset data"
rm -f "$DATA"/token-tracker.db*
# 建表必须先跑应用自己的迁移（seed 只写数据，不建表）
npx tsx "$HERE/init-db.ts" "$DATA/token-tracker.db" >/dev/null
node "$HERE/seed.mjs" "$DATA/token-tracker.db" "$DAYS" "$PER_DAY"
node "$HERE/check-vk.mjs" "$DATA/token-tracker.db" | head -3
# 与生产一致的 models.dev 快照（避免压测期间走网络刷新）
[[ -f "$DATA/models-dev-cache.json" ]] || cp "$HERE/data/models-dev-cache.json" "$DATA/" 2>/dev/null || true
node "$HERE/fix-snapshot.mjs" "$DATA/models-dev-cache.json" >/dev/null 2>&1 || true

echo "==> mock upstream on :$MOCK_PORT"
pkill -f "mock-upstream.mjs $MOCK_PORT" 2>/dev/null || true
node "$HERE/mock-upstream.mjs" "$MOCK_PORT" >"$OUT/mock.log" 2>&1 &
MOCK_PID=$!

echo "==> start container $IMAGE"
docker ps -aq --filter "name=tt-bench-" | xargs -r docker rm -f >/dev/null 2>&1 || true
docker rm -f "$NAME" >/dev/null 2>&1 || true
EXTRA_ARGS=()
if [[ -n "${EXTRA_ENV:-}" ]]; then read -r -a EXTRA_ARGS <<<"$EXTRA_ENV"; fi
docker run -d --name "$NAME" \
  --network host \
  -v "$DATA:/app/data" \
  -e SQLITE_DATABASE_PATH=/app/data/token-tracker.db \
  -e ALLOW_PRIVATE_UPSTREAMS=true \
  -e GATEWAY_SECRET="$GATEWAY_SECRET" \
  -e ADMIN_API_KEY="$ADMIN_API_KEY" \
  "${EXTRA_ARGS[@]}" \
  "$IMAGE" >/dev/null

CPID=""
for i in $(seq 1 120); do
  CPID=$(docker inspect -f '{{.State.Pid}}' "$NAME" 2>/dev/null || echo "")
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/session" || true)
  [[ "$code" == "401" ]] && break
  sleep 1
done
[[ "$code" == "401" ]] || {
  echo "container not ready (last=$code)"
  docker logs "$NAME" 2>&1 | tail -30
  exit 1
}

# cgroup v2 路径（从目标进程的 /proc/<pid>/cgroup 取）
CGROUP_REL=$(awk -F: '{print $3}' "/proc/$CPID/cgroup" | head -1)
CGROUP="/sys/fs/cgroup$CGROUP_REL"
[[ -f "$CGROUP/memory.stat" ]] || { echo "cgroup not found: $CGROUP"; exit 1; }
echo "     pid=$CPID cgroup=$CGROUP"

echo "==> login"
TOKEN=$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$ADMIN_API_KEY\"}" |
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).token||"")}catch{console.log("")}})')
[[ -n "$TOKEN" ]] || { echo "login failed"; docker logs "$NAME" 2>&1 | tail -20; exit 1; }

# 采样器：每秒一次，记录 docker stats 同口径所需的全部字段
(
  while true; do
    ts=$(date +%s)
    cur=$(cat "$CGROUP/memory.current" 2>/dev/null || echo 0)
    cpu=$(awk '{print $14 + $15}' "/proc/$CPID/stat" 2>/dev/null || echo 0)
    awk -v ts="$ts" -v cur="$cur" -v cpu="$cpu" '
      { v[$1] = $2 }
      END {
        printf "{\"t\":%d,\"current\":%d,\"anon\":%d,\"file\":%d,\"inactive_file\":%d,\"active_file\":%d,\"slab\":%d,\"sock\":%d,\"kernel_stack\":%d,\"pagetables\":%d,\"cpuTicks\":%d}\n",
          ts, cur, v["anon"], v["file"], v["inactive_file"], v["active_file"], v["slab"], v["sock"], v["kernel_stack"], v["pagetables"], cpu
      }' "$CGROUP/memory.stat" 2>/dev/null
    sleep 1
  done
) >"$OUT/cgroup.jsonl" &
PROBE_PID=$!

echo "==> idle baseline ${IDLE_BEFORE}s"
sleep "$IDLE_BEFORE"

echo "==> load ${LOAD_DURATION}s concurrency=$CONCURRENCY think=${THINK_MS}ms adminRps=$ADMIN_RPS"
node "$HERE/loadgen.mjs" --base "http://127.0.0.1:$PORT" --token "$TOKEN" \
  --duration "$LOAD_DURATION" --concurrency "$CONCURRENCY" --admin-rps "$ADMIN_RPS" \
  --think-ms "$THINK_MS" --scenario "$SCENARIO" | tee "$OUT/loadgen.txt"

echo "==> cooldown ${IDLE_AFTER}s"
sleep "$IDLE_AFTER"

kill "$PROBE_PID" 2>/dev/null
docker stats --no-stream --format '{{.MemUsage}}' "$NAME" >"$OUT/docker-stats.txt" 2>/dev/null || true

node "$HERE/summarize-cgroup.mjs" "$OUT/cgroup.jsonl" "$IDLE_BEFORE" "$LOAD_DURATION" "$IDLE_AFTER" \
  >"$OUT/summary.json"
cat "$OUT/summary.json"
