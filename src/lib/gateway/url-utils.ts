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
