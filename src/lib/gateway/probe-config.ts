// upstream 自定义探活端点（可选）：探活 / 手动 Test 打哪个路径、发什么 body。
// 语义：配置存在 → 只打该端点一次（不补发第二种风格，显式即真相）；
//       配置为空/非法 → 回落默认 chat → responses 双风格补发（与历史行为一致）。
// body 中 {{model}} 会被替换为真实 model 名（否则探活打写死的模型名，健康标记会标错对象）。
import { joinUrlPath, sanitizePathSegments } from "./url-utils";

export interface ProbeConfig {
  path: string; // 相对 baseUrl 的路径，必须以 / 开头（如 /v1/systemone）
  body: Record<string, unknown>; // 请求体模板，字符串值里的 {{model}} 会被替换
}

export const PROBE_MODEL_VAR = "{{model}}";
export const MAX_PROBE_PATH_LENGTH = 1024;
export const MAX_PROBE_BODY_JSON_LENGTH = 8192;

// 格式校验：path 必须是以单个 / 开头的相对路径（拒绝绝对 URL 与 // 协议相对形式），
// 且经 sanitizePathSegments 净化后不能逃逸（`..` 上溯）；body 必须是对象，大小有上限。
export function isValidProbeConfig(input: unknown): input is ProbeConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const cfg = input as Record<string, unknown>;
  const path = cfg.path;
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length > MAX_PROBE_PATH_LENGTH) return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("://")) return false;
  // 拒绝一切可被 URL 解析等价归一化为点段/分隔符的写法：
  // - 原始 `..` 段：sanitizePathSegments 仅在越根时返回 null，中段 `..`（/v1/../admin）会通过
  // - 百分号编码 `%2e`/`%2f`/`%5c`：WHATWG URL 把编码点段当 `..`、编码斜杠当分隔符处理
  // - 反斜杠：special scheme（http/https）下 URL 解析与 `/` 等价
  // - 控制字符与空格：URL 解析前会被剥离（如 tab 插在 `..` 中间）
  // 以上任一种都能在归一化后逃出 baseUrl 前缀，而 `joinUrlPath` 只做字符串拼接、无法察觉
  if (path.split("/").includes("..")) return false;
  if (/%2e|%2f|%5c/i.test(path)) return false;
  if (path.includes("\\")) return false;
  // `?`/`#` 会把后面内容变成 query/fragment，使 `..?x=1` 这样的段绕开按 `/` 切段的 `..` 检查
  // （URL 解析后 `?`/`#` 之前的部分仍会归一化，`/v1/..?x=1` → `/?x=1`）
  if (/[?#]/.test(path)) return false;
  if (/[\u0000-\u0020\u007f]/.test(path)) return false;
  if (sanitizePathSegments(path) === null) return false;

  const body = cfg.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return false;
  }
  if (serialized.length > MAX_PROBE_BODY_JSON_LENGTH) return false;
  return true;
}

// per-model 自定义探活端点：同一 upstream 混用不同端点风格（chat / responses / embeddings 等）
// 时，按真实 model 名精确匹配各自的探活端点，不再需要拆多条同 base_url upstream。
// 解析优先级：per-model 命中 > upstream 级 probeConfig > 默认协议双风格。
export interface ModelProbeConfig {
  model: string; // 精确匹配发往 upstream 的真实 model 名（不做通配，通配 enabled_models 走 upstream 级/默认）
  path: string; // 同 ProbeConfig.path
  body: Record<string, unknown>; // 同 ProbeConfig.body，字符串值里的 {{model}} 会被替换
}

export const MAX_MODEL_PROBE_CONFIGS = 20;
export const MAX_MODEL_PROBE_MODEL_LENGTH = 256;

// 格式校验：数组 ≤20 条、model 非空 ≤256、每条 path/body 复用单条 ProbeConfig 校验、model 不重复
export function isValidModelProbeConfigs(input: unknown): input is ModelProbeConfig[] {
  if (!Array.isArray(input)) return false;
  if (input.length > MAX_MODEL_PROBE_CONFIGS) return false;
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const cfg = item as Record<string, unknown>;
    if (
      typeof cfg.model !== "string" ||
      cfg.model.trim() === "" ||
      cfg.model.length > MAX_MODEL_PROBE_MODEL_LENGTH
    ) {
      return false;
    }
    if (!isValidProbeConfig({ path: cfg.path, body: cfg.body })) return false;
    if (seen.has(cfg.model)) return false;
    seen.add(cfg.model);
  }
  return true;
}

// DB 读出的 JSON 文本 → ModelProbeConfig[]；空值/解析失败/含非法条目一律整体回落 []（不阻塞读路径）
export function parseModelProbeConfigs(raw: string | null | undefined): ModelProbeConfig[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidModelProbeConfigs(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 落库前序列化；空数组返回 null（与 classifierModels 口径一致），非法返回 null（调用方已校验，这里安全兜底）
export function serializeModelProbeConfigs(configs: ModelProbeConfig[]): string | null {
  if (!isValidModelProbeConfigs(configs)) return null;
  return configs.length > 0 ? JSON.stringify(configs) : null;
}

// DB 读出的 JSON 文本 → ProbeConfig；空值/解析失败/非法一律回落 null（= auto，不阻塞读路径）
export function parseProbeConfig(raw: string | null | undefined): ProbeConfig | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidProbeConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 落库前序列化；非法返回 null（调用方负责校验，这里只做安全兜底）
export function serializeProbeConfig(config: ProbeConfig | null): string | null {
  if (!config) return null;
  if (!isValidProbeConfig(config)) return null;
  return JSON.stringify(config);
}

// 递归替换 body 中所有字符串里的 {{model}}（顶层、嵌套、子串一律替换）
export function applyModelToProbeBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return value.split(PROBE_MODEL_VAR).join(model);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null) {
      // Object.fromEntries 走 CreateDataProperty，`__proto__` 键不会被原型 setter 吃掉
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)])
      );
    }
    return value;
  };
  return walk(body) as Record<string, unknown>;
}

// path 中的 {{model}} 替换（gemini 风格端点的 model 在 path 段里，如
// /v1beta/models/{{model}}:generateContent）；替换结果由调用方复核仍在 baseUrl 前缀内
export function applyModelToProbePath(path: string, model: string): string {
  return path.split(PROBE_MODEL_VAR).join(model);
}

// 按自定义配置构造探活请求（与 buildProbeRequest 同序：URL 由 baseUrl + path 拼接）
export function buildProbeRequestFromConfig(
  baseUrl: string,
  model: string,
  config: ProbeConfig
): { url: string; body: Record<string, unknown> } {
  return {
    url: joinUrlPath(baseUrl, applyModelToProbePath(config.path, model)),
    body: applyModelToProbeBody(config.body, model),
  };
}

// 纵深防御：已拼接完成的 URL 是否仍在 baseUrl 的路径前缀内（防 {{model}} 替换进
// 含 // 或 .. 的 model 名后逃出前缀；isProbePathInsideBase 只查模板 path，查不到替换后结果）
export function isProbeUrlInsideBase(baseUrl: string, url: string): boolean {
  try {
    const base = new URL(baseUrl);
    const resolved = new URL(url);
    if (resolved.origin !== base.origin) return false;
    const basePath = base.pathname.replace(/\/+$/, "");
    if (basePath === "") return true;
    return resolved.pathname === basePath || resolved.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

// 纵深防御：按 WHATWG URL 归一化后，path 是否仍在 baseUrl 的路径前缀内。
// 上面的逐条黑名单无法穷举所有等价写法（曾经漏过 `%2e%2e`、反斜杠、`..?x=1`），
// 这里直接验证最终不变量；不符时调用方回落默认双风格（不抛错、不阻断探活）。
// base 为裸 host（pathname 为空）时，同源任意路径都在范围内。
export function isProbePathInsideBase(baseUrl: string, path: string): boolean {
  try {
    const base = new URL(baseUrl);
    const resolved = new URL(joinUrlPath(baseUrl, path));
    if (resolved.origin !== base.origin) return false;
    const basePath = base.pathname.replace(/\/+$/, "");
    if (basePath === "") return true;
    return resolved.pathname === basePath || resolved.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

// UI 预置（仅前端一键填入 path + body，落库仍是普通 ProbeConfig，不持久化预置名）
export interface ProbePreset {
  id: string;
  label: string;
  path: string;
  body: Record<string, unknown>;
}

export const PROBE_PRESETS: ProbePreset[] = [
  {
    id: "chat",
    label: "chat (/v1/chat/completions, openai style)",
    path: "/v1/chat/completions",
    body: {
      model: PROBE_MODEL_VAR,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      stream: false,
    },
  },
  {
    id: "responses",
    label: "responses (/v1/responses)",
    path: "/v1/responses",
    body: { model: PROBE_MODEL_VAR, input: "hi" },
  },
  {
    id: "embeddings",
    label: "embeddings (/v1/embeddings)",
    path: "/v1/embeddings",
    body: { model: PROBE_MODEL_VAR, input: "hi" },
  },
  {
    id: "anthropic-messages",
    label: "anthropic messages (/v1/messages)",
    path: "/v1/messages",
    body: {
      model: PROBE_MODEL_VAR,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      stream: false,
    },
  },
  {
    id: "gemini-generateContent",
    label: "gemini generateContent (/v1beta/models/{model}:generateContent)",
    path: "/v1beta/models/{{model}}:generateContent",
    body: {
      contents: [{ parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 1 },
    },
  },
  {
    id: "rerank",
    label: "rerank (/v1/rerank)",
    path: "/v1/rerank",
    body: { model: PROBE_MODEL_VAR, query: "hi", documents: ["hi"] },
  },
  {
    id: "systemone",
    label: "systemone (/v1/systemone)",
    path: "/v1/systemone",
    body: {
      model: PROBE_MODEL_VAR,
      state: "hi",
      questions: {
        ok: { type: "noul", instructions: "Is this text non-empty?" },
      },
    },
  },
];
