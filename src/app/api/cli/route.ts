import { NextRequest, NextResponse } from "next/server";
import { initDatabase, db } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import { executeStatsQuery, type StatsQueryResult } from "@/lib/stats-query";
import { resolveProviderFilter } from "@/lib/provider-utils";
import { getDisplayName, getPricing, normalizeModel } from "@/lib/model-registry";
import {
  calculateCost,
  calculateCostPerMillion,
} from "@/lib/cost-utils";
import { type StatItem } from "@/lib/model-utils";
import { toNum } from "@/lib/number-utils";

export const dynamic = "force-dynamic";

const VALID_RANGES = ["3d", "7d", "14d", "30d"];

function formatNumber(num: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(num));
}

function formatCompact(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return formatNumber(num);
}

function formatCost(num: number): string {
  if (num <= 0) return "$0.0000";
  return `$${num.toFixed(4)}`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toISOString().split("T")[0];
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const d = new Date(dateStr);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function pad(str: string, width: number): string {
  return str.padEnd(width, " ");
}

function padLeft(str: string, width: number): string {
  return str.padStart(width, " ");
}

function computeChange(current: number, previous: number): string {
  if (previous === 0) {
    if (current === 0) return "  0.0%";
    return "  +∞";
  }
  const change = ((current - previous) / previous) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(1)}%`;
}

function computeCostFromStatItem(item: StatItem): { cost: number; effectiveTokens: number } {
  const pricing = getPricing(item.group);
  const inputTokens = toNum(item.totalInputUncached);
  const cacheRead = toNum(item.totalInputCached);
  const cacheWrite = toNum(item.totalCacheWrite);
  const outputTokens = toNum(item.totalOutput);

  const cost = calculateCost({
    inputTokens,
    cacheRead,
    cacheWrite,
    outputTokens,
    pricing,
  });

  const effectiveTokens = inputTokens + cacheRead + cacheWrite + outputTokens;

  return { cost, effectiveTokens };
}

function normalizeProviderInput(provider: string): string {
  // ProviderA -> Provider A
  const match = provider.match(/^Provider([A-Z])$/);
  if (match) {
    return `Provider ${match[1]}`;
  }
  return provider;
}

function isStatItemsWithGroup(data: StatsQueryResult): data is Array<StatItem & { group: string }> {
  return Array.isArray(data);
}

function isTotalStatItems(data: StatsQueryResult): data is Array<StatItem & { group: string; lastActiveAt?: string }> {
  return Array.isArray(data) && (data.length === 0 || "lastActiveAt" in data[0]);
}

async function queryCliData(range: string, provider: string, providerFilter: string[] | null) {
  const [total, totalModels, daily, models] = await Promise.all([
    executeStatsQuery({
      groupBy: "none",
      range: "all",
      provider,
      providerFilter,
    }),
    executeStatsQuery({
      groupBy: "model",
      range: "all",
      provider,
      providerFilter,
      limit: null,
    }),
    executeStatsQuery({
      groupBy: "date",
      range,
      provider,
      granularity: "day",
      providerFilter,
    }),
    executeStatsQuery({
      groupBy: "model",
      range,
      provider,
      providerFilter,
    }),
  ]);
  return { total, totalModels, daily, models };
}

export async function GET(request: NextRequest) {
  await initDatabase();

  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "7d";
    let provider = searchParams.get("provider") || "all";

    // CLI-specific: ProviderA -> Provider A
    provider = normalizeProviderInput(provider);

    // Validate range
    if (!VALID_RANGES.includes(range)) {
      return new NextResponse(
        `Error: Invalid range. Must be one of: ${VALID_RANGES.join(", ")}\n`,
        { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    // Resolve provider filter
    let providerFilter: string[] | null = null;
    if (provider !== "all") {
      const allProviderRows = await db
        .selectDistinct({ provider: tokenRecords.provider })
        .from(tokenRecords);
      const allProviderNames: string[] = allProviderRows
        .map((r: any) => r.provider)
        .filter((n: any): n is string => n !== null && n !== undefined);

      providerFilter = resolveProviderFilter(provider, allProviderNames);

      // CLI-specific fallback: case-insensitive match
      if (!providerFilter || providerFilter.length === 0) {
        const lowerProvider = provider.toLowerCase();
        const matched = allProviderNames.filter(
          (p) => p.toLowerCase() === lowerProvider
        );
        providerFilter = matched.length > 0 ? matched : null;
      }

      if (!providerFilter || providerFilter.length === 0) {
        return new NextResponse(
          `Error: Unknown provider: ${provider}\n`,
          { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
    }

    // Query data
    const { total, totalModels, daily, models } = await queryCliData(range, provider, providerFilter);

    // Build output
    const lines: string[] = [];

    const providerDisplay =
      provider === "all" ? "all providers" : provider;
    lines.push(`Token Tracker Dashboard (${range}, ${providerDisplay})`);
    lines.push("=".repeat(60));
    lines.push("");

    // No data check
    if (
      !total ||
      !Array.isArray(total) ||
      total.length === 0 ||
      !total[0].count
    ) {
      lines.push("No records found.");
      return new NextResponse(lines.join("\n") + "\n", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const totalArr = isTotalStatItems(total) ? total : [];
    const totalItem = totalArr[0];
    const lastActiveAt = totalItem?.lastActiveAt ?? null;

    const totalModelsArr = isStatItemsWithGroup(totalModels) ? totalModels : [];

    let totalCost = 0;
    let totalEffectiveTokens = 0;
    for (const item of totalModelsArr) {
      const { cost, effectiveTokens } = computeCostFromStatItem(item);
      totalCost += cost;
      totalEffectiveTokens += effectiveTokens;
    }
    const totalCostPerMillion = calculateCostPerMillion(totalCost, totalEffectiveTokens);

    lines.push(`Last Active: ${formatDateTime(lastActiveAt)}`);
    lines.push("");

    // Summary
    const totalInput = toNum(totalItem.totalInput);
    const totalInputCached = toNum(totalItem.totalInputCached);
    const totalInputUncached = toNum(totalItem.totalInputUncached);
    const totalOutput = toNum(totalItem.totalOutput);
    const totalCacheWrite = toNum(totalItem.totalCacheWrite);
    const totalCount = toNum(totalItem.count);
    const cacheHitRate =
      totalInput > 0 ? ((totalInputCached / totalInput) * 100).toFixed(1) : "0.0";

    const summaryItems = [
      { label: "Total Input:", value: formatNumber(totalInput), suffix: "tokens", indent: 0 },
      { label: "\u251c\u2500 Cached:", value: formatNumber(totalInputCached), suffix: "tokens", indent: 2 },
      { label: "\u2514\u2500 Uncached:", value: formatNumber(totalInputUncached), suffix: "tokens", indent: 2 },
      { label: "Cache Hit Rate:", value: cacheHitRate + "%", suffix: "", indent: 0 },
      { label: "Total Output:", value: formatNumber(totalOutput), suffix: "tokens", indent: 0 },
      { label: "Total Requests:", value: formatNumber(totalCount), suffix: "", indent: 0 },
      { label: "Estimated Cost:", value: formatCost(totalCost), suffix: "", indent: 0 },
      { label: "Avg cost / 1M tokens:", value: formatCost(totalCostPerMillion), suffix: "", indent: 0 },
    ];

    const maxLabelLen = Math.max(...summaryItems.map((item) => item.indent + item.label.length));
    const maxValueLen = Math.max(...summaryItems.map((item) => item.value.length));

    lines.push("Summary (Total)");
    lines.push("-".repeat(40));
    for (const item of summaryItems) {
      const fullLabel = " ".repeat(item.indent) + item.label;
      const labelPadded = pad(fullLabel, maxLabelLen + 2);
      const valuePadded = padLeft(item.value, maxValueLen);
      const suffix = item.suffix ? " " + item.suffix : "";
      lines.push(`${labelPadded}${valuePadded}${suffix}`);
    }
    lines.push("");

    // Today vs Yesterday
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = yesterdayDate.toISOString().split("T")[0];

    const dailyArr = isStatItemsWithGroup(daily) ? daily : [];
    const todayItem = dailyArr.find((d) => d.group === todayStr);
    const yesterdayItem = dailyArr.find(
      (d) => d.group === yesterdayStr
    );

    lines.push("Today vs Yesterday");
    lines.push("-".repeat(60));

    if (todayItem || yesterdayItem) {
      const todayInput = toNum(todayItem?.totalInput);
      const todayOutput = toNum(todayItem?.totalOutput);
      const todayCacheRead = toNum(todayItem?.totalInputCached);
      const todayCacheWrite = toNum(todayItem?.totalCacheWrite);
      const todayRequests = toNum(todayItem?.count);

      const yestInput = toNum(yesterdayItem?.totalInput);
      const yestOutput = toNum(yesterdayItem?.totalOutput);
      const yestCacheRead = toNum(yesterdayItem?.totalInputCached);
      const yestCacheWrite = toNum(yesterdayItem?.totalCacheWrite);
      const yestRequests = toNum(yesterdayItem?.count);

      const col1 = 14;
      const col2 = 16;
      const col3 = 16;
      const col4 = 10;

      lines.push(
        `${pad("", col1)} ${padLeft("Today", col2)} ${padLeft("Yesterday", col3)} ${padLeft("Change", col4)}`
      );
      lines.push(
        `${pad("Input", col1)} ${padLeft(formatNumber(todayInput), col2)} ${padLeft(formatNumber(yestInput), col3)} ${padLeft(computeChange(todayInput, yestInput), col4)}`
      );
      lines.push(
        `${pad("Output", col1)} ${padLeft(formatNumber(todayOutput), col2)} ${padLeft(formatNumber(yestOutput), col3)} ${padLeft(computeChange(todayOutput, yestOutput), col4)}`
      );
      lines.push(
        `${pad("Cache Rd", col1)} ${padLeft(formatNumber(todayCacheRead), col2)} ${padLeft(formatNumber(yestCacheRead), col3)} ${padLeft(computeChange(todayCacheRead, yestCacheRead), col4)}`
      );
      lines.push(
        `${pad("Requests", col1)} ${padLeft(formatNumber(todayRequests), col2)} ${padLeft(formatNumber(yestRequests), col3)} ${padLeft(computeChange(todayRequests, yestRequests), col4)}`
      );
    } else {
      lines.push("No data for today or yesterday.");
    }
    lines.push("");

    // Top 5 Models
    const rawModelArr = isStatItemsWithGroup(models) ? models.slice(0, 5) : [];
    const modelArr = rawModelArr.map((item) => {
      const { cost, effectiveTokens } = computeCostFromStatItem(item);
      return {
        ...item,
        displayName: getDisplayName(item.group),
        cost,
        costPerMillion: calculateCostPerMillion(cost, effectiveTokens),
      };
    });

    lines.push(`Top 5 Models (${range})`);
    lines.push("-".repeat(60));

    if (modelArr.length > 0) {
      const colInput = 14;
      const colCache = 13;
      const colHit = 8;
      const colOutput = 14;
      const colCost = 12;
      const colReqs = 11;

      // 动态计算模型名称列宽
      const modelLabels = modelArr.map((m, i) => `${i + 1}. ${m.displayName}`);
      const colModel = Math.max(
        5, // "Model" header
        ...modelLabels.map((l) => l.length)
      );

      lines.push(
        `${pad("Model", colModel)} ${padLeft("Total Input", colInput)} ${padLeft("Cache Read", colCache)} ${padLeft("Hit%", colHit)} ${padLeft("Total Output", colOutput)} ${padLeft("Avg / 1M", colCost)} ${padLeft("Requests", colReqs)}`
      );
      lines.push(
        "\u2500".repeat(
          colModel +
            colInput +
            colCache +
            colHit +
            colOutput +
            colCost +
            colReqs +
            6
        )
      );

      for (let i = 0; i < modelArr.length; i++) {
        const m = modelArr[i];
        const mInput = toNum(m.totalInput);
        const mCacheRead = toNum(m.totalInputCached);
        const mHitRate =
          mInput > 0 ? ((mCacheRead / mInput) * 100).toFixed(1) : "0.0";

        lines.push(
          `${pad(`${i + 1}. ${m.displayName}`, colModel)} ${padLeft(formatNumber(mInput), colInput)} ${padLeft(formatNumber(mCacheRead), colCache)} ${padLeft(mHitRate + "%", colHit)} ${padLeft(formatNumber(toNum(m.totalOutput)), colOutput)} ${padLeft(formatCost(m.costPerMillion), colCost)} ${padLeft(formatNumber(toNum(m.count)), colReqs)}`
        );
      }
    } else {
      lines.push("No model data available.");
    }
    lines.push("");

    // Daily Trend
    lines.push("Daily Trend");
    lines.push("-".repeat(60));

    if (dailyArr.length > 0) {
      const colDate = 12;
      const colInput = 14;
      const colOutput = 12;
      const colReqs = 10;
      const colTotal = 10;

      lines.push(
        `${pad("Date", colDate)} ${padLeft("Input", colInput)} ${padLeft("Output", colOutput)} ${padLeft("Requests", colReqs)} ${padLeft("Total", colTotal)}`
      );
      lines.push(
        "\u2500".repeat(colDate + colInput + colOutput + colReqs + colTotal + 4)
      );

      for (const d of dailyArr) {
        const dInput = toNum(d.totalInput);
        const dOutput = toNum(d.totalOutput);
        const dTotal = dInput + dOutput;
        lines.push(
          `${pad(d.group, colDate)} ${padLeft(formatNumber(dInput), colInput)} ${padLeft(formatNumber(dOutput), colOutput)} ${padLeft(formatNumber(toNum(d.count)), colReqs)} ${padLeft(formatCompact(dTotal), colTotal)}`
        );
      }
    } else {
      lines.push("No daily data available.");
    }

    return new NextResponse(lines.join("\n") + "\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    console.error("CLI error:", error);
    return new NextResponse("Error: Internal server error\n", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
