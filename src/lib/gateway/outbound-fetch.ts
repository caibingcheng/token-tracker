import { fetch as undiciFetch, type Dispatcher } from "undici";
import { assertOutboundUrlAllowed, type OutboundScope } from "./url-guard";

// 带真实 key 的出站请求统一走 npm undici 自带的 fetch。
//
// 为什么不能用 Node 内建（全局）fetch 配 npm undici 的 Dispatcher：
// npm undici 8 的 Dispatcher 接口新增了 `onRequestStart` 等 handler 方法，而 Node 进程内建的
// undici（Node 24 = 7.29）仍按旧 handler 接口调用 —— 把 undici 8 的 Agent / ProxyAgent 传给
// 全局 fetch 会直接抛 `UND_ERR_INVALID_ARG: invalid onRequestStart method`，
// 所有出站请求（含连接时 SSRF 校验、proxy_url 代理链路）全部失败。
// 因此 dispatcher 与 fetch 必须来自同一个 undici 实例。

export type OutboundInit = RequestInit & {
  /** undici（连接时地址校验 / ProxyAgent），与 fetch 同源 */
  dispatcher?: Dispatcher;
  /** 流式请求体需要半双工 */
  duplex?: "half";
  /**
   * 目标用途（决定 URL 安全策略，默认 "upstream"）：
   * - upstream / proxy：HTTP/HTTPS 均允许，私网/环回字面 IP 需 ALLOW_PRIVATE_UPSTREAMS
   * - sync：HTTP/HTTPS 均允许，额外允许 loopback，其他私网仍需逃生开关
   */
  scope?: OutboundScope;
};

export type OutboundFetch = (
  input: string | URL,
  init?: OutboundInit
) => Promise<Response>;

const defaultImpl: OutboundFetch = (input, init) => {
  // scope 是本模块的策略参数，不传给 undici
  const { scope: _scope, ...rest } = init ?? {};
  return undiciFetch(String(input), rest as never) as unknown as Promise<Response>;
};

let impl: OutboundFetch = defaultImpl;

// 单个出站请求入口：调用方一律用它，禁止裸 fetch 直连（会绕过 dispatcher 与 redirect 约定）。
// 这里同时是**运行时 URL 安全边界**：写入校验挡不住存量行（旧配置、直接改库、env 覆盖），
// 所以在真正发请求前按 scope 再校验一次 —— 私网字面 IP 与非法 scheme 均 fail-closed。
// 声明为 async：URL 校验失败时返回 rejected promise（而不是同步抛出），
// 与 fetch 的调用约定一致 —— 调用方的 try/await 能统一兜住
export async function outboundFetch(
  input: string | URL,
  init?: OutboundInit
): Promise<Response> {
  assertOutboundUrlAllowed(String(input), init?.scope ?? "upstream");
  const { scope: _scope, ...rest } = init ?? {};
  return impl(input, rest as OutboundInit);
}

// 测试注入点（替代 vi.stubGlobal("fetch")，因为本模块不读全局 fetch）。
// 参数放宽为 unknown：测试常传 vi.fn() mock，不必在每个用例里写类型断言
export function setOutboundFetchImpl(next: unknown): void {
  impl = (next as OutboundFetch | null) ?? defaultImpl;
}
