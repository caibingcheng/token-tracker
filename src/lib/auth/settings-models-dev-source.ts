import { getSetting, setSetting } from "@/lib/auth/settings";
import {
  MODELS_DEV_SOURCE_DEFAULT,
  type ModelsDevSource,
} from "@/lib/models-dev/snapshot";

export type { ModelsDevSource };

// models.dev 快照数据源开关（settings 表 models_dev_source，明文）：
// settings 优先，无 env fallback。仅写开关，不触发拉取；
// 下次手动 Refresh / 懒刷新按新源拉取，失败保留旧快照。

export const MODELS_DEV_SOURCE_SETTING_KEY = "models_dev_source";

export function isValidModelsDevSource(v: unknown): v is ModelsDevSource {
  return v === "models.dev" || v === "github";
}

// 非法 / null → 默认 "models.dev"
export function parseModelsDevSource(raw: string | null): ModelsDevSource {
  if (raw === "models.dev" || raw === "github") return raw;
  return MODELS_DEV_SOURCE_DEFAULT;
}

// 唯一 async 入口：读取 + 解析（getSetting 自带 withSkipCache，无 10s 延迟）
export async function loadModelsDevSource(): Promise<ModelsDevSource> {
  const raw = await getSetting(MODELS_DEV_SOURCE_SETTING_KEY);
  return parseModelsDevSource(raw);
}

export async function setModelsDevSource(source: ModelsDevSource): Promise<void> {
  await setSetting(MODELS_DEV_SOURCE_SETTING_KEY, source);
}
