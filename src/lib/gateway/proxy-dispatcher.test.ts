import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { createServer, type Server } from "node:net";
import {
  getProxyDispatcher,
  buildProxyAgentOptions,
  getDirectDispatcher,
  getSyncDispatcher,
  getOutboundDispatcher,
} from "@/lib/gateway/proxy-dispatcher";
import { createGuardedLookup } from "@/lib/gateway/outbound-guard";
import { outboundFetch } from "@/lib/gateway/outbound-fetch";
import { Agent, ProxyAgent } from "undici";

const ORIG_ALLOW = process.env.ALLOW_PRIVATE_UPSTREAMS;

afterEach(() => {
  if (ORIG_ALLOW === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAMS;
  else process.env.ALLOW_PRIVATE_UPSTREAMS = ORIG_ALLOW;
});

describe("getProxyDispatcher", () => {
  it("returns undefined for null/empty proxyUrl", () => {
    expect(getProxyDispatcher(null)).toBeUndefined();
    expect(getProxyDispatcher(undefined)).toBeUndefined();
    expect(getProxyDispatcher("")).toBeUndefined();
    expect(getProxyDispatcher("   ")).toBeUndefined();
  });

  it("returns the same instance for the same URL (cache)", () => {
    const a = getProxyDispatcher("https://proxy.example.com:3128");
    const b = getProxyDispatcher("https://proxy.example.com:3128");
    expect(a).toBeInstanceOf(ProxyAgent);
    expect(a).toBe(b);
  });

  it("returns distinct instances for distinct URLs", () => {
    const a = getProxyDispatcher("https://proxy-a.example.com:3128");
    const b = getProxyDispatcher("https://proxy-b.example.com:3128");
    expect(a).not.toBe(b);
  });

  it("treats URLs differing in credentials as distinct keys", () => {
    const a = getProxyDispatcher("https://user1:pass1@proxy.example.com:3128");
    const b = getProxyDispatcher("https://user2:pass2@proxy.example.com:3128");
    expect(a).not.toBe(b);
  });

  it("rebuilds cache after exceeding the 50-entry cap", () => {
    const first = getProxyDispatcher("https://cap-check.example.com:1");
    for (let i = 0; i < 55; i++) {
      getProxyDispatcher(`https://bulk-${i}.example.com:${1000 + i}`);
    }
    const after = getProxyDispatcher("https://cap-check.example.com:1");
    expect(after).toBeInstanceOf(ProxyAgent);
    expect(after).not.toBe(first);
  });

  it("运行时允许公网 HTTP 代理，私网字面 IP 仍被拒（fail-closed）", () => {
    expect(getProxyDispatcher("http://proxy.example.com:3128")).toBeInstanceOf(ProxyAgent);
    expect(getProxyDispatcher("http://user:pass@8.8.8.8:3128")).toBeInstanceOf(ProxyAgent);
    expect(() => getProxyDispatcher("https://169.254.169.254:3128")).toThrow(/private/);
    expect(() => getProxyDispatcher("https://127.0.0.1:3128")).toThrow(/private/);
    // 逃生开关打开后内网代理可用
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    expect(getProxyDispatcher("http://10.0.0.9:3128")).toBeInstanceOf(ProxyAgent);
  });
});

describe("ProxyAgent 主机的连接时地址校验（DNS rebinding）", () => {
  it("ProxyAgent 构造参数把 guarded lookup 挂在 proxyTls 上（undici 的 proxy 连接 = proxyTls）", () => {
    const options = buildProxyAgentOptions("https://user:pass@proxy.example.com:3128");
    expect(options.uri).toBe("https://user:pass@proxy.example.com:3128");
    expect(typeof options.proxyTls.lookup).toBe("function");
  });

  it("挂在 ProxyAgent 上的 lookup 真的按地址分类（真实 DNS：localhost → loopback 被拦）", async () => {
    // buildProxyAgentOptions 用的是默认真实 DNS lookup，这里用一定能解析的 localhost
    // 验证「代理主机解析结果」会被分类拦截（不是只挂了个函数）
    const lookup = buildProxyAgentOptions("https://proxy.example.com:3128").proxyTls.lookup;
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      lookup("localhost", { all: true }, (e) => resolve(e));
    });
    expect(err?.code).toBe("ERR_BLOCKED_OUTBOUND_ADDRESS");
  });
});

// 真实网络行为验证：本地 TCP 监听充「假代理」，用一个解析到 loopback 的代理主机名，
// 断言 guarded lookup 在建连之前就拦住（连接数 0）；打开逃生开关后才会真的连上去。
// 这验证的是 npm undici 8 的实际行为（proxyTls.lookup 是否真的作用于代理连接）。
describe("ProxyAgent 代理主机的真实建连拦截", () => {
  // 单个 server 贯穿整个 describe（每次测试重置计数）：避免多次创建导致句柄泄漏、
  // 让 vitest worker 无法正常退出。
  const state = { connections: 0 };
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer((socket) => {
      state.connections += 1;
      socket.on("error", () => {});
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function attemptProxy(proxyUrl: string): Promise<{ status: number; error: unknown }> {
    state.connections = 0;
    try {
      const res = await outboundFetch("https://example.com/", {
        dispatcher: getProxyDispatcher(proxyUrl),
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      await res.body?.cancel();
      return { status: res.status, error: null };
    } catch (error) {
      return { status: 0, error };
    }
  }

  function codesOf(err: unknown): string[] {
    const codes: string[] = [];
    let cur: unknown = err;
    for (let i = 0; i < 6 && cur; i++) {
      const rec = cur as { code?: unknown; cause?: unknown };
      if (typeof rec.code === "string") codes.push(rec.code);
      cur = rec.cause;
    }
    return codes;
  }

  it("代理主机解析到 loopback → 建连前拦截（0 连接，ERR_BLOCKED_OUTBOUND_ADDRESS）", async () => {
    const { error, status } = await attemptProxy(`https://localhost:${port}`);
    expect(status).toBe(0);
    expect(codesOf(error)).toContain("ERR_BLOCKED_OUTBOUND_ADDRESS");
    expect(state.connections).toBe(0);
  });

  it("ALLOW_PRIVATE_UPSTREAMS=true → 放行到代理主机（真实发起连接）", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const { error, status } = await attemptProxy(`https://localhost:${port}`);
    // 假代理不做 TLS，必然失败，但连接必须已经发生（证明 lookup 例外生效）
    expect(status).toBe(0);
    expect(error).not.toBeNull();
    expect(state.connections).toBeGreaterThan(0);
    expect(codesOf(error)).not.toContain("ERR_BLOCKED_OUTBOUND_ADDRESS");
  });
});

describe("dispatcher 选择", () => {
  it("无 proxyUrl 时返回共享的受保护直连 Agent（缓存复用）", () => {
    const a = getOutboundDispatcher(null);
    const b = getOutboundDispatcher(undefined);
    expect(a).toBe(getDirectDispatcher());
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(Agent);
    expect(a).not.toBeInstanceOf(ProxyAgent);
  });

  it("sync 使用单独 loopback-scoped Agent（只额外放行环回）", () => {
    const sync = getOutboundDispatcher(null, { allowLoopback: true });
    expect(sync).toBe(getSyncDispatcher());
    expect(sync).not.toBe(getDirectDispatcher());
    expect(sync).toBeInstanceOf(Agent);
  });

  it("有 proxyUrl 时返回 ProxyAgent（代理主机同样受连接时校验）", () => {
    const dispatcher = getOutboundDispatcher("https://user:pass@8.8.8.8:3128");
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
  });
});

describe("createGuardedLookup 的 loopback 例外只属 sync", () => {
  const lookupWith = (
    ip: string,
    options?: { allowLoopback?: boolean }
  ): Promise<NodeJS.ErrnoException | null> =>
    new Promise((resolve) => {
      const base = ((
        _host: string,
        _opts: unknown,
        cb: (err: NodeJS.ErrnoException | null, address: string, family?: number) => void
      ) => cb(null, ip, ip.includes(":") ? 6 : 4)) as never;
      createGuardedLookup(base, options)("host.example", { all: false }, (err) => resolve(err));
    });

  it("默认口径（upstream/proxy）：loopback 一律拦", async () => {
    for (const ip of ["127.0.0.1", "::1"]) {
      const err = await lookupWith(ip);
      expect(err?.code, ip).toBe("ERR_BLOCKED_OUTBOUND_ADDRESS");
    }
  });

  it("sync 口径（allowLoopback）：loopback 放行，私网/元数据仍拦", async () => {
    for (const ip of ["127.0.0.1", "::1"]) {
      expect(await lookupWith(ip, { allowLoopback: true }), ip).toBeNull();
    }
    for (const ip of ["10.0.0.9", "192.168.1.10", "169.254.169.254", "fd00::1"]) {
      const err = await lookupWith(ip, { allowLoopback: true });
      expect(err?.code, ip).toBe("ERR_BLOCKED_OUTBOUND_ADDRESS");
    }
  });
});
