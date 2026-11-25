#!/usr/bin/env bash
# 逐接口内存归因：对一个已启动的网关实例逐个打 API，测量每个接口造成的
# RSS / RssAnon 增量（请求后静置 6s，让 V8 有机会回收）。
#
# 用法：bash bench/endpoint-probe.sh <base-url> <token> [pid]
set -uo pipefail
BASE="${1:?base url}"
TOKEN="${2:?session token}"
PID="${3:?server pid}"

mem() {
  awk '/^VmRSS|^RssAnon|^RssFile/ {printf "%s=%dMB ", $1, $2/1024}' "/proc/$PID/status"
}

PATHS=(
  "/api/dashboard"
  "/api/dashboard?range=30d"
  "/api/records?page=1&limit=50"
  "/api/records?page=1&limit=200&model=claude-sonnet-4-5-20250929"
  "/api/providers"
  "/api/models"
  "/api/agents"
  "/api/model-pricing"
  "/api/admin/upstreams"
  "/api/admin/model-prices"
)

echo "baseline: $(mem)"
for p in "${PATHS[@]}"; do
  before=$(awk '/^RssAnon/ {print $2}' "/proc/$PID/status")
  peak=0
  for i in 1 2 3; do
    curl -s -o /dev/null -H "X-API-Key: $TOKEN" "$BASE$p"
    cur=$(awk '/^RssAnon/ {print $2}' "/proc/$PID/status")
    [[ "$cur" -gt "$peak" ]] && peak=$cur
    sleep 1
  done
  sleep 5
  after=$(awk '/^RssAnon/ {print $2}' "/proc/$PID/status")
  printf "%-62s anon_before=%6.1fMB peak=+%6.1fMB after=+%6.1fMB  [%s]\n" \
    "$p" \
    "$(echo "$before/1024" | bc -l)" \
    "$(echo "($peak-$before)/1024" | bc -l)" \
    "$(echo "($after-$before)/1024" | bc -l)" \
    "$(mem)"
done
