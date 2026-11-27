// 发往上游的请求头构造（纯逻辑，中心与 relay 共用）。
// 从 proxy.ts 拆出：relay 不得 import proxy.ts，但出站 header 的剔除规则必须同一口径
//（漏剔一个 hop-by-hop header 就可能把客户端凭据/伪造 IP 透给上游）。
import type { Protocol } from "./model-router";
import { buildAuthHeaders } from "./upstream-client";
import { applyHeaderTransforms } from "./header-transforms";
import type { HeaderTransform, HeaderTransformContext } from "./header-transforms";

// 构造发往上游的请求头：剔除客户端认证/传输头，按协议注入真实 key，
// 最后一棒应用 upstream header transforms（fill/override 自定义出站 header）
export function buildUpstreamHeaders(
  clientHeaders: Headers,
  protocol: Protocol,
  apiKey: string,
  transforms?: HeaderTransform[],
  transformContext?: HeaderTransformContext
): Headers {
  const headers = new Headers();
  const SKIP = new Set([
    "host",
    "authorization",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "upgrade",
    // curl 对 >1KB body 默认发 Expect: 100-continue；请求体已在网关整包缓冲，
    // 100-continue 协商不透传——npm undici 不支持 expect 头，转发即 UND_ERR_NOT_SUPPORTED 拒连（502）
    "expect",
    "x-api-key",
    "x-goog-api-key",
    "accept-encoding", // 强制 identity，保证响应体可解析 usage
    // 客户端可控的源信息/会话头一律不透明传给上游（防伪造 IP 溯源、会话窃取）
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-real-ip",
    "forwarded",
    "via",
    "cookie",
    "cf-connecting-ip",
    "true-client-ip",
    "x-client-ip",
    // 服务端写入的 socket 对端地址（内部用途，不得透给上游，也不得让客户端值冒充）
    "x-internal-remote-addr",
  ]);
  clientHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (SKIP.has(lower)) return;
    headers.set(key, value);
  });
  headers.set("accept-encoding", "identity");
  for (const [key, value] of Object.entries(buildAuthHeaders(protocol, apiKey))) {
    headers.set(key, value);
  }
  if (transforms && transforms.length > 0 && transformContext) {
    applyHeaderTransforms(headers, transforms, transformContext);
  }
  return headers;
}
