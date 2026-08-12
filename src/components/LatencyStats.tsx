"use client";

import { useMemo } from "react";
import { formatLatencyMs } from "@/lib/number-utils";
import {
  localDateKeyFromUtcDate,
  addDaysLocal,
} from "@/lib/timezone-utils";

export interface LatencyModelStat {
  model: string;
  displayName: string;
  provider: string;
  providerName: string;
  count: number;
  streamCount: number;
  avgTtftMs: number | null;
  p50TtftMs: number | null;
  avgLatencyMs: number | null;
  outputTokensPerSec: number | null;
}

export interface LatencyDayStat {
  group: string;
  streamCount: number;
  avgTtftMs: number | null;
  p50TtftMs: number | null;
}

interface LatencyStatsProps {
  byModel: LatencyModelStat[];
  daily: LatencyDayStat[];
  loading: boolean;
  range: number;
  timezoneOffsetMinutes: number;
}

function formatTokensPerSec(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v.toFixed(1)}/s`;
}

function formatDayLabel(value: string): string {
  const parts = value.split("-");
  return parts.length >= 3 ? `${Number(parts[1])}-${Number(parts[2])}` : value;
}

function getLastNDays(days: number, timezoneOffsetMinutes: number): string[] {
  const result: string[] = [];
  const now = new Date();
  const localNow = new Date(now.getTime() - timezoneOffsetMinutes * 60000);
  const end = new Date(
    Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate()
    )
  );
  let current = addDaysLocal(end, -(days - 1), timezoneOffsetMinutes);
  for (let i = 0; i < days; i++) {
    result.push(localDateKeyFromUtcDate(current, timezoneOffsetMinutes));
    current = addDaysLocal(current, 1, timezoneOffsetMinutes);
  }
  return result;
}

export default function LatencyStats({
  byModel,
  daily,
  loading,
  range,
  timezoneOffsetMinutes,
}: LatencyStatsProps) {
  const { bars, maxP50 } = useMemo(() => {
    const map = new Map(daily.map((d) => [d.group, d]));
    const lastNDays = getLastNDays(range, timezoneOffsetMinutes);
    const days = lastNDays.map((date) => {
      const existing = map.get(date);
      return {
        group: date,
        streamCount: existing?.streamCount ?? 0,
        p50TtftMs: existing?.p50TtftMs ?? null,
        avgTtftMs: existing?.avgTtftMs ?? null,
      };
    });
    const maxP50 = Math.max(
      ...days.map((d) => d.p50TtftMs ?? 0),
      0
    );
    return { bars: days, maxP50 };
  }, [daily, range, timezoneOffsetMinutes]);

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-3 md:p-6 mb-8">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold">Speed (Last {range} Days)</h2>
          <span
            className="text-xs text-gray-400 cursor-help"
            title="TTFT = 流式请求首个 chunk 到达耗时（首 token 延迟）；Latency = 整请求耗时；tok/s = 流式生成速度（不含首 token 等待）。TTFT 仅流式请求有值，Streams 列展示其样本量。"
          >
            ?
          </span>
        </div>
        <div className="h-40 bg-gray-100 rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-3 md:p-6 mb-8">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Speed (Last {range} Days)</h2>
        <span
          className="text-xs text-gray-400 cursor-help"
          title="TTFT = 流式请求首个 chunk 到达耗时（首 token 延迟）；Total = 整请求耗时；tok/s = 流式生成速度（不含首 token 等待）。TTFT 仅流式请求有值，Streams 列展示其样本量。"
        >
          ?
        </span>
      </div>
      <p className="text-xs text-gray-400 mb-4">
        TTFT (p50) · Avg TTFT · Avg Total · Generation Speed
      </p>

      <div className="hidden md:block overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">p50 TTFT</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Avg TTFT</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Avg Total</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">tok/s</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {byModel.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-gray-400">
                  No streaming requests in this period
                </td>
              </tr>
            )}
            {byModel.map((m) => (
              <tr key={`${m.provider}\u0000${m.model}`}>
                <td className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">
                  {m.displayName}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                  {m.providerName}
                </td>
                <td className="px-4 py-3 text-sm text-gray-900 text-right whitespace-nowrap">
                  {formatLatencyMs(m.p50TtftMs)}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600 text-right whitespace-nowrap">
                  {formatLatencyMs(m.avgTtftMs)}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600 text-right whitespace-nowrap">
                  {formatLatencyMs(m.avgLatencyMs)}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600 text-right whitespace-nowrap">
                  {formatTokensPerSec(m.outputTokensPerSec)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="md:hidden space-y-3">
        {byModel.length === 0 && (
          <p className="text-center text-sm text-gray-400 py-4">
            No streaming requests in this period
          </p>
        )}
        {byModel.map((m) => (
          <div
            key={`${m.provider}\u0000${m.model}`}
            className="border border-gray-200 rounded-lg p-4"
          >
            <div className="flex justify-between items-start mb-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{m.displayName}</p>
                <p className="text-xs text-gray-400 mt-0.5">{m.providerName}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-gray-500">p50 TTFT</p>
                <p className="text-sm font-semibold text-gray-900">{formatLatencyMs(m.p50TtftMs)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Avg TTFT</p>
                <p className="text-sm font-semibold text-gray-900">{formatLatencyMs(m.avgTtftMs)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Avg Total</p>
                <p className="text-sm font-semibold text-gray-900">{formatLatencyMs(m.avgLatencyMs)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">tok/s</p>
                <p className="text-sm font-semibold text-gray-900">{formatTokensPerSec(m.outputTokensPerSec)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {bars.some((b) => b.streamCount > 0) && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-700 mb-2">
              Daily p50 TTFT ({formatLatencyMs(maxP50)} max)
            </h3>
            <div className="flex items-end gap-px h-32 mt-2">
              {bars.map((b) => {
                const heightPct =
                  maxP50 > 0 && b.p50TtftMs != null
                    ? Math.max((b.p50TtftMs / maxP50) * 100, 4)
                    : 0;
                return (
                  <div
                    key={b.group}
                    className="flex-1 flex flex-col justify-end"
                    title={`${b.group} · p50 ${formatLatencyMs(b.p50TtftMs)} · avg ${formatLatencyMs(b.avgTtftMs)} · ${b.streamCount} streams`}
                  >
                    <div
                      className={`w-full rounded-sm ${b.streamCount > 0 ? "bg-blue-500 hover:bg-blue-600" : "bg-gray-100"}`}
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] text-gray-400 mt-1">
              {bars.length > 0 && (
                <>
                  <span>{formatDayLabel(bars[0].group)}</span>
                  <span>{formatDayLabel(bars[Math.floor(bars.length / 2)].group)}</span>
                  <span>{formatDayLabel(bars[bars.length - 1].group)}</span>
                </>
              )}
          </div>
        </div>
      )}
    </div>
  );
}
