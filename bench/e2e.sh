#!/usr/bin/env bash
# 端到端功能验证：三协议透传（流式/非流式）、用量落库、模型并集、失败路径、管理 API。
# 用法：bash bench/e2e.sh
# 默认被测服务端 = Hono bundle（npm run build 产出的 build/server.js，需要同目录下的 out/ 静态导出）；
# E2E_SERVER_CMD="<cmd>" bash bench/e2e.sh 可换掉被测服务端（cwd=仓库根）
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
source "$HERE/lib/env.sh"
bench_init_secrets
export ALLOW_PRIVATE_UPSTREAMS=true
export NODE_ENV=production
PORT=3009
MOCK_PORT=18080   # 必须与 seed 时写入 upstreams.base_url 的端口一致
export MOCK_BASE_URL="http://127.0.0.1:$MOCK_PORT"

# 临时目录：让 node 自己给一个 OS 原生、正斜杠的路径。
# 不能用固定 `/tmp/e2e-*`：MSYS（Git Bash）的 `/tmp` 在 Windows 下 node 解析不了，
# `require("/tmp/x.json")` 直接 MODULE_NOT_FOUND，连带管理 API 断言集体 FAIL。
# mkdtemp 顺带避开了固定文件名可被预置符号链接的问题。
TMP="$(node -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path");process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(),"tt-e2e-")).replace(/\\/g,"/"))')"

# e2e 自包含：每次用自己的小库重建。
# 不能复用 bench/data/bench.db —— 凭据轮换（GATEWAY_SECRET 变化）后那里的
# virtual_keys 解不开，会整轮 401。
E2E_DB_DIR="$HERE/e2e-data"
E2E_DB="$E2E_DB_DIR/e2e.db"
# 守卫必须在 rm / init-db / seed 之前：那三个动作会删库、建表、跑迁移，
# 落到真实库（或经符号链接指到真实库）时先执行就是事故
bench_guard_db "$E2E_DB"
mkdir -p "$E2E_DB_DIR"
rm -f "$E2E_DB" "$E2E_DB-wal" "$E2E_DB-shm"
npx tsx "$HERE/init-db.ts" "$E2E_DB" >/dev/null
node "$HERE/seed.mjs" "$E2E_DB" 3 200 >/dev/null
export SQLITE_DATABASE_PATH="$E2E_DB"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad() { FAIL=$((FAIL + 1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1 ($2)"; else bad "$1 (got $2, want $3)"; fi; }

VK="$BENCH_VK"
bench_guard_db "$SQLITE_DATABASE_PATH"
BASE="http://127.0.0.1:$PORT"

cleanup() {
  [[ -n "${SPID:-}" ]] && kill "$SPID" 2>/dev/null
  [[ -n "${MPID:-}" ]] && kill "$MPID" 2>/dev/null
  wait 2>/dev/null
  [[ -n "${TMP:-}" ]] && rm -rf "$TMP"
}
trap cleanup EXIT

node "$HERE/mock-upstream.mjs" "$MOCK_PORT" >"$TMP/mock.log" 2>&1 &
MPID=$!
if [[ -n "${E2E_SERVER_CMD:-}" ]]; then
  # 可选：用别的服务端替掉默认的 Hono bundle，
  # 断言集不变，用来验证「换运行时后 SSE 透传/落库/错误路径仍然一致」
  ( cd "$ROOT" && PORT=$PORT HOSTNAME=127.0.0.1 exec $E2E_SERVER_CMD >"$TMP/server.log" 2>&1 ) &
  SPID=$!
else
  # exec：让 SPID 直接指向 node 进程，cleanup 的 kill 才能真正收掉服务端（子 shell 会被绕过）
  ( cd "$ROOT" && PORT=$PORT HOSTNAME=127.0.0.1 exec node build/server.js >"$TMP/server.log" 2>&1 ) &
  SPID=$!
fi

for i in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/session" || true)
  [[ "$code" == "401" ]] && break
  sleep 1
done
[[ "$code" == "401" ]] || { echo "server not ready ($code)"; tail -20 "$TMP/server.log"; exit 1; }

TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d "{\"apiKey\":\"$ADMIN_API_KEY\"}" |
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).token||"")}catch{console.log("")}})')
[[ -n "$TOKEN" ]] || { echo "login failed"; exit 1; }

count_rows() {
  curl -s -H "X-API-Key: $TOKEN" "$BASE/api/records?page=1&limit=1" |
    node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.pagination?.total ?? 0)})'
}

echo "== 1. OpenAI 非流式 =="
before=$(count_rows)
body=$(curl -s -w '\n%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $VK" -H 'content-type: application/json' \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"hi e2e"}]}')
code=$(echo "$body" | tail -1)
json=$(echo "$body" | sed '$d')
check "status" "$code" "200"
echo "$json" | grep -q '"usage"' && ok "response carries usage" || bad "response missing usage"
echo "$json" | grep -q '"id"' && ok "response is a JSON body" || bad "response body broken"
after=$(count_rows)
check "record written" "$after" "$((before + 1))"

echo "== 2. OpenAI 流式 =="
before=$(count_rows)
stream=$(curl -s -N -w '\n%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $VK" -H 'content-type: application/json' \
  -d '{"model":"gpt-5","stream":true,"messages":[{"role":"user","content":"hi stream"}]}')
code=$(echo "$stream" | tail -1)
check "status" "$code" "200"
echo "$stream" | grep -q 'data: \[DONE\]' && ok "SSE terminated with [DONE]" || bad "SSE not terminated"
after=$(count_rows)
check "streamed record written" "$after" "$((before + 1))"

echo "== 3. Anthropic 非流式 =="
before=$(count_rows)
body=$(curl -s -w '\n%{http_code}' -X POST "$BASE/v1/messages" \
  -H "x-api-key: $VK" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-4-5-20250929","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}')
check "status" "$(echo "$body" | tail -1)" "200"
echo "$body" | grep -q '"type":"message"' && ok "anthropic body shape" || bad "anthropic body shape"
check "record written" "$(count_rows)" "$((before + 1))"

echo "== 4. Anthropic 流式 =="
before=$(count_rows)
stream=$(curl -s -N -w '\n%{http_code}' -X POST "$BASE/v1/messages" \
  -H "x-api-key: $VK" -H 'content-type: application/json' \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}')
check "status" "$(echo "$stream" | tail -1)" "200"
echo "$stream" | grep -q 'message_stop' && ok "anthropic SSE terminated" || bad "anthropic SSE not terminated"
check "streamed record written" "$(count_rows)" "$((before + 1))"

echo "== 5. Gemini 非流式 =="
before=$(count_rows)
body=$(curl -s -w '\n%{http_code}' -X POST "$BASE/v1beta/models/gemini-2.5-pro:generateContent" \
  -H "x-goog-api-key: $VK" -H 'content-type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}')
check "status" "$(echo "$body" | tail -1)" "200"
echo "$body" | grep -q 'candidates' && ok "gemini body shape" || bad "gemini body shape"
check "record written" "$(count_rows)" "$((before + 1))"

echo "== 6. 鉴权与错误路径 =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' -d '{"model":"gpt-5","messages":[]}')
check "no virtual key -> 401" "$code" "401"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $VK" -H 'content-type: application/json' \
  -d '{"model":"no-such-model","messages":[]}')
check "unknown model -> 404" "$code" "404"

errbody=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $VK" -H 'content-type: application/json' \
  -d '{"model":"no-such-model","messages":[]}')
echo "$errbody" | grep -qi "mock-\|127.0.0.1" && bad "error leaks internal upstream detail" || ok "error does not leak upstream detail"

echo "== 7. 模型并集 =="
models=$(curl -s "$BASE/v1/models" -H "authorization: Bearer $VK")
echo "$models" | grep -q 'gpt-5' && ok "openai models listed" || bad "openai models missing"
echo "$models" | grep -q 'claude-sonnet-4-5-20250929' && ok "anthropic models listed" || bad "anthropic models missing"
echo "$models" | grep -q 'gemini-2.5-pro' && ok "gemini models listed" || bad "gemini models missing"

echo "== 8. 管理 API =="
for p in /api/dashboard /api/dashboard?range=30d /api/records /api/providers /api/models /api/agents /api/model-pricing /api/admin/upstreams; do
  code=$(curl -s -o "$TMP/resp.json" -w '%{http_code}' -H "X-API-Key: $TOKEN" "$BASE$p")
  if [[ "$code" == "200" ]] && node -e 'const j=require(process.argv[1]); if(j.success===false) process.exit(1)' "$TMP/resp.json" 2>/dev/null; then
    ok "$p"
  else
    bad "$p ($code)"
  fi
done

upid=$(curl -s -H "X-API-Key: $TOKEN" "$BASE/api/admin/upstreams" |
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.data?.[0]?.id ?? "")}catch{console.log("")}})')
if [[ -n "$upid" ]]; then
  code=$(curl -s -o "$TMP/dyn.json" -w '%{http_code}' -H "X-API-Key: $TOKEN" "$BASE/api/admin/upstreams/$upid")
  # 正向断言：params.id 拿不到值时 Number(undefined)=NaN → 也是 404，必须 200 才能证明 :id 映射生效
  check "dynamic [id] route 200" "$code" "200"
  node -e 'const j=require(process.argv[1]); process.exit(j.success===true?0:1)' "$TMP/dyn.json" 2>/dev/null \
    && ok "dynamic [id] payload" || bad "dynamic [id] payload"
else
  bad "dynamic [id] route (no upstream id from list)"
fi

echo "== 9. latency 聚合非空（Dashboard Speed 面板数据源）=="
curl -s -H "X-API-Key: $TOKEN" "$BASE/api/dashboard?range=3d" >"$TMP/dash.json"
node -e '
const j = require(process.argv[1]);
const d = j.data || {};
const lat = d.latency || {};
const byModel = lat.byModel || [];
const daily = lat.daily || [];
if (!Array.isArray(byModel) || byModel.length === 0) { console.log("  \033[31mFAIL\033[0m latency.byModel empty"); process.exit(1); }
if (!Array.isArray(daily) || daily.length === 0) { console.log("  \033[31mFAIL\033[0m latency.daily empty"); process.exit(1); }
const bad = byModel.find(s => s.count <= 0 || (s.streamCount > 0 && !Number.isFinite(s.p50TtftMs)));
if (bad) { console.log("  \033[31mFAIL\033[0m latency row invalid:", JSON.stringify(bad)); process.exit(1); }
console.log("  PASS latency.byModel=" + byModel.length + " latency.daily=" + daily.length);
' "$TMP/dash.json" && PASS=$((PASS + 1)) || FAIL=$((FAIL + 1))

echo "== 10. 上游失败路径（停掉 mock 后应 502 且不泄漏）=="
kill "$MPID" 2>/dev/null
sleep 1
code=$(curl -s -o "$TMP/err.txt" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer $VK" -H 'content-type: application/json' \
  -d '{"model":"gpt-5","messages":[]}')
check "upstream down -> 502" "$code" "502"
grep -qi "mock-\|127.0.0.1" "$TMP/err.txt" && bad "502 leaks upstream detail" || ok "502 does not leak upstream detail"

echo
echo "===== e2e: PASS=$PASS FAIL=$FAIL ====="
[[ "$FAIL" -eq 0 ]]
