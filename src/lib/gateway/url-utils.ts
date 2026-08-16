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
