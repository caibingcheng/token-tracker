// 客户端凭证 / 会话 header 的提取（纯逻辑，中心与 relay 共用）。
// 从 proxy.ts 拆出：relay 不得 import proxy.ts（构建期硬约束），但这两件事必须同一口径
// —— vk 只认三处 header（**不接受 `?key=` query**），会话只认 7 个原生 header。

export const MAX_SESSION_ID_LENGTH = 256;

// 保留原有 generic header，并覆盖 Claude Code / Codex / OpenCode / session affinity 常见形式
export const SESSION_ID_HEADERS = [
  "x-claude-code-session-id",
  "x-opencode-session",
  "session-id",
  "x-session-id",
  "session_id",
  "x-session-affinity",
  "x-conversation-id",
] as const;

// 从请求头中提取客户端原生会话 ID；请求内只调用一次，供 Records 与路由粘性共用。
export function extractSessionId(headers: Headers): string | null {
  for (const name of SESSION_ID_HEADERS) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    return trimmed.slice(0, MAX_SESSION_ID_LENGTH);
  }
  return null;
}

// 从请求头中提取虚拟 key token。
// 只认三个 header：Authorization: Bearer / x-api-key / x-goog-api-key。
// **不再支持 `?key=` query 认证**：query string 会进访问日志、反代日志、Referer、浏览器历史，
// 虚拟 key 泄露面太大（Gemini 风格客户端请改用 x-goog-api-key header）。
export function extractVirtualKeyToken(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (authorization && authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const apiKey = headers.get("x-api-key");
  if (apiKey) return apiKey;
  const googKey = headers.get("x-goog-api-key");
  if (googKey) return googKey;
  return null;
}
