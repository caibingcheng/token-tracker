import { describe, it, expect, afterEach, vi } from "vitest";
import { createGuardedLookup, BlockedOutboundAddressError } from "./outbound-guard";
import { getDirectDispatcher, getOutboundDispatcher } from "./proxy-dispatcher";
import { ProxyAgent } from "undici";

// 连接时 SSRF 防护：给 undici Agent 注入的 lookup 必须对「实际要连的地址」分类，
// DNS rebinding（保存时公网、连接时 127.0.0.1）因此无法绕过。

const ORIG_ALLOW = process.env.ALLOW_PRIVATE_UPSTREAMS;

afterEach(() => {
  if (ORIG_ALLOW === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAMS;
  else process.env.ALLOW_PRIVATE_UPSTREAMS = ORIG_ALLOW;
});

type Cb = (err: NodeJS.ErrnoException | null, address: string | unknown[], family?: number) => void;

function run(
  lookup: (hostname: string, options: unknown, cb: Cb) => void,
  options: unknown = { all: false }
): Promise<{ err: NodeJS.ErrnoException | null; address?: unknown; family?: number }> {
  return new Promise((resolve) => {
    lookup("rebind.example", options, (err, address, family) => resolve({ err, address, family }));
  });
}

describe("createGuardedLookup", () => {
  it("public address passes through unchanged", async () => {
    const lookup = createGuardedLookup(((_h, _o, cb: Cb) => cb(null, "104.18.20.21", 4)) as never);
    const r = await run(lookup);
    expect(r.err).toBeNull();
    expect(r.address).toBe("104.18.20.21");
    expect(r.family).toBe(4);
  });

  it("blocks a rebound loopback address (DNS rebinding)", async () => {
    const lookup = createGuardedLookup(((_h, _o, cb: Cb) => cb(null, "127.0.0.1", 4)) as never);
    const r = await run(lookup);
    expect(r.err).toBeInstanceOf(BlockedOutboundAddressError);
    expect((r.err as NodeJS.ErrnoException).code).toBe("ERR_BLOCKED_OUTBOUND_ADDRESS");
  });

  it("blocks private/metadata IPv4 and IPv6 in one shot", async () => {
    for (const ip of ["10.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "::ffff:7f00:1", "fd00::1"]) {
      const lookup = createGuardedLookup(((_h, _o, cb: Cb) => cb(null, ip, ip.includes(":") ? 6 : 4)) as never);
      const r = await run(lookup);
      expect(r.err, ip).toBeInstanceOf(BlockedOutboundAddressError);
    }
  });

  it("blocks when ANY of the resolved addresses is private (all:true)", async () => {
    const lookup = createGuardedLookup(
      ((_h, _o, cb: Cb) =>
        cb(null, [
          { address: "104.18.20.21", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ], undefined)) as never
    );
    const r = await run(lookup, { all: true });
    expect(r.err).toBeInstanceOf(BlockedOutboundAddressError);
  });

  it("passes an all-public address list through", async () => {
    const list = [
      { address: "104.18.20.21", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ];
    const lookup = createGuardedLookup(((_h, _o, cb: Cb) => cb(null, list, undefined)) as never);
    const r = await run(lookup, { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toBe(list);
  });

  it("propagates resolver errors and empty result sets", async () => {
    const failing = createGuardedLookup(
      ((_h, _o, cb: Cb) => {
        const err: NodeJS.ErrnoException = new Error("boom");
        err.code = "ENOTFOUND";
        cb(err, "", undefined);
      }) as never
    );
    expect((await run(failing)).err?.code).toBe("ENOTFOUND");

    const empty = createGuardedLookup(((_h, _o, cb: Cb) => cb(null, [], undefined)) as never);
    expect((await run(empty)).err?.code).toBe("ENOTFOUND");
  });

  it("ALLOW_PRIVATE_UPSTREAMS=true 全放行（内网自建 LLM 逃生）", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    const lookup = createGuardedLookup(((_h, _o, cb: Cb) => cb(null, "127.0.0.1", 4)) as never);
    const r = await run(lookup);
    expect(r.err).toBeNull();
    expect(r.address).toBe("127.0.0.1");
  });
});

describe("dispatcher 选择", () => {
  it("无 proxyUrl 时返回共享的受保护直连 Agent（缓存复用）", () => {
    const a = getOutboundDispatcher(null);
    const b = getOutboundDispatcher(undefined);
    expect(a).toBe(getDirectDispatcher());
    expect(a).toBe(b);
    expect(a).not.toBeInstanceOf(ProxyAgent);
  });

  it("有 proxyUrl 时返回 ProxyAgent（代理链路本身在写入侧已过 SSRF 校验）", () => {
    const dispatcher = getOutboundDispatcher("https://user:pass@8.8.8.8:3128");
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
  });
});

describe("outbound-fetch（dispatcher 与 fetch 同源约束）", () => {
  it("直连 dispatcher 是 npm undici 的 Agent（必须与 undici fetch 同版本实例）", async () => {
    const { Agent } = await import("undici");
    expect(getDirectDispatcher()).toBeInstanceOf(Agent);
  });

  it("outboundFetch 走可注入实现（不读全局 fetch）", async () => {
    const { outboundFetch, setOutboundFetchImpl } = await import("./outbound-fetch");
    const seen: Array<{ input: unknown; init: unknown }> = [];
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    setOutboundFetchImpl(((input: unknown, init: unknown) => {
      seen.push({ input, init });
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as never);
    try {
      const res = await outboundFetch("https://api.example/v1", {
        method: "POST",
        dispatcher: getDirectDispatcher(),
        redirect: "manual",
      });
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.input).toBe("https://api.example/v1");
      expect((seen[0]!.init as { redirect?: string }).redirect).toBe("manual");
      expect(globalFetch).not.toHaveBeenCalled(); // 绝不落到全局 fetch（版本不匹配会全线失败）
    } finally {
      setOutboundFetchImpl(null);
      vi.unstubAllGlobals();
    }
  });
});
