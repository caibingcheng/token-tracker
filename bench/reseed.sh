#!/usr/bin/env bash
# 只重建 bench 的验证库（供 verify-latency / 手工对照用），不跑压测。
# 凭据由 lib/env.sh 自动生成；数据库路径被 guard 限制在 bench/ 内。
#
# 用法：bash bench/reseed.sh            # bench/data/bench.db, 30 天 x 10000 条
#       DB=bench/e2e-data/x.db DAYS=3 PER_DAY=200 bash bench/reseed.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib/env.sh"
bench_init_secrets

DB="${DB:-$HERE/data/bench.db}"
DAYS="${DAYS:-30}"
PER_DAY="${PER_DAY:-10000}"

bench_guard_db "$DB"
mkdir -p "$(dirname "$DB")"
rm -f "$DB" "$DB-wal" "$DB-shm"

npx tsx "$HERE/init-db.ts" "$DB" >/dev/null
node "$HERE/seed.mjs" "$DB" "$DAYS" "$PER_DAY"
