import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { initDatabase } from "@/lib/db";
import {
  executeStatsQuery,
  type StatItemWithGroup,
  type TotalStatItem,
} from "@/lib/stats-query";
import { localDateKeyFromUtcDate } from "@/lib/timezone-utils";
import { toNum } from "@/lib/number-utils";

export const dynamic = "force-dynamic";

// 公开快照接口（无认证，见 docs/agents/api-routes.md）：用进程内快照做全局限流 ——
// TTL 内的同一时区请求直接返回同一份数据且不触达数据库。多实例各自持有一份，
// 允许实例间短暂不一致。数据不需要实时，60s 足够。
const SNAPSHOT_TTL_MS = 60_000;
// tzOffset 让缓存 key 有 1441 种可能，因此缓存条目设上限 + 每窗口设全局刷新预算，
// 防止匿名请求者用不同 tzOffset 放大聚合查询。
// 容量必须明显大于单窗口预算：否则上一窗口的快照会被本窗口的刷新全部挤出，
// TTL 缓存跨窗口失效（= 每个新窗口必重新读库），且 stale 回退永远不可达。
const MAX_SNAPSHOTS = 32;
const MAX_BUILDS_PER_WINDOW = 8;
const MAX_TZ_OFFSET = 720;

type UsageTotals = {
  totalInput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalCacheWrite: number;
  totalOutput: number;
  requests: number;
};

// summary 与 today 用同一组字段（today 额外带 date），保证两边可直接对比
type UsageBlock = UsageTotals & {
  // 0~1 比率
  cacheHitRate: number;
};

export type CliSnapshot = {
  generatedAt: string;
  summary: UsageBlock;
  today: UsageBlock & { date: string };
};

// key = tzOffsetMinutes（getTimezoneOffset 语义）；Map 插入顺序即 LRU 顺序，
// 新鲜命中与刷新都会重排，只有真正最久未使用的时区被淘汰
const snapshots = new Map<number, { at: number; body: CliSnapshot }>();
const inflight = new Map<number, Promise<CliSnapshot>>();
let windowStart = 0;
let windowBuilds = 0;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function usageTotals(row: StatItemWithGroup | TotalStatItem | undefined): UsageTotals {
  return {
    totalInput: toNum(row?.totalInput),
    totalInputCached: toNum(row?.totalInputCached),
    totalInputUncached: toNum(row?.totalInputUncached),
    totalCacheWrite: toNum(row?.totalCacheWrite),
    totalOutput: toNum(row?.totalOutput),
    requests: toNum(row?.count),
  };
}

function usageBlock(row: StatItemWithGroup | TotalStatItem | undefined): UsageBlock {
  const totals = usageTotals(row);
  return {
    ...totals,
    cacheHitRate:
      totals.totalInput > 0
        ? round(totals.totalInputCached / totals.totalInput, 4)
        : 0,
  };
}

function takeBuildBudget(): boolean {
  const now = Date.now();
  if (now - windowStart >= SNAPSHOT_TTL_MS) {
    windowStart = now;
    windowBuilds = 0;
  }
  if (windowBuilds >= MAX_BUILDS_PER_WINDOW) return false;
  windowBuilds += 1;
  return true;
}

async function buildSnapshot(tzOffsetMinutes: number): Promise<CliSnapshot> {
  await initDatabase();

  const [total, daily] = await Promise.all([
    executeStatsQuery({
      groupBy: "none",
      range: "all",
      provider: "all",
      agentUaFilter: null,
    }),
    // 与 /api/dashboard 的 today 同源：2d 窗口 + 同一个 tzOffset 日界分组
    executeStatsQuery({
      groupBy: "date",
      range: "2d",
      provider: "all",
      granularity: "day",
      agentUaFilter: null,
      timezoneOffsetMinutes: tzOffsetMinutes,
    }),
  ]);

  const dailyRows = daily as StatItemWithGroup[];
  const todayKey = localDateKeyFromUtcDate(new Date(), tzOffsetMinutes);

  return {
    generatedAt: new Date().toISOString(),
    summary: usageBlock((total as TotalStatItem[])[0]),
    today: {
      date: todayKey,
      ...usageBlock(dailyRows.find((row) => row.group === todayKey)),
    },
  };
}

function json(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
): NextResponse {
  return NextResponse.json(body, {
    status: init?.status ?? 200,
    headers: { "Cache-Control": "no-store", ...init?.headers },
  });
}

function touchSnapshot(
  tzOffsetMinutes: number,
  entry: { at: number; body: CliSnapshot }
): void {
  snapshots.delete(tzOffsetMinutes);
  snapshots.set(tzOffsetMinutes, entry);
}

// null = 刷新预算耗尽且该时区没有可回退的快照
async function getSnapshot(tzOffsetMinutes: number): Promise<CliSnapshot | null> {
  const cached = snapshots.get(tzOffsetMinutes);
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) {
    // 新鲜命中也要重排，保持真正的 LRU 语义
    touchSnapshot(tzOffsetMinutes, cached);
    return cached.body;
  }

  const pending = inflight.get(tzOffsetMinutes);
  if (pending) return pending;

  if (!takeBuildBudget()) return cached?.body ?? null;

  const task = buildSnapshot(tzOffsetMinutes)
    .then((body) => {
      touchSnapshot(tzOffsetMinutes, { at: Date.now(), body });
      while (snapshots.size > MAX_SNAPSHOTS) {
        const oldest = snapshots.keys().next().value;
        if (oldest === undefined) break;
        snapshots.delete(oldest);
      }
      return body;
    })
    .finally(() => {
      inflight.delete(tzOffsetMinutes);
    });

  inflight.set(tzOffsetMinutes, task);
  return task;
}

// 仅供测试：清空快照与刷新预算，强制下次请求重新读库
export function resetCliSnapshot(): void {
  snapshots.clear();
  inflight.clear();
  windowStart = 0;
  windowBuilds = 0;
}

export async function GET(request: NextRequest) {
  // 唯一接受的参数是 tzOffset（与 /api/dashboard 同语义）；provider/agent 等过滤参数
  // 一律忽略 —— 它们会构成名单枚举 oracle，见注释与文档
  const raw = new URL(request.url).searchParams.get("tzOffset");
  let tzOffsetMinutes = 0;
  if (raw !== null) {
    // 严格十进制整数：parseInt 会把 "1abc"/"1.5" 静默截成 1，与公开契约不符
    if (!/^-?\d+$/.test(raw)) {
      return tzOffsetError();
    }
    tzOffsetMinutes = Number(raw);
    if (
      !Number.isSafeInteger(tzOffsetMinutes) ||
      tzOffsetMinutes < -MAX_TZ_OFFSET ||
      tzOffsetMinutes > MAX_TZ_OFFSET
    ) {
      return tzOffsetError();
    }
  }

  try {
    const body = await getSnapshot(tzOffsetMinutes);
    if (!body) {
      return json(
        { success: false, error: "Too many snapshot refreshes, retry later" },
        {
          status: 429,
          headers: { "Retry-After": String(SNAPSHOT_TTL_MS / 1000) },
        }
      );
    }
    return json(body);
  } catch (error) {
    console.error("CLI snapshot error:", error);
    // 刷新失败时退回该时区上一次快照，避免公开接口直接 500
    const stale = snapshots.get(tzOffsetMinutes);
    if (stale) {
      touchSnapshot(tzOffsetMinutes, stale);
      return json(stale.body);
    }
    return json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

function tzOffsetError(): NextResponse {
  return json(
    {
      success: false,
      error: `Invalid tzOffset. Must be an integer between -${MAX_TZ_OFFSET} and ${MAX_TZ_OFFSET}.`,
    },
    { status: 400 }
  );
}
