import { ProxyAgent, type Dispatcher } from "undici";

// 模块级 ProxyAgent 缓存：key = 明文 proxyUrl（含凭据），仅内存驻留，永不落日志。
// 编辑 proxy_url 会生成新 key，旧 entry 惰性驻留；上限 50，超出整体清空重建。

const MAX_PROXY_AGENTS = 50;

const proxyAgentCache = new Map<string, Dispatcher>();

// 返回 undefined 表示直连（null/空字符串）
export function getProxyDispatcher(
  proxyUrl: string | null | undefined
): Dispatcher | undefined {
  if (!proxyUrl || !proxyUrl.trim()) return undefined;
  const cached = proxyAgentCache.get(proxyUrl);
  if (cached) return cached;
  if (proxyAgentCache.size >= MAX_PROXY_AGENTS) {
    proxyAgentCache.clear();
  }
  const agent = new ProxyAgent({ uri: proxyUrl });
  proxyAgentCache.set(proxyUrl, agent);
  return agent;
}
