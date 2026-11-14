/**
 * 生成演示用 token_records / model_prices 数据（本地开发 / UI 调试）。
 *
 * 用法：
 *   npm run seed:demo -- --reset     # 清空 token_records + model_prices 后重新生成
 *   npx tsx scripts/seed-demo-data.ts --reset
 *
 * 不带 --reset 时，若 token_records 已有数据则直接退出（避免重复灌数据）。
 * 只写 token_records 与 model_prices，不碰 settings / upstreams / virtual_keys。
 */
import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH =
  process.env.SQLITE_DATABASE_PATH || path.join(".", "data", "token-tracker.db");
const DAYS = 90;
const RESET = process.argv.includes("--reset");

interface Price {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number | null;
}

// USD / 1M tokens，source = manual（不会被 auto-fill 覆盖）
const PRICES: Price[] = [
  { model: "claude-sonnet-4-5-20250929", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { model: "claude-haiku-4-5-20251001", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { model: "claude-opus-4-1-20250805", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { model: "gpt-5", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: null },
  { model: "gpt-5-mini", input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: null },
  { model: "o3", input: 2, output: 8, cacheRead: 0.5, cacheWrite: null },
  { model: "gemini-2.5-pro", input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: null },
  { model: "gemini-2.5-flash", input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: null },
];

interface ModelProfile {
  model: string;
  provider: string;
  weight: number;
  prompt: [number, number]; // 总 prompt（uncached input + cache_read）
  output: [number, number];
  cacheProb: number;
  cacheShare: [number, number]; // cache_read / 总 prompt，约等于命中率
  cacheWrite: boolean;
  ttftFrac: [number, number];
}

const MODELS: ModelProfile[] = [
  { model: "claude-sonnet-4-5-20250929", provider: "anthropic", weight: 26, prompt: [8000, 120000], output: [150, 3600], cacheProb: 0.9, cacheShare: [0.55, 0.92], cacheWrite: true, ttftFrac: [0.08, 0.25] },
  { model: "claude-haiku-4-5-20251001", provider: "anthropic", weight: 12, prompt: [2000, 40000], output: [60, 1200], cacheProb: 0.85, cacheShare: [0.45, 0.9], cacheWrite: true, ttftFrac: [0.06, 0.2] },
  { model: "claude-opus-4-1-20250805", provider: "anthropic", weight: 5, prompt: [15000, 180000], output: [200, 5000], cacheProb: 0.92, cacheShare: [0.6, 0.95], cacheWrite: true, ttftFrac: [0.1, 0.3] },
  { model: "gpt-5", provider: "openai", weight: 18, prompt: [6000, 150000], output: [120, 4200], cacheProb: 0.7, cacheShare: [0.25, 0.7], cacheWrite: false, ttftFrac: [0.1, 0.35] },
  { model: "gpt-5-mini", provider: "openai", weight: 14, prompt: [1500, 50000], output: [50, 1500], cacheProb: 0.6, cacheShare: [0.2, 0.6], cacheWrite: false, ttftFrac: [0.08, 0.28] },
  { model: "o3", provider: "openai", weight: 5, prompt: [4000, 80000], output: [300, 6000], cacheProb: 0.55, cacheShare: [0.15, 0.5], cacheWrite: false, ttftFrac: [0.2, 0.5] },
  { model: "gemini-2.5-pro", provider: "google", weight: 10, prompt: [5000, 100000], output: [100, 3000], cacheProb: 0.5, cacheShare: [0.15, 0.55], cacheWrite: false, ttftFrac: [0.1, 0.3] },
  { model: "gemini-2.5-flash", provider: "google", weight: 10, prompt: [1000, 30000], output: [40, 900], cacheProb: 0.45, cacheShare: [0.1, 0.5], cacheWrite: false, ttftFrac: [0.05, 0.2] },
];

const AGENTS = [
  { key: "claude-code", ua: "claude-cli/1.0.72 (external, cli)", weight: 45 },
  { key: "opencode", ua: "opencode/0.6.3", weight: 30 },
  { key: "codex", ua: "codex_cli_rs/0.42.0", weight: 20 },
  { key: "cursor", ua: "cursor-agent/0.1.9", weight: 5 },
];

// 命名路由虚拟名（request_model）
const VIRTUAL_NAMES = ["auto-frontend", "auto-backend", "auto-fast"];

// 确定性 PRNG，保证多次生成同一份数据
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20240117);

const int = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

function weightedPick<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rand() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function hex(len: number): string {
  let out = "";
  while (out.length < len) out += int(0, 15).toString(16);
  return out.slice(0, len);
}

interface Row {
  model: string;
  provider: string;
  agent: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  status: string | null;
  latency_ms: number;
  ttft_ms: number | null;
  virtual_key_id: null;
  user_agent: string | null;
  session_id: string | null;
  request_model: string;
  remote_instance_uid: null;
  created_at: string;
}

function buildRecord(at: Date): Row {
  const classifier = rand() < 0.015;
  const profile = classifier
    ? MODELS.find((m) => m.model === "gemini-2.5-flash")!
    : weightedPick(MODELS);
  const agentEntry = weightedPick(AGENTS);
  const userAgent = rand() < 0.04 ? null : agentEntry.ua;

  const requestModel =
    !classifier && rand() < 0.22 ? pick(VIRTUAL_NAMES) : profile.model;

  let status: string | null = null;
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
  // input_tokens 不含 cache_read（项目口径）
  const inputTokens = promptTokens - cacheRead;
  const outputTokens = classifier
    ? int(8, 60)
    : Math.round(int(profile.output[0], profile.output[1]) * (status ? 0.6 : 1));
  const cacheWrite =
    profile.cacheWrite && cacheRead > 0 && rand() < 0.6 ? int(200, 6000) : 0;

  const latency = classifier
    ? int(250, 1600)
    : Math.round(
        int(900, 4200) + (inputTokens + outputTokens) / int(20, 60) + (profile.model === "o3" ? int(2000, 9000) : 0)
      );
  const streaming = !classifier && rand() < 0.85;
  const ttft = streaming
    ? Math.max(120, Math.round(latency * (profile.ttftFrac[0] + rand() * (profile.ttftFrac[1] - profile.ttftFrac[0]))))
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
    virtual_key_id: null,
    user_agent: userAgent,
    session_id: rand() < 0.78 ? hex(64) : null,
    request_model: requestModel,
    remote_instance_uid: null,
    created_at: at.toISOString(),
  };
}

function dayRecords(dayStart: Date, isToday: boolean): Row[] {
  const weekday = dayStart.getDay();
  const weekendFactor = weekday === 0 || weekday === 6 ? 0.45 : 1;
  // 8% 的往日无流量，制造热力图空洞
  if (!isToday && rand() < 0.08) return [];
  const count = isToday
    ? int(16, 24)
    : Math.max(1, Math.round(int(8, 26) * weekendFactor));
  const now = new Date();
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    let at: Date;
    if (isToday) {
      // 均匀铺在 00:00 → 当前时刻（偏向近期），保证「今日」卡片任何时段都有数据
      const span = now.getTime() - dayStart.getTime();
      at = new Date(dayStart.getTime() + Math.floor(Math.pow(rand(), 0.6) * span));
    } else {
      // 工作时段（9-23 点）权重更高
      const hour = rand() < 0.75 ? int(9, 23) : int(0, 8);
      at = new Date(
        dayStart.getFullYear(),
        dayStart.getMonth(),
        dayStart.getDate(),
        hour,
        int(0, 59),
        int(0, 59)
      );
    }
    rows.push(buildRecord(at));
  }
  return rows;
}

function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const existing = (db.prepare("SELECT COUNT(*) AS c FROM token_records").get() as { c: number }).c;
  if (existing > 0 && !RESET) {
    console.error(
      `token_records 已有 ${existing} 行，拒绝重复灌数据。加 --reset 清空后重建。`
    );
    db.close();
    process.exit(1);
  }

  const rows: Row[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = DAYS - 1; i >= 0; i--) {
    const dayStart = new Date(today.getTime() - i * 86400000);
    rows.push(...dayRecords(dayStart, i === 0));
  }

  const insertRecord = db.prepare(`
    INSERT INTO token_records (
      model, provider, agent, input_tokens, output_tokens, cache_read, cache_write,
      status, latency_ms, ttft_ms, virtual_key_id, user_agent, session_id,
      request_model, remote_instance_uid, created_at
    ) VALUES (
      @model, @provider, @agent, @input_tokens, @output_tokens, @cache_read, @cache_write,
      @status, @latency_ms, @ttft_ms, @virtual_key_id, @user_agent, @session_id,
      @request_model, @remote_instance_uid, @created_at
    )
  `);
  const insertPrice = db.prepare(`
    INSERT INTO model_prices (
      model, input_price, output_price, cache_read_price, cache_write_price,
      source, models_dev_id, updated_at
    ) VALUES (
      @model, @input, @output, @cacheRead, @cacheWrite, 'manual', NULL, @updatedAt
    )
    ON CONFLICT(model) DO UPDATE SET
      input_price = excluded.input_price,
      output_price = excluded.output_price,
      cache_read_price = excluded.cache_read_price,
      cache_write_price = excluded.cache_write_price,
      source = 'manual',
      updated_at = excluded.updated_at
  `);

  const oldPrices = (db.prepare("SELECT COUNT(*) AS c FROM model_prices").get() as { c: number }).c;

  const insertAll = db.transaction(() => {
    db.prepare("DELETE FROM token_records").run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'token_records'").run();
    for (const row of rows) insertRecord.run(row);

    db.prepare("DELETE FROM model_prices").run();
    const now = new Date().toISOString();
    for (const price of PRICES) insertPrice.run({ ...price, updatedAt: now });
  });
  insertAll();

  const todayRows = rows.filter((r) => r.created_at >= today.toISOString()).length;
  const totals = db
    .prepare(
      "SELECT COUNT(*) AS c, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read) AS cr FROM token_records"
    )
    .get() as { c: number; i: number; o: number; cr: number };

  console.log(`DB: ${DB_PATH}`);
  console.log(`清除旧数据：token_records ${existing} 行、model_prices ${oldPrices} 行`);
  console.log(`写入：${totals.c} 条记录（今日 ${todayRows} 条），${DAYS} 天`);
  console.log(`Tokens：input ${totals.i} / output ${totals.o} / cache_read ${totals.cr}`);
  console.log(`模型：${MODELS.length} 个，价格行：${PRICES.length} 个`);
  db.close();
}

main();
