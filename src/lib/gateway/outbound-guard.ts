import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import {
  isBlockedOutboundIp,
  isLoopbackIp,
  privateUpstreamsAllowed,
} from "./url-guard";

// 连接时 SSRF 防护（DNS rebinding 的真正解法）：
// 保存配置时的解析结果只代表「那一刻」的 DNS，攻击者可把 TTL 压到 0 让域名在
// 真正建连时解析到 127.0.0.1 / 169.254.169.254。这里给 undici Agent 注入自定义
// `lookup`，把它实际拿到的地址（即将建连的地址）在 connect 之前分类，
// 私网/环回/链路本地/元数据一律拒绝 —— 校验对象与连接对象是同一个解析结果，无法再被换掉。

export class BlockedOutboundAddressError extends Error {
  readonly code = "ERR_BLOCKED_OUTBOUND_ADDRESS";
  constructor() {
    // 不回显具体地址（可能含内网拓扑信息），仅进服务端日志用固定文案
    super("Outbound connection to a private/loopback address is blocked");
    this.name = "BlockedOutboundAddressError";
  }
}

// 与 node:net 的 LookupFunction 同签名（undici 的 connect.lookup 直接透传给 net/tls.connect）
export type NodeLookupFn = (
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number
  ) => void
) => void;

function blocked(): BlockedOutboundAddressError {
  return new BlockedOutboundAddressError();
}

export interface GuardedLookupOptions {
  /**
   * 放行 loopback（127.0.0.0/8、::1）—— 仅供 sync 推送使用：
   * 它的配置层明确允许 loopback 明文 http（本机/容器内 B→A 联调），
   * 若这里不放行，会变成「配置允许、实际不可用」。私网（10/8、192.168/16、ULA…）仍拦。
   */
  allowLoopback?: boolean;
}

// 包装原始 lookup：解析结果逐个分类后才交给 socket。
// baseLookup 可注入（测试用），默认 node:dns.lookup。
export function createGuardedLookup(
  baseLookup: NodeLookupFn = dnsLookup as unknown as NodeLookupFn,
  options: GuardedLookupOptions = {}
): NodeLookupFn {
  const allowLoopback = options.allowLoopback === true;
  return (hostname, lookupOptions, callback) => {
    baseLookup(hostname, lookupOptions, (err, address, family) => {
      if (err) {
        callback(err, "");
        return;
      }
      if (privateUpstreamsAllowed()) {
        callback(null, address, family);
        return;
      }
      const entries: LookupAddress[] = Array.isArray(address)
        ? address
        : typeof address === "string"
          ? [{ address, family: family ?? 0 }]
          : [];
      if (entries.length === 0) {
        const notFound: NodeJS.ErrnoException = new Error(
          "Outbound host did not resolve to any address"
        );
        notFound.code = "ENOTFOUND";
        callback(notFound, "");
        return;
      }
      for (const entry of entries) {
        if (!isBlockedOutboundIp(entry.address)) continue;
        // sync 的 loopback 例外：只放行环回，其他私网/元数据地址照旧拦
        if (allowLoopback && isLoopbackIp(entry.address)) continue;
        callback(blocked(), "");
        return;
      }
      callback(null, address, family);
    });
  };
}
