import { LRUCache } from "lru-cache";
import {
  executeStatsQuery,
  type StatsQueryResult,
  type TotalStatItem,
  type StatItemWithGroupAndModel,
} from "@/lib/stats-query";
import type {
  StatusPageConfig,
  StatusPageElementsConfig,
} from "@/lib/auth/settings";
import { aggregateByNormalizedModel, TOP_N_DISPLAY, TOP_N_RAW_MODELS, type StatItem } from "@/lib/model-utils";
import { getDisplayName, type ModelAliasRule } from "@/lib/model-registry";
import { toNum } from "@/lib/number-utils";
import {
  mergeAggregatedCosts,
  type AggregatedCost,
} from "@/lib/cost-utils";
import { localDateKeyFromUtcDate } from "@/lib/timezone-utils";
import {
  loadHiddenProviderGroups,
  type HiddenProviderGroup,
} from "@/lib/provider-utils";
import { loadModelAliases } from "@/lib/auth/settings";

// /status/data 公开端点的查询与响应裁剪逻辑（不依赖 Next.js 运行时，可单测）。
// 数据面最小化原则：仅执行启用元素所需的查询，响应不含未启用元素的数据。

const STATUS_DAILY_RANGE = "30d";

export interface StatusElements extends StatusPageElementsConfig {}

// 元素联动：hourly（24h 分布）依赖 daily 趋势数据，hourly 开启时强制 daily 视为开启
export function resolveStatusElements(cfg: StatusPageElementsConfig): StatusElements {
  return { ...cfg, daily: cfg.daily || cfg.hourly };
}

// ---- 响应级缓存：60s TTL，key = tzOffset（公开端点对所有访客返回相同数据）----
// 整包缓存无法感知写库，故 TTL 取 60s（公开页可接受滞后）；config 变更走主动失效

const STATUS_CACHE_TTL_MS = 60_000;
const STATUS_CACHE_MAX = 50;

const statusResponseCache = new LRUCache<string, StatusData>({
  max: STATUS_CACHE_MAX,
  ttl: STATUS_CACHE_TTL_MS,
  allowStale: false,
});

export function invalidateStatusCache(): void {
  statusResponseCache.clear();
}

export function getStatusCacheKey(timezoneOffsetMinutes: number): string {
  return String(timezoneOffsetMinutes);
}

// ---- 固定窗口限流（与 setup/login 同款内存滑动窗口模式，独立 bucket）----

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 60;
const statusAttempts = new Map<string, number[]>();
let sweepCounter = 0;

export function checkStatusRateLimit(key: string): boolean {
  const now = Date.now();
  sweepCounter++;
  if (sweepCounter % 64 === 0) {
    statusAttempts.forEach((ts, k) => {
      if (ts.length === 0 || now - ts[ts.length - 1]! >= RATE_WINDOW_MS) {
        statusAttempts.delete(k);
      }
    });
  }
  const timestamps = (statusAttempts.get(key) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS
  );
  if (timestamps.length >= RATE_MAX_REQUESTS) {
    statusAttempts.set(key, timestamps);
    return true;
  }
  timestamps.push(now);
  statusAttempts.set(key, timestamps);
  return false;
}

export function getCachedStatusData(key: string): StatusData | undefined {
  return statusResponseCache.get(key);
}

export function setCachedStatusData(key: string, data: StatusData): void {
  statusResponseCache.set(key, data);
}

// ---- 类型（与 Dashboard 前端组件兼容）----

export interface DayData {
  group: string;
  totalInput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalOutput: number;
  totalCacheWrite: number;
  count: number;
  totalCost: number;
  costPerMillionTokens: number;
  costPerMillionInput: number;
  costPerMillionCacheRead: number;
  costPerMillionCacheWrite: number;
  costPerMillionOutput: number;
}

export interface ModelStat extends StatItem {
  canonicalId: string;
  displayName: string;
  totalCost: number;
  costPerMillionTokens: number;
  costPerMillionInput: number;
  costPerMillionCacheRead: number;
  costPerMillionCacheWrite: number;
  costPerMillionOutput: number;
}

export interface StatusTotalStat {
  group: string;
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalCacheWrite: number;
  count: number;
  firstActiveAt?: string;
  lastActiveAt?: string;
  totalCost: number;
  costPerMillionTokens: number;
  costPerMillionInput: number;
  costPerMillionCacheRead: number;
  costPerMillionCacheWrite: number;
  costPerMillionOutput: number;
}

export interface StatusData {
  elements: StatusElements;
  total: StatusTotalStat | null;
  totalDays: number;
  today: DayData | null;
  yesterday: DayData | null;
  daily: DayData[];
  heatmap: DayData[];
  hourly: DayData[];
  topModels: ModelStat[];
  totalTopModels: ModelStat[];
  todayModels: ModelStat[];
  dailyModels: Record<string, ModelStat[]>;
  timezoneOffsetMinutes: number;
}

// ---- 查询组装（复用 executeStatsQuery，口径与 Dashboard 一致）----

function isTotalStatItems(data: StatsQueryResult): data is TotalStatItem[] {
  return Array.isArray(data) && (data.length === 0 || "lastActiveAt" in data[0]);
}

function isStatItemsWithGroup(
  data: StatsQueryResult
): data is Array<StatItem & { group: string }> {
  return Array.isArray(data) && data.length > 0 && "group" in data[0];
}

function isStatItemsWithModel(
  data: StatsQueryResult
): data is StatItemWithGroupAndModel[] {
  return Array.isArray(data) && data.length > 0 && "model" in data[0];
}

function toCost(item: StatItem): AggregatedCost | null {
  return item.cost ?? null;
}

function formatDateKey(date: Date, timezoneOffsetMinutes: number): string {
  return localDateKeyFromUtcDate(date, timezoneOffsetMinutes);
}

function getTotalDays(
  firstActiveAt: string | undefined,
  timezoneOffsetMinutes: number
): number {
  if (!firstActiveAt) return 0;
  const first = new Date(firstActiveAt);
  if (Number.isNaN(first.getTime())) return 0;
  const firstKey = formatDateKey(first, timezoneOffsetMinutes);
  const todayKey = formatDateKey(new Date(), timezoneOffsetMinutes);
  const start = new Date(`${firstKey}T00:00:00Z`).getTime();
  const end = new Date(`${todayKey}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  const diffDays = Math.floor((end - start) / (1000 * 60 * 60 * 24));
  return Math.max(1, diffDays + 1);
}

function aggregateCostByDate(
  rows: StatItemWithGroupAndModel[]
): Map<string, AggregatedCost> {
  const map = new Map<string, AggregatedCost[]>();

  for (const row of rows) {
    const date = String(row.group);
    const existing = map.get(date);
    if (existing) {
      existing.push(row.cost ?? emptyCost());
    } else {
      map.set(date, [row.cost ?? emptyCost()]);
    }
  }

  const result = new Map<string, AggregatedCost>();
  map.forEach((costs, date) => {
    result.set(date, mergeAggregatedCosts(costs));
  });

  return result;
}

function emptyCost(): AggregatedCost {
  return {
    totalCost: 0,
    effectiveTokens: 0,
    costPerMillionTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    inputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    outputCost: 0,
    costPerMillionInput: 0,
    costPerMillionCacheRead: 0,
    costPerMillionCacheWrite: 0,
    costPerMillionOutput: 0,
  };
}

function buildDayData(
  key: string,
  costMap: Map<string, AggregatedCost> | null,
  countMap: Map<string, number>
): DayData | null {
  if (!costMap) {
    return {
      group: key,
      totalInput: 0,
      totalInputCached: 0,
      totalInputUncached: 0,
      totalOutput: 0,
      totalCacheWrite: 0,
      count: countMap.get(key) ?? 0,
      totalCost: 0,
      costPerMillionTokens: 0,
      costPerMillionInput: 0,
      costPerMillionCacheRead: 0,
      costPerMillionCacheWrite: 0,
      costPerMillionOutput: 0,
    };
  }

  const aggregate = costMap.get(key);
  if (!aggregate) return null;

  return {
    group: key,
    totalInput: aggregate.inputTokens + aggregate.cacheReadTokens,
    totalInputCached: aggregate.cacheReadTokens,
    totalInputUncached: aggregate.inputTokens,
    totalOutput: aggregate.outputTokens,
    totalCacheWrite: aggregate.cacheWriteTokens,
    count: countMap.get(key) ?? 0,
    totalCost: aggregate.totalCost,
    costPerMillionTokens: aggregate.costPerMillionTokens,
    costPerMillionInput: aggregate.costPerMillionInput,
    costPerMillionCacheRead: aggregate.costPerMillionCacheRead,
    costPerMillionCacheWrite: aggregate.costPerMillionCacheWrite,
    costPerMillionOutput: aggregate.costPerMillionOutput,
  };
}

function buildModelStat(item: StatItem, aliases: ModelAliasRule[] = []): ModelStat {
  return {
    ...item,
    canonicalId: item.group,
    displayName: getDisplayName(item.group, aliases),
    totalCost: item.cost?.totalCost ?? 0,
    costPerMillionTokens: item.cost?.costPerMillionTokens ?? 0,
    costPerMillionInput: item.cost?.costPerMillionInput ?? 0,
    costPerMillionCacheRead: item.cost?.costPerMillionCacheRead ?? 0,
    costPerMillionCacheWrite: item.cost?.costPerMillionCacheWrite ?? 0,
    costPerMillionOutput: item.cost?.costPerMillionOutput ?? 0,
  };
}

// 按日期 → 该日 Top 模型（30d date-model 行归一化聚合）
function aggregateTopModelsByDate(
  rows: StatItemWithGroupAndModel[],
  groups: HiddenProviderGroup[],
  aliases: ModelAliasRule[] = []
): Map<string, ModelStat[]> {
  const byDate = new Map<string, StatItem[]>();

  for (const row of rows) {
    const date = String(row.group);
    if (!byDate.has(date)) {
      byDate.set(date, []);
    }
    byDate.get(date)!.push({
      group: String(row.model),
      provider: row.provider,
      totalInput: toNum(row.totalInput),
      totalOutput: toNum(row.totalOutput),
      totalInputCached: toNum(row.totalInputCached),
      totalInputUncached: toNum(row.totalInputUncached),
      totalCacheWrite: toNum(row.totalCacheWrite),
      count: toNum(row.count),
      cost: row.cost,
    });
  }

  const result = new Map<string, ModelStat[]>();
  byDate.forEach((items, date) => {
    result.set(
      date,
      aggregateByNormalizedModel(items, groups, aliases)
        .slice(0, TOP_N_RAW_MODELS)
        .map((item) => buildModelStat(item, aliases))
    );
  });

  return result;
}

export async function queryStatusData(
  config: StatusPageConfig,
  timezoneOffsetMinutes: number
): Promise<StatusData> {
  const elements = resolveStatusElements(config.elements);
  const groups = await loadHiddenProviderGroups();
  const aliases = await loadModelAliases();

  // 成本/模型数据需要 model 级查询（cost 或 topModels 开启时）
  const needsModelData = elements.cost || elements.topModels;
  const baseParams = {
    provider: "all" as const,
    providerFilter: null as string[] | null,
    model: "all" as const,
    modelFilter: null as string[] | null,
    agentFilter: null as string | null,
    timezoneOffsetMinutes,
  };

  const results = await Promise.all([
    elements.total
      ? executeStatsQuery({ groupBy: "none", range: "all", ...baseParams })
      : Promise.resolve(null),
    elements.total && needsModelData
      ? executeStatsQuery({ groupBy: "model", range: "all", ...baseParams, limit: null })
      : Promise.resolve(null),
    elements.today
      ? executeStatsQuery({ groupBy: "date", range: "2d", ...baseParams, granularity: "day" })
      : Promise.resolve(null),
    elements.today && needsModelData
      ? executeStatsQuery({ groupBy: "date-model", range: "2d", ...baseParams, granularity: "day" })
      : Promise.resolve(null),
    elements.daily || elements.hourly
      ? executeStatsQuery({ groupBy: "date", range: STATUS_DAILY_RANGE, ...baseParams, granularity: "day" })
      : Promise.resolve(null),
    elements.daily && needsModelData
      ? executeStatsQuery({ groupBy: "date-model", range: STATUS_DAILY_RANGE, ...baseParams, granularity: "day" })
      : Promise.resolve(null),
    elements.heatmap
      ? executeStatsQuery({ groupBy: "date", range: "365d", ...baseParams, granularity: "day" })
      : Promise.resolve(null),
    elements.hourly
      ? executeStatsQuery({ groupBy: "date", range: STATUS_DAILY_RANGE, ...baseParams, granularity: "hour" })
      : Promise.resolve(null),
    elements.topModels
      ? executeStatsQuery({ groupBy: "model", range: STATUS_DAILY_RANGE, ...baseParams, limit: null })
      : Promise.resolve(null),
  ]);

  const [
    totalResult,
    totalModelResult,
    date2dResult,
    dateModel2dResult,
    date30dResult,
    dateModel30dResult,
    heatmapResult,
    hourlyResult,
    models30dResult,
  ] = results;

  // Total 汇总
  const totalRaw = totalResult ?? [];
  const totalArr = isTotalStatItems(totalRaw) ? totalRaw : [];
  let total: StatusTotalStat | null = null;
  let totalDays = 0;
  if (elements.total && totalArr.length > 0) {
    const first = totalArr[0];
    totalDays = getTotalDays(first.firstActiveAt, timezoneOffsetMinutes);

    let totalCost = 0;
    let costPerMillionTokens = 0;
    let costPerMillionInput = 0;
    let costPerMillionCacheRead = 0;
    let costPerMillionCacheWrite = 0;
    let costPerMillionOutput = 0;

    if (needsModelData) {
      const totalModelRaw = totalModelResult ?? [];
      const totalModelsArr = isStatItemsWithGroup(totalModelRaw) ? totalModelRaw : [];
      const aggregate = mergeAggregatedCosts(totalModelsArr.map(toCost));
      totalCost = aggregate.totalCost;
      costPerMillionTokens = aggregate.costPerMillionTokens;
      costPerMillionInput = aggregate.costPerMillionInput;
      costPerMillionCacheRead = aggregate.costPerMillionCacheRead;
      costPerMillionCacheWrite = aggregate.costPerMillionCacheWrite;
      costPerMillionOutput = aggregate.costPerMillionOutput;
    }

    total = {
      ...first,
      totalCost,
      costPerMillionTokens,
      costPerMillionInput,
      costPerMillionCacheRead,
      costPerMillionCacheWrite,
      costPerMillionOutput,
    };
  }

  // Today / Yesterday
  const countMapAll = new Map<string, number>();
  const date2dRaw = date2dResult ?? [];
  const date2dArr = isStatItemsWithGroup(date2dRaw) ? date2dRaw : [];
  for (const row of date2dArr) {
    countMapAll.set(String(row.group), toNum(row.count));
  }

  const todayKey = formatDateKey(new Date(), timezoneOffsetMinutes);
  const yesterdayDate = new Date();
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterdayKey = formatDateKey(yesterdayDate, timezoneOffsetMinutes);

  const dateModel2dRaw = dateModel2dResult ?? [];
  const costMap2d = needsModelData
    ? aggregateCostByDate(isStatItemsWithModel(dateModel2dRaw) ? dateModel2dRaw : [])
    : null;

  let today: DayData | null = null;
  let yesterday: DayData | null = null;
  if (elements.today) {
    today = buildDayData(todayKey, costMap2d, countMapAll);
    yesterday = buildDayData(yesterdayKey, costMap2d, countMapAll);
  }

  // Daily（30d）
  let daily: DayData[] = [];
  const date30dRaw = date30dResult ?? [];
  const dateModel30dRaw = dateModel30dResult ?? [];
  if (elements.daily) {
    const date30dArr = isStatItemsWithGroup(date30dRaw) ? date30dRaw : [];
    const costMap30d = needsModelData
      ? aggregateCostByDate(isStatItemsWithModel(dateModel30dRaw) ? dateModel30dRaw : [])
      : null;

    daily = date30dArr.map((item) => {
      const aggregate = costMap30d?.get(String(item.group));
      if (!aggregate) {
        return {
          group: String(item.group),
          totalInput: toNum(item.totalInput),
          totalInputCached: toNum(item.totalInputCached),
          totalInputUncached: toNum(item.totalInputUncached),
          totalOutput: toNum(item.totalOutput),
          totalCacheWrite: toNum(item.totalCacheWrite),
          count: toNum(item.count),
          totalCost: 0,
          costPerMillionTokens: 0,
          costPerMillionInput: 0,
          costPerMillionCacheRead: 0,
          costPerMillionCacheWrite: 0,
          costPerMillionOutput: 0,
        };
      }
      return {
        group: String(item.group),
        totalInput: aggregate.inputTokens + aggregate.cacheReadTokens,
        totalInputCached: aggregate.cacheReadTokens,
        totalInputUncached: aggregate.inputTokens,
        totalOutput: aggregate.outputTokens,
        totalCacheWrite: aggregate.cacheWriteTokens,
        count: toNum(item.count),
        totalCost: aggregate.totalCost,
        costPerMillionTokens: aggregate.costPerMillionTokens,
        costPerMillionInput: aggregate.costPerMillionInput,
        costPerMillionCacheRead: aggregate.costPerMillionCacheRead,
        costPerMillionCacheWrite: aggregate.costPerMillionCacheWrite,
        costPerMillionOutput: aggregate.costPerMillionOutput,
      };
    });
  }

  // Heatmap（365d）
  let heatmap: DayData[] = [];
  const heatmapRaw = heatmapResult ?? [];
  if (elements.heatmap && isStatItemsWithGroup(heatmapRaw)) {
    heatmap = heatmapRaw.map((row) => ({
      group: String(row.group),
      totalInput: toNum(row.totalInput),
      totalInputCached: toNum(row.totalInputCached),
      totalInputUncached: toNum(row.totalInputUncached),
      totalOutput: toNum(row.totalOutput),
      totalCacheWrite: toNum(row.totalCacheWrite),
      count: toNum(row.count),
      totalCost: 0,
      costPerMillionTokens: 0,
      costPerMillionInput: 0,
      costPerMillionCacheRead: 0,
      costPerMillionCacheWrite: 0,
      costPerMillionOutput: 0,
    }));
  }

  // Hourly（30d 小时分布）
  let hourly: DayData[] = [];
  const hourlyRaw = hourlyResult ?? [];
  if (elements.hourly && isStatItemsWithGroup(hourlyRaw)) {
    hourly = hourlyRaw.map((row) => ({
      group: String(row.group),
      totalInput: toNum(row.totalInput),
      totalInputCached: toNum(row.totalInputCached),
      totalInputUncached: toNum(row.totalInputUncached),
      totalOutput: toNum(row.totalOutput),
      totalCacheWrite: toNum(row.totalCacheWrite),
      count: toNum(row.count),
      totalCost: 0,
      costPerMillionTokens: 0,
      costPerMillionInput: 0,
      costPerMillionCacheRead: 0,
      costPerMillionCacheWrite: 0,
      costPerMillionOutput: 0,
    }));
  }

  // Top Models（30d）+ All-time Top Models
  let topModels: ModelStat[] = [];
  let totalTopModels: ModelStat[] = [];
  if (elements.topModels) {
    const models30dRaw = models30dResult ?? [];
    const models30dArr = isStatItemsWithGroup(models30dRaw) ? models30dRaw : [];
    topModels = aggregateByNormalizedModel(
      models30dArr.map((row) => ({
        group: String(row.group),
        provider: row.provider,
        totalInput: toNum(row.totalInput),
        totalOutput: toNum(row.totalOutput),
        totalInputCached: toNum(row.totalInputCached),
        totalInputUncached: toNum(row.totalInputUncached),
        totalCacheWrite: toNum(row.totalCacheWrite),
        count: toNum(row.count),
        cost: row.cost,
      })),
      groups,
      aliases
    )
      .slice(0, TOP_N_DISPLAY)
      .map((item) => buildModelStat(item, aliases));

    const totalModelRaw = totalModelResult ?? [];
    const totalModelsArr = isStatItemsWithGroup(totalModelRaw) ? totalModelRaw : [];
    totalTopModels = aggregateByNormalizedModel(
      totalModelsArr.map((row) => ({
        group: String(row.group),
        provider: row.provider,
        totalInput: toNum(row.totalInput),
        totalOutput: toNum(row.totalOutput),
        totalInputCached: toNum(row.totalInputCached),
        totalInputUncached: toNum(row.totalInputUncached),
        totalCacheWrite: toNum(row.totalCacheWrite),
        count: toNum(row.count),
        cost: row.cost,
      })),
      groups,
      aliases
    )
      .slice(0, TOP_N_DISPLAY)
      .map((item) => buildModelStat(item, aliases));
  }

  // Today Top Models（复用 2d date-model 行，过滤今日键）
  let todayModels: ModelStat[] = [];
  if (elements.topModels && elements.today) {
    const dm2d = isStatItemsWithModel(dateModel2dRaw) ? dateModel2dRaw : [];
    todayModels = aggregateByNormalizedModel(
      dm2d
        .filter((row) => String(row.group) === todayKey)
        .map((row) => ({
          group: String(row.model),
          provider: row.provider,
          totalInput: toNum(row.totalInput),
          totalOutput: toNum(row.totalOutput),
          totalInputCached: toNum(row.totalInputCached),
          totalInputUncached: toNum(row.totalInputUncached),
          totalCacheWrite: toNum(row.totalCacheWrite),
          count: toNum(row.count),
          cost: row.cost,
        })),
      groups,
      aliases
    )
      .slice(0, TOP_N_DISPLAY)
      .map((item) => buildModelStat(item, aliases));
  }

  // 每日 Top 模型（30d，点击图表某天时展示该日模型；依赖 daily + topModels）
  let dailyModels: Record<string, ModelStat[]> = {};
  if (elements.daily && elements.topModels) {
    dailyModels = Object.fromEntries(
      aggregateTopModelsByDate(
        isStatItemsWithModel(dateModel30dRaw) ? dateModel30dRaw : [],
        groups,
        aliases
      )
    );
  }

  return {
    elements,
    total,
    totalDays,
    today,
    yesterday,
    daily,
    heatmap,
    hourly,
    topModels,
    totalTopModels,
    todayModels,
    dailyModels,
    timezoneOffsetMinutes,
  };
}
