import { describe, it, expect } from "vitest";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { compressResponse } from "./compress";

// 压缩层：替代 Next standalone 的 compression()。核心风险是「压了不该压的」（SSE / 网关透传），
// 以及 304/204/206 上多出 Content-Encoding。这里用最小 Hono app 把边界钉住。
const BIG = "x".repeat(4096);

function buildApp() {
  const app = new Hono({ strict: false });
  app.use("*", compressResponse);
  app.all("*", (c) => {
    const path = c.req.path;
    if (path === "/sse") {
      return c.body(BIG, 200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    }
    if (path === "/small") {
      // 声明了 Content-Length 才会走 threshold 判断（与静态文件同路径）
      return c.body("tiny", 200, { "Content-Type": "text/plain", "Content-Length": "4" });
    }
    if (path === "/range") return c.body(BIG, 206, { "Content-Type": "text/html" });
    if (path === "/nocontent") return c.body(null, 304);
    return c.html(BIG);
  });
  return app;
}

const app = buildApp();
const GZIP = { "Accept-Encoding": "gzip" };

describe("compressResponse（hono/compress 包装）", () => {
  it("大 body 压缩，且解压后与原内容一致", async () => {
    const res = await app.request("http://localhost/page", { headers: GZIP });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
    expect(res.headers.get("content-length")).toBeNull();
    const raw = Buffer.from(await res.arrayBuffer());
    expect(gunzipSync(raw).toString()).toBe(BIG);
    expect(raw.length).toBeLessThan(BIG.length);
  });

  it("客户端不支持 gzip 时不压缩", async () => {
    const res = await app.request("http://localhost/page");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(BIG);
  });

  it("网关前缀（/v1 /v1beta /raw）一律不压", async () => {
    for (const path of ["/v1/chat/completions", "/v1beta/models/x", "/raw/openai/v1/x", "/v1"]) {
      const res = await app.request("http://localhost" + path, { headers: GZIP });
      expect(res.headers.get("content-encoding"), path).toBeNull();
      expect(await res.text(), path).toBe(BIG);
    }
  });

  it("SSE（text/event-stream）即便在非网关前缀下也不压", async () => {
    const res = await app.request("http://localhost/sse", { headers: GZIP });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(BIG);
  });

  it("Content-Length 小于阈值（1KB）的响应不压", async () => {
    // 注：hono/compress 的 threshold 依赖 Content-Length；route handler 直接返回 JSON/文本时
    // 平台还没补 Content-Length，会照压（多 20-30 字节 gzip 头，上游 compression 中间件同行为）
    const res = await app.request("http://localhost/small", { headers: GZIP });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe("tiny");
  });

  it("206 / 304 不压", async () => {
    for (const path of ["/range", "/nocontent"]) {
      const res = await app.request("http://localhost" + path, { headers: GZIP });
      expect(res.headers.get("content-encoding"), path).toBeNull();
    }
  });

  it("已带 Content-Encoding 的响应不二次编码", async () => {
    const app2 = new Hono();
    app2.use("*", compressResponse);
    app2.all("*", (c) => c.body(BIG, 200, { "Content-Type": "text/html", "Content-Encoding": "br" }));
    const res = await app2.request("http://localhost/x", { headers: GZIP });
    expect(res.headers.get("content-encoding")).toBe("br");
  });
});
