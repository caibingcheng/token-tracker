import { joinUrlPath } from "./url-utils";
import { getOutboundDispatcher } from "./proxy-dispatcher";
import { outboundFetch } from "./outbound-fetch";
import {
  detectBalanceProvider,
  isBalanceFetchMode,
  normalizeBalanceFetchMode,
  BALANCE_FETCH_MODES,
  type BalanceProvider,
  type BalanceFetchMode,
} from "./balance-detect";

export {
  detectBalanceProvider,
  isBalanceFetchMode,
  normalizeBalanceFetchMode,
  BALANCE_FETCH_MODES,
  type BalanceProvider,
  type BalanceFetchMode,
};

export interface BalanceResult {
  balance: string;
  currency: string;
}

// 解析实际生效的 provider：auto → URL/name 探测；none → 不获取（null）
export function resolveBalanceMode(
  baseUrl: string,
  mode: BalanceFetchMode,
  name?: string
): BalanceProvider | null {
  if (mode === "none") return null;
  if (mode === "auto") return detectBalanceProvider(baseUrl, name);
  return mode;
}

// 是否启用余额自动获取：auto 无识别规则 = off
export function balanceAutoFetchOf(
  mode: BalanceFetchMode,
  baseUrl: string,
  name?: string
): boolean {
  return resolveBalanceMode(baseUrl, mode, name) !== null;
}

function clampPct(used: number, limit: number): number {
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

interface BalanceWindow {
  label: string;
  percent: number;
  // 窗口重置时间（epoch ms），存在则摘要里附剩余时长
  resetAt?: number;
}

// 距重置剩余时长：<1m / 42m / 5h / 3d
function formatResetIn(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// usage 类 provider 的多窗口摘要：["5h 23% (2h)", "wk 61%"] → "5h 23% (2h) · wk 61%"
function summarizeWindows(lanes: BalanceWindow[]): string {
  const now = Date.now();
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const lane of lanes) {
    if (seen.has(lane.label)) continue;
    seen.add(lane.label);
    const reset =
      lane.resetAt !== undefined && Number.isFinite(lane.resetAt)
        ? ` (${formatResetIn(lane.resetAt - now)})`
        : "";
    parts.push(`${lane.label} ${lane.percent}%${reset}`);
  }
  return parts.join(" · ");
}

// 拉取余额/用量；mode 缺省 auto。不支持的 provider 抛错由调用方处理。
export async function fetchBalance(
  baseUrl: string,
  apiKey: string,
  proxyUrl?: string | null,
  mode: BalanceFetchMode = "auto"
): Promise<BalanceResult> {
  const provider = resolveBalanceMode(baseUrl, mode);
  if (!provider) {
    throw new Error("Balance auto-fetch not supported for this upstream");
  }
  const dispatcher = getOutboundDispatcher(proxyUrl);

  switch (provider) {
    case "deepseek":
      return fetchDeepseekBalance(baseUrl, apiKey, dispatcher);
    case "openrouter":
      return fetchOpenrouterBalance(apiKey, dispatcher);
    case "kimi":
      return fetchKimiBalance(baseUrl, apiKey, dispatcher);
    case "kimi-coding":
      return fetchKimiCodingUsage(apiKey, dispatcher);
    case "glm":
      return fetchGlmQuota(baseUrl, apiKey, dispatcher);
    case "opencode-go":
      return fetchOpencodeGoUsage(apiKey, dispatcher);
    case "ollama-cloud":
      return fetchOllamaCloudBalance(apiKey, dispatcher);
  }
}

async function fetchDeepseekBalance(
  baseUrl: string,
  apiKey: string,
  dispatcher: ReturnType<typeof getOutboundDispatcher>
): Promise<BalanceResult> {
  const res = await outboundFetch(joinUrlPath(baseUrl, "/user/balance"), {
    headers: { Authorization: `Bearer ${apiKey}` },
    // 手动模式：3xx 视为失败，防 key 经跨源重定向泄露
    redirect: "manual",
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) {
    throw new Error(`DeepSeek balance API returned ${res.status}`);
  }
  const json = (await res.json()) as { balance_infos?: Array<{ total_balance?: string | number; currency?: string }> };
  const infos = json.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) {
    throw new Error("Unexpected DeepSeek balance response");
  }
  const total = infos.reduce((acc, b) => acc + (Number(b.total_balance) || 0), 0);
  return { balance: String(total), currency: infos[0]?.currency || "CNY" };
}

async function fetchOpenrouterBalance(
  apiKey: string,
  dispatcher: ReturnType<typeof getOutboundDispatcher>
): Promise<BalanceResult> {
  const res = await outboundFetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
    // 手动模式：3xx 视为失败，防 key 经跨源重定向泄露
    redirect: "manual",
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter auth/key API returned ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: { usage?: string | number; limit?: string | number | null };
  };
  const data = json.data;
  if (!data) {
    throw new Error("Unexpected OpenRouter auth/key response");
  }
  const usage = Number(data.usage) || 0;
  const limit = data.limit;
  const remaining =
    typeof limit === "number" && !Number.isNaN(limit)
      ? Math.max(0, limit - usage)
      : "unknown";
  return { balance: String(remaining), currency: "USD" };
}

// Kimi 开放平台按量余额：GET <baseUrl>/v1/users/me/balance（CNY）
async function fetchKimiBalance(
  baseUrl: string,
  apiKey: string,
  dispatcher: ReturnType<typeof getOutboundDispatcher>
): Promise<BalanceResult> {
  const res = await outboundFetch(joinUrlPath(baseUrl, "/v1/users/me/balance"), {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: "manual",
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) {
    throw new Error(`Kimi balance API returned ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: { available_balance?: number };
  };
  const available = json.data?.available_balance;
  if (typeof available !== "number" || Number.isNaN(available)) {
    throw new Error("Unexpected Kimi balance response");
  }
  return { balance: String(available), currency: "CNY" };
}

interface KimiCodeWindow {
  duration?: number;
  timeUnit?: string;
}

interface KimiCodeUsage {
  limit?: string | number;
  used?: string | number;
  remaining?: string | number;
  resetTime?: string;
}

interface KimiCodeUsageResponse {
  usage?: KimiCodeUsage | null;
  limits?: Array<{ window?: KimiCodeWindow | null; detail?: KimiCodeUsage | null }> | null;
  boosterWallet?: {
    balance?: { type?: string; amount?: string | number; amountLeft?: string | number } | null;
  } | null;
}

function toResetAt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function kimiCodeWindowLabel(window?: KimiCodeWindow | null): string {
  if (!window?.duration) return "limit";
  const duration = window.duration;
  const unit = window.timeUnit?.toUpperCase() ?? "";
  if (unit === "TIME_UNIT_MINUTE") {
    if (duration >= 60 && duration % 60 === 0) return `${duration / 60}h`;
    return `${duration}m`;
  }
  if (unit === "TIME_UNIT_HOUR") return duration === 168 ? "wk" : `${duration}h`;
  // 7 天窗口与 usage 的周窗口是同一语义，统一标为 wk 以便去重
  if (unit === "TIME_UNIT_DAY") return duration === 7 ? "wk" : `${duration}d`;
  if (unit === "TIME_UNIT_MONTH") return `${duration}mo`;
  return `${duration}${unit.replace("TIME_UNIT_", "").toLowerCase()}`;
}

// detail.used 缺失时用 limit - remaining 推算；两者都缺则该窗口不可计算
function kimiCodePercent(detail: KimiCodeUsage): number | null {
  const limit = Number(detail.limit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  let used = Number(detail.used);
  if (!Number.isFinite(used)) {
    const remaining = Number(detail.remaining);
    if (!Number.isFinite(remaining)) return null;
    used = limit - remaining;
  }
  return clampPct(used, limit);
}

// Kimi for Coding 套餐用量：固定 endpoint（key 与开放平台独立）；返回多窗口百分比摘要
async function fetchKimiCodingUsage(
  apiKey: string,
  dispatcher: ReturnType<typeof getOutboundDispatcher>
): Promise<BalanceResult> {
  const res = await outboundFetch("https://api.kimi.com/coding/v1/usages", {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: "manual",
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) {
    throw new Error(`Kimi Coding usage API returned ${res.status}`);
  }
  const json = (await res.json()) as KimiCodeUsageResponse;
  const lanes: BalanceWindow[] = [];
  for (const item of json.limits ?? []) {
    if (!item.detail) continue;
    const percent = kimiCodePercent(item.detail);
    if (percent !== null)
      lanes.push({ label: kimiCodeWindowLabel(item.window), percent, resetAt: toResetAt(item.detail.resetTime) });
  }
  if (json.usage) {
    const percent = kimiCodePercent(json.usage);
    if (percent !== null)
      lanes.push({ label: "wk", percent, resetAt: toResetAt(json.usage.resetTime) });
  }
  const summary = summarizeWindows(lanes);
  if (!summary) {
    throw new Error("Unexpected Kimi Coding usage response");
  }
  // 加油包余额：amountLeft 为 1_000_000 定点小数（= 1 分），折美元追加到摘要
  const booster = json.boosterWallet?.balance;
  if (booster?.type === "BOOSTER") {
    const amount = Number(booster.amount);
    const amountLeft = Number(booster.amountLeft);
    if (Number.isFinite(amount) && amount > 0 && Number.isFinite(amountLeft)) {
      const dollars = Math.max(0, Math.round(amountLeft / 1_000_000) / 100);
      return { balance: `${summary} (Extra $${dollars.toFixed(2)})`, currency: "" };
    }
  }
  return { balance: summary, currency: "" };
}

interface GlmLimit {
  type?: string;
  unit?: number;
  usage?: number;
  currentValue?: number;
  percentage?: number;
  // 窗口重置时间（epoch ms）
  nextResetTime?: number;
}

interface GlmQuotaResponse {
  code?: number;
  success?: boolean;
  msg?: string;
  data?: { limits?: GlmLimit[]; level?: string };
}

// GLM Coding Plan 额度：Authorization 裸 key（无 Bearer），dashboard XHR 逆向接口。
// 仅 Coding Plan key 可用；按量付费 key 无余额接口。
async function fetchGlmQuota(
  baseUrl: string,
  apiKey: string,
  dispatcher: ReturnType<typeof getOutboundDispatcher>
): Promise<BalanceResult> {
  const host = baseUrl.toLowerCase().includes("bigmodel.cn")
    ? "https://open.bigmodel.cn"
    : "https://api.z.ai";
  const res = await outboundFetch(`${host}/api/monitor/usage/quota/limit`, {
    headers: { accept: "application/json", Authorization: apiKey },
    redirect: "manual",
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) {
    throw new Error(`GLM quota API returned ${res.status}`);
  }
  const json = (await res.json()) as GlmQuotaResponse;
  if (json.success === false || (json.code != null && json.code !== 200)) {
    throw new Error(json.msg || `GLM quota API returned code ${json.code}`);
  }
  const limits = json.data?.limits;
  if (!Array.isArray(limits)) {
    throw new Error("Unexpected GLM quota response");
  }
  // unit 3 = 5 小时窗口，unit 6 = 周窗口；TIME_LIMIT = 月度（MCP）额度
  const lanes: BalanceWindow[] = [];
  for (const l of limits) {
    let percent = l.percentage;
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      if (typeof l.usage === "number" && l.usage > 0 && typeof l.currentValue === "number") {
        percent = (l.currentValue / l.usage) * 100;
      } else {
        continue;
      }
    }
    percent = Math.min(100, Math.max(0, Math.round(percent)));
    const resetAt =
      typeof l.nextResetTime === "number" && Number.isFinite(l.nextResetTime)
        ? l.nextResetTime
        : undefined;
    if (l.type === "TOKENS_LIMIT" && l.unit === 3)
      lanes.push({ label: "5h", percent, resetAt });
    else if (l.type === "TOKENS_LIMIT" && l.unit === 6)
      lanes.push({ label: "wk", percent, resetAt });
    else if (l.type === "TIME_LIMIT") lanes.push({ label: "mo", percent, resetAt });
  }
  const summary = summarizeWindows(lanes);
  if (!summary) {
    throw new Error("Unexpected GLM quota response");
  }
  const level = json.data?.level;
  return { balance: level ? `${summary} · ${level}` : summary, currency: "" };
}

interface OpencodeGoUsageEntry {
  percent?: number;
  resetsAt?: string;
}

interface OpencodeGoUsageResponse {
  usage?: {
    rolling?: OpencodeGoUsageEntry;
    weekly?: OpencodeGoUsageEntry;
    monthly?: OpencodeGoUsageEntry;
  };
}

interface OllamaCloudLimit {
  remaining_percent?: number;
  resets_at?: string;
}

interface OllamaCloudBalanceResponse {
  included?: {
    // 新套餐：period 内的剩余额度 / 总额度
    balance_usd?: number;
    allowance_usd?: number;
    period?: { from?: string; until?: string };
    // 旧套餐：session / weekly 剩余百分比
    session?: OllamaCloudLimit;
    weekly?: OllamaCloudLimit;
  };
  purchased?: { balance_usd?: number };
}

// Ollama Cloud 余额：固定 endpoint https://ollama.com/api/balance（Bearer）。
// 摘要里自带 $ 单位（chip 只渲染 balance 字符串，不显示 currency）。
async function fetchOllamaCloudBalance(
  apiKey: string,
  dispatcher: ReturnType<typeof getOutboundDispatcher>
): Promise<BalanceResult> {
  const res = await outboundFetch("https://ollama.com/api/balance", {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: "manual",
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) {
    throw new Error(`Ollama Cloud balance API returned ${res.status}`);
  }
  const json = (await res.json()) as OllamaCloudBalanceResponse;
  const included = json.included ?? {};
  // 只认真正的有限 number：Number(null) === 0 会把缺失字段误显示成 $0.00，
  // 而 JSON 里的 1e400 会解析成 Infinity
  const finiteOf = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  // 购买额度只算未过期的余额，单独作后缀
  const purchased = finiteOf(json.purchased?.balance_usd) ?? 0;
  const extra = purchased > 0 ? ` + $${purchased.toFixed(2)}` : "";

  // 旧套餐：session(5h) / weekly 窗口的剩余百分比 → 已用百分比
  const lanes: BalanceWindow[] = [];
  const pushLimit = (label: string, limit?: OllamaCloudLimit) => {
    const remaining = finiteOf(limit?.remaining_percent);
    if (remaining === null) return;
    lanes.push({
      label,
      percent: clampPct(100 - remaining, 100),
      resetAt: toResetAt(limit?.resets_at),
    });
  };
  pushLimit("5h", included.session);
  pushLimit("wk", included.weekly);
  const summary = summarizeWindows(lanes);
  if (summary) return { balance: `${summary}${extra}`, currency: "" };

  const balanceUsd = finiteOf(included.balance_usd);
  if (balanceUsd === null) {
    throw new Error("Unexpected Ollama Cloud balance response");
  }
  const allowanceUsd = finiteOf(included.allowance_usd);
  const head =
    allowanceUsd !== null && allowanceUsd > 0
      ? `$${balanceUsd.toFixed(2)}/$${allowanceUsd.toFixed(2)}`
      : `$${balanceUsd.toFixed(2)}`;
  const resetAt = toResetAt(included.period?.until);
  const reset =
    resetAt !== undefined ? ` (${formatResetIn(resetAt - Date.now())})` : "";
  return { balance: `${head}${extra}${reset}`, currency: "" };
}

// OpenCode Go 用量：rolling(5h) / weekly / monthly 百分比窗口
async function fetchOpencodeGoUsage(
  apiKey: string,
  dispatcher: ReturnType<typeof getOutboundDispatcher>
): Promise<BalanceResult> {
  const res = await outboundFetch("https://opencode.ai/zen/go/v1/usage", {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: "manual",
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) {
    throw new Error(`OpenCode Go usage API returned ${res.status}`);
  }
  const json = (await res.json()) as OpencodeGoUsageResponse;
  const lanes: BalanceWindow[] = [];
  const push = (label: string, entry?: OpencodeGoUsageEntry) => {
    if (typeof entry?.percent === "number" && Number.isFinite(entry.percent)) {
      const resetAt = entry.resetsAt ? Date.parse(entry.resetsAt) : undefined;
      lanes.push({
        label,
        percent: Math.min(100, Math.max(0, Math.round(entry.percent))),
        resetAt: resetAt !== undefined && !Number.isNaN(resetAt) ? resetAt : undefined,
      });
    }
  };
  push("5h", json.usage?.rolling);
  push("wk", json.usage?.weekly);
  push("mo", json.usage?.monthly);
  const summary = summarizeWindows(lanes);
  if (!summary) {
    throw new Error("Could not parse OpenCode Go usage data");
  }
  return { balance: summary, currency: "" };
}
