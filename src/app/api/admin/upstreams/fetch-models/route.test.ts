import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import {
  db,
  initDatabase,
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
  dir = mkdtempSync(join(tmpdir(), "tt-fetch-models-route-"));
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

async function insertUpstreamWithKey(name: string): Promise<number> {
  return withSkipCache(async () => {
    const row = await db
      .insert(upstreamsTable)
      .values({
        name,
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        enabledModels: JSON.stringify(["gpt-4o"]),
        priority: 0,
        enabled: 1,
      })
      .returning();
    await db.insert(upstreamKeysTable).values({
      upstreamId: row[0]!.id,
      apiKeyEncrypted: encryptSecret("sk-stored"),
      enabled: 1,
    });
    return row[0]!.id;
  });
}

describe("/api/admin/upstreams/fetch-models", () => {
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
    const res = await POST(req("/api/admin/upstreams/fetch-models"));
    expect(res.status).toBe(401);
  });

  it("私有地址 baseUrl 拒绝 400（明文 key 模式），且不发起 fetch", async () => {
    const token = await makeToken();
    const res = await POST(
      req("/api/admin/upstreams/fetch-models", token, {
        protocol: "openai",
        baseUrl: "http://169.254.169.254",
        apiKey: "sk-test",
      })
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("私有地址 baseUrl 拒绝 400（upstreamId 存储 key 模式），且不发起 fetch", async () => {
    const upstreamId = await insertUpstreamWithKey("stored-key-up");
    const token = await makeToken();
    const res = await POST(
      req("/api/admin/upstreams/fetch-models", token, {
        protocol: "openai",
        baseUrl: "http://192.168.0.10",
        upstreamId,
      })
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("合法 baseUrl + upstreamId 用存储 key 拉取成功", async () => {
    const upstreamId = await insertUpstreamWithKey("stored-key-up");
    const token = await makeToken();
    const res = await POST(
      req("/api/admin/upstreams/fetch-models", token, {
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        upstreamId,
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.models).toEqual(["gpt-4o"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://8.8.8.8/models");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-stored");
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
      req("/api/admin/upstreams/fetch-models", token, {
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
      req("/api/admin/upstreams/fetch-models", token, {
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
    const res = await POST(
      req("/api/admin/upstreams/fetch-models", token, {
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        apiKey: "sk-test",
        proxyUrl: "socks5://8.8.8.8:1080",
      })
    );
    expect(res.status).toBe(400);
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
      await db.insert(upstreamKeysTable).values({
        upstreamId: row[0]!.id,
        apiKeyEncrypted: encryptSecret("sk-stored"),
        enabled: 1,
      });
      return row[0]!.id;
    });
    const token = await makeToken();
    const res = await POST(
      req("/api/admin/upstreams/fetch-models", token, {
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        upstreamId,
      })
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    expect(init.dispatcher).toBeDefined();
  });
});
