export interface ModelPricing {
  canonicalId: string;
  displayName: string;
  inputPrice: number;
  cacheReadPrice: number;
  cacheWritePrice: number;
  outputPrice: number;
}

export interface CostInput {
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  outputTokens: number;
  pricing: ModelPricing | null;
}

export interface AggregatedCost {
  totalCost: number;
  effectiveTokens: number;
  costPerMillionTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  inputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  outputCost: number;
  costPerMillionInput: number;
  costPerMillionCacheRead: number;
  costPerMillionCacheWrite: number;
  costPerMillionOutput: number;
}

export function emptyAggregatedCost(): AggregatedCost {
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

export function addToAggregate(
  aggregate: AggregatedCost,
  input: CostInput
): void {
  const { inputTokens, cacheRead, cacheWrite, outputTokens, pricing } = input;

  const inputPrice = pricing?.inputPrice ?? 0;
  const cacheReadPrice = pricing?.cacheReadPrice ?? 0;
  const cacheWritePrice = pricing?.cacheWritePrice ?? 0;
  const outputPrice = pricing?.outputPrice ?? 0;

  const inputCost = (inputTokens * inputPrice) / 1_000_000;
  const cacheReadCost = (cacheRead * cacheReadPrice) / 1_000_000;
  const cacheWriteCost = (cacheWrite * cacheWritePrice) / 1_000_000;
  const outputCost = (outputTokens * outputPrice) / 1_000_000;

  aggregate.inputTokens += inputTokens;
  aggregate.cacheReadTokens += cacheRead;
  aggregate.cacheWriteTokens += cacheWrite;
  aggregate.outputTokens += outputTokens;

  aggregate.inputCost += inputCost;
  aggregate.cacheReadCost += cacheReadCost;
  aggregate.cacheWriteCost += cacheWriteCost;
  aggregate.outputCost += outputCost;

  aggregate.totalCost +=
    inputCost + cacheReadCost + cacheWriteCost + outputCost;
  aggregate.effectiveTokens += inputTokens + cacheRead + cacheWrite + outputTokens;
}

export function finalizeAggregate(
  aggregate: AggregatedCost
): AggregatedCost {
  aggregate.costPerMillionInput =
    aggregate.inputTokens > 0
      ? (aggregate.inputCost / aggregate.inputTokens) * 1_000_000
      : 0;
  aggregate.costPerMillionCacheRead =
    aggregate.cacheReadTokens > 0
      ? (aggregate.cacheReadCost / aggregate.cacheReadTokens) * 1_000_000
      : 0;
  aggregate.costPerMillionCacheWrite =
    aggregate.cacheWriteTokens > 0
      ? (aggregate.cacheWriteCost / aggregate.cacheWriteTokens) * 1_000_000
      : 0;
  aggregate.costPerMillionOutput =
    aggregate.outputTokens > 0
      ? (aggregate.outputCost / aggregate.outputTokens) * 1_000_000
      : 0;

  aggregate.costPerMillionTokens =
    aggregate.effectiveTokens > 0 && aggregate.totalCost > 0
      ? (aggregate.totalCost / aggregate.effectiveTokens) * 1_000_000
      : 0;

  return aggregate;
}

export interface PricingConsistencyResult {
  ok: boolean;
  mismatches: Array<{
    category: string;
    expected: number;
    actual: number;
  }>;
}

export function checkPricingConsistency(
  inputs: CostInput[],
  aggregate: AggregatedCost,
  tolerance = 0.0001
): PricingConsistencyResult {
  const mismatches: PricingConsistencyResult["mismatches"] = [];

  const firstPricing = inputs.length > 0 ? inputs[0].pricing : null;
  if (
    !firstPricing ||
    inputs.some((input) => input.pricing?.canonicalId !== firstPricing.canonicalId)
  ) {
    return { ok: true, mismatches };
  }

  const checks = [
    {
      category: "input",
      expected: firstPricing.inputPrice,
      actual: aggregate.costPerMillionInput,
    },
    {
      category: "cacheRead",
      expected: firstPricing.cacheReadPrice,
      actual: aggregate.costPerMillionCacheRead,
    },
    {
      category: "cacheWrite",
      expected: firstPricing.cacheWritePrice,
      actual: aggregate.costPerMillionCacheWrite,
    },
    {
      category: "output",
      expected: firstPricing.outputPrice,
      actual: aggregate.costPerMillionOutput,
    },
  ];

  for (const { category, expected, actual } of checks) {
    if (expected > 0) {
      if (Math.abs(actual - expected) / expected > tolerance) {
        mismatches.push({ category, expected, actual });
      }
    } else if (actual !== 0) {
      mismatches.push({ category, expected, actual });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

export function aggregateCost(
  inputs: CostInput[]
): AggregatedCost {
  const aggregate = emptyAggregatedCost();
  for (const input of inputs) {
    addToAggregate(aggregate, input);
  }
  return finalizeAggregate(aggregate);
}

export function calculateCost(input: CostInput): number {
  const { inputTokens, cacheRead, cacheWrite, outputTokens, pricing } = input;
  if (!pricing) return 0;

  return (
    inputTokens * pricing.inputPrice +
    cacheRead * pricing.cacheReadPrice +
    cacheWrite * pricing.cacheWritePrice +
    outputTokens * pricing.outputPrice
  ) / 1_000_000;
}

export function calculateCostPerMillion(
  totalCost: number,
  effectiveTokens: number
): number {
  if (effectiveTokens <= 0 || totalCost <= 0) return 0;
  return (totalCost / effectiveTokens) * 1_000_000;
}
