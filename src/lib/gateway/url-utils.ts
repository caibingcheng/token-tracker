// 拼接上游 base_url 与请求 path，消除 /v1、/v1beta 前缀重叠。
// 例如 base="https://api.deepseek.com/v1" + path="/v1/chat/completions"
//  → "https://api.deepseek.com/v1/chat/completions"（而不是 /v1/v1/...）
export function joinUrlPath(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  for (const prefix of ["/v1beta", "/v1"]) {
    if (base.endsWith(prefix) && (p === prefix || p.startsWith(`${prefix}/`))) {
      return base + p.slice(prefix.length);
    }
  }
  return base + p;
}

// 净化 path 中的 `..` 段，防止逃逸出上游 base 前缀（如 /v1/../internal → /internal）。
// 逐段解析重建：`.` 丢弃，`..` 弹出一段（栈空即逃逸 → 返回 null，调用方应 400）。
export function sanitizePathSegments(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const hadTrailingSlash = path.length > 1 && path.endsWith("/");
  const segments = path.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null; // 尝试逃逸到根之外
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const joined = "/" + out.join("/");
  return hadTrailingSlash && joined !== "/" ? joined + "/" : joined;
}

// /raw 裸透传入口前缀：客户端打 /raw/<upstream base URL 之后的部分>，网关剥掉前缀后
// 原样拼到 base URL（上游永远看不到 /raw），用于 /v1、/v1beta 之外的端点（如 OpenRouter
// 的 /alpha/*，base = https://openrouter.ai/api）。
// 中心（proxy.ts / plan route）与 relay（prepare.ts）共用：relay 侧的协议检测、model
// 提取与 usage 解析都必须在剥前缀后的内层 path 上做，否则 /raw 上的 anthropic/gemini
// 端点会被当成 openai。
const RAW_PASSTHROUGH_PREFIX = "/raw";

// 非 /raw 路径原样返回；内层路径再过一次净化（防 .. 逃逸），
// 空内层路径（/raw、/raw/）或逃逸路径返回 null（调用方 400）。
export function stripRawPassthroughPrefix(path: string): string | null {
  if (path !== RAW_PASSTHROUGH_PREFIX && !path.startsWith(`${RAW_PASSTHROUGH_PREFIX}/`)) {
    return path;
  }
  const inner = sanitizePathSegments(path.slice(RAW_PASSTHROUGH_PREFIX.length));
  if (inner === null || inner === "/") return null;
  return inner;
}
