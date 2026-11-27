import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { closeDb, db, devicesTable, initDatabase, upstreamKeysTable, upstreamsTable } from "@/lib/db";
import { loadPlainUpstreamKeys, loadPlainUpstreamKeysForDevice } from "@/lib/gateway/proxy-deps";
import { setAdminApiKey, getTokenEpoch, deleteSetting } from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret } from "@/lib/gateway/crypto";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";
const SECRET = "0123456789abcdef0123456789abcdef";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-upstream-keys-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = SECRET;
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
  process.env.GATEWAY_SECRET = SECRET;
  await initDatabase();
  await withSkipCache(async () => {
    await db.delete(upstreamKeysTable);
    await db.delete(upstreamsTable);
    await db.delete(devicesTable);
  });
  await deleteSetting("token_epoch").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(path: string, method: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": token ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedUpstream(): Promise<number> {
  const row = await withSkipCache(async () =>
    db
      .insert(upstreamsTable)
      .values({ name: `u-${Date.now()}`, protocol: "openai", baseUrl: "https://api.example.com" })
      .returning()
  );
  return row[0].id;
}

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

describe("upstream keys route - 掩码与泄露面", () => {
  it("GET 只返回掩码，响应体不含密文与明文片段", async () => {
    const upstreamId = await seedUpstream();
    const plain = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const token = await makeToken();
    await POST(req(`/api/admin/upstreams/${upstreamId}/keys`, "POST", token, { apiKey: plain }), ctx(upstreamId) as any);

    const res = await GET(req(`/api/admin/upstreams/${upstreamId}/keys`, "GET", token), ctx(upstreamId) as any);
    const text = JSON.stringify(await res.json());

    expect(res.status).toBe(200);
    expect(text).not.toContain(plain); // 明文不出网
    expect(text).not.toContain(plain.slice(10, 20)); // 中段也不出网
    expect(text).not.toContain("apiKeyEncrypted"); // 密文字段不外泄
    expect(text).toContain("sk-pro***6789"); // 只露白名单标记/前 6 + 末 4
  });

  it("短 key 完全不露，回落 key #<id>", async () => {
    const upstreamId = await seedUpstream();
    const token = await makeToken();
    const created = await (
      await POST(req(`/api/admin/upstreams/${upstreamId}/keys`, "POST", token, { apiKey: "shortkey" }), ctx(upstreamId) as any)
    ).json();

    const res = await GET(req(`/api/admin/upstreams/${upstreamId}/keys`, "GET", token), ctx(upstreamId) as any);
    const body = await res.json();
    expect(body.data[0].maskedKey).toBe(`key #${created.data.id}`);
  });

  it("单行密文损坏只影响该行，不阻塞列表也不回显原因", async () => {
    const upstreamId = await seedUpstream();
    const token = await makeToken();
    const broken = await withSkipCache(async () =>
      db
        .insert(upstreamKeysTable)
        .values({ upstreamId, apiKeyEncrypted: "not-a-valid-payload" })
        .returning()
    );

    const res = await GET(req(`/api/admin/upstreams/${upstreamId}/keys`, "GET", token), ctx(upstreamId) as any);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data[0].maskedKey).toBe(`key #${broken[0].id}`);
    expect(JSON.stringify(body)).not.toContain("Decryption failed");
  });

  it("GATEWAY_SECRET 缺失时 GET 返回 503，不静默降级成 key #<id>", async () => {
    // 走 LOCAL_ADMIN_BYPASS 入口：带 token 的路径会先在 guard 验签时抛 GatewaySecretMissingError，
    // 掩码代码根本到不了；只有绕过认证（本地部署）时才真正走到这里
    const upstreamId = await seedUpstream();
    await withSkipCache(async () =>
      db.insert(upstreamKeysTable).values({ upstreamId, apiKeyEncrypted: encryptSecret("sk-abcdef1234567890") })
    );
    delete process.env.GATEWAY_SECRET;
    process.env.LOCAL_ADMIN_BYPASS = "1";

    const res = await GET(
      new NextRequest(`http://localhost/api/admin/upstreams/${upstreamId}/keys`, {
        method: "GET",
        headers: { host: "localhost" },
      }),
      ctx(upstreamId) as any
    );

    delete process.env.LOCAL_ADMIN_BYPASS;
    process.env.GATEWAY_SECRET = SECRET;
    expect(res.status).toBe(503);
  });

  it("没有会话 token 时 401", async () => {
    const upstreamId = await seedUpstream();
    const res = await GET(req(`/api/admin/upstreams/${upstreamId}/keys`, "GET"), ctx(upstreamId) as any);
    expect(res.status).toBe(401);
  });

  it("per-device key：写入 device_id、列表回设备名、直连 loader 看不到", async () => {
    const upstreamId = await seedUpstream();
    const token = await makeToken();
    const device = await withSkipCache(async () =>
      db
        .insert(devicesTable)
        .values({
          fingerprint: `u-${"a".repeat(32)}`,
          name: "laptop",
          publicKey: "pub",
          createdAt: new Date().toISOString(),
        })
        .returning({ id: devicesTable.id })
    );
    const deviceId = Number(device[0]!.id);

    // 通用 key + 设备专属 key
    const generic = await POST(
      req(`/api/admin/upstreams/${upstreamId}/keys`, "POST", token, { apiKey: "sk-generic-123456" }),
      ctx(upstreamId) as any
    );
    expect(generic.status).toBe(201);
    const scoped = await POST(
      req(`/api/admin/upstreams/${upstreamId}/keys`, "POST", token, {
        apiKey: "sk-device-123456",
        deviceId,
      }),
      ctx(upstreamId) as any
    );
    expect(scoped.status).toBe(201);
    expect(((await scoped.json()) as any).data.deviceId).toBe(deviceId);

    // 列表回设备名（UI 徽标 `device: <name>` 的数据源）
    const list = await GET(req(`/api/admin/upstreams/${upstreamId}/keys`, "GET", token), ctx(upstreamId) as any);
    const rows = ((await list.json()) as any).data as {
      deviceId: number | null;
      deviceName: string | null;
    }[];
    expect(rows.map((r) => r.deviceId)).toEqual([null, deviceId]);
    expect(rows[1]!.deviceName).toBe("laptop");

    // loader 语义（§12.3）：deviceId 缺省只返回通用 key；指定 device 时专属优先
    await expect(loadPlainUpstreamKeysForDevice(upstreamId, null)).resolves.toEqual([
      { id: expect.any(Number), apiKey: "sk-generic-123456" },
    ]);
    const forDevice = await loadPlainUpstreamKeysForDevice(upstreamId, deviceId);
    expect(forDevice.map((k) => k.apiKey)).toEqual(["sk-device-123456", "sk-generic-123456"]);
    await expect(loadPlainUpstreamKeys(upstreamId)).resolves.toEqual(["sk-generic-123456"]);
  });

  it("per-device key：未知 device 404，非法 deviceId 400", async () => {
    const upstreamId = await seedUpstream();
    const token = await makeToken();
    const unknown = await POST(
      req(`/api/admin/upstreams/${upstreamId}/keys`, "POST", token, { apiKey: "sk-x-123456", deviceId: 999 }),
      ctx(upstreamId) as any
    );
    expect(unknown.status).toBe(404);
    const invalid = await POST(
      req(`/api/admin/upstreams/${upstreamId}/keys`, "POST", token, { apiKey: "sk-x-123456", deviceId: -1 }),
      ctx(upstreamId) as any
    );
    expect(invalid.status).toBe(400);
  });
});
