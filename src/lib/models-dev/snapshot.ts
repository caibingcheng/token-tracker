import fs from "fs";
import path from "path";

// 快照管理：本地缓存 data/models-dev-cache.json，
// 懒刷新（7 天 TTL + 手动强制），拉取失败静默回退旧快照。
// 双数据源：models.dev / GitHub LiteLLM 各自动解析为统一 ModelsDevData，
// 下游（Simulation/Picker/match/stats/UI）零感知；单一当前快照语义（后完成者覆盖）。
export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MODELS_DEV_SOURCE_DEFAULT = "models.dev" as const;
export type ModelsDevSource = "models.dev" | "github";
export const LITELLM_MODEL_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const LITELLM_MODEL_PRICES_FALLBACK_URL =
  "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json";
export const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SNAPSHOT_FILE_NAME = "models-dev-cache.json";

export interface ModelsDevCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelsDevModel {
  id: string;
  name?: string;
  cost: ModelsDevCost;
  last_updated?: string;
  [key: string]: unknown;
}

export interface ModelsDevProvider {
  id: string;
  name?: string;
  models: Record<string, ModelsDevModel>;
  [key: string]: unknown;
}

export type ModelsDevData = Record<string, ModelsDevProvider>;

export interface ModelsDevSnapshot {
  fetchedAt: string;
  source: ModelsDevSource;
  data: ModelsDevData;
}

// 快照拉取失败分类（供 Refresh 端点区分网络 / 上游 HTTP / 结构非法）
export interface ModelsDevFetchError {
  kind: "network" | "http" | "invalid";
  status?: number;
}

export type ModelsDevFetchResult =
  | { ok: true; data: ModelsDevData }
  | { ok: false; error: ModelsDevFetchError };

export type ModelsDevRefreshResult =
  | { ok: true; snapshot: ModelsDevSnapshot }
  | { ok: false; error: ModelsDevFetchError };

// 快照路径：与 SQLite 同目录（data/），便于 Docker 卷挂载持久化
export function resolveSnapshotPath(dbPath?: string): string {
  const source = dbPath ?? process.env.SQLITE_DATABASE_PATH;
  const dir = source ? path.dirname(source) : "data";
  return path.join(dir, SNAPSHOT_FILE_NAME);
}

// 有限非负数值守卫：价格类字段统一兜底（防负数/NaN/Infinity 污染成本计算）
export function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

// ---- LiteLLM 模型价格文件解析（第二数据源）----
// 扁平结构 modelId -> { input_cost_per_token, output_cost_per_token,
// cache_read_input_token_cost, cache_creation_input_token_cost, litellm_provider, ... }
// 价格单位 per-token → 换算 USD/1M ×1e6；仅取标准 per-token 字段，
// batch / priority / reasoning 细分价统一不取（与 models.dev 单档语义对齐）。

// 检测：parsed 是普通对象，且至少一个条目值为对象并带非空字符串 litellm_provider 字段
export function looksLikeLitellmStructure(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const provider = (value as Record<string, unknown>).litellm_provider;
    if (typeof provider === "string" && provider.trim() !== "") return true;
  }
  return false;
}

// per-token → USD/1M；非有限非负数值忽略（返回 undefined）
function scalePriceToPerMillion(value: unknown): number | undefined {
  if (!isFiniteNonNegative(value)) return undefined;
  const scaled = value * 1_000_000;
  return isFiniteNonNegative(scaled) ? scaled : undefined;
}

// 转换 litellm 扁平结构为 models.dev 结构。规则：
// - 跳过 sample_spec、litellm_provider 空/非字符串的条目
// - 无任何 token 价的条目 → 保留、cost 省略（= models.dev「无价条目」语义）
// - 分组 data[litellm_provider].models[modelId]；空 provider 剔除、完全无模型 → {}
// - 不做 provider 名映射（同名冲突由匹配管线 PRIORITY_PROVIDERS 消解）
export function convertLitellmToModelsDev(flat: unknown): ModelsDevData {
  const data: ModelsDevData = {};
  if (flat === null || typeof flat !== "object" || Array.isArray(flat)) {
    return data;
  }
  for (const [modelKey, entry] of Object.entries(
    flat as Record<string, unknown>
  )) {
    if (
      modelKey === "sample_spec" ||
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const rawProvider = e.litellm_provider;
    const provider =
      typeof rawProvider === "string" ? rawProvider.trim() : "";
    if (!provider) continue;

    const cost: Record<string, number> = {};
    const input = scalePriceToPerMillion(e.input_cost_per_token);
    if (input !== undefined) cost.input = input;
    const output = scalePriceToPerMillion(e.output_cost_per_token);
    if (output !== undefined) cost.output = output;
    const cacheRead = scalePriceToPerMillion(e.cache_read_input_token_cost);
    if (cacheRead !== undefined) cost.cache_read = cacheRead;
    const cacheWrite = scalePriceToPerMillion(
      e.cache_creation_input_token_cost
    );
    if (cacheWrite !== undefined) cost.cache_write = cacheWrite;

    const providerEntry =
      data[provider] ?? { id: provider, name: provider, models: {} };
    const modelEntry = { id: modelKey } as ModelsDevModel;
    if (Object.keys(cost).length > 0) {
      modelEntry.cost = cost as unknown as ModelsDevCost;
    }
    providerEntry.models[modelKey] = modelEntry;
    data[provider] = providerEntry;
  }
  return data;
}

export function isValidModelsDevData(data: unknown): data is ModelsDevData {
  if (data === null || typeof data !== "object") return false;
  const providers = data as Record<string, unknown>;
  const entries = Object.entries(providers);
  if (entries.length === 0) return false;
  // 部分合法即可（api.json 可能包含异常 provider，容忍个别坏数据）
  let validCount = 0;
  for (const [, p] of entries) {
    if (
      p &&
      typeof p === "object" &&
      typeof (p as ModelsDevProvider).models === "object" &&
      (p as ModelsDevProvider).models !== null
    ) {
      validCount++;
    }
  }
  return validCount > 0;
}

// 旧快照文件缺 source 字段 → 回退默认 "models.dev"（零迁移）
function parseSnapshotSource(raw: unknown): ModelsDevSource {
  if (raw === "models.dev" || raw === "github") return raw;
  return MODELS_DEV_SOURCE_DEFAULT;
}

export function readSnapshotFile(filePath?: string): ModelsDevSnapshot | null {
  const p = filePath ?? resolveSnapshotPath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ModelsDevSnapshot>;
    if (
      typeof parsed.fetchedAt !== "string" ||
      !isValidModelsDevData(parsed.data)
    ) {
      return null;
    }
    return {
      fetchedAt: parsed.fetchedAt,
      source: parseSnapshotSource(parsed.source),
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

export function writeSnapshotFile(
  snapshot: ModelsDevSnapshot,
  filePath?: string
): void {
  const p = filePath ?? resolveSnapshotPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(snapshot), "utf-8");
  } catch (err) {
    console.warn(`[models.dev] Failed to write snapshot to ${p}:`, err);
  }
}

// 上传数据清洗（仅上传路径使用）：
// - 结构非法（model/cost 非对象）→ 丢弃
// - 数值非法（负数/NaN/Infinity/字符串价格）→ 丢弃
// - cost 缺失或为 null = 官方合法的"无价格"条目 → 保留（消费端 toCandidate/select
//   有 isFiniteNonNegative 兜底回退 0/null，成本计算不受影响）
// 返回全新对象，不改动入参；空 provider 移除。
export function sanitizeModelsDevData(
  data: ModelsDevData
): { data: ModelsDevData; dropped: number } {
  const out: ModelsDevData = {};
  let dropped = 0;
  for (const [providerId, provider] of Object.entries(data)) {
    const models: Record<string, ModelsDevModel> = {};
    for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
      if (model === null || typeof model !== "object" || Array.isArray(model)) {
        dropped++;
        continue;
      }
      const cost = model.cost;
      if (
        cost != null &&
        (typeof cost !== "object" ||
          (cost.input != null && !isFiniteNonNegative(cost.input)) ||
          (cost.output != null && !isFiniteNonNegative(cost.output)) ||
          (cost.cache_read != null && !isFiniteNonNegative(cost.cache_read)) ||
          (cost.cache_write != null && !isFiniteNonNegative(cost.cache_write)))
      ) {
        dropped++;
        continue;
      }
      models[modelId] = model;
    }
    if (Object.keys(models).length > 0) {
      out[providerId] = { ...provider, models };
    }
  }
  return { data: out, dropped };
}

// 手动上传快照（admin API）：构造 {fetchedAt: now, source, data} 写入内存缓存 + 落盘，
// 立即生效无需重启；同时清空 in-flight 刷新（进行中的 fetch 不可取消，
// 其完成后可能覆盖上传结果 —— 极小概率竞态，接受）。
export function uploadSnapshot(
  data: ModelsDevData,
  opts: { filePath?: string; now?: Date; source?: ModelsDevSource } = {}
): ModelsDevSnapshot {
  const snapshot: ModelsDevSnapshot = {
    fetchedAt: (opts.now ?? new Date()).toISOString(),
    source: opts.source ?? MODELS_DEV_SOURCE_DEFAULT,
    data,
  };
  parsedCache = snapshot;
  inflightRefresh = null;
  writeSnapshotFile(snapshot, opts.filePath);
  return snapshot;
}

async function fetchModelsDevApi(
  fetchImpl: typeof fetch
): Promise<ModelsDevFetchResult> {
  try {
    const res = await fetchImpl(MODELS_DEV_API_URL, {
      headers: { "accept-encoding": "identity" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[models.dev] Fetch failed with status ${res.status}`);
      return { ok: false, error: { kind: "http", status: res.status } };
    }
    const data: unknown = await res.json();
    if (!isValidModelsDevData(data)) {
      console.warn("[models.dev] Fetch returned invalid data shape");
      return { ok: false, error: { kind: "invalid" } };
    }
    return { ok: true, data };
  } catch (err) {
    console.warn("[models.dev] Fetch error:", err);
    return { ok: false, error: { kind: "network" } };
  }
}

// github 源：依次尝试 raw.githubusercontent → jsDelivr CDN 回退；
// 每个 URL 网络错误 / 非 2xx / 转换后结构非法都换下一个；
// 全部失败返回最后一个错误分类。
async function fetchLitellmPrices(
  fetchImpl: typeof fetch
): Promise<ModelsDevFetchResult> {
  const urls = [LITELLM_MODEL_PRICES_URL, LITELLM_MODEL_PRICES_FALLBACK_URL];
  let lastError: ModelsDevFetchError = { kind: "network" };
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, {
        headers: { "accept-encoding": "identity" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        console.warn(
          `[models.dev] Litellm fetch failed with status ${res.status} (${url})`
        );
        lastError = { kind: "http", status: res.status };
        continue;
      }
      const parsed: unknown = await res.json();
      const data = convertLitellmToModelsDev(parsed);
      if (isValidModelsDevData(data)) {
        return { ok: true, data };
      }
      console.warn(`[models.dev] Litellm fetch returned invalid data shape (${url})`);
      lastError = { kind: "invalid" };
    } catch (err) {
      console.warn(`[models.dev] Litellm fetch error (${url}):`, err);
      lastError = { kind: "network" };
    }
  }
  return { ok: false, error: lastError };
}

export async function fetchModelsDevData(
  fetchImpl: typeof fetch = fetch,
  source: ModelsDevSource = MODELS_DEV_SOURCE_DEFAULT
): Promise<ModelsDevFetchResult> {
  if (source === "github") return fetchLitellmPrices(fetchImpl);
  return fetchModelsDevApi(fetchImpl);
}

interface RefreshOpts {
  filePath?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  source?: ModelsDevSource;
}

interface InflightRefresh {
  source: ModelsDevSource;
  promise: Promise<ModelsDevRefreshResult>;
}

let parsedCache: ModelsDevSnapshot | null = null;
let inflightRefresh: InflightRefresh | null = null;

// 发起/复用当前 source 的刷新（in-flight 竞态修复）：
// - 同源 in-flight → 复用同一 promise（避免重复拉取）
// - 异源 in-flight → 等待其 settle 后串行再发起（保证写盘顺序 = 发起顺序，
//   后完成者覆盖，无乱序覆盖）
async function runRefresh(opts: RefreshOpts): Promise<ModelsDevRefreshResult> {
  const source = opts.source ?? MODELS_DEV_SOURCE_DEFAULT;
  while (true) {
    if (inflightRefresh) {
      if (inflightRefresh.source === source) {
        return inflightRefresh.promise;
      }
      await inflightRefresh.promise.catch(() => {});
      continue;
    }
    const entry: InflightRefresh = { source, promise: doRefresh(opts) };
    entry.promise
      .finally(() => {
        if (inflightRefresh === entry) inflightRefresh = null;
      })
      .catch(() => {});
    inflightRefresh = entry;
    return entry.promise;
  }
}

// 读取快照（内存缓存解析结果，避免重复 parse 3.6MB）。
// 懒刷新：fetchedAt 超过 7 天 → 后台异步拉新（不阻塞当前请求），本次仍返回旧快照。
// force=true 时同步拉取并落盘。source 只影响刷新行为（缓存为单一当前快照，先到先享）。
export async function getSnapshot(
  opts: RefreshOpts & { force?: boolean } = {}
): Promise<ModelsDevSnapshot | null> {
  if (parsedCache) {
    const age = Date.now() - new Date(parsedCache.fetchedAt).getTime();
    const stale = age > SNAPSHOT_TTL_MS;
    if (opts.force || stale) {
      // 后台刷新（fire-and-forget，不阻塞本次返回）
      runRefresh(opts).catch(() => {});
    }
    if (!opts.force) return parsedCache;
    return await snapshotFromRefresh(await runRefresh(opts));
  }

  const disk = readSnapshotFile(opts.filePath);
  if (disk) {
    parsedCache = disk;
    const age = Date.now() - new Date(disk.fetchedAt).getTime();
    if (opts.force || age > SNAPSHOT_TTL_MS) {
      runRefresh(opts).catch(() => {});
    }
    if (!opts.force) return disk;
    return await snapshotFromRefresh(await runRefresh(opts));
  }

  // 无本地快照：同步拉取（首次使用，无旧快照可回退）
  return await snapshotFromRefresh(await runRefresh(opts));
}

async function snapshotFromRefresh(
  p: Promise<ModelsDevRefreshResult> | ModelsDevRefreshResult | null
): Promise<ModelsDevSnapshot | null> {
  if (!p) return null;
  const r = await p;
  return r.ok ? r.snapshot : null;
}

// 强制刷新快照（admin API 手动触发）。返回区分失败原因的结果，
// 下游 UI 可呈现网络 / 上游 HTTP / 结构非法等具体错误。
export async function refreshSnapshot(
  opts: RefreshOpts = {}
): Promise<ModelsDevRefreshResult> {
  return await runRefresh(opts);
}

async function doRefresh(opts: RefreshOpts): Promise<ModelsDevRefreshResult> {
  const source = opts.source ?? MODELS_DEV_SOURCE_DEFAULT;
  const fetched = await fetchModelsDevData(opts.fetchImpl, source);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const snapshot: ModelsDevSnapshot = {
    fetchedAt: (opts.now ?? new Date()).toISOString(),
    source,
    data: fetched.data,
  };
  parsedCache = snapshot;
  writeSnapshotFile(snapshot, opts.filePath);
  return { ok: true, snapshot };
}

// 测试辅助：清空内存缓存（含 in-flight）
export function resetSnapshotCache(): void {
  parsedCache = null;
  inflightRefresh = null;
}
