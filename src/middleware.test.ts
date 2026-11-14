import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { setAdminApiKey, deleteAdminApiKey } from "@/lib/auth/settings";
import { closeDb } from "@/lib/db";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;

const DB_KEY = "Db-Strong-Key-9f3a2b";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-middleware-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIG_SECRET;
});

beforeEach(async () => {
  await setAdminApiKey(DB_KEY);
  vi.resetModules();
});

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/dashboard", { headers });
}

async function run(headers: Record<string, string> = {}) {
  const mod = await import("./middleware");
  return mod.middleware(request(headers));
}

async function validToken(): Promise<string> {
  const { getTokenEpoch } = await import("@/lib/auth/settings");
  return signSessionToken(await getTokenEpoch(), keyFingerprint(DB_KEY));
}

describe("middleware - cookie 认证", () => {
  it("无 header 无 cookie → 401，不下发 Set-Cookie", async () => {
    const res = await run();
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("合法 cookie → 放行", async () => {
    const token = await validToken();
    const res = await run({ cookie: `tt_session=${token}` });
    expect(res.status).toBe(200);
  });

  it("malformed cookie（无点分格式）→ 401 且过期 Set-Cookie 清掉它", async () => {
    const res = await run({ cookie: "tt_session=malformed" });
    expect(res.status).toBe(401);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("伪造 cookie（有格式但验签失败）→ 401 且清 cookie", async () => {
    const res = await run({ cookie: "tt_session=Zm9v.bar" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("空 X-API-Key header 不压制合法 cookie（归一为 null 后 fallback）", async () => {
    const token = await validToken();
    const res = await run({
      "x-api-key": "",
      cookie: `tt_session=${token}`,
    });
    expect(res.status).toBe(200);
  });

  it("非空无效 X-API-Key header 优先于 cookie → 401，且不清可能有效的 cookie", async () => {
    const token = await validToken();
    const res = await run({
      "x-api-key": "forged.token",
      cookie: `tt_session=${token}`,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("有效 X-API-Key header 放行（脚本路径不变）", async () => {
    const res = await run({ "x-api-key": await validToken() });
    expect(res.status).toBe(200);
  });
});
