import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET as LIST_GET, POST as LIST_POST } from "./route";
import { GET as ITEM_GET, PATCH } from "./[id]/route";
import { db, initDatabase, upstreamsTable, upstreamKeysTable, tokenRecords } from "@/lib/db";
import { eq } from "drizzle-orm";
import { setAdminApiKey, getTokenEpoch, deleteSetting } from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";
import { decryptSecret } from "@/lib/gateway/crypto";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-upstreams-route-"));
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
  });
  await deleteSetting("token_epoch").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, method: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": token ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const PROXY = "http://user:pass@8.8.8.8:3128";
const PROXY2 = "https://1.1.1.1:8080";

describe("/api/admin/upstreams - proxy_url", () => {
  it("POST 加密落库：密文 ≠ 明文且可 decrypt 还原", async () => {
    const token = await makeToken();
    const res = await LIST_POST(
      req("/api/admin/upstreams", "POST", token, {
        name: "up1",
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        enabledModels: ["gpt-4o"],
        proxyUrl: PROXY,
      })
    );
    expect(res.status).toBe(201);

    const rows = await withSkipCache(async () =>
      db.select().from(upstreamsTable).where(eq(upstreamsTable.name, "up1"))
    );
    expect(rows).toHaveLength(1);
    const stored = rows[0]!.proxyUrlEncrypted as string;
    expect(stored).not.toBe(PROXY);
    expect(decryptSecret(stored)).toBe(PROXY);
  });

  it("POST 不带 proxyUrl 时落库 NULL", async () => {
    const token = await makeToken();
    const res = await LIST_POST(
      req("/api/admin/upstreams", "POST", token, {
        name: "up2",
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
      })
    );
    expect(res.status).toBe(201);
    const rows = await withSkipCache(async () =>
      db.select().from(upstreamsTable).where(eq(upstreamsTable.name, "up2"))
    );
    expect(rows[0]!.proxyUrlEncrypted).toBeNull();
  });

  it("POST 非法 proxyUrl 400（socks5/私网地址）", async () => {
    const token = await makeToken();
    for (const bad of ["socks5://proxy:1080", "http://127.0.0.1:8080", "http://192.168.1.1:3128"]) {
      const res = await LIST_POST(
        req("/api/admin/upstreams", "POST", token, {
          name: "up-bad",
          protocol: "openai",
          baseUrl: "https://8.8.8.8",
          proxyUrl: bad,
        })
      );
      expect(res.status).toBe(400);
    }
    const count = await withSkipCache(async () =>
      db.select({ id: upstreamsTable.id }).from(upstreamsTable)
    );
    expect(count).toHaveLength(0);
  });

  it("GET 列表返回 hasProxy/proxyDisplay 且不泄漏 userinfo", async () => {
    const token = await makeToken();
    await LIST_POST(
      req("/api/admin/upstreams", "POST", token, {
        name: "up1",
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        proxyUrl: PROXY,
      })
    );
    await LIST_POST(
      req("/api/admin/upstreams", "POST", token, {
        name: "up2",
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
      })
    );
    const res = await LIST_GET(req("/api/admin/upstreams", "GET", token));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: any[] };
    const body = JSON.stringify(data);
    expect(body).not.toContain("user:pass");
    expect(body).not.toContain(PROXY);
    const up1 = data.find((d) => d.name === "up1");
    const up2 = data.find((d) => d.name === "up2");
    expect(up1.hasProxy).toBe(true);
    expect(up1.proxyDisplay).toBe("http://8.8.8.8:3128");
    expect(up2.hasProxy).toBe(false);
    expect(up2.proxyDisplay).toBeNull();
    expect("proxyUrlEncrypted" in up1).toBe(false);
  });

  it("GET 单项返回脱敏字段且不泄漏凭据", async () => {
    const token = await makeToken();
    const createRes = await LIST_POST(
      req("/api/admin/upstreams", "POST", token, {
        name: "up1",
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        proxyUrl: PROXY,
      })
    );
    const { data } = (await createRes.json()) as { data: { id: number } };
    const res = await ITEM_GET(
      req(`/api/admin/upstreams/${data.id}`, "GET", token),
      { params: { id: String(data.id) } }
    );
    expect(res.status).toBe(200);
    const item = await res.json();
    const body = JSON.stringify(item);
    expect(body).not.toContain("user:pass");
    expect(item.data.hasProxy).toBe(true);
    expect(item.data.proxyDisplay).toBe("http://8.8.8.8:3128");
    expect("proxyUrlEncrypted" in item.data).toBe(false);
  });

  it("PATCH 换代理：新值加密替换", async () => {
    const token = await makeToken();
    const createRes = await LIST_POST(
      req("/api/admin/upstreams", "POST", token, {
        name: "up1",
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        proxyUrl: PROXY,
      })
    );
    const { data } = (await createRes.json()) as { data: { id: number } };
    const res = await PATCH(
      req(`/api/admin/upstreams/${data.id}`, "PATCH", token, { proxyUrl: PROXY2 }),
      { params: { id: String(data.id) } }
    );
    expect(res.status).toBe(200);
    const rows = await withSkipCache(async () =>
      db.select().from(upstreamsTable).where(eq(upstreamsTable.id, data.id))
    );
    expect(decryptSecret(rows[0]!.proxyUrlEncrypted as string)).toBe(PROXY2);
  });

  it("PATCH proxyUrl:null 清除代理", async () => {
    const token = await makeToken();
    const createRes = await LIST_POST(
      req("/api/admin/upstreams", "POST", token, {
        name: "up1",
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        proxyUrl: PROXY,
      })
    );
    const { data } = (await createRes.json()) as { data: { id: number } };
    const res = await PATCH(
      req(`/api/admin/upstreams/${data.id}`, "PATCH", token, { proxyUrl: null }),
      { params: { id: String(data.id) } }
    );
    expect(res.status).toBe(200);
    const rows = await withSkipCache(async () =>
      db.select().from(upstreamsTable).where(eq(upstreamsTable.id, data.id))
    );
    expect(rows[0]!.proxyUrlEncrypted).toBeNull();
  });

  it("PATCH 省略 proxyUrl 字段时保持不变", async () => {
    const token = await makeToken();
    const createRes = await LIST_POST(
      req("/api/admin/upstreams", "POST", token, {
        name: "up1",
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        proxyUrl: PROXY,
      })
    );
    const { data } = (await createRes.json()) as { data: { id: number } };
    const res = await PATCH(
      req(`/api/admin/upstreams/${data.id}`, "PATCH", token, { name: "up1-renamed" }),
      { params: { id: String(data.id) } }
    );
    expect(res.status).toBe(200);
    const rows = await withSkipCache(async () =>
      db.select().from(upstreamsTable).where(eq(upstreamsTable.id, data.id))
    );
    expect(decryptSecret(rows[0]!.proxyUrlEncrypted as string)).toBe(PROXY);
  });

  it("PATCH 非法 proxyUrl 400", async () => {
    const token = await makeToken();
    const createRes = await LIST_POST(
      req("/api/admin/upstreams", "POST", token, {
        name: "up1",
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
      })
    );
    const { data } = (await createRes.json()) as { data: { id: number } };
    const res = await PATCH(
      req(`/api/admin/upstreams/${data.id}`, "PATCH", token, {
        proxyUrl: "http://169.254.169.254:3128",
      }),
      { params: { id: String(data.id) } }
    );
    expect(res.status).toBe(400);
  });

  it("PATCH 其他字段更新不触碰 proxyUrl 密文", async () => {
    const token = await makeToken();
    const createRes = await LIST_POST(
      req("/api/admin/upstreams", "POST", token, {
        name: "up1",
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
        proxyUrl: PROXY,
      })
    );
    const { data } = (await createRes.json()) as { data: { id: number } };
    const before = await withSkipCache(async () =>
      db.select().from(upstreamsTable).where(eq(upstreamsTable.id, data.id))
    );
    await PATCH(
      req(`/api/admin/upstreams/${data.id}`, "PATCH", token, { enabled: false }),
      { params: { id: String(data.id) } }
    );
    const after = await withSkipCache(async () =>
      db.select().from(upstreamsTable).where(eq(upstreamsTable.id, data.id))
    );
    expect(after[0]!.proxyUrlEncrypted).toBe(before[0]!.proxyUrlEncrypted);
  });

  it("未认证 401", async () => {
    const res = await LIST_GET(req("/api/admin/upstreams", "GET"));
    expect(res.status).toBe(401);
    const res2 = await LIST_POST(
      req("/api/admin/upstreams", "POST", undefined, {
        name: "up1",
        protocol: "openai",
        baseUrl: "https://8.8.8.8",
      })
    );
    expect(res2.status).toBe(401);
  });
});
