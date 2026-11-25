#!/usr/bin/env bash
# 基准测试编排：seed → 起 mock 上游 → 起网关（带探针）→ idle 基线 → 压测 → 回落观察
#
# 用法：LABEL=before bash bench/run.sh [--skip-seed] [--skip-build]
#
# 输出：
#   bench/out/<LABEL>/probe.jsonl   每 2s 的 rss/heap/external/cpu 时间序列
#   bench/out/<LABEL>/summary.json  分阶段聚合
#   bench/out/<LABEL>/loadgen.txt   压测结果
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
LABEL="${LABEL:-run}"
OUT="$HERE/out/$LABEL"
DB_DIR="$HERE/data"
DB="$DB_DIR/bench.db"
PORT="${PORT:-3001}"
MOCK_PORT="${MOCK_PORT:-18080}"

DAYS="${DAYS:-30}"
PER_DAY="${PER_DAY:-10000}"
IDLE_BEFORE="${IDLE_BEFORE:-40}"
LOAD_DURATION="${LOAD_DURATION:-300}"
IDLE_AFTER="${IDLE_AFTER:-90}"
CONCURRENCY="${CONCURRENCY:-8}"
ADMIN_RPS="${ADMIN_RPS:-4}"
SCENARIO="${SCENARIO:-all}"
THINK_MS="${THINK_MS:-0}"

# 生产同款 V8 参数（见 Dockerfile），可用 NODE_FLAGS 覆盖做 A/B
NODE_FLAGS="${NODE_FLAGS:---max-old-space-size=256 --expose-gc --max-semi-space-size=8}"

# JEMALLOC：可选，指同生产 Dockerfile 的 libjemalloc.so（避免 glibc arena 碎片）。
# 只对 server 进程 preload：bash 自身 preload 会在某些发行版上因依赖链报错。
JEMALLOC="${JEMALLOC:-}"
if [[ -n "${MALLOC_CONF:-}" ]]; then export MALLOC_CONF; fi

mkdir -p "$OUT" "$DB_DIR"

source "$HERE/lib/env.sh"
bench_init_secrets
export SQLITE_DATABASE_PATH="$DB"
bench_guard_db "$DB"
export ALLOW_PRIVATE_UPSTREAMS=true
export NODE_ENV=production
export MOCK_BASE_URL="http://127.0.0.1:$MOCK_PORT"

if [[ ! " $* " =~ " --skip-seed " ]]; then
  echo "==> seed: $DAYS days x $PER_DAY rows/day"
  rm -f "$DB" "$DB-wal" "$DB-shm"
  npx tsx "$HERE/init-db.ts" "$DB" >/dev/null
  node "$HERE/seed.mjs" "$DB" "$DAYS" "$PER_DAY"
fi

if [[ ! " $* " =~ " --skip-build " ]]; then
  echo "==> build"
  (cd "$ROOT" && npm run build >"$OUT/build.log" 2>&1) || {
    echo "build failed, see $OUT/build.log"
    tail -30 "$OUT/build.log"
    exit 1
  }
fi

cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null
  [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

echo "==> mock upstream on $MOCK_PORT"
node "$HERE/mock-upstream.mjs" "$MOCK_PORT" >"$OUT/mock.log" 2>&1 &
MOCK_PID=$!

# 与生产同构：跑 esbuild bundle build/server.js（Dockerfile 的 CMD），
# 而不是 `next start`（已无 Next 服务端；bundle 不加载任何 Next CLI，基线 RSS 可比）
SERVER="$ROOT/build/server.js"
if [[ ! -f "$SERVER" ]]; then
  echo "missing $SERVER — run npm run build（gen-routes + next build + esbuild）"
  exit 1
fi

PROBE_OUT="$OUT/probe.jsonl" \
NODE_OPTIONS="--require $HERE/probe.cjs $NODE_FLAGS" \
PORT="$PORT" HOSTNAME=127.0.0.1 \
  bash -c "cd '$ROOT' && exec env LD_PRELOAD='$JEMALLOC' node ${NODE_ARGS:-} build/server.js" >"$OUT/server.log" 2>&1 &
SERVER_PID=$!

echo "==> waiting for server (pid $SERVER_PID)"
for i in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/auth/session" || true)
  [[ "$code" == "401" ]] && break
  sleep 1
done
[[ "$code" == "401" ]] || {
  echo "server did not become ready (last=$code)"
  tail -30 "$OUT/server.log"
  exit 1
}

TOKEN=$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$ADMIN_API_KEY\"}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).token||"")}catch{console.log("")}})')
[[ -n "$TOKEN" ]] || { echo "login failed"; exit 1; }
echo "==> logged in"

dump_mem() {
  local tag="$1"
  {
    echo "### $tag  t=$(date +%s)"
    grep -E 'VmRSS|VmSize|RssAnon|RssFile|RssShmem|Threads' "/proc/$SERVER_PID/status" 2>/dev/null
    cat "/proc/$SERVER_PID/smaps_rollup" 2>/dev/null | head -25
    echo
  } >>"$OUT/smaps.txt"
}

echo "==> idle baseline ${IDLE_BEFORE}s"
sleep "$IDLE_BEFORE"
dump_mem "idleBefore"

echo "==> load ${LOAD_DURATION}s concurrency=$CONCURRENCY adminRps=$ADMIN_RPS scenario=$SCENARIO"
node "$HERE/loadgen.mjs" --base "http://127.0.0.1:$PORT" --token "$TOKEN" \
  --duration "$LOAD_DURATION" --concurrency "$CONCURRENCY" --admin-rps "$ADMIN_RPS" \
  --think-ms "$THINK_MS" --scenario "$SCENARIO" | tee "$OUT/loadgen.txt"

echo "==> cooldown ${IDLE_AFTER}s"
sleep "$IDLE_AFTER"
dump_mem "idleAfter"

echo "==> summarize"
node "$HERE/summarize.mjs" "$OUT/probe.jsonl" "$IDLE_BEFORE" "$LOAD_DURATION" "$IDLE_AFTER" \
  | tee "$OUT/summary.json"
