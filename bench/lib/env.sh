#!/usr/bin/env bash
# bench 公共环境：自动生成一次性凭据 + 强制数据库隔离。
#
# 凭据不写死在仓库里：首次运行时随机生成并保存到 bench/.state/（已 gitignore），
# 之后复用，保证「seed 写库 → 容器解密 → loadgen 发请求」三方拿到同一份值。
# 这些值只对本机 bench 实例有效，不具备任何外部访问能力。

BENCH_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$BENCH_HOME/.." && pwd)"
BENCH_STATE="$BENCH_HOME/.state"

_bench_abs() {
  realpath -m "$1" 2>/dev/null || echo "$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")"
}

_bench_rand_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
}

# 生成（或复用）三项 bench 凭据，导出为 GATEWAY_SECRET / ADMIN_API_KEY / BENCH_VK
bench_init_secrets() {
  mkdir -p "$BENCH_STATE"
  chmod 700 "$BENCH_STATE" 2>/dev/null || true

  local f
  f="$BENCH_STATE/gateway-secret"
  if [[ ! -s "$f" ]]; then
    _bench_rand_hex >"$f"
    chmod 600 "$f"
  fi
  GATEWAY_SECRET="$(cat "$f")"
  export GATEWAY_SECRET

  f="$BENCH_STATE/admin-key"
  if [[ ! -s "$f" ]]; then
    _bench_rand_hex >"$f"
    chmod 600 "$f"
  fi
  ADMIN_API_KEY="$(cat "$f")"
  export ADMIN_API_KEY

  f="$BENCH_STATE/virtual-key"
  if [[ ! -s "$f" ]]; then
    node -e 'process.stdout.write("vk-bench" + require("node:crypto").randomBytes(24).toString("base64url") + "\n")' >"$f"
    chmod 600 "$f"
  fi
  BENCH_VK="$(cat "$f")"
  export BENCH_VK
}

# 任何 bench 用的数据库都必须落在 bench/ 目录内，
# 杜绝误用（或误建/误迁移）仓库里真正在用的 data/token-tracker.db
bench_guard_db() {
  local p="$1"
  if [[ -z "$p" ]]; then
    echo "bench_guard_db: empty database path" >&2
    exit 1
  fi
  local abs root
  abs="$(_bench_abs "$p")"
  root="$(_bench_abs "$BENCH_HOME")"
  case "$abs" in
    "$root"/*) ;;
    *)
      echo "refusing to touch a database outside $root: $p" >&2
      echo "bench must only use its own scratch databases (bench/data, bench/docker-data)" >&2
      exit 1
      ;;
  esac
}
