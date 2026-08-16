import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveStreamIdleTimeoutMs,
  getStreamIdleTimeoutMinutesSetting,
  setStreamIdleTimeoutMinutesSetting,
  deleteSetting,
} from "@/lib/auth/settings";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-settings-stream-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

beforeEach(async () => {
  await deleteSetting("stream_idle_timeout_minutes").catch(() => {});
});

describe("resolveStreamIdleTimeoutMs", () => {
  it("未配置时默认 30 分钟", async () => {
    expect(await resolveStreamIdleTimeoutMs()).toBe(30 * 60 * 1000);
  });

  it("settings 合法值按分钟换算", async () => {
    await setStreamIdleTimeoutMinutesSetting(5);
    expect(await resolveStreamIdleTimeoutMs()).toBe(5 * 60 * 1000);
  });

  it("settings 非法值（0/负数/NaN）→ 回退默认", async () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await setStreamIdleTimeoutMinutesSetting(bad);
      expect(await resolveStreamIdleTimeoutMs()).toBe(30 * 60 * 1000);
    }
  });

  it("删除 settings 后回退默认（无 env 依赖）", async () => {
    await setStreamIdleTimeoutMinutesSetting(12);
    await deleteSetting("stream_idle_timeout_minutes");
    expect(await resolveStreamIdleTimeoutMs()).toBe(30 * 60 * 1000);
  });
});

describe("get/setStreamIdleTimeoutMinutesSetting", () => {
  it("无配置返回 null，保存后返回数字", async () => {
    expect(await getStreamIdleTimeoutMinutesSetting()).toBeNull();
    await setStreamIdleTimeoutMinutesSetting(15);
    expect(await getStreamIdleTimeoutMinutesSetting()).toBe(15);
  });

  it("非法值返回 null", async () => {
    await setStreamIdleTimeoutMinutesSetting(0);
    expect(await getStreamIdleTimeoutMinutesSetting()).toBeNull();
  });

  it("写入后立即可读（withSkipCache 无 10s 延迟）", async () => {
    await setStreamIdleTimeoutMinutesSetting(7);
    expect(await getStreamIdleTimeoutMinutesSetting()).toBe(7);
  });
});
