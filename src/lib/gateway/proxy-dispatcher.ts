import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { createGuardedLookup } from "./outbound-guard";
import { assertOutboundUrlAllowed } from "./url-guard";

// 出站 dispatcher 统一入口：
// - 配了 proxy_url → ProxyAgent（模块级缓存，key = 明文 proxyUrl，仅内存驻留，永不落日志）
// - 未配 → 共享 Agent，注入连接时地址校验（防 DNS rebinding，见 outbound-guard.ts）
// - sync 推送 → 单独的 loopback-scoped Agent（只额外放行环回，见 getSyncDispatcher）
// 所有带真实 key 的出站 fetch 都必须走这里，不允许裸 fetch 直连。

const MAX_PROXY_AGENTS = 50;

const proxyAgentCache = new Map<string, Dispatcher>();

export interface ProxyAgentOptionsInput {
  uri: string;
  // undici ProxyAgent：proxyTls 用于「客户端 → 代理主机」这条连接（internal buildConnector
  // 把其中的 lookup 直接透传给 net/tls.connect），requestTls 用于隧道内到目标的那段 TLS
  // （socket 已建，不再做 DNS），因此防 rebinding 要挂在 proxyTls.lookup 上。
  proxyTls: { lookup: ReturnType<typeof createGuardedLookup> };
}

// 纯函数：ProxyAgent 构造参数（单测断言 lookup 确实挂上去了）
export function buildProxyAgentOptions(proxyUrl: string): ProxyAgentOptionsInput {
  return {
    uri: proxyUrl,
    proxyTls: { lookup: createGuardedLookup() },
  };
}

// 返回 undefined 表示直连（null/空字符串）。
// 运行时校验：存量 proxy 配置也可能指向私网字面 IP（写入校验当初没拦），
// 这里再拦一次（fail-closed），并且代理主机本身的 DNS 解析走 createGuardedLookup。HTTP/HTTPS 均允许。
export function getProxyDispatcher(
  proxyUrl: string | null | undefined
): Dispatcher | undefined {
  if (!proxyUrl || !proxyUrl.trim()) return undefined;
  const cached = proxyAgentCache.get(proxyUrl);
  if (cached) return cached;
  // 统一出站 URL 校验（HTTP/HTTPS 均允许；私网/环回字面 IP 需逃生开关）
  assertOutboundUrlAllowed(proxyUrl, "proxy");
  if (proxyAgentCache.size >= MAX_PROXY_AGENTS) {
    proxyAgentCache.clear();
  }
  const agent = new ProxyAgent(buildProxyAgentOptions(proxyUrl));
  proxyAgentCache.set(proxyUrl, agent);
  return agent;
}

let directAgent: Agent | null = null;
let syncAgent: Agent | null = null;

// 直连 Agent：连接时地址校验挂在 connect.lookup 上，校验地址 = 实际建连地址
export function getDirectDispatcher(): Dispatcher {
  if (!directAgent) {
    directAgent = new Agent({ connect: { lookup: createGuardedLookup() } });
  }
  return directAgent;
}

// sync 专用直连 Agent：额外放行 loopback（配置层允许 loopback 明文 http 的 B→A 联调场景），
// 私网/元数据地址照旧拦截 —— 不为 sync 全面放开私网
export function getSyncDispatcher(): Dispatcher {
  if (!syncAgent) {
    syncAgent = new Agent({ connect: { lookup: createGuardedLookup(undefined, { allowLoopback: true }) } });
  }
  return syncAgent;
}

export interface OutboundDispatcherOptions {
  /** sync 推送：loopback 例外（与配置层 isSecureSyncTarget 对齐） */
  allowLoopback?: boolean;
}

// 恒返回 dispatcher（proxy 优先，否则受地址校验保护的直连 Agent），调用方直接注入 fetch init
export function getOutboundDispatcher(
  proxyUrl?: string | null,
  options: OutboundDispatcherOptions = {}
): Dispatcher {
  return getProxyDispatcher(proxyUrl) ?? (options.allowLoopback ? getSyncDispatcher() : getDirectDispatcher());
}
