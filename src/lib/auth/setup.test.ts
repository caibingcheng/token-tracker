import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { canRunSetup, runSetup, isValidSetupKey, checkSetupRateLimit } from "./setup";
import { getAdminApiKey, getTokenEpoch } from "./settings";
import { signSessionToken, verifySessionToken, keyFingerprint } from "./session";
import { recordAuditLog } from "@/lib/admin/audit";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_ADMIN = process.env.ADMIN_API_KEY;
const ORIG_LEGACY = process.env.API_KEYS;
const ORIG_SECRET = process.env.GATEWAY_SECRET;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-setup-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_ADMIN === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = ORIG_ADMIN;
  if (ORIG_LEGACY === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = ORIG_LEGACY;
  if (ORIG_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIG_SECRET;
});

beforeEach(async () => {
  delete process.env.ADMIN_API_KEY;
  delete process.env.API_KEYS;
  const { deleteAdminApiKey, deleteSetting } = await import("./settings");
  await deleteAdminApiKey();
  await deleteSetting("token_epoch");
});

afterEach(async () => {
  delete process.env.ADMIN_API_KEY;
  delete process.env.API_KEYS;
  const { deleteAdminApiKey, deleteSetting } = await import("./settings");
  await deleteAdminApiKey();
  await deleteSetting("token_epoch");
});

// 闸门四状态表：
// | DB key | env key | 期望 |
// | 有 | 任意 | false（403）|
// | 无 | 有（含旧名 API_KEYS） | false（403）|
// | 无 | 无 | true（允许）|
// | 无 | "" / "  " / 全逗号 | true（视为未配置）|
describe("canRunSetup 闸门四状态", () => {
  it("状态1: DB 有 key → false（无论 env）", async () => {
    const { setAdminApiKey } = await import("./settings");
    await setAdminApiKey("some-db-key-123456");
    process.env.ADMIN_API_KEY = "env-key-123456";
    expect(await canRunSetup()).toBe(false);
    expect(
      await runSetup("another-key-123456").catch((e) => e.constructor.name)
    ).toBe("SetupNotAllowedError");
  });

  it("状态2: DB 无 key + env ADMIN_API_KEY → false", async () => {
    process.env.ADMIN_API_KEY = "env-key-123456";
    expect(await canRunSetup()).toBe(false);
  });

  it("状态2b: DB 无 key + env 旧名 API_KEYS → false", async () => {
    process.env.API_KEYS = "legacy-key-123456";
    expect(await canRunSetup()).toBe(false);
  });

  it("状态3: DB 无 key + env 无 key → true，runSetup 成功", async () => {
    expect(await canRunSetup()).toBe(true);
    const token = await runSetup("fresh-setup-key-123456");
    expect(token).toBeTruthy();
    const payload = verifySessionToken(token);
    expect(payload).not.toBeNull();
  });

  it("状态4: env 空串 / 纯空格 / 全逗号 → 视为未配置，允许", async () => {
    process.env.ADMIN_API_KEY = "";
    expect(await canRunSetup()).toBe(true);
    process.env.ADMIN_API_KEY = "   ";
    expect(await canRunSetup()).toBe(true);
    process.env.ADMIN_API_KEY = ",,,";
    expect(await canRunSetup()).toBe(true);
  });
});

describe("runSetup 写入与并发安全", () => {
  it("写入后可解密出 key，token_epoch 为 1，token keyId 匹配", async () => {
    const key = "write-check-key-123456";
    const token = await runSetup(key);
    const payload = verifySessionToken(token)!;
    expect(payload.epoch).toBe(1);
    expect(payload.keyId).toBe(keyFingerprint(key));
    expect(await getAdminApiKey()).toBe(key);
    expect(await getTokenEpoch()).toBe(1);
  });

  it("TOCTOU：DB 已有 key 时再 runSetup 抛错（事务 re-check）", async () => {
    const { setAdminApiKey } = await import("./settings");
    await setAdminApiKey("pre-existing-key-123456");
    expect(await canRunSetup()).toBe(false);
    await expect(runSetup("concurrent-key-123456")).rejects.toThrow(
      "Setup is not allowed"
    );
  });

  it("并发双 runSetup：仅一个成功", async () => {
    const results = await Promise.allSettled([
      runSetup("race-key-A-123456"),
      runSetup("race-key-B-123456"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = await getAdminApiKey();
    expect(winner).toMatch(/^race-key-[AB]-123456$/);
    expect((fulfilled[0] as PromiseFulfilledResult<string>).value).toBeTruthy();
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      name: "SetupNotAllowedError",
    });
  });
});

describe("key 强度与限流", () => {
  it("isValidSetupKey：≥16 字符才通过", () => {
    expect(isValidSetupKey("")).toBe(false);
    expect(isValidSetupKey("short")).toBe(false);
    expect(isValidSetupKey("1234567890123456")).toBe(true);
    expect(isValidSetupKey("  1234567890123456  ")).toBe(true);
  });

  it("checkSetupRateLimit：超过 10 次窗口后限流", () => {
    const bucket = "test-bucket";
    for (let i = 0; i < 10; i++) {
      expect(checkSetupRateLimit(bucket)).toBe(false);
    }
    expect(checkSetupRateLimit(bucket)).toBe(true);
  });
});

describe("审计写入", () => {
  it("recordAuditLog 可写入 setup_admin_key 动作", async () => {
    await expect(
      recordAuditLog({
        action: "setup_admin_key",
        targetType: "system",
        ip: "127.0.0.1",
        details: { keyLength: 24 },
      })
    ).resolves.toBeUndefined();
  });
});

// signSessionToken 默认 TTL 路径（保证导入不破坏既有签名）
describe("回归：签名不受 setup 影响", () => {
  it("signSessionToken 仍可签发", () => {
    const token = signSessionToken(0, "deadbeef");
    expect(verifySessionToken(token)).not.toBeNull();
  });
});
