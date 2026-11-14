import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { closeDb } from "@/lib/db";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { setAdminApiKey, deleteAdminApiKey, deleteSetting } from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ORIG_ADMIN = process.env.ADMIN_API_KEY;

const DB_KEY = "Db-Strong-Key-9f3a2b";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-session-route-"));
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
  if (ORIG_ADMIN === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = ORIG_ADMIN;
});

beforeEach(async () => {
  delete process.env.ADMIN_API_KEY;
  await setAdminApiKey(DB_KEY);
  await deleteSetting("session_token_ttl_hours").catch(() => {});
  vi.resetModules();
});

function cookieRequest(cookie: string | null): NextRequest {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://localhost/api/auth/session", { headers });
}

function authedRequest(token: string): NextRequest {
  return new NextRequest("http://localhost/api/auth/session", {
    headers: { "x-api-key": token },
  });
}

async function getHandler() {
  const mod = await import("./route");
  return mod.GET as unknown as (request: NextRequest) => Promise<Response>;
}

describe("GET /api/auth/session - 登录态探测", () => {
  it("无 cookie → 401（未登录）", async () => {
    const GET = await getHandler();
    expect((await GET(cookieRequest(null))).status).toBe(401);
  });

  it("cookie 中的有效会话 token → 200", async () => {
    const GET = await getHandler();
    const { getTokenEpoch } = await import("@/lib/auth/settings");
    const epoch = await getTokenEpoch();
    const token = signSessionToken(epoch, keyFingerprint(DB_KEY));
    const res = await GET(cookieRequest(`tt_session=${token}`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { authenticated?: boolean }).authenticated).toBe(true);
  });

  it("cookie 中 token 即将过期 → 续期 Set-Cookie，且不再下发 X-Session-Token（防同源 JS 读走续期 token）", async () => {
    const GET = await getHandler();
    const { getTokenEpoch } = await import("@/lib/auth/settings");
    const epoch = await getTokenEpoch();
    // 签 2h TTL：默认 24h 的一半是 12h，剩余 2h → 触发滑动续期
    const token = signSessionToken(epoch, keyFingerprint(DB_KEY), 2 * 60 * 60 * 1000);
    const res = await GET(cookieRequest(`tt_session=${token}`));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("tt_session=");
    expect(setCookie).not.toContain(token.slice(0, 20)); // 必须是新签的 token
    expect(res.headers.get("x-session-token")).toBeNull();
  });

  it("header 认证且 token 即将过期 → 续期 X-Session-Token，但不 Set-Cookie", async () => {
    const GET = await getHandler();
    const { getTokenEpoch } = await import("@/lib/auth/settings");
    const epoch = await getTokenEpoch();
    const token = signSessionToken(epoch, keyFingerprint(DB_KEY), 2 * 60 * 60 * 1000);
    const res = await GET(authedRequest(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-session-token")).toBeTruthy();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("空 X-API-Key header 不压制 cookie fallback（归一为 null）", async () => {
    const GET = await getHandler();
    const { getTokenEpoch } = await import("@/lib/auth/settings");
    const epoch = await getTokenEpoch();
    const token = signSessionToken(epoch, keyFingerprint(DB_KEY));
    const req = cookieRequest(`tt_session=${token}`);
    req.headers.set("x-api-key", "");
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it("伪造 cookie → 401", async () => {
    const GET = await getHandler();
    expect((await GET(cookieRequest("tt_session=forged.payload"))).status).toBe(401);
  });
});
