// /api/device/pair/start：码格式、每 IP pending 上限、限流先于读 body
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { closeDb, db, devicePairingsTable, devicesTable, initDatabase } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { resetDeviceSweeperForTests } from "@/lib/device/store";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
let dir: string;
let ipCounter = 0;

function req(body: unknown, ip?: string): NextRequest {
  const addr = ip ?? `10.0.0.${++ipCounter % 250}`;
  return new NextRequest("http://localhost/api/device/pair/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-remote-addr": addr,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const payload = () => ({
  fingerprint: `u-${"f".repeat(32)}`,
  name: "laptop",
  publicKey: "A".repeat(59),
  clientSecret: "s".repeat(32),
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-pairstart-"));
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
  await initDatabase();
  await withSkipCache(async () => {
    await db.delete(devicePairingsTable);
    await db.delete(devicesTable);
  });
  resetDeviceSweeperForTests();
});

describe("POST /api/device/pair/start", () => {
  it("返回 8 位码 + TTL + interval，只落 sha256（不存明文码）", async () => {
    const res = await POST(req(payload()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(body.data.expiresIn).toBe(600);
    expect(body.data.interval).toBe(5);

    const rows = await withSkipCache(async () => db.select().from(devicePairingsTable));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.codeHash).not.toContain(body.data.code);
    expect(rows[0]!.status).toBe("pending");
  });

  it("非法字段 400（fingerprint / publicKey / clientSecret）", async () => {
    expect((await POST(req({ ...payload(), fingerprint: "nope" }))).status).toBe(400);
    expect((await POST(req({ ...payload(), publicKey: "短" }))).status).toBe(400);
    expect((await POST(req({ ...payload(), clientSecret: "short" }))).status).toBe(400);
  });

  it("每 IP 同时存在的 pending 会话 ≤ 3（第 4 次 429）", async () => {
    const ip = "192.0.2.7";
    for (let i = 0; i < 3; i++) {
      expect((await POST(req(payload(), ip))).status).toBe(200);
    }
    expect((await POST(req(payload(), ip))).status).toBe(429);
    // 其他来源不受影响
    expect((await POST(req(payload(), "192.0.2.8"))).status).toBe(200);
  });

  it("限流先于读 body：坏 JSON / 缺字段同样计数，第 11 次 429", async () => {
    const ip = "198.51.100.9";
    let sawRateLimit = false;
    for (let i = 0; i < 11; i++) {
      const res = await POST(req("{not json", ip));
      if (res.status === 429) {
        sawRateLimit = true;
        expect(i).toBe(10);
        break;
      }
      expect(res.status).toBe(400);
    }
    expect(sawRateLimit).toBe(true);
  });
});
