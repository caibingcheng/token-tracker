// socket 对端地址的传递（安全判定的唯一可信来源）。
//
// 为什么需要这一层：Host / X-Forwarded-For / X-Real-IP 全部是客户端可控 header，
// 不能用来判定"请求是否来自本机"。真实对端地址只能取自 Node 的 IncomingMessage.socket。
// @hono/node-server 把 IncomingMessage 通过 fetch 的第二参数（HttpBindings）暴露给 Hono：
//   node_modules/@hono/node-server/dist/index.mjs  getRequestListener()
//   → `res = fetchCallback(req, { incoming, outgoing })`
// （类型见同包 index.d.mts `type HttpBindings = { incoming: IncomingMessage; outgoing: ServerResponse }`）
// Hono 把它挂在 c.env 上，所以 `c.env.incoming.socket.remoteAddress` 就是对端地址。
//
// 中间层（dispatch / verify-session）在构造内部请求时把对端地址写进内部 header，
// 供 route handler 与 lib（local-bypass / client-ip）读取；写入是**无条件覆盖**，
// 客户端自己带的同名 header 不生效（且该 header 永不转发给 upstream，见 buildUpstreamHeaders）。
import type { Context } from "hono";
import { INTERNAL_REMOTE_ADDR_HEADER } from "@/lib/net/client-ip";

export { INTERNAL_REMOTE_ADDR_HEADER };

interface NodeIncomingLike {
  socket?: { remoteAddress?: string };
}

// 取本次请求的 socket 对端地址；无 Hono env（next dev 单进程 / 单测直调 handler）时 null
export function peerAddress(c: Context): string | null {
  const incoming = (c.env as { incoming?: NodeIncomingLike } | undefined)?.incoming;
  const addr = incoming?.socket?.remoteAddress;
  return typeof addr === "string" && addr !== "" ? addr : null;
}

// 把对端地址写入内部请求 header（就地写，返回同一个 Headers 便于链式使用）
export function applyPeerAddressHeader(headers: Headers, c: Context): Headers {
  const addr = peerAddress(c);
  if (addr) headers.set(INTERNAL_REMOTE_ADDR_HEADER, addr);
  else headers.delete(INTERNAL_REMOTE_ADDR_HEADER);
  return headers;
}
