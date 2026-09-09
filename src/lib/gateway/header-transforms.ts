// Upstream 出站 header 变换（纯逻辑，可单测）。
// 语义：作为出站 header 管线的最后一棒（客户端透传 → 注入真实 key → accept-encoding
// → transforms），按 upstream 配置补充/替换自定义 header。
// fill = 客户端未带该 header 时补充；override = 无条件覆盖。enabled=false 跳过。

export interface HeaderTransform {
  id: string; // 前端生成："ht-" + 8 hex
  header: string; // header 名，存储与比对一律小写
  value: string; // 值模板：字面量 + ${var.*} 变量插值
  mode: "fill" | "override";
  enabled: boolean;
}

// 模板变量上下文；sessionId 支持懒计算（仅当启用的 transform 引用该变量时才求值）
export interface HeaderTransformContext {
  sessionId: string | (() => string);
  model: string;
  keyName: string;
  upstream: string;
}

export const MAX_HEADER_TRANSFORMS = 20;
export const MAX_HEADER_TRANSFORM_VALUE_LENGTH = 4096;

// RFC 7230 token 字符集
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const KNOWN_VARS: Record<string, keyof HeaderTransformContext> = {
  sessionId: "sessionId",
  model: "model",
  keyName: "keyName",
  upstream: "upstream",
};

// 格式校验（无语义黑名单）：header 名 token 字符集、value 禁 CRLF 且 ≤4KB、
// 条目数 ≤20、mode ∈ {fill, override}、enabled boolean。不校验「这是什么头」。
export function isValidHeaderTransforms(input: unknown): input is HeaderTransform[] {
  if (!Array.isArray(input)) return false;
  if (input.length > MAX_HEADER_TRANSFORMS) return false;
  for (const item of input) {
    if (typeof item !== "object" || item === null) return false;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== "string" || t.id.length === 0) return false;
    if (typeof t.header !== "string" || !HEADER_NAME_RE.test(t.header)) return false;
    if (
      typeof t.value !== "string" ||
      t.value.includes("\r") ||
      t.value.includes("\n") ||
      t.value.length > MAX_HEADER_TRANSFORM_VALUE_LENGTH
    ) {
      return false;
    }
    if (t.mode !== "fill" && t.mode !== "override") return false;
    if (typeof t.enabled !== "boolean") return false;
  }
  return true;
}

// 落库前规范化：header 名一律小写
export function normalizeHeaderTransforms(transforms: HeaderTransform[]): HeaderTransform[] {
  return transforms.map((t) => ({ ...t, header: t.header.toLowerCase() }));
}

// DB 读出的 JSON 文本 → HeaderTransform[]；解析失败/非数组回退 []（不阻塞读路径）
export function parseHeaderTransforms(raw: string | null | undefined): HeaderTransform[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidHeaderTransforms(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolveVar(context: HeaderTransformContext, name: string): string | null {
  const key = KNOWN_VARS[name];
  if (!key) return null; // 未知变量保留字面量（拼写错误可见，不静默吞掉）
  const value = context[key];
  return typeof value === "function" ? value() : value;
}

export function applyHeaderTransforms(
  headers: Headers,
  transforms: HeaderTransform[] | undefined,
  context: HeaderTransformContext
): Headers {
  if (!transforms || transforms.length === 0) return headers;
  // fill 的「缺失」基准 = transforms 应用前的 header 集（第 3 层之后的最终集）；
  // 若边遍历边判断，先到的 fill 条目会让同名后到条目被误判为「已存在」
  const preexisting = new Set<string>();
  headers.forEach((_value, key) => preexisting.add(key.toLowerCase()));
  for (const t of transforms) {
    if (!t.enabled) continue;
    if (t.mode === "fill" && preexisting.has(t.header.toLowerCase())) continue;
    const value = t.value.replace(/\$\{var\.([A-Za-z]+)\}/g, (match, name: string) => {
      const resolved = resolveVar(context, name);
      return resolved === null ? match : resolved;
    });
    headers.set(t.header, value);
  }
  return headers;
}
