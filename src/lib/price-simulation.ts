import type { ModelPricing } from "./cost-utils";

// Price Simulation 纯逻辑：给定 token 分布 + 价格 + 目标 cache rate，算出仿真成本。
// 口径：Total Input = cache read + uncached input（含 cache）；
// 调整 cache rate 时保持 Total Input 不变，在 cached / uncached 之间重分配。

export interface PriceSimulationInput {
  /** Total Input 口径（含 cache read） */
  totalInput: number;
  /** cache read token（含在 totalInput 内） */
  cacheRead: number;
  cacheWrite: number;
  outputTokens: number;
  pricing: ModelPricing | null;
  /** 目标 cache rate，0..1；null/undefined = 沿用实际 cache rate */
  cacheRate?: number | null;
}

export interface PriceSimulationResult {
  /** 实际 cache rate（cacheRead / totalInput），0..1 */
  actualCacheRate: number;
  /** 实际参与计算的 cache rate，0..1 */
  simulatedCacheRate: number;
  cacheReadTokens: number;
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  cost: number;
}

function finiteNonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 实际 cache rate = cacheRead / totalInput，超界/非法输入兜底 */
export function computeCacheRate(totalInput: number, cacheRead: number): number {
  const total = finiteNonNegative(totalInput);
  if (total === 0) return 0;
  return Math.min(finiteNonNegative(cacheRead), total) / total;
}

/** cache rate 归一化到 0..1；null/NaN 返回 null（表示"跟随实际"） */
export function normalizeCacheRate(
  rate: number | null | undefined
): number | null {
  if (rate === null || rate === undefined) return null;
  const n = Number(rate);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/** 保持 Total Input 不变，按 cache rate 重分配 cached / uncached */
export function redistributeInputTokens(
  totalInput: number,
  cacheRate: number
): { cacheRead: number; uncachedInput: number } {
  const total = finiteNonNegative(totalInput);
  const rate = normalizeCacheRate(cacheRate) ?? 0;
  const cacheRead = total * rate;
  return { cacheRead, uncachedInput: total - cacheRead };
}

export function simulatePricing(
  input: PriceSimulationInput
): PriceSimulationResult {
  const totalInput = finiteNonNegative(input.totalInput);
  const actualCacheRate = computeCacheRate(totalInput, input.cacheRead);
  const simulatedCacheRate =
    normalizeCacheRate(input.cacheRate) ?? actualCacheRate;
  const { cacheRead, uncachedInput } = redistributeInputTokens(
    totalInput,
    simulatedCacheRate
  );
  const cacheWrite = finiteNonNegative(input.cacheWrite);
  const outputTokens = finiteNonNegative(input.outputTokens);

  const pricing = input.pricing;
  const cost = pricing
    ? (uncachedInput * finiteNonNegative(pricing.inputPrice) +
        cacheRead * finiteNonNegative(pricing.cacheReadPrice) +
        cacheWrite * finiteNonNegative(pricing.cacheWritePrice) +
        outputTokens * finiteNonNegative(pricing.outputPrice)) /
      1_000_000
    : 0;

  return {
    actualCacheRate,
    simulatedCacheRate,
    cacheReadTokens: cacheRead,
    uncachedInputTokens: uncachedInput,
    cacheWriteTokens: cacheWrite,
    outputTokens,
    cost,
  };
}

/** 解析 cache rate 输入（百分比字符串）；空串/非法/负数返回 null（= 跟随实际） */
export function parseCacheRateInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(100, n) / 100;
}

/** 解析单价输入（$ / 1M）；空串/非法/负数返回 null（= 回退模型官方价） */
export function parsePriceInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
