/**
 * 网关 + 管理 API 混合压测。
 *
 * 用法：node bench/loadgen.mjs [options]
 *   --base        网关地址（默认 http://127.0.0.1:3001）
 *   --vk          虚拟 key
 *   --token       会话 token（admin API）
 *   --duration    秒（默认 300）
 *   --concurrency 网关并发（默认 8）
 *   --admin-rps   管理 API 每秒请求数（默认 4）
 *   --scenario    all | gateway | admin | idle
 *
 * 输出：延迟分位、RPS、错误明细
 */
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
}

const BASE = opt("base", "http://127.0.0.1:3001");
const VK = opt("vk", process.env.BENCH_VK || "");
const TOKEN = opt("token", "");
const DURATION = Number(opt("duration", 300));
const CONCURRENCY = Number(opt("concurrency", 8));
const ADMIN_RPS = Number(opt("admin-rps", 4));
// 每次网关请求后的思考时间（ms）：模拟真实客户端的低 QPS，而不是纯压满
const THINK_MS = Number(opt("think-ms", 0));
const SCENARIO = opt("scenario", "all");

const SESSIONS = Array.from({ length: 500 }, (_, i) => `bench-session-${i}`);
const SESSION_HEADERS = [
  "x-claude-code-session-id",
  "x-opencode-session",
  "session_id",
  "x-session-affinity",
];

const GATEWAY_REQUESTS = [
  // OpenAI
  { protocol: "openai", path: "/v1/chat/completions", model: "gpt-5", weight: 18 },
  { protocol: "openai", path: "/v1/chat/completions", model: "gpt-5-mini", weight: 14 },
  { protocol: "openai", path: "/v1/chat/completions", model: "o3", weight: 5 },
  // Anthropic
  { protocol: "anthropic", path: "/v1/messages", model: "claude-sonnet-4-5-20250929", weight: 26 },
  { protocol: "anthropic", path: "/v1/messages", model: "claude-haiku-4-5-20251001", weight: 12 },
  { protocol: "anthropic", path: "/v1/messages", model: "claude-opus-4-1-20250805", weight: 5 },
  // Gemini
  { protocol: "gemini", path: "/v1beta/models/gemini-2.5-pro:generateContent", model: "gemini-2.5-pro", weight: 10 },
  { protocol: "gemini", path: "/v1beta/models/gemini-2.5-flash:generateContent", model: "gemini-2.5-flash", weight: 10 },
];

const ADMIN_PATHS = [
  "/api/dashboard",
  "/api/dashboard",
  "/api/records?page=1&limit=50",
  "/api/records?page=2&limit=50&provider=anthropic",
  "/api/providers",
  "/api/models",
  "/api/agents",
  "/api/model-pricing",
  "/api/dashboard?range=30d",
  "/api/dashboard?range=3d",
  "/api/records?page=1&limit=200&model=claude-sonnet-4-5-20250929",
  "/api/admin/upstreams",
];

function weighted(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

const latencies = [];
const errors = new Map();
let okCount = 0;
let failCount = 0;
const stopAt = Date.now() + DURATION * 1000;

function record(ms, ok, err) {
  latencies.push(ms);
  if (ok) okCount++;
  else {
    failCount++;
    const k = err || "unknown";
    errors.set(k, (errors.get(k) || 0) + 1);
  }
}

async function gatewayOnce(idx) {
  const req = weighted(GATEWAY_REQUESTS);
  const streaming = Math.random() < 0.7;
  const session = SESSIONS[Math.floor(Math.random() * SESSIONS.length)];
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${VK}`,
  };
  headers[SESSION_HEADERS[idx % SESSION_HEADERS.length]] = session;

  let body;
  if (req.protocol === "gemini") {
    body = {
      contents: [{ role: "user", parts: [{ text: `bench request ${idx}` }] }],
      ...(streaming ? {} : {}),
    };
  } else if (req.protocol === "anthropic") {
    body = {
      model: req.model,
      max_tokens: 1024,
      stream: streaming,
      system: "You are a helpful assistant used for benchmarking.",
      messages: [{ role: "user", content: `bench request ${idx}` }],
    };
  } else {
    body = {
      model: req.model,
      stream: streaming,
      messages: [{ role: "user", content: `bench request ${idx}` }],
    };
  }

  const started = performance.now();
  const signal = AbortSignal.timeout(30_000);
  try {
    const res = await fetch(`${BASE}${req.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      record(performance.now() - started, false, `${res.status} ${text.slice(0, 80)}`);
      return;
    }
    if (streaming) {
      const reader = res.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } else {
      await res.arrayBuffer();
    }    record(performance.now() - started, true);
  } catch (e) {
    record(performance.now() - started, false, `net: ${e.name}`);
  }
}

async function adminOnce(i) {
  const p = ADMIN_PATHS[i % ADMIN_PATHS.length];
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}${p}`, {
      headers: TOKEN ? { "X-API-Key": TOKEN } : {},
      signal: AbortSignal.timeout(60_000),
    });
    await res.arrayBuffer();
    if (!res.ok) {
      record(performance.now() - started, false, `admin ${res.status} ${p}`);
      return;
    }
    record(performance.now() - started, true);
  } catch (e) {
    record(performance.now() - started, false, `admin net: ${e.name}`);
  }
}

async function gatewayLoop(idx) {
  let i = idx;
  while (Date.now() < stopAt) {
    await gatewayOnce(i++);
    if (THINK_MS > 0) await new Promise((r) => setTimeout(r, THINK_MS));
  }
}

async function adminLoop() {
  const intervalMs = 1000 / Math.max(0.1, ADMIN_RPS);
  let i = 0;
  while (Date.now() < stopAt) {
    await adminOnce(i++);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
}

async function main() {
  const startedAt = Date.now();
  const tasks = [];
  // 硬超时兜底：任何请求挂死（无响应 body）都不能让整轮压测无限等待
  const hardStop = setTimeout(() => {
    console.error("[loadgen] hard timeout, forcing exit");
    finish(startedAt);
  }, (DURATION + 60) * 1000);
  hardStop.unref?.();

  if (SCENARIO === "all" || SCENARIO === "gateway") {
    for (let i = 0; i < CONCURRENCY; i++) tasks.push(gatewayLoop(i));
  }
  if (SCENARIO === "all" || SCENARIO === "admin") {
    tasks.push(adminLoop());
  }
  if (SCENARIO === "idle") {
    // 空转：只验证无流量下的稳态内存
  }
  await Promise.all(tasks);
  clearTimeout(hardStop);
  finish(startedAt);
}

function finish(startedAt) {
  const elapsed = (Date.now() - startedAt) / 1000;
  const result = {
    scenario: SCENARIO,
    durationS: +elapsed.toFixed(1),
    total: okCount + failCount,
    ok: okCount,
    fail: failCount,
    rps: +(okCount / elapsed).toFixed(1),
    latency: {
      p50: pct(latencies, 50),
      p95: pct(latencies, 95),
      p99: pct(latencies, 99),
      max: +Math.max(0, ...latencies).toFixed(1),
    },
    errors: Object.fromEntries(
      [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    ),
  };
  console.log("BENCH_RESULT " + JSON.stringify(result));
  process.exit(0);
}

main().catch((e) => {
  console.error("loadgen failed:", e);
  process.exit(1);
});
