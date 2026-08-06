export interface QuotaCheckInput {
  virtualKeyId: number;
  maxRpm: number | null;
  maxTpm: number | null;
  maxDailyTokens: number | null;
  maxMonthlyTokens: number | null;
  now: Date;
}

export interface QuotaUsage {
  rpm: number; // 最近 60 秒请求数
  tpm: number; // 最近 60 秒 token 数
  dailyTokens: number; // 当前 UTC 自然日累计 token
  monthlyTokens: number; // 当前 UTC 自然月累计 token
}

export type QuotaViolation =
  | { dimension: "max_rpm"; current: number; limit: number }
  | { dimension: "max_tpm"; current: number; limit: number }
  | { dimension: "max_daily_tokens"; current: number; limit: number }
  | { dimension: "max_monthly_tokens"; current: number; limit: number }
  | null;

// 配额检查：null 限额不限制；current > limit 才超限（边界 = 允许）；
// 多维度同时超限按固定优先级返回第一个：rpm → tpm → daily → monthly
export function checkQuota(input: QuotaCheckInput, usage: QuotaUsage): QuotaViolation {
  if (input.maxRpm != null && usage.rpm > input.maxRpm) {
    return { dimension: "max_rpm", current: usage.rpm, limit: input.maxRpm };
  }
  if (input.maxTpm != null && usage.tpm > input.maxTpm) {
    return { dimension: "max_tpm", current: usage.tpm, limit: input.maxTpm };
  }
  if (input.maxDailyTokens != null && usage.dailyTokens > input.maxDailyTokens) {
    return { dimension: "max_daily_tokens", current: usage.dailyTokens, limit: input.maxDailyTokens };
  }
  if (input.maxMonthlyTokens != null && usage.monthlyTokens > input.maxMonthlyTokens) {
    return { dimension: "max_monthly_tokens", current: usage.monthlyTokens, limit: input.maxMonthlyTokens };
  }
  return null;
}
