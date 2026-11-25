// 出站认证方式：与「API 协议」解耦的独立配置。
//
// 现实里协议与认证头不是一一映射：
//   - OpenRouter / Kimi：anthropic 面与 openai 面都收 Authorization: Bearer
//   - OpenCode Zen / Go：anthropic 面必须 x-api-key，openai 面收 Bearer
// 所以认证头不能从请求协议推导，也不能从 upstream.protocol 推导，
// 只能由 upstream 显式配置（upstreams.auth_style）。
import { isProtocol, normalizeUpstreamProtocols, type Protocol } from "./model-router";

export const AUTH_STYLES = ["bearer", "x-api-key", "x-goog-api-key"] as const;
export type AuthStyle = (typeof AUTH_STYLES)[number];

export function isAuthStyle(value: unknown): value is AuthStyle {
  return typeof value === "string" && (AUTH_STYLES as readonly string[]).includes(value);
}

// 存量回填 / 新建默认值：按默认面映射（历史行为 = 按协议推导认证头），
// 保证老配置升级后行为不变。多面异构的 provider（Zen 类）需拆记录并显式配置。
export function defaultAuthStyleForProtocol(protocol: string): AuthStyle {
  switch (protocol) {
    case "anthropic":
      return "x-api-key";
    case "gemini":
      return "x-goog-api-key";
    default:
      return "bearer";
  }
}

// upstreams 行的认证/面配置解析（容忍存量脏数据）：
// - protocol：默认面，非法值回落 openai
// - protocols：接受面集合，空/非法回落 [protocol]
// - authStyle：出站认证头，非法/缺失回落按默认面推导
export function resolveUpstreamAuthConfig(row: {
  protocol: string;
  protocols?: string | null;
  authStyle?: string | null;
}): { protocol: Protocol; protocols: Protocol[]; authStyle: AuthStyle } {
  const protocol: Protocol = isProtocol(row.protocol) ? row.protocol : "openai";
  const protocols = normalizeUpstreamProtocols(row.protocols, protocol);
  const authStyle = isAuthStyle(row.authStyle)
    ? row.authStyle
    : defaultAuthStyleForProtocol(protocols[0]!);
  return { protocol, protocols, authStyle };
}

export function buildAuthHeaders(
  authStyle: AuthStyle,
  apiKey: string
): Record<string, string> {
  switch (authStyle) {
    case "x-api-key":
      return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    case "x-goog-api-key":
      return { "x-goog-api-key": apiKey };
    default:
      return { Authorization: `Bearer ${apiKey}` };
  }
}
