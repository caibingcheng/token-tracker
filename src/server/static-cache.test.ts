import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createStaticCache } from "./static-cache";

// 协商缓存层：serveStatic 本身只发 Last-Modified、从不返 304（@hono/node-server 无该逻辑），
// 页面壳带 no-cache 时缺校验器就等于每次整包重下。这里钉住 304 的判定与「不误伤」边界。
let root: string;

function buildApp() {
  const app = new Hono();
  app.use("*", createStaticCache(root));
  // 用假 handler 代替 serveStatic：本测试只关心缓存层，不关心文件流
  app.use("*", (c) => c.body("BODY", 200, { "Content-Type": "text/html", "Last-Modified": "x" }));
  return app;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tt-cache-"));
  for (const name of ["index.html", "admin.html", "admin.txt"]) writeFileSync(join(root, name), "hello");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("staticCache（ETag + 304）", () => {
  const app = buildApp();

  it("200 响应补弱 ETag（size-mtime）", async () => {
    const res = await app.request("http://localhost/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  });

  it("If-None-Match 命中 → 304 且不带 body", async () => {
    const first = await app.request("http://localhost/admin");
    const etag = first.headers.get("etag")!;
    const res = await app.request("http://localhost/admin", { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("last-modified")).toBeTruthy();
  });

  it("If-None-Match 弱比较（带/不带 W/ 前缀等价）+ 通配 *", async () => {
    const etag = (await app.request("http://localhost/admin")).headers.get("etag")!;
    const bare = etag.replace(/^W\//, "");
    for (const header of [bare, `"other", ${etag}`, "*"]) {
      const res = await app.request("http://localhost/admin", { headers: { "If-None-Match": header } });
      expect(res.status).toBe(304);
    }
    const miss = await app.request("http://localhost/admin", { headers: { "If-None-Match": 'W/"deadbeef-1"' } });
    expect(miss.status).toBe(200);
  });

  it("If-Modified-Since 按秒比较（mtime 同秒不判变更，早于 mtime 必须 200）", async () => {
    const res = await app.request("http://localhost/admin", {
      headers: { "If-Modified-Since": new Date(Date.now() + 60_000).toUTCString() },
    });
    expect(res.status).toBe(304);
    const stale = await app.request("http://localhost/admin", {
      headers: { "If-Modified-Since": new Date(0).toUTCString() },
    });
    expect(stale.status).toBe(200);
    // 非法日期串不能当成「永不过期」：忽略该头，回 200 全量
    const invalid = await app.request("http://localhost/admin", {
      headers: { "If-Modified-Since": "not-a-date" },
    });
    expect(invalid.status).toBe(200);
  });

  it("有 If-None-Match 时忽略 If-Modified-Since（RFC 9110 13.1.3）", async () => {
    // 两个头同时存在且 INM 未命中：即便 IMS 落在未来也必须 200，否则会把新内容当旧的跳过
    const res = await app.request("http://localhost/admin", {
      headers: {
        "If-None-Match": 'W/"deadbeef-1"',
        "If-Modified-Since": new Date(Date.now() + 60_000).toUTCString(),
      },
    });
    expect(res.status).toBe(200);
  });

  it("RSC payload（admin.txt）同样走协商缓存", async () => {
    const etag = (await app.request("http://localhost/admin.txt")).headers.get("etag");
    const res = await app.request("http://localhost/admin.txt", { headers: { "If-None-Match": etag! } });
    expect(res.status).toBe(304);
  });

  it("非静态路径不参与（不补 ETag、不返 304）", async () => {
    const res = await app.request("http://localhost/api/whatever");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
    const cond = await app.request("http://localhost/api/whatever", { headers: { "If-None-Match": "*" } });
    expect(cond.status).toBe(200);
  });

  it("HEAD 同样走协商缓存，200 时保留 ETag", async () => {
    const head = await app.request("http://localhost/admin", { method: "HEAD" });
    expect(head.status).toBe(200);
    const etag = head.headers.get("etag");
    expect(etag).toBeTruthy();
    const resumed = await app.request("http://localhost/admin", {
      method: "HEAD",
      headers: { "If-None-Match": etag! },
    });
    expect(resumed.status).toBe(304);
  });

  it("非 GET/HEAD 不参与", async () => {
    const res = await app.request("http://localhost/admin", { method: "POST", body: "x" });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
  });

  it("下层返回 206/404 时不补 ETag", async () => {
    const rangeApp = new Hono();
    rangeApp.use("*", createStaticCache(root));
    rangeApp.use("*", (c) => c.body("part", 206));
    expect((await rangeApp.request("http://localhost/admin")).headers.get("etag")).toBeNull();

    const missingApp = new Hono();
    missingApp.use("*", createStaticCache(root));
    missingApp.use("*", (c) => c.text("nf", 404));
    expect((await missingApp.request("http://localhost/nope")).headers.get("etag")).toBeNull();
  });

  it("下层未命中（文件不存在）时不拦截 304", async () => {
    const res = await app.request("http://localhost/nope", { headers: { "If-None-Match": "*" } });
    expect(res.status).toBe(200);
  });
});
