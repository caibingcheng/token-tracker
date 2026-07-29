"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatNumber } from "@/lib/number-utils";
import { useNumberFormat } from "./NumberFormatContext";
import {
  addDaysLocal,
  getLocalDayOfWeek,
  getLocalMonthLabel,
  formatOffsetMinutesToString,
} from "@/lib/timezone-utils";

export interface HeatmapData {
  group: string;
  totalInput: number;
  totalOutput: number;
}

interface UsageHeatmapProps {
  data: HeatmapData[];
  loading: boolean;
  timezoneOffsetMinutes: number;
}

const WEEK_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getBucketClass(value: number, max: number): string {
  if (value <= 0 || max <= 0) return "bg-white";
  const ratio = value / max;
  if (ratio <= 0.25) return "bg-green-300";
  if (ratio <= 0.5) return "bg-green-500";
  if (ratio <= 0.75) return "bg-green-700";
  return "bg-green-900";
}

export default function UsageHeatmap({
  data,
  loading,
  timezoneOffsetMinutes,
}: UsageHeatmapProps) {
  const { compact } = useNumberFormat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const { weeks, maxValue, totalCells, monthLabels } = useMemo(() => {
    const now = new Date();
    const localNow = new Date(now.getTime() - timezoneOffsetMinutes * 60000);
    const end = new Date(
      Date.UTC(
        localNow.getUTCFullYear(),
        localNow.getUTCMonth(),
        localNow.getUTCDate()
      )
    );
    const start = addDaysLocal(end, -364, timezoneOffsetMinutes);

    const valueMap = new Map<string, number>();
    for (const row of data) {
      const tokens = (row.totalInput || 0) + (row.totalOutput || 0);
      valueMap.set(row.group, (valueMap.get(row.group) || 0) + tokens);
    }

    const allDays: { date: Date; key: string; value: number }[] = [];
    let current = start;
    while (current.getTime() <= end.getTime()) {
      const shifted = new Date(
        current.getTime() - timezoneOffsetMinutes * 60000
      );
      const key = `${shifted.getUTCFullYear()}-${String(
        shifted.getUTCMonth() + 1
      ).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
      allDays.push({ date: new Date(current), key, value: valueMap.get(key) || 0 });
      current = addDaysLocal(current, 1, timezoneOffsetMinutes);
    }

    const values = allDays.map((d) => d.value);
    const maxValue = values.length > 0 ? Math.max(...values) : 0;

    const startDayOfWeek = getLocalDayOfWeek(start, timezoneOffsetMinutes);
    const leadingEmpty = startDayOfWeek;
    const padded: (null | { date: Date; key: string; value: number })[] = Array(
      leadingEmpty
    ).fill(null);
    padded.push(...allDays);

    const weeks: (null | { date: Date; key: string; value: number })[][] = [];
    for (let i = 0; i < padded.length; i += 7) {
      weeks.push(padded.slice(i, i + 7));
    }

    if (weeks.length > 0 && weeks[weeks.length - 1].length < 7) {
      const last = weeks[weeks.length - 1];
      while (last.length < 7) {
        last.push(null);
      }
    }

    const monthLabels: { label: string; startCol: number; endCol: number }[] = [];
    let currentMonth = "";
    let currentStart = -1;
    weeks.forEach((week, weekIndex) => {
      const firstDay = week.find((d) => d !== null);
      if (!firstDay) return;
      const label = getLocalMonthLabel(firstDay.date, timezoneOffsetMinutes);
      if (label !== currentMonth) {
        if (currentMonth !== "" && currentStart !== -1) {
          monthLabels[monthLabels.length - 1].endCol = weekIndex + 2;
        }
        currentMonth = label;
        currentStart = weekIndex + 2;
        monthLabels.push({ label, startCol: currentStart, endCol: weeks.length + 2 });
      }
    });

    // Ensure each label has a positive span; the last one may land on the final column.
    for (const label of monthLabels) {
      if (label.endCol <= label.startCol) {
        label.endCol = label.startCol + 1;
      }
    }

    return { weeks, maxValue, totalCells: allDays.length, monthLabels };
  }, [data, timezoneOffsetMinutes]);

  useEffect(() => {
    if (scrollRef.current && mounted) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [mounted, weeks]);

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="h-4 bg-gray-200 rounded w-40 mb-3 animate-pulse"></div>
        <div className="overflow-x-auto pb-2">
          <div
            className="grid gap-1"
            style={{
              gridTemplateColumns: `auto repeat(40, minmax(10px, 1fr))`,
              gridTemplateRows: `auto repeat(7, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: 7 }).map((_, i) => (
              <div
                key={`l-${i}`}
                className="text-[10px] text-gray-300"
                style={{ gridColumn: 1, gridRow: i + 2 }}
              >
                {WEEK_DAYS[i]}
              </div>
            ))}
            {Array.from({ length: 40 }).map((_, weekIndex) =>
              Array.from({ length: 7 }).map((_, dayIndex) => (
                <div
                  key={`${weekIndex}-${dayIndex}`}
                  className="rounded-sm bg-gray-100 animate-pulse aspect-square"
                  style={{ gridColumn: weekIndex + 2, gridRow: dayIndex + 2 }}
                ></div>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }

  const offsetLabel = formatOffsetMinutesToString(timezoneOffsetMinutes);

  return (
    <div className="bg-white rounded-lg shadow p-4 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-gray-700">
          Usage Heatmap (Last 365 Days, UTC{offsetLabel})
        </h2>
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <span>Less</span>
          <span className="w-2.5 h-2.5 rounded-sm bg-white border border-gray-200" />
          <span className="w-2.5 h-2.5 rounded-sm bg-green-300" />
          <span className="w-2.5 h-2.5 rounded-sm bg-green-500" />
          <span className="w-2.5 h-2.5 rounded-sm bg-green-700" />
          <span className="w-2.5 h-2.5 rounded-sm bg-green-900" />
          <span>More</span>
        </div>
      </div>

      <div ref={scrollRef} className="overflow-x-auto pb-2">
        <div
          className="grid gap-1 min-w-max"
          style={{
            gridTemplateColumns: `auto repeat(${weeks.length}, minmax(10px, 1fr))`,
            gridTemplateRows: `auto repeat(7, minmax(0, 1fr))`,
          }}
        >
          {monthLabels.map((m, index) => (
            <div
              key={index}
              className="text-[10px] text-gray-400 leading-none"
              style={{
                gridColumn: `${m.startCol} / ${m.endCol}`,
                gridRow: 1,
              }}
            >
              {m.label}
            </div>
          ))}

          {WEEK_DAYS.map((d, index) => (
            <div
              key={d}
              className="text-[10px] text-gray-400 pr-2 flex items-center"
              style={{ gridColumn: 1, gridRow: index + 2 }}
            >
              {d}
            </div>
          ))}

          {weeks.map((week, weekIndex) =>
            week.map((day, dayIndex) => {
              const col = weekIndex + 2;
              const row = dayIndex + 2;
              if (!day) {
                return (
                  <div
                    key={`${weekIndex}-${dayIndex}`}
                    className="rounded-sm bg-white border border-gray-100"
                    style={{ gridColumn: col, gridRow: row }}
                  />
                );
              }
              const totalTokens = day.value;
              const dateText = new Date(
                `${day.key}T00:00:00Z`
              ).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                timeZone: "UTC",
              });
              return (
                <div
                  key={`${weekIndex}-${dayIndex}`}
                  className={`rounded-sm border border-gray-100 ${getBucketClass(
                    totalTokens,
                    maxValue
                  )} hover:ring-1 hover:ring-gray-400 cursor-pointer aspect-square`}
                  style={{ gridColumn: col, gridRow: row }}
                  title={`${dateText}: ${formatNumber(totalTokens, compact)} tokens`}
                />
              );
            })
          )}
        </div>
      </div>

      <p className="text-[10px] text-gray-400 mt-2">
        {totalCells} days · UTC{offsetLabel} · total input + output tokens
      </p>
    </div>
  );
}
