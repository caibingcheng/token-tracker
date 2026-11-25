import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDb } from "@/lib/db";
import { deleteSetting } from "./settings";
import { generateTotpCode, generateTotpSecret } from "./totp";
import { verifyTotpCodeNoReplay, getLastTotpCounter } from "./totp-replay";

// settings 表读写的模块级测试：用临时 SQLite 库，避免碰开发库
const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-totp-replay-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  // 先关句柄再删目录（Windows 未关句柄删库会 EPERM）
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

beforeEach(async () => {
  await deleteSetting("totp_last_counter").catch(() => {});
});

describe("verifyTotpCodeNoReplay 三态", () => {
  it("正确码 → ok 并记录时间步；同码再验 → replay；错码 → invalid", async () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = generateTotpCode(secret, now);

    expect(await verifyTotpCodeNoReplay(secret, code, now)).toBe("ok");
    expect(await getLastTotpCounter(secret)).toBe(Math.floor(now / 1000 / 30));
    // 同一时间步的码不能再用（重放）
    expect(await verifyTotpCodeNoReplay(secret, code, now)).toBe("replay");
    // 码本身不对是 invalid（与 replay 区分开，路由侧只对 invalid 计失败次数）
    const wrong = code === "000000" ? "000001" : "000000";
    expect(await verifyTotpCodeNoReplay(secret, wrong, now)).toBe("invalid");
    // invalid 不改写已消费的时间步
    expect(await getLastTotpCounter(secret)).toBe(Math.floor(now / 1000 / 30));
  });

  it("下一时间步的码 → ok（窗口内前进合法）", async () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(await verifyTotpCodeNoReplay(secret, generateTotpCode(secret, now), now)).toBe("ok");
    const next = generateTotpCode(secret, now + 30_000);
    expect(await verifyTotpCodeNoReplay(secret, next, now)).toBe("ok");
  });

  it("时钟回拨（更早时间步的码）→ replay，不覆盖已记录的时间步", async () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(await verifyTotpCodeNoReplay(secret, generateTotpCode(secret, now), now)).toBe("ok");
    const before = await getLastTotpCounter(secret);
    const past = generateTotpCode(secret, now - 30_000);
    expect(await verifyTotpCodeNoReplay(secret, past, now)).toBe("replay");
    expect(await getLastTotpCounter(secret)).toBe(before);
  });

  it("换绑后的新 secret 重新起算（同窗口内不被旧计数误判重放）", async () => {
    const now = Date.now();
    const oldSecret = generateTotpSecret();
    expect(await verifyTotpCodeNoReplay(oldSecret, generateTotpCode(oldSecret, now), now)).toBe("ok");
    const newSecret = generateTotpSecret();
    expect(await verifyTotpCodeNoReplay(newSecret, generateTotpCode(newSecret, now), now)).toBe("ok");
  });
});

describe("verifyTotpCodeNoReplay 并发串行化", () => {
  it("同一码并发两次 → 恰一个 ok、一个 replay（读-判-写不被并发送穿）", async () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = generateTotpCode(secret, now);
    const results = await Promise.all([
      verifyTotpCodeNoReplay(secret, code, now),
      verifyTotpCodeNoReplay(secret, code, now),
    ]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "replay")).toHaveLength(1);
  });

  it("同一码并发 3 次 → 恰一个 ok，其余全是 replay", async () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = generateTotpCode(secret, now);
    const results = await Promise.all([
      verifyTotpCodeNoReplay(secret, code, now),
      verifyTotpCodeNoReplay(secret, code, now),
      verifyTotpCodeNoReplay(secret, code, now),
    ]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "replay")).toHaveLength(2);
  });

  it("并发不同时间步的码依次推进（串行不丢写）", async () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const codes = [generateTotpCode(secret, now), generateTotpCode(secret, now + 30_000)];
    const results = await Promise.all(codes.map((c) => verifyTotpCodeNoReplay(secret, c, now)));
    // 两个不同时间步各自消费一次：都 ok，且最终记录的是较大者
    expect(results).toEqual(["ok", "ok"]);
    expect(await getLastTotpCounter(secret)).toBe(Math.floor((now + 30_000) / 1000 / 30));
  });
});
