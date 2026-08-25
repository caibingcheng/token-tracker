import type { ModelsDevSnapshot } from "./snapshot";
import { matchModelsDevModel } from "./match";

// 自动填充 model_prices 双模式契约：
// - fill 模式（默认）：只填空行，永不覆盖已有价格
// - force 模式（overwrite=true）：覆盖所有非 manual 已定价行；
//   source='manual' 的行永不被任何自动流程触碰（isPriced → skipped，isManual → skipped）。
// 未定价行在两种模式下行为一致（匹配到就填 filled）。

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
  updated: string[]; // 覆盖写入的已定价行（fill 模式恒为空数组）
  skipped: string[]; // 已定价未覆盖 / manual 保护跳过
  unmatched: string[]; // 无候选（含 fill 模式已定价——保持向后兼容命名）
}

export interface AutoFillOptions {
  snapshot: ModelsDevSnapshot | null;
  isPriced: (model: string) => boolean | Promise<boolean>;
  overwrite?: boolean; // true = 覆盖非 manual 已定价行
  isManual?: (model: string) => boolean | Promise<boolean>; // force 模式跳过 manual 源
  write: (price: AutoFillModelPrice) => void | Promise<void>;
  now?: Date;
}

export async function autoFillModelPrices(
  models: string[],
  opts: AutoFillOptions
): Promise<AutoFillResult> {
  const result: AutoFillResult = { filled: [], updated: [], skipped: [], unmatched: [] };
  if (!opts.snapshot) {
    result.unmatched.push(...models);
    return result;
  }

  for (const model of models) {
    const m = model.trim();
    if (!m) continue;
    const priced = await opts.isPriced(m);
    if (priced && !opts.overwrite) {
      result.skipped.push(m);
      continue;
    }
    if (priced && (await opts.isManual?.(m))) {
      // manual 行永不被任何自动流程触碰
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
    if (priced) {
      result.updated.push(m);
    } else {
      result.filled.push(m);
    }
  }

  return result;
}
