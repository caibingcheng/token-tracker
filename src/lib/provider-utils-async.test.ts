import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseHiddenProviderGroups,
  parseStoredHiddenProviderGroups,
  loadHiddenProviderGroups,
  anonymizeProvider,
  resolveProviderFilter,
} from "./provider-utils";
import { setHiddenProvidersSetting, deleteSetting } from "@/lib/auth/settings";
import { invalidateModelCache, getRegistry } from "@/lib/model-registry";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-hp-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

beforeEach(async () => {
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

describe("loadHiddenProviderGroups 数据源", () => {
  it("settings 已保存 → settings 生效", async () => {
    await setHiddenProvidersSetting([{ name: "panelA", patterns: ["panel*"] }]);
    const groups = await loadHiddenProviderGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("panelA");
    expect(groups[0].patterns).toEqual(["panel*"]);
  });

  it("settings 未保存 → 空数组", async () => {
    expect(await loadHiddenProviderGroups()).toEqual([]);
  });

  it("settings 保存空数组 → 空数组（面板主动清空）", async () => {
    await setHiddenProvidersSetting([]);
    expect(await loadHiddenProviderGroups()).toEqual([]);
  });
});

describe("parseStoredHiddenProviderGroups JSON 化 + 兼容", () => {
  it("null / 空 → 空数组", () => {
    expect(parseStoredHiddenProviderGroups(null)).toEqual([]);
    expect(parseStoredHiddenProviderGroups("")).toEqual([]);
  });

  it("JSON 数组 round-trip（name 空串自动补 Provider X）", () => {
    const stored = JSON.stringify([
      { name: "CustomA", patterns: ["vendor*", "vendor-partner"] },
      { name: "", patterns: ["google"] },
    ]);
    expect(parseStoredHiddenProviderGroups(stored)).toEqual([
      { name: "CustomA", letter: "A", patterns: ["vendor*", "vendor-partner"] },
      { name: "Provider B", letter: "B", patterns: ["google"] },
    ]);
  });

  it("旧字符串语法自动迁移（懒迁移兼容）", () => {
    const groups = parseStoredHiddenProviderGroups(
      "CustomA:vendor*;google,google-partner"
    );
    expect(groups).toEqual([
      { name: "CustomA", letter: "A", patterns: ["vendor*"] },
      { name: "Provider B", letter: "B", patterns: ["google", "google-partner"] },
    ]);
  });

  it("非法 JSON / 形状不符 → 回退字符串语法解析", () => {
    const legacy = "CustomA:vendor*";
    expect(parseStoredHiddenProviderGroups("{not json")).toEqual(
      parseHiddenProviderGroups("{not json")
    );
    expect(parseStoredHiddenProviderGroups('{"name":"x"}')).toEqual(
      parseHiddenProviderGroups('{"name":"x"}')
    );
    expect(parseStoredHiddenProviderGroups('[{"name":"x"}]')).toEqual(
      parseHiddenProviderGroups('[{"name":"x"}]')
    );
    expect(parseStoredHiddenProviderGroups('[{"name":"x","patterns":[]}]')).toEqual(
      parseHiddenProviderGroups('[{"name":"x","patterns":[]}]')
    );
    expect(parseStoredHiddenProviderGroups(legacy)).toEqual(
      parseHiddenProviderGroups(legacy)
    );
  });

  it("letter 按行序生成（超过 A-Z 后行为与旧解析一致）", () => {
    const stored = JSON.stringify([
      { name: "", patterns: ["p1"] },
      { name: "", patterns: ["p2"] },
      { name: "Custom", patterns: ["p3"] },
    ]);
    const groups = parseStoredHiddenProviderGroups(stored);
    expect(groups.map((g) => `${g.letter}:${g.name}`)).toEqual([
      "A:Provider A",
      "B:Provider B",
      "C:Custom",
    ]);
  });

  it("patterns 含空白元素被清洗；清洗后为空 → 回退", () => {
    const stored = JSON.stringify([{ name: "G", patterns: [" a* ", "b*"] }]);
    expect(parseStoredHiddenProviderGroups(stored)[0].patterns).toEqual([
      "a*",
      "b*",
    ]);
    expect(parseStoredHiddenProviderGroups('[{"name":"G","patterns":["  "]}]')).toEqual(
      parseHiddenProviderGroups('[{"name":"G","patterns":["  "]}]')
    );
  });
});

describe("显式传参的纯函数", () => {
  it("anonymizeProvider 使用传入 groups", () => {
    const groups = parseHiddenProviderGroups("CustomA:vendor*");
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

    await setHiddenProvidersSetting([{ name: "", patterns: ["new-group"] }]);
    expect(reg.rawToCanonical.size).toBe(0);
  });
});
