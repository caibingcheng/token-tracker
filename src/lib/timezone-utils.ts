/**
 * Browser-first timezone helpers.
 *
 * `offsetMinutes` is the value returned by `new Date().getTimezoneOffset()`:
 *   - UTC+8  -> -480
 *   - UTC-5  -> 300
 *   - UTC    -> 0
 *
 * To convert a UTC instant to local time, add `-offsetMinutes` minutes.
 */

export function getClientTimezoneOffsetMinutes(): number {
  return new Date().getTimezoneOffset();
}

export function formatOffsetMinutesToString(offsetMinutes: number): string {
  const totalMinutes = -offsetMinutes;
  const sign = totalMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(totalMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}`;
}

export function offsetMinutesToSqlModifiers(offsetMinutes: number): string[] {
  const totalMinutes = -offsetMinutes;
  if (totalMinutes === 0) {
    return ["+0 hours"];
  }
  const sign = totalMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(totalMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const modifiers: string[] = [];
  if (hours !== 0) modifiers.push(`${sign}${hours} hours`);
  if (minutes !== 0) modifiers.push(`${sign}${minutes} minutes`);
  if (modifiers.length === 0) return ["+0 hours"];
  return modifiers;
}

export function localDateKeyFromUtcDate(
  date: Date,
  offsetMinutes: number
): string {
  const shifted = new Date(date.getTime() - offsetMinutes * 60000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 本地日期 key（YYYY-MM-DD）对应的 UTC 起始时刻 ISO 字符串。
// 用于日期过滤直比较（created_at >= utcStart），保证可命中索引
// （strftime 套列会导致索引失效）。offsetMinutes 为 getTimezoneOffset() 语义。
export function localDateKeyToUtcStartISO(
  dateKey: string,
  offsetMinutes: number
): string {
  return new Date(
    Date.parse(`${dateKey}T00:00:00Z`) + offsetMinutes * 60000
  ).toISOString();
}

// 计算 range 查询的起始本地日期 key（YYYY-MM-DD）。
// 前端 "Last N Days" 窗口对应 today-(N-1) ~ today 共 N 天；
// 使用 todayLocal 的纯日期 key 运算，避免 UTC- 时区的 round-trip 漂移。
export function computeRangeStartDateKey(
  days: number,
  offsetMinutes: number,
  now: Date = new Date()
): string {
  const todayLocal = localDateKeyFromUtcDate(now, offsetMinutes);
  const base = new Date(`${todayLocal}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - (days - 1));
  return base.toISOString().slice(0, 10);
}

export function addDaysLocal(
  date: Date,
  days: number,
  offsetMinutes: number
): Date {
  const shifted = new Date(date.getTime() - offsetMinutes * 60000);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return new Date(shifted.getTime() + offsetMinutes * 60000);
}

export function getLocalDayOfWeek(
  date: Date,
  offsetMinutes: number
): number {
  const shifted = new Date(date.getTime() - offsetMinutes * 60000);
  return shifted.getUTCDay();
}

export function getLocalMonthLabel(
  date: Date,
  offsetMinutes: number
): string {
  const shifted = new Date(date.getTime() - offsetMinutes * 60000);
  return shifted.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}
