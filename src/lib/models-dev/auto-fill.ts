import type { ModelsDevSnapshot } from "./snapshot";
import { matchModelsDevModel } from "./match";

// 自动填充 model_prices：只填空行，永不覆盖已有价格；
// source='manual' 的行永不被任何自动流程触碰（isPriced 已覆盖该语义）。

export interface AutoFillModelPrice {
  model: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  source: "models.dev";
  modelsDevId: string;
  updatedAt: string;
}

export interface AutoFillResult {
  filled: string[];
  skipped: string[]; // 已定价未覆盖
  unmatched: string[]; // 无候选
}

export interface AutoFillOptions {
  snapshot: ModelsDevSnapshot | null;
  isPriced: (model: string) => boolean | Promise<boolean>;
  write: (price: AutoFillModelPrice) => void | Promise<void>;
  now?: Date;
}

export async function autoFillModelPrices(
  models: string[],
  opts: AutoFillOptions
): Promise<AutoFillResult> {
  const result: AutoFillResult = { filled: [], skipped: [], unmatched: [] };
  if (!opts.snapshot) {
    result.unmatched.push(...models);
    return result;
  }

  for (const model of models) {
    const m = model.trim();
    if (!m) continue;
    if (await opts.isPriced(m)) {
      result.skipped.push(m);
      continue;
    }
    const { matched } = matchModelsDevModel(m, opts.snapshot.data);
    if (!matched) {
      result.unmatched.push(m);
      continue;
    }
    await opts.write({
      model: m,
      inputPrice: matched.inputPrice,
      outputPrice: matched.outputPrice,
      cacheReadPrice: matched.cacheReadPrice,
      cacheWritePrice: matched.cacheWritePrice,
      source: "models.dev",
      modelsDevId: matched.modelsDevId,
      updatedAt: (opts.now ?? new Date()).toISOString(),
    });
    result.filled.push(m);
  }

  return result;
}
