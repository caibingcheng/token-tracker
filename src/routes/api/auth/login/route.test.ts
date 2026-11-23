import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { closeDb } from "@/lib/db";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { setAdminApiKey, deleteAdminApiKey, deleteSetting } from "@/lib/auth/settings";
import { MAX_AUTH_BODY_BYTES } from "@/lib/auth/request-body";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ORIG_ADMIN = process.env.ADMIN_API_KEY;
const ORIG_LEGACY = process.env.API_KEYS;
const ORIG_TRUSTED = process.env.TRUSTED_PROXY;

const DB_KEY = "Db-Strong-Key-9f3a2b";
const STRONG_ENV_KEY = "Env-Strong-Key-7c1d4e";
const WEAK_ENV_KEY = "weakkey";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-login-route-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
  // 限流取自可信 IP：保持默认（false）= 全局桶，测试内每个用例重置模块拿到新桶
  delete process.env.TRUSTED_PROXY;
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIG_SECRET;
  if (ORIG_ADMIN === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = ORIG_ADMIN;
  if (ORIG_LEGACY === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = ORIG_LEGACY;
  if (ORIG_TRUSTED === undefined) delete process.env.TRUSTED_PROXY;
  else process.env.TRUSTED_PROXY = ORIG_TRUSTED;
});

beforeEach(async () => {
  delete process.env.ADMIN_API_KEY;
  delete process.env.API_KEYS;
  await deleteAdminApiKey();
  await deleteSetting("token_epoch").catch(() => {});
  await deleteSetting("totp_enabled").catch(() => {});
  // 每个用例独立的限流桶（模块级 Map 随模块重置清空）
  vi.resetModules();
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
  delete process.env.API_KEYS;
});

type LoginHandler = (request: NextRequest) => Promise<Response>;

async function handler(): Promise<LoginHandler> {
  const mod = await import("./route");
  return mod.POST as unknown as LoginHandler;
}

function jsonRequest(body: string | null, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers,
    body,
  } as RequestInit);
}

function streamRequest(totalBytes: number): NextRequest {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(16 * 1024, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
}

describe("POST /api/auth/login - 请求体上限", () => {
  it("拒绝超大 body（content-length 声明）413", async () => {
    const POST = await handler();
    const res = await POST(
      jsonRequest(JSON.stringify({ apiKey: "x" }), {
        "content-length": String(MAX_AUTH_BODY_BYTES + 10),
      })
    );
    expect(res.status).toBe(413);
  });

  it("拒绝超大 chunked body（无 content-length）413", async () => {
    const POST = await handler();
    const res = await POST(streamRequest(MAX_AUTH_BODY_BYTES + 1));
    expect(res.status).toBe(413);
  });

  it("坏 JSON → 400，空 apiKey → 400", async () => {
    const POST = await handler();
    expect((await POST(jsonRequest("{bad json"))).status).toBe(400);
    expect((await POST(jsonRequest(JSON.stringify({ apiKey: "  " })))).status).toBe(400);
    expect((await POST(jsonRequest(null))).status).toBe(400);
  });
});

describe("POST /api/auth/login - 限流在读取 body 之前", () => {
  it("缺 key / 坏 JSON / 超大 body 都计入限流，第 11 次返回 429", async () => {
    await setAdminApiKey(DB_KEY);
    const POST = await handler();

    // 前 3 次分别用缺 key、坏 JSON、超大 body 消耗额度
    expect((await POST(jsonRequest(JSON.stringify({})))).status).toBe(400);
    expect((await POST(jsonRequest("{bad"))).status).toBe(400);
    const oversized = await POST(streamRequest(MAX_AUTH_BODY_BYTES + 1));
    expect(oversized.status).toBe(413);

    // 再补 7 次错误凭据（累计 10 次）
    for (let i = 0; i < 7; i++) {
      const res = await POST(jsonRequest(JSON.stringify({ apiKey: "Wrong-Key-9f3a2b" })));
      expect(res.status).toBe(401);
    }

    // 第 11 次：即使凭据正确也必须先被限流拦下（证明 429 判定在读 body 之前）
    const limited = await POST(jsonRequest(JSON.stringify({ apiKey: DB_KEY })));
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });

  it("登录成功后重置计数", async () => {
    await setAdminApiKey(DB_KEY);
    const POST = await handler();
    for (let i = 0; i < 9; i++) {
      await POST(jsonRequest(JSON.stringify({ apiKey: "Wrong-Key-9f3a2b" })));
    }
    const ok = await POST(jsonRequest(JSON.stringify({ apiKey: DB_KEY })));
    expect(ok.status).toBe(200);
    const payload = (await ok.json()) as { token?: string };
    expect(payload.token).toBeTruthy();
    // 计数已清零：还能继续尝试
    const again = await POST(jsonRequest(JSON.stringify({ apiKey: DB_KEY })));
    expect(again.status).toBe(200);
  });
});

describe("POST /api/auth/login - 会话 cookie", () => {
  it("登录成功下发 httpOnly Set-Cookie（body token 保留给脚本）", async () => {
    await setAdminApiKey(DB_KEY);
    const POST = await handler();
    const res = await POST(jsonRequest(JSON.stringify({ apiKey: DB_KEY })));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("tt_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    // localhost 属安全上下文：带 Secure
    expect(setCookie).toContain("Secure");
    const payload = (await res.json()) as { token?: string };
    expect(payload.token).toBeTruthy();
  });

  it("登录失败不下发 cookie", async () => {
    await setAdminApiKey(DB_KEY);
    const POST = await handler();
    const res = await POST(jsonRequest(JSON.stringify({ apiKey: "Wrong-Key-9f3a2b" })));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /api/auth/login - 弱 env key 仅提示", () => {
  it("DB 无 key 时弱 env key 也可登录", async () => {
    process.env.ADMIN_API_KEY = WEAK_ENV_KEY;
    const POST = await handler();
    const res = await POST(jsonRequest(JSON.stringify({ apiKey: WEAK_ENV_KEY })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: string }).token).toBeTruthy();
  });

  it("DB 无 key 时强 env key 可登录", async () => {
    process.env.ADMIN_API_KEY = STRONG_ENV_KEY;
    const POST = await handler();
    const res = await POST(jsonRequest(JSON.stringify({ apiKey: STRONG_ENV_KEY })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: string }).token).toBeTruthy();
  });

  it("DB 有 key 时 env 弱 key 不生效（DB 优先）", async () => {
    await setAdminApiKey(DB_KEY);
    process.env.ADMIN_API_KEY = WEAK_ENV_KEY;
    const POST = await handler();
    expect(
      (await POST(jsonRequest(JSON.stringify({ apiKey: WEAK_ENV_KEY })))).status
    ).toBe(401);
    expect((await POST(jsonRequest(JSON.stringify({ apiKey: DB_KEY })))).status).toBe(200);
  });
});
