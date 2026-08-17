import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import {
  db,
  initDatabase,
  tokenRecords,
  upstreamsTable,
  upstreamKeysTable,
  virtualKeysTable,
} from "@/lib/db";
import { setAdminApiKey, getTokenEpoch, deleteSetting } from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret } from "@/lib/gateway/crypto";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-test-connection-route-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIG_SECRET;
});

beforeEach(async () => {
  await initDatabase();
  await withSkipCache(async () => {
    await db.delete(tokenRecords);
    await db.delete(upstreamKeysTable);
    await db.delete(upstreamsTable);
    await db.delete(virtualKeysTable);
  });
  await deleteSetting("token_epoch").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/admin/upstreams/test-connection", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("未认证 401", async () => {
    const res = await POST(req("/api/admin/upstreams/test-connection"));
    expect(res.status).toBe(401);
  });

  it("私有地址 baseUrl 拒绝 400，且不发起 fetch", async () => {
    const token = await makeToken();
    for (const baseUrl of [
      "http://127.0.0.1",
      "http://169.254.169.254",
      "http://192.168.1.1",
    ]) {
      const res = await POST(
        req("/api/admin/upstreams/test-connection", token, {
          protocol: "openai",
          baseUrl,
          apiKey: "sk-test",
        })
      );
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("格式非法 baseUrl 拒绝 400", async () => {
    const token = await makeToken();
    const res = await POST(
      req("/api/admin/upstreams/test-connection", token, {
        protocol: "openai",
        baseUrl: "ftp://api.example",
        apiKey: "sk-test",
      })
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("合法 baseUrl 走 fetch（redirect: manual）", async () => {
    const token = await makeToken();
    const res = await POST(
      req("/api/admin/upstreams/test-connection", token, {
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        apiKey: "sk-test",
      })
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init as RequestInit & { redirect?: string }).redirect).toBe("manual");
  });

  it("3xx 视为失败且不跟随重定向", async () => {
    fetchMock.mockResolvedValue(
      new Response("redirecting", {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      })
    );
    const token = await makeToken();
    const res = await POST(
      req("/api/admin/upstreams/test-connection", token, {
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        apiKey: "sk-test",
      })
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.data.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("显式 proxyUrl 校验并透传 dispatcher", async () => {
    const token = await makeToken();
    const res = await POST(
      req("/api/admin/upstreams/test-connection", token, {
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        apiKey: "sk-test",
        proxyUrl: "http://user:pass@8.8.8.8:3128",
      })
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    expect(init.dispatcher).toBeDefined();
  });

  it("非法 proxyUrl 400 且不发起 fetch", async () => {
    const token = await makeToken();
    for (const proxyUrl of ["socks5://8.8.8.8:1080", "http://127.0.0.1:8080"]) {
      const res = await POST(
        req("/api/admin/upstreams/test-connection", token, {
          protocol: "openai",
          baseUrl: "https://8.8.8.8",
          apiKey: "sk-test",
          proxyUrl,
        })
      );
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("未显式 proxyUrl 时用 upstreamId 从库存解密补充", async () => {
    const upstreamId = await withSkipCache(async () => {
      const row = await db
        .insert(upstreamsTable)
        .values({
          name: "proxy-stored-up",
          protocol: "openai",
          baseUrl: "https://8.8.8.8",
          enabledModels: JSON.stringify(["gpt-4o"]),
          priority: 0,
          enabled: 1,
          proxyUrlEncrypted: encryptSecret("http://user:pass@8.8.8.8:3128"),
        })
        .returning();
      return row[0]!.id;
    });
    const token = await makeToken();
    const res = await POST(
      req("/api/admin/upstreams/test-connection", token, {
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        apiKey: "sk-test",
        upstreamId,
      })
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    expect(init.dispatcher).toBeDefined();
  });
});
