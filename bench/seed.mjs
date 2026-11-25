/**
 * 基准测试数据种子（独立于 scripts/seed-demo-data.ts，不进生产路径）。
 *
 * 用法：
 *   node bench/seed.mjs <dbPath> <days> <recordsPerDay>
 *
 * 直接写 SQLite（不经应用代码），造出「日均 N 条、跨 D 天」的真实分布：
 * 8 模型 / 3 provider / 4 客户端 / 7 种 status / 22% 命名路由虚拟名。
 * 同时建 3 个指向本地 mock 的 upstream + 1 个虚拟 key（AES-256-GCM 加密）。
 */
import Database from "better-sqlite3";
import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import path from "node:path";
import { guardBenchPath, benchSecret, benchVirtualKey } from "./lib/guard.mjs";

const DAYS = Number(process.argv[3] || 30);
const PER_DAY = Number(process.argv[4] || 10000);
if (!process.argv[2]) {
  console.error("usage: node bench/seed.mjs <dbPath> <days> <recordsPerDay>");
  process.exit(1);
}
// 只允许写 bench/ 目录内的临时库（会删表重建）
let dbPath;
let GATEWAY_SECRET;
try {
  dbPath = guardBenchPath(process.argv[2], "database");
  GATEWAY_SECRET = benchSecret();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

const MOCK_BASE_URL = process.env.MOCK_BASE_URL || "http://127.0.0.1:18080";
// 由 bench/lib/env.sh 自动生成并复用（首次运行随机，存 bench/.state/，已 gitignore）
let BENCH_VK;
try {
  BENCH_VK = benchVirtualKey();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

// ---- crypto：与 src/lib/gateway/crypto.ts 同格式 iv:tag:ciphertext(base64) ----
const KEY = /^[0-9a-fA-F]{64}$/.test(GATEWAY_SECRET)
  ? Buffer.from(GATEWAY_SECRET, "hex")
  : (() => {
      const b = Buffer.from(GATEWAY_SECRET, "base64");
      return b.length === 32 ? b : createHash("sha256").update(GATEWAY_SECRET).digest();
    })();

function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

// ---- 确定性 PRNG ----
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20240117);
const int = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const MODELS = [
  { model: "claude-sonnet-4-5-20250929", provider: "anthropic", weight: 26, prompt: [8000, 120000], output: [150, 3600], cacheProb: 0.9, cacheShare: [0.55, 0.92], cacheWrite: true, ttft: [0.08, 0.25] },
  { model: "claude-haiku-4-5-20251001", provider: "anthropic", weight: 12, prompt: [2000, 40000], output: [60, 1200], cacheProb: 0.85, cacheShare: [0.45, 0.9], cacheWrite: true, ttft: [0.06, 0.2] },
  { model: "claude-opus-4-1-20250805", provider: "anthropic", weight: 5, prompt: [15000, 180000], output: [200, 5000], cacheProb: 0.92, cacheShare: [0.6, 0.95], cacheWrite: true, ttft: [0.1, 0.3] },
  { model: "gpt-5", provider: "openai", weight: 18, prompt: [6000, 150000], output: [120, 4200], cacheProb: 0.7, cacheShare: [0.25, 0.7], cacheWrite: false, ttft: [0.1, 0.35] },
  { model: "gpt-5-mini", provider: "openai", weight: 14, prompt: [1500, 50000], output: [50, 1500], cacheProb: 0.6, cacheShare: [0.2, 0.6], cacheWrite: false, ttft: [0.08, 0.28] },
  { model: "o3", provider: "openai", weight: 5, prompt: [4000, 80000], output: [300, 6000], cacheProb: 0.55, cacheShare: [0.15, 0.5], cacheWrite: false, ttft: [0.2, 0.5] },
  { model: "gemini-2.5-pro", provider: "google", weight: 10, prompt: [5000, 100000], output: [100, 3000], cacheProb: 0.5, cacheShare: [0.15, 0.55], cacheWrite: false, ttft: [0.1, 0.3] },
  { model: "gemini-2.5-flash", provider: "google", weight: 10, prompt: [1000, 30000], output: [40, 900], cacheProb: 0.45, cacheShare: [0.1, 0.5], cacheWrite: false, ttft: [0.05, 0.2] },
];
const AGENTS = [
  { key: "claude-code", ua: "claude-cli/1.0.72 (external, cli)", weight: 45 },
  { key: "opencode", ua: "opencode/0.6.3", weight: 30 },
  { key: "codex", ua: "codex_cli_rs/0.42.0", weight: 20 },
  { key: "cursor", ua: "cursor-agent/0.1.9", weight: 5 },
];
const VIRTUAL_NAMES = ["auto-frontend", "auto-backend", "auto-fast"];

function weighted(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rand() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}
const hex = (len) => {
  let out = "";
  while (out.length < len) out += int(0, 15).toString(16);
  return out.slice(0, len);
};

function buildRow(at, vkId) {
  const classifier = rand() < 0.015;
  const profile = classifier ? MODELS.find((m) => m.model === "gemini-2.5-flash") : weighted(MODELS);
  const agentEntry = weighted(AGENTS);
  const userAgent = rand() < 0.04 ? null : agentEntry.ua;
  const requestModel = !classifier && rand() < 0.22 ? pick(VIRTUAL_NAMES) : profile.model;

  let status = null;
  const roll = rand();
  if (roll < 0.045) status = "no_usage";
  else if (roll < 0.075) status = "client_aborted";
  else if (roll < 0.087) status = "stream_interrupted";
  else if (classifier) status = "classifier";

  const promptTokens = classifier ? int(300, 1800) : int(profile.prompt[0], profile.prompt[1]);
  const cacheRead =
    !classifier && rand() < profile.cacheProb
      ? Math.round(promptTokens * (profile.cacheShare[0] + rand() * (profile.cacheShare[1] - profile.cacheShare[0])))
      : 0;
  const inputTokens = promptTokens - cacheRead;
  const outputTokens = classifier
    ? int(8, 60)
    : Math.round(int(profile.output[0], profile.output[1]) * (status ? 0.6 : 1));
  const cacheWrite = profile.cacheWrite && cacheRead > 0 && rand() < 0.6 ? int(200, 6000) : 0;
  const latency = classifier
    ? int(250, 1600)
    : Math.round(int(900, 4200) + (inputTokens + outputTokens) / int(20, 60) + (profile.model === "o3" ? int(2000, 9000) : 0));
  const streaming = !classifier && rand() < 0.85;
  const ttft = streaming
    ? Math.max(120, Math.round(latency * (profile.ttft[0] + rand() * (profile.ttft[1] - profile.ttft[0]))))
    : null;

  return {
    model: profile.model,
    provider: profile.provider,
    agent: agentEntry.key,
    input_tokens: status === "no_usage" ? 0 : inputTokens,
    output_tokens: status === "no_usage" ? 0 : outputTokens,
    cache_read: status === "no_usage" ? 0 : cacheRead,
    cache_write: status === "no_usage" ? 0 : cacheWrite,
    status,
    latency_ms: latency,
    ttft_ms: status === "no_usage" ? null : ttft,
    virtual_key_id: vkId,
    user_agent: userAgent,
    session_id: rand() < 0.78 ? hex(64) : null,
    request_model: requestModel,
    remote_instance_uid: null,
    created_at: at.toISOString(),
  };
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

const existing = db.prepare("SELECT COUNT(*) AS c FROM token_records").get().c;
if (existing > 0) {
  console.error(`token_records already has ${existing} rows, aborting`);
  db.close();
  process.exit(1);
}

// ---- 路由配置 ----
const t = (Date.now());
const nowIso = new Date(t).toISOString();
db.prepare("DELETE FROM upstreams").run();
db.prepare("DELETE FROM upstream_keys").run();
db.prepare("DELETE FROM virtual_keys").run();

const upstreamRows = [
  { name: "mock-openai", protocol: "openai", models: ["gpt-5", "gpt-5-mini", "o3"] },
  { name: "mock-anthropic", protocol: "anthropic", models: ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001", "claude-opus-4-1-20250805"] },
  { name: "mock-gemini", protocol: "gemini", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
];
const insUpstream = db.prepare(`
  INSERT INTO upstreams (name, protocol, base_url, enabled_models, priority, enabled, health_check_model, balance_fetch_mode, created_at)
  VALUES (@name, @protocol, @baseUrl, @models, @priority, 1, @healthCheckModel, 'none', @createdAt)
`);
const insKey = db.prepare(
  "INSERT INTO upstream_keys (upstream_id, api_key_encrypted, enabled, created_at) VALUES (?, ?, 1, ?)"
);
for (let i = 0; i < upstreamRows.length; i++) {
  const u = upstreamRows[i];
  const res = insUpstream.run({
    name: u.name,
    protocol: u.protocol,
    baseUrl: MOCK_BASE_URL,
    models: JSON.stringify(u.models),
    priority: i,
    healthCheckModel: u.models[0],
    createdAt: nowIso,
  });
  insKey.run(res.lastInsertRowid, encryptSecret(`sk-mock-${u.protocol}`), nowIso);
}

const vkRes = db
  .prepare("INSERT INTO virtual_keys (name, api_key_encrypted, enabled, enabled_models, created_at) VALUES (?, ?, 1, '[\"*\"]', ?)")
  .run("bench", encryptSecret(BENCH_VK), nowIso);
const vkId = Number(vkRes.lastInsertRowid);

// 模型价格（让 dashboard 的成本计算真的跑起来）
const PRICES = [
  ["claude-sonnet-4-5-20250929", 3, 15, 0.3, 3.75],
  ["claude-haiku-4-5-20251001", 1, 5, 0.1, 1.25],
  ["claude-opus-4-1-20250805", 15, 75, 1.5, 18.75],
  ["gpt-5", 1.25, 10, 0.125, null],
  ["gpt-5-mini", 0.25, 2, 0.025, null],
  ["o3", 2, 8, 0.5, null],
  ["gemini-2.5-pro", 1.25, 10, 0.31, null],
  ["gemini-2.5-flash", 0.3, 2.5, 0.075, null],
];
db.prepare("DELETE FROM model_prices").run();
const insPrice = db.prepare(
  `INSERT INTO model_prices (model, input_price, output_price, cache_read_price, cache_write_price, source, models_dev_id, updated_at)
   VALUES (?, ?, ?, ?, ?, 'manual', NULL, ?)`
);
for (const [m, i, o, cr, cw] of PRICES) insPrice.run(m, i, o, cr, cw, nowIso);

// ---- token_records ----
const insRecord = db.prepare(`
  INSERT INTO token_records (model, provider, agent, input_tokens, output_tokens, cache_read, cache_write,
    status, latency_ms, ttft_ms, virtual_key_id, user_agent, session_id, request_model, remote_instance_uid, created_at)
  VALUES (@model, @provider, @agent, @input_tokens, @output_tokens, @cache_read, @cache_write,
    @status, @latency_ms, @ttft_ms, @virtual_key_id, @user_agent, @session_id, @request_model, @remote_instance_uid, @created_at)
`);

const today = new Date();
today.setHours(0, 0, 0, 0);
const startedAt = Date.now();
db.prepare("DELETE FROM token_records").run();

const insertAll = db.transaction(() => {
  for (let d = DAYS - 1; d >= 0; d--) {
    const dayStart = new Date(today.getTime() - d * 86400000);
    const isToday = d === 0;
    const count = PER_DAY;
    for (let i = 0; i < count; i++) {
      // 日内分布：工作时段（9-23 点）权重 75%
      let at;
      if (rand() < 0.75) {
        const hour = isToday ? Math.min(23, Math.floor((Date.now() - dayStart.getTime()) / 3600000)) : int(9, 23);
        at = new Date(dayStart.getTime() + hour * 3600000 + int(0, 3599999));
      } else {
        at = new Date(dayStart.getTime() + int(0, 8) * 3600000 + int(0, 3599999));
      }
      if (at.getTime() > Date.now()) at = new Date(Date.now() - int(0, 3600000));
      insRecord.run(buildRow(at, vkId));
    }
  }
});
insertAll();

const totals = db
  .prepare("SELECT COUNT(*) AS c, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read) AS cr, MIN(created_at) AS minAt, MAX(created_at) AS maxAt FROM token_records")
  .get();
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

const sz = (await import("node:fs")).statSync(dbPath).size;
console.log(
  JSON.stringify(
    {
      db: path.resolve(dbPath),
      dbSizeMB: +(sz / 1048576).toFixed(1),
      rows: totals.c,
      days: DAYS,
      perDay: PER_DAY,
      input: totals.i,
      output: totals.o,
      cacheRead: totals.cr,
      from: totals.minAt,
      to: totals.maxAt,
      vkId,
      // 只回显前缀：完整值在 bench/.state/virtual-key，避免明文进日志
      vkPrefix: BENCH_VK.slice(0, 12) + "…",
      seedSeconds: +((Date.now() - startedAt) / 1000).toFixed(1),
    },
    null,
    2
  )
);
