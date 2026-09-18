export function toNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "bigint") return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function formatFullNumber(num: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(num));
}

export function formatCompactNumber(num: number, decimals = 2): string {
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000_000) {
    return `${(num / 1_000_000_000_000).toFixed(decimals)}T`;
  }
  if (abs >= 1_000_000_000) {
    return `${(num / 1_000_000_000).toFixed(decimals)}B`;
  }
  if (abs >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(decimals)}M`;
  }
  if (abs >= 1_000) {
    return `${(num / 1_000).toFixed(decimals)}K`;
  }
  return formatFullNumber(num);
}

const COMPACT_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  t: 1_000_000_000_000,
};

// 解析紧凑数字书写："2000"、"2K"、"2 k"、"1M"、"1.5m"；非法输入（含负数、空串）返回 null
export function parseCompactNumber(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([kmbt]?)$/.exec(raw.trim().toLowerCase());
  if (!match) return null;
  const value = Math.round(Number(match[1]) * (COMPACT_MULTIPLIERS[match[2]] ?? 1));
  return Number.isSafeInteger(value) ? value : null;
}

export function formatNumber(num: number, compact: boolean): string {
  return compact ? formatCompactNumber(num) : formatFullNumber(num);
}

export function formatLatencyMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}
