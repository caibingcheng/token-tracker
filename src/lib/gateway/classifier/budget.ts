// 分类器输入预算解析：条目显式配置 > models.dev context window > 保守默认。
import { normalizeModelKey } from "../../models-dev/match";
import type { ModelsDevData } from "../../models-dev/snapshot";
import { DEFAULT_CLASSIFIER_MAX_INPUT_TOKENS } from "./summarize";

// models.dev 快照查 context window：精确 → 归一化 → 末段（typesafe/jev → jev）匹配；
// 无命中或条目无 limit.context → null
export function lookupContextWindow(model: string, data: ModelsDevData): number | null {
  const raw = model.trim();
  if (!raw) return null;
  const norm = normalizeModelKey(raw);
  const lastSeg = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const normLastSeg = normalizeModelKey(lastSeg);

  for (const providerId of Object.keys(data)) {
    const models = data[providerId]?.models;
    if (!models || typeof models !== "object") continue;
    for (const modelId of Object.keys(models)) {
      const idNorm = normalizeModelKey(modelId);
      const idLastSeg = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
      const hit =
        modelId === raw ||
        idNorm === norm ||
        normalizeModelKey(idLastSeg) === normLastSeg;
      if (!hit) continue;
      const limit = (models[modelId] as Record<string, unknown>).limit;
      if (typeof limit !== "object" || limit === null) continue;
      const context = (limit as Record<string, unknown>).context;
      if (typeof context === "number" && Number.isFinite(context) && context >= 256) {
        return Math.floor(context);
      }
    }
  }
  return null;
}

// 预算解析优先级：条目显式 maxInputTokens > models.dev context window（封顶）> 默认 4096。
// models.dev 的 context window 可能极大（1M 级），直通会让单次决策发送巨量 summary，
// 故派生预算封顶 32k；条目显式配置是管理员的刻意选择，不受此封顶限制（写入侧已有 1M 上限校验）。
export const MAX_CLASSIFIER_INPUT_TOKENS = 32_768;

export function resolveInputBudget(
  explicit: number | undefined,
  modelsDevContext: number | null
): number {
  if (explicit !== undefined) return explicit;
  if (modelsDevContext !== null) return Math.min(modelsDevContext, MAX_CLASSIFIER_INPUT_TOKENS);
  return DEFAULT_CLASSIFIER_MAX_INPUT_TOKENS;
}
