// /api/device/pair/poll + 配对闭环：pending 428 → authorize → 一次取 token → 复用 400；
// 未知码 428 / 错 secret 428 且 3 次作废；slow_down；lookup 不消费码
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { POST as poll } from "./route";
import { POST as lookup } from "../../pair/lookup/route";
import { POST as start } from "../../pair/start/route";
import { closeDb, db, devicesTable, devicePairingsTable, initDatabase } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { authorizePairing, pollPairing, resetDeviceSweeperForTests } from "@/lib/device/store";
import { isDeviceTokenShaped, normalizePairingCode, pairingCodeHash } from "@/lib/device/pairing";
import { setAdminApiKey, getTokenEpoch } from "@/lib/auth/settings";
import { keyFingerprint, signSessionToken } from "@/lib/auth/session";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";
let dir: string;
let ipCounter = 0;

function nextIp(): string {
  return `10.1.0.${++ipCounter % 250}`;
}

function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-remote-addr": nextIp(), ...headers },
    body: JSON.stringify(body),
  });
}

const clientSecret = "s".repeat(32);

async function begin(): Promise<string> {
  const res = await start(
    jsonReq("http://localhost/api/device/pair/start", {
      fingerprint: `u-${"a".repeat(32)}`,
      name: "laptop",
      publicKey: "A".repeat(59),
      clientSecret,
    })
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as any).data.code as string;
}

function pollReq(code: string, secret = clientSecret): NextRequest {
  return jsonReq("http://localhost/api/device/pair/poll", { code, clientSecret: secret });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-pairpoll-"));
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
  // slow_down / secret 失败计数都按 code_hash 记在进程内，用例间用新码即可隔离
  await new Promise((r) => setTimeout(r, 5));
});

describe("配对闭环", () => {
  it("pending → 428；authorize 后 poll 取到 dt- token（只一次）；复用 → 400", async () => {
    const code = await begin();
    const pending = await poll(pollReq(code));
    expect(pending.status).toBe(428);
    expect(((await pending.json()) as any).error).toBe("authorization_pending");

    const authorized = await authorizePairing({ code });
    expect(authorized.ok).toBe(true);
    // "用户点授权"之间 relay 仍在按 interval 轮询：清掉进程内节奏状态，代表下一次定时轮询
    resetDeviceSweeperForTests();

    const first = await poll(pollReq(code));
    expect(first.status).toBe(200);
    const body = (await first.json()) as any;
    expect(body.data.status).toBe("authorized");
    expect(isDeviceTokenShaped(body.data.token)).toBe(true);

    // token 只存 sha256：库里不含明文
    const devices = await withSkipCache(async () => db.select().from(devicesTable));
    expect(devices).toHaveLength(1);
    expect(devices[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(devices[0]!.tokenHash).not.toBe(body.data.token);

    const again = await poll(pollReq(code));
    expect(again.status).toBe(400);
    expect(((await again.json()) as any).error).toBe("expired_token");
  });

  it("reauth：同 fingerprint 复用 device 行（保 device_id），只换 token", async () => {
    const code1 = await begin();
    await authorizePairing({ code: code1 });
    const token1 = ((await (await poll(pollReq(code1))).json()) as any).data.token as string;
    const before = await withSkipCache(async () => db.select().from(devicesTable));

    const code2 = await begin();
    const reauth = await authorizePairing({ code: code2 });
    expect(reauth.ok && reauth.reauth).toBe(true);
    const token2 = ((await (await poll(pollReq(code2))).json()) as any).data.token as string;

    const after = await withSkipCache(async () => db.select().from(devicesTable));
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(token2).not.toBe(token1);
  });

  it("未知码 / 错 clientSecret 一律 428；错 secret 3 次后作废", async () => {
    const unknown = await poll(pollReq("ABCD-EFGH"));
    expect(unknown.status).toBe(428);

    const code = await begin();
    expect((await poll(pollReq(code, "x".repeat(32)))).status).toBe(428);
    expect((await poll(pollReq(code, "x".repeat(32)))).status).toBe(428);
    expect((await poll(pollReq(code, "x".repeat(32)))).status).toBe(428);
    // 3 次后会话作废：即使给对 secret 也不能再授权
    const after = await authorizePairing({ code });
    expect(after.ok).toBe(false);
  });

  it("slow_down：快于 interval 的连续轮询返回 429 并回传翻倍后的 interval", async () => {
    const code = await begin();
    expect((await poll(pollReq(code))).status).toBe(428);
    const fast = await poll(pollReq(code));
    expect(fast.status).toBe(429);
    const body = (await fast.json()) as any;
    expect(body.error).toBe("slow_down");
    expect(body.interval).toBeGreaterThanOrEqual(10);
  });

  it("过期码：给对 secret → 400 expired_token", async () => {
    const code = await begin();
    const normalized = normalizePairingCode(code)!;
    await withSkipCache(async () => {
      await db
        .update(devicePairingsTable)
        .set({ expiresAt: Date.now() - 1000 })
        .where(eq(devicePairingsTable.codeHash, pairingCodeHash(normalized)));
    });
    const res = await poll(pollReq(code));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("expired_token");
  });

  it("pair/lookup 需会话 token；只读不消费码", async () => {
    await setAdminApiKey(ADMIN_KEY);
    const token = signSessionToken(
      await getTokenEpoch(),
      keyFingerprint(ADMIN_KEY),
      60 * 60 * 1000
    );
    const code = await begin();

    const res = await lookup(
      new NextRequest("http://localhost/api/device/pair/lookup", {
        method: "POST",
        headers: { "content-type": "application/json", "X-API-Key": token },
        body: JSON.stringify({ code }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.fingerprint).toBe(`u-${"a".repeat(32)}`);
    expect(body.data.name).toBe("laptop");

    // 不消费：仍能 authorize 并取 token
    expect((await authorizePairing({ code })).ok).toBe(true);
    resetDeviceSweeperForTests();
    expect((await poll(pollReq(code))).status).toBe(200);

    // 未带会话 token → 401
    const unauthorized = await lookup(
      new NextRequest("http://localhost/api/device/pair/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      })
    );
    expect(unauthorized.status).toBe(401);
  });
});

// pollPairing 直调（绕过 HTTP 限流），确认状态机本身的行为
describe("pollPairing 状态机", () => {
  it("不存在的码 → unknown（对外 428）", async () => {
    const result = await pollPairing({
      code: "ZZZZ-ZZZZ",
      clientSecret,
      clientIp: null,
      userAgent: null,
    });
    expect(result.state).toBe("unknown");
  });
});
