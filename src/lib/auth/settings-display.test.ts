import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getHiddenProvidersSetting,
  setHiddenProvidersSetting,
  resolveSessionTtlMs,
  getSessionTtlHoursSetting,
  setSessionTtlHoursSetting,
  deleteSetting,
} from "@/lib/auth/settings";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_TTL = process.env.SESSION_TOKEN_TTL_HOURS;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-settings-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_TTL === undefined) delete process.env.SESSION_TOKEN_TTL_HOURS;
  else process.env.SESSION_TOKEN_TTL_HOURS = ORIG_TTL;
});

beforeEach(async () => {
  delete process.env.SESSION_TOKEN_TTL_HOURS;
  await deleteSetting("hidden_providers").catch(() => {});
  await deleteSetting("session_token_ttl_hours").catch(() => {});
});

describe("hidden_providers settings 读写", () => {
  it("未保存时返回 null，保存后返回 JSON 原值", async () => {
    expect(await getHiddenProvidersSetting()).toBeNull();
    const groups = [{ name: "CustomA", patterns: ["vendor*"] }];
    await setHiddenProvidersSetting(groups);
    expect(await getHiddenProvidersSetting()).toBe(JSON.stringify(groups));
  });

  it("写入后立即可读（withSkipCache 无 10s 延迟）", async () => {
    const groups = [{ name: "g1", patterns: ["a*"] }];
    await setHiddenProvidersSetting(groups);
    expect(await getHiddenProvidersSetting()).toBe(JSON.stringify(groups));
  });
});

describe("resolveSessionTtlMs fallback 优先级", () => {
  it("settings 优先于 env", async () => {
    process.env.SESSION_TOKEN_TTL_HOURS = "2";
    await setSessionTtlHoursSetting(48);
    expect(await resolveSessionTtlMs()).toBe(48 * 60 * 60 * 1000);
  });

  it("无 settings 时 env 生效", async () => {
    process.env.SESSION_TOKEN_TTL_HOURS = "2";
    expect(await resolveSessionTtlMs()).toBe(2 * 60 * 60 * 1000);
  });

  it("无 settings 无 env → 默认 24h", async () => {
    expect(await resolveSessionTtlMs()).toBe(24 * 60 * 60 * 1000);
  });

  it("settings 非法值（0/负数/NaN）→ 跳过回退 env/默认", async () => {
    await setSessionTtlHoursSetting(0);
    expect(await resolveSessionTtlMs()).toBe(24 * 60 * 60 * 1000);

    process.env.SESSION_TOKEN_TTL_HOURS = "2";
    await setSessionTtlHoursSetting(-5);
    expect(await resolveSessionTtlMs()).toBe(2 * 60 * 60 * 1000);
  });

  it("删除 settings 后回退 env/默认", async () => {
    await setSessionTtlHoursSetting(12);
    await deleteSetting("session_token_ttl_hours");
    process.env.SESSION_TOKEN_TTL_HOURS = "3";
    expect(await resolveSessionTtlMs()).toBe(3 * 60 * 60 * 1000);
  });
});

describe("getSessionTtlHoursSetting", () => {
  it("无配置返回 null，保存后返回数字", async () => {
    expect(await getSessionTtlHoursSetting()).toBeNull();
    await setSessionTtlHoursSetting(6);
    expect(await getSessionTtlHoursSetting()).toBe(6);
  });
});
