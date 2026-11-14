import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { closeDb } from "@/lib/db";
import { tmpdir } from "os";
import { join } from "path";
import {
  canRunSetup,
  runSetup,
  checkSetupRateLimit,
} from "./setup";
import {
  getLoginKeyStrength,
  LOGIN_KEY_STRENGTH_META,
} from "@/lib/login-key-strength";
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
  closeDb();
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

describe("弱 key 仅提示 + env 闸门", () => {
  it.each(["short", "1234567890123456", "abcdefghijklmnop"])(
    "runSetup 接受弱 key %s 并正常签发会话",
    async (weak) => {
      const token = await runSetup(weak);
      expect(verifySessionToken(token)).not.toBeNull();
      expect(await getAdminApiKey()).toBe(weak);
      expect(await canRunSetup()).toBe(false);
    }
  );

  it("弱 env key 可用于登录且仍关闭 setup", async () => {
    process.env.ADMIN_API_KEY = "weakkey";
    const { getEnvAdminKeys, getEnvAdminKeysConfigured } = await import("./settings");
    expect(getEnvAdminKeysConfigured()).toEqual(["weakkey"]);
    expect(getEnvAdminKeys()).toEqual(["weakkey"]);
    expect(await canRunSetup()).toBe(false);
    await expect(runSetup("Strong-Admin-Key-9f3a")).rejects.toMatchObject({
      name: "SetupNotAllowedError",
    });
    expect(await getAdminApiKey()).toBeNull();
  });

  it("强弱 env key 混合时都保留，且不放行 setup", async () => {
    process.env.ADMIN_API_KEY = "Strong-Env-Key-9f3a,weakkey";
    const { getEnvAdminKeys } = await import("./settings");
    expect(getEnvAdminKeys()).toEqual(["Strong-Env-Key-9f3a", "weakkey"]);
    expect(await canRunSetup()).toBe(false);
  });

  it("只有弱 env key 时 setup 仍关闭，删掉 env 才放行", async () => {
    process.env.API_KEYS = "shorty";
    expect(await canRunSetup()).toBe(false);
    delete process.env.API_KEYS;
    expect(await canRunSetup()).toBe(true);
  });
});

describe("key 强度分级（前后端同一标准）", () => {
  it("getLoginKeyStrength：按长度 + 字符类别数分级", () => {
    expect(getLoginKeyStrength("")).toBe("weak");
    expect(getLoginKeyStrength("short")).toBe("weak"); // <8 字符
    expect(getLoginKeyStrength("1234567890123456")).toBe("weak"); // 16 位纯数字：仅 1 类
    expect(getLoginKeyStrength("abcdefghijklmnop")).toBe("weak"); // 16 位纯小写：仅 1 类
    expect(getLoginKeyStrength("Abcdefg1")).toBe("fair"); // 8-15 字符 + 2 类
    expect(getLoginKeyStrength("Abcdefghijklmnop1")).toBe("strong"); // ≥16 + 2 类
    expect(getLoginKeyStrength("  Abcdefghijklmnop1  ")).toBe("strong"); // 首尾空白 trim
  });

  it("LOGIN_KEY_STRENGTH_META 三档齐全", () => {
    expect(LOGIN_KEY_STRENGTH_META.weak.label).toBe("Weak");
    expect(LOGIN_KEY_STRENGTH_META.fair.label).toBe("Fair");
    expect(LOGIN_KEY_STRENGTH_META.strong.label).toBe("Strong");
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
