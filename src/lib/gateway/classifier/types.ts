// 分类器类型定义与 upstreams.classifier_models 条目解析。
// 两个正交维度：type 决定请求/响应 schema（wire format），
// 认证与传输（Bearer / x-api-key / proxyUrl / redirect manual）由 upstream.protocol 决定。

export type ClassifierType = "jev-systemone" | "chat";
export const VALID_CLASSIFIER_TYPES: readonly ClassifierType[] = ["jev-systemone", "chat"];

// 分类器种类（named_routes.classifier_kind）：
// - model：LLM 分类器，classifier_upstream_id + classifier_model 指向 upstream.classifier_models 声明的模型
// - priority：规则分类器，按优先级 + 可用性选链首（零 LLM 开销；命名路由不配 LLM 分类器即此模式，
//   此模式下 classifier_upstream_id=0、classifier_model='' 作占位）
export type ClassifierKind = "model" | "priority";
export const VALID_CLASSIFIER_KINDS: readonly ClassifierKind[] = ["model", "priority"];

export function isClassifierKind(value: unknown): value is ClassifierKind {
  return typeof value === "string" && (VALID_CLASSIFIER_KINDS as string[]).includes(value);
}

export function isClassifierType(value: unknown): value is ClassifierType {
  return typeof value === "string" && (VALID_CLASSIFIER_TYPES as string[]).includes(value);
}

// upstreams.classifier_models JSON 条目：声明该 upstream 可作分类器的模型
export interface ClassifierModelEntry {
  model: string;
  type: ClassifierType;
  maxInputTokens?: number; // 决策请求输入预算上限；缺省走 models.dev context → 默认值
  path?: string; // 端点路径覆盖（如 OpenRouter 的 /alpha/decisions）；缺省用 adapter 默认
}

export const MAX_CLASSIFIER_MODELS_PER_UPSTREAM = 32;

export function isValidClassifierModelEntry(input: unknown): input is ClassifierModelEntry {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const e = input as Record<string, unknown>;
  if (typeof e.model !== "string" || e.model.length === 0 || e.model.length > 256) return false;
  if (!isClassifierType(e.type)) return false;
  if (e.maxInputTokens !== undefined) {
    if (typeof e.maxInputTokens !== "number" || !Number.isFinite(e.maxInputTokens)) return false;
    if (e.maxInputTokens < 256 || e.maxInputTokens > 1_000_000) return false;
  }
  if (e.path !== undefined) {
    // 相对路径，与 probe_config 同口径：拒绝一切 URL 归一化后可逃出 baseUrl 前缀的写法
    //（字面 `..` / 百分号编码点段与分隔符 / 反斜杠 / `?#` 截断 / 控制字符，详见 isValidProbeConfig）
    if (typeof e.path !== "string" || e.path.length === 0 || e.path.length > 1024) return false;
    if (!e.path.startsWith("/") || e.path.startsWith("//")) return false;
    if (e.path.includes("://") || e.path.includes("..")) return false;
    if (/%2e|%2f|%5c/i.test(e.path)) return false;
    if (e.path.includes("\\") || /[?#]/.test(e.path)) return false;
    if (/[\u0000-\u0020\u007f]/.test(e.path)) return false;
  }
  return true;
}

// DB JSON 文本 → 条目数组；空值/解析失败 → 空数组（不阻塞读路径）
export function parseClassifierModels(raw: string | null | undefined): ClassifierModelEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidClassifierModelEntry).slice(0, MAX_CLASSIFIER_MODELS_PER_UPSTREAM);
  } catch {
    return [];
  }
}

// 发给分类器的单个候选选项
export interface ClassifierRouteOption {
  key: string; // 选项键（r<routeId>），分类器返回此键
  routeId: number; // named_route_targets.id
  label: string; // 真实 model 名 + 路由描述
}

export interface ClassifierDecisionInput {
  instruction: string; // 命名路由的决策指令
  options: ClassifierRouteOption[];
  state: string; // summarize 产物（预算制请求摘要）
}

export interface ClassifierUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ClassifierDecision {
  routeId: number | null; // null = 输出非法/未命中任何选项
  usage: ClassifierUsage | null;
}

// 分类器 adapter：每个 type 一个实现，两个函数（构造请求 / 解析响应）。
// 新增分类协议 = 注册新 adapter，主链路零改动。
export interface ClassifierAdapter {
  type: ClassifierType;
  defaultPath: string;
  buildRequest(
    model: string,
    input: ClassifierDecisionInput,
    entry: ClassifierModelEntry
  ): { path: string; body: Record<string, unknown> };
  parseResponse(json: unknown, options: ClassifierRouteOption[]): ClassifierDecision;
}

// 决策请求除 state 外的固定开销估算（instruction + 选项文本 + schema 模板），用于预算扣减
export function estimateOverheadTokens(
  instruction: string,
  options: ClassifierRouteOption[]
): number {
  const chars =
    instruction.length +
    options.reduce((sum, o) => sum + o.key.length + o.label.length, 0) +
    800; // schema 模板固定余量（questions/choices 结构 + message 框架）
  return Math.ceil(chars / 4);
}
