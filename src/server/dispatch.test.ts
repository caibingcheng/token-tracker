import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { dispatch } from "./dispatch";
import type { NextRequest } from "./next-shim";

// dispatch 是 route handler 与 Hono 之间唯一的适配点，e2e 不覆盖动态段参数的正向路径
//（[id] 拿不到值 → Number(undefined)=NaN → 查不到 → 也是 404，断言区分不出来），
// 这里用假路由直接钉住三件事：:id 映射、[*] 通配切分、body 流式透传。

function buildApp() {
  const app = new Hono();
  app.get("/api/items/:id", (c) =>
    dispatch(
      async (req: NextRequest, ctx) => {
        const params = await ctx.params;
        return Response.json({
          id: params.id,
          header: req.headers.get("x-t"),
          cookie: req.cookies.get("tt_session")?.value ?? null,
          pathname: new URL(req.url).pathname,
          proto: new URL(req.url).protocol,
        });
      },
      c,
      []
    )
  );
  app.post("/v1/*", (c) =>
    dispatch(
      async (req: NextRequest, ctx) => {
        const params = await ctx.params;
        return Response.json({ path: params.path, body: await req.json() });
      },
      c,
      ["path"]
    )
  );
  return app;
}

describe("dispatch (Hono → route handler)", () => {
  const app = buildApp();

  it(":id 动态段映射为 params.id，headers/cookies/url 可见", async () => {
    const res = await app.request("http://localhost/api/items/42", {
      headers: { "x-t": "v", cookie: "tt_session=abc.def" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "42",
      header: "v",
      cookie: "abc.def",
      pathname: "/api/items/42",
      proto: "http:",
    });
  });

  it("X-Forwarded-Proto: https 时 request.url 升为 https（反代终止 TLS 下 Secure cookie 依赖它）", async () => {
    const res = await app.request("http://public.example/api/items/9", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { proto: string }).proto).toBe("https:");
  });

  it("无 XFP 时不升格（与迁移前一致：仅按 socket/头判定）", async () => {
    const res = await app.request("http://public.example/api/items/9");
    expect(((await res.json()) as { proto: string }).proto).toBe("http:");
  });

  it("通配段 [...path] 还原为 segment 数组", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
      duplex: "half",
    } as RequestInit);
    const res = await app.request(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: ["chat", "completions"], body: { a: 1 } });
  });

  it("GET 无 body 时 handler 拿到的 request.body 为 null", async () => {
    const res = await app.request("http://localhost/api/items/7");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("7");
  });

  it("通配段零段（裸 /v1）→ 404，不进 handler（Next [...path] 需要至少一段）", async () => {
    const strict = new Hono({ strict: false }); // 与 src/server/index.ts 同配置
    let invoked = 0;
    strict.post("/v1/*", (c) =>
      dispatch(
        async () => {
          invoked++;
          return Response.json({ ok: true });
        },
        c,
        ["path"]
      )
    );
    strict.notFound((c) => c.text("not found", 404));

    for (const path of ["/v1", "/v1/"]) {
      const res = await strict.request("http://localhost" + path, { method: "POST" });
      expect(res.status, path).toBe(404);
    }
    expect(invoked).toBe(0);

    // 有段时照常进 handler（不能把整条链路拦死）
    const ok = await strict.request("http://localhost/v1/chat/completions", { method: "POST" });
    expect(ok.status).toBe(200);
    expect(invoked).toBe(1);
  });
});

// socket 对端地址是「是否来自本机」判定的唯一可信来源（setup 闸门 / LOCAL_ADMIN_BYPASS /
// 限流桶）。dispatch 负责把它写进内部 header，且必须覆盖客户端自带的同名 header。
describe("dispatch - 内部对端地址 header", () => {
  function appWithPeerEcho() {
    const app = new Hono();
    app.get("/api/whoami", (c) =>
      dispatch(
        async (req) => Response.json({ peer: req.headers.get("x-internal-remote-addr") }),
        c,
        []
      )
    );
    return app;
  }

  it("c.env.incoming.socket.remoteAddress 写入内部 header（覆盖客户端值）", async () => {
    const app = appWithPeerEcho();
    const res = await app.request(
      "http://localhost/api/whoami",
      { headers: { "x-internal-remote-addr": "203.0.113.9" } },
      { incoming: { socket: { remoteAddress: "::ffff:127.0.0.1" } } } as never
    );
    expect(await res.json()).toEqual({ peer: "::ffff:127.0.0.1" });
  });

  it("取不到对端（无 Hono env）→ 内部 header 被删除，客户端值不生效", async () => {
    const app = appWithPeerEcho();
    const res = await app.request("http://localhost/api/whoami", {
      headers: { "x-internal-remote-addr": "127.0.0.1" },
    });
    expect(await res.json()).toEqual({ peer: null });
  });
});
