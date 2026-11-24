import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { signSessionToken } from "@/lib/auth/session";
import { verifySession } from "./verify-session";

// 验签层是 /api 的第一层防漏，排除集必须与 guard-scan.test.ts 的 exempt 文件清单严格对应：
// 只有那 4 条**精确**路径免验签，任何同前缀路径（未来的 login/callback、cli/xxx）都要继续验签。
const ORIG_SECRET = process.env.GATEWAY_SECRET;

beforeAll(() => {
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (ORIG_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIG_SECRET;
});

function buildApp() {
  const app = new Hono({ strict: false }); // 与 src/server/index.ts 同配置
  app.use("/api/*", verifySession);
  app.all("/api/*", (c) => c.json({ reached: c.req.path }));
  return app;
}

describe("verifySession（排除集 + 401 语义）", () => {
  const app = buildApp();

  it("4 条公开路径免验签（含尾斜杠归一）", async () => {
    for (const path of ["/api/auth/login", "/api/auth/setup", "/api/auth/logout", "/api/cli", "/api/cli/"]) {
      const res = await app.request("http://localhost" + path, { method: "POST" });
      expect(res.status).toBe(200);
    }
  });

  it("同前缀但不是公开路径的必须验签（精确匹配，不是前缀匹配）", async () => {
    for (const path of [
      "/api/auth/loginX",
      "/api/auth/loginfoo",
      "/api/auth/logoutx",
      "/api/auth/setup/confirm",
      "/api/auth/login/callback",
      "/api/cli/foo",
      "/api/clee",
    ]) {
      const res = await app.request("http://localhost" + path, { method: "POST" });
      expect(res.status, path).toBe(401);
    }
  });

  it("无 token 的受保护路径 → 401 + 统一错误体", async () => {
    const res = await app.request("http://localhost/api/dashboard");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: "Invalid or missing session token" });
  });

  it("query / HEAD / OPTIONS / 裸 /api 都按同一规则处理", async () => {
    // query 不进 c.req.path，不能影响排除判定
    expect((await app.request("http://localhost/api/cli?tzOffset=480")).status).toBe(200);
    expect((await app.request("http://localhost/api/cli", { method: "HEAD" })).status).toBe(200);
    expect((await app.request("http://localhost/api/cli", { method: "OPTIONS" })).status).toBe(200);
    expect((await app.request("http://localhost/api/auth/login?next=/", { method: "POST" })).status).toBe(200);
    // 同前缀的非公开路径：任何方法都要验签
    expect((await app.request("http://localhost/api/cli/foo")).status).toBe(401);
    expect((await app.request("http://localhost/api/dashboard", { method: "OPTIONS" })).status).toBe(401);
    // 裸 /api 不在排除集：验签而不是放行
    expect((await app.request("http://localhost/api")).status).toBe(401);
  });

  it("签名有效 → 放行到路由", async () => {
    const token = signSessionToken(1, "fp");
    const res = await app.request("http://localhost/api/dashboard", { headers: { "X-API-Key": token } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: "/api/dashboard" });
  });

  it("签名被篡改 → 401", async () => {
    // 只改 base64url **末**字符不可靠：32 字节 HMAC 的末字符含 padding bit，
    // 落在 'A'-'D' 区间时解码回同一串字节 → 验签仍通过（与 src/lib/auth/session 单测同坑）。
    // 改签名段**首**字符才落在全有效位。
    const token = signSessionToken(1, "fp");
    const dot = token.indexOf(".");
    const sig = token.slice(dot + 1);
    const broken = `${token.slice(0, dot)}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    const res = await app.request("http://localhost/api/dashboard", { headers: { "X-API-Key": broken } });
    expect(res.status).toBe(401);
  });

  it("非 /api 路径不参与验签", async () => {
    const app2 = new Hono({ strict: false });
    app2.use("/api/*", verifySession);
    app2.get("/v1/*", (c) => c.text("gateway"));
    const res = await app2.request("http://localhost/v1/chat/completions");
    expect(res.status).toBe(200);
  });

  it("GATEWAY_SECRET 缺失 → 503（不静默降级）", async () => {
    const secret = process.env.GATEWAY_SECRET;
    delete process.env.GATEWAY_SECRET;
    try {
      const res = await app.request("http://localhost/api/dashboard", {
        headers: { "X-API-Key": "anything.sig" },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        success: false,
        error: "GATEWAY_SECRET is not configured",
      });
      // 公开路径不受 secret 缺失影响
      expect((await app.request("http://localhost/api/cli")).status).toBe(200);
    } finally {
      process.env.GATEWAY_SECRET = secret;
    }
  });
});
