import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseHiddenProviderGroups,
  loadHiddenProviderGroups,
  anonymizeProvider,
  resolveProviderFilter,
} from "./provider-utils";
import { setHiddenProvidersSetting, deleteSetting } from "@/lib/auth/settings";
import { invalidateModelCache, getRegistry } from "@/lib/model-registry";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_HIDDEN = process.env.HIDDEN_PROVIDERS;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-hp-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_HIDDEN === undefined) delete process.env.HIDDEN_PROVIDERS;
  else process.env.HIDDEN_PROVIDERS = ORIG_HIDDEN;
});

beforeEach(async () => {
  delete process.env.HIDDEN_PROVIDERS;
  await deleteSetting("hidden_providers").catch(() => {});
});

describe("parseHiddenProviderGroups 纯函数", () => {
  it("空串 / 空白 → 空数组", () => {
    expect(parseHiddenProviderGroups("")).toEqual([]);
    expect(parseHiddenProviderGroups("   ")).toEqual([]);
  });

  it("legacy 格式：每个 pattern 独立成组（Provider A/B...）", () => {
    const groups = parseHiddenProviderGroups("openai,anthropic");
    expect(groups).toEqual([
      { name: "Provider A", letter: "A", patterns: ["openai"] },
      { name: "Provider B", letter: "B", patterns: ["anthropic"] },
    ]);
  });

  it("匿名分组格式（分号）", () => {
    const groups = parseHiddenProviderGroups("name1*,name2*;name3,name4*");
    expect(groups[0]).toEqual({
      name: "Provider A",
      letter: "A",
      patterns: ["name1*", "name2*"],
    });
    expect(groups[1].name).toBe("Provider B");
    expect(groups[1].patterns).toEqual(["name3", "name4*"]);
  });

  it("命名分组格式（冒号）", () => {
    const groups = parseHiddenProviderGroups("CustomA:vendor,vendor-partner;CustomB:vendor-platform");
    expect(groups[0]).toEqual({
      name: "CustomA",
      letter: "A",
      patterns: ["vendor", "vendor-partner"],
    });
    expect(groups[1].name).toBe("CustomB");
  });

  it("非法语法容错：空组 / 无 pattern 组被过滤", () => {
    expect(parseHiddenProviderGroups("a*;;b*")).toHaveLength(2);
    expect(parseHiddenProviderGroups("a:;b*")[0].patterns).toEqual([]);
    expect(parseHiddenProviderGroups(",,")).toEqual([]);
  });
});

describe("loadHiddenProviderGroups 优先级", () => {
  it("settings 已保存 → settings 优先（忽略 env）", async () => {
    process.env.HIDDEN_PROVIDERS = "envA:env*";
    await setHiddenProvidersSetting("panelA:panel*");
    const groups = await loadHiddenProviderGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("panelA");
    expect(groups[0].patterns).toEqual(["panel*"]);
  });

  it("settings 未保存 → env 回退", async () => {
    process.env.HIDDEN_PROVIDERS = "envA:env*";
    const groups = await loadHiddenProviderGroups();
    expect(groups[0].name).toBe("envA");
  });

  it("settings 未保存且 env 空 → 空数组", async () => {
    expect(await loadHiddenProviderGroups()).toEqual([]);
  });

  it("settings 保存空串 → 空数组（面板主动清空）", async () => {
    await setHiddenProvidersSetting("");
    process.env.HIDDEN_PROVIDERS = "envA:env*";
    expect(await loadHiddenProviderGroups()).toEqual([]);
  });
});

describe("显式传参的纯函数", () => {
  it("anonymizeProvider 使用传入 groups 而非 env", () => {
    const groups = parseHiddenProviderGroups("CustomA:vendor*");
    process.env.HIDDEN_PROVIDERS = "other";
    expect(anonymizeProvider("vendor-x", [], groups)).toBe("CustomA");
    expect(anonymizeProvider("google", [], groups)).toBe("google");
    expect(anonymizeProvider("vendor-x", [], [])).toBe("vendor-x");
  });

  it("resolveProviderFilter 使用传入 groups", () => {
    const groups = parseHiddenProviderGroups("CustomA:vendor*");
    const all = ["vendor-a", "vendor-b", "google"];
    expect(resolveProviderFilter("CustomA", all, groups)).toEqual([
      "vendor-a",
      "vendor-b",
    ]);
    expect(resolveProviderFilter("google", all, groups)).toEqual(["google"]);
    expect(resolveProviderFilter("CustomA", all, [])).toEqual([]);
  });
});

describe("写入后缓存失效", () => {
  it("setHiddenProvidersSetting 使 rawToCanonical 缓存失效", async () => {
    invalidateModelCache();
    const reg = getRegistry();
    expect(reg.rawToCanonical.size).toBe(0);

    // 预置一个缓存项（模拟此前 normalizeModel 已计算）
    reg.rawToCanonical.set("vendor-x:model-a", "provider-a/model-a");
    expect(reg.rawToCanonical.size).toBe(1);

    await setHiddenProvidersSetting("new-group");
    expect(reg.rawToCanonical.size).toBe(0);
  });
});
