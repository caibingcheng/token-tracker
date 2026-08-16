import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseHiddenSources,
  isValidHiddenSources,
  loadHiddenSources,
  setHiddenSourcesSetting,
  deleteSetting,
  DEFAULT_HIDDEN_SOURCES,
  type HiddenSourcesConfig,
} from "@/lib/auth/settings";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-hidden-sources-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

beforeEach(async () => {
  await deleteSetting("hidden_sources").catch(() => {});
});

describe("parseHiddenSources 默认值合并", () => {
  it("null 时返回空配置（不隐藏任何源、不排除总计）", () => {
    expect(parseHiddenSources(null)).toEqual(DEFAULT_HIDDEN_SOURCES);
  });

  it("空字符串时返回默认配置", () => {
    expect(parseHiddenSources("")).toEqual(DEFAULT_HIDDEN_SOURCES);
  });

  it("非法 JSON 时返回默认配置（不抛错）", () => {
    expect(parseHiddenSources("{broken")).toEqual(DEFAULT_HIDDEN_SOURCES);
  });

  it("部分配置时与默认值逐 key 合并，不污染共享默认对象", () => {
    const cfg = parseHiddenSources(
      JSON.stringify({ upstreams: ["deepseek", "openai"], excludedVirtualKeys: ["old-agent"] })
    );
    expect(cfg.upstreams).toEqual(["deepseek", "openai"]);
    expect(cfg.excludedVirtualKeys).toEqual(["old-agent"]);
    expect(cfg.virtualKeys).toEqual([]);
    expect(cfg.excludedUpstreams).toEqual([]);
    // 默认对象未被污染
    expect(DEFAULT_HIDDEN_SOURCES.upstreams).toEqual([]);
    expect(DEFAULT_HIDDEN_SOURCES.excludedVirtualKeys).toEqual([]);
  });

  it("非法字段类型（字符串 / 数字）被忽略", () => {
    const cfg = parseHiddenSources(
      JSON.stringify({ upstreams: "deepseek", virtualKeys: [1, 2], excludedUpstreams: 42, excludedVirtualKeys: true })
    );
    expect(cfg.upstreams).toEqual([]);
    expect(cfg.virtualKeys).toEqual([]);
    expect(cfg.excludedUpstreams).toEqual([]);
    expect(cfg.excludedVirtualKeys).toEqual([]);
  });

  it("数组内的非字符串元素被剔除", () => {
    const cfg = parseHiddenSources(
      JSON.stringify({
        upstreams: ["deepseek", 42, null],
        virtualKeys: ["agent-a", {}],
        excludedUpstreams: ["openai"],
      })
    );
    expect(cfg.upstreams).toEqual(["deepseek"]);
    expect(cfg.virtualKeys).toEqual(["agent-a"]);
    expect(cfg.excludedUpstreams).toEqual(["openai"]);
  });
});

describe("isValidHiddenSources 校验", () => {
  it("完整合法配置通过", () => {
    const cfg: HiddenSourcesConfig = {
      upstreams: ["deepseek"],
      virtualKeys: [],
      excludedUpstreams: ["openai"],
      excludedVirtualKeys: ["old-agent"],
    };
    expect(isValidHiddenSources(cfg)).toBe(true);
  });

  it("缺少字段 / 字段类型错误拒绝", () => {
    expect(isValidHiddenSources({ virtualKeys: [] })).toBe(false);
    expect(isValidHiddenSources({ upstreams: [1], virtualKeys: [], excludedUpstreams: [], excludedVirtualKeys: [] })).toBe(false);
    expect(isValidHiddenSources({ upstreams: [], virtualKeys: [], excludedUpstreams: [], excludedVirtualKeys: "yes" })).toBe(false);
  });

  it("含未知 key 拒绝", () => {
    expect(
      isValidHiddenSources({ upstreams: [], virtualKeys: [], excludedUpstreams: [], excludedVirtualKeys: [], hacked: true })
    ).toBe(false);
  });

  it("非对象（null/字符串/数组）拒绝", () => {
    expect(isValidHiddenSources(null)).toBe(false);
    expect(isValidHiddenSources("abc")).toBe(false);
    expect(isValidHiddenSources([])).toBe(false);
  });
});

describe("loadHiddenSources / setHiddenSourcesSetting", () => {
  it("未保存时返回空配置", async () => {
    expect(await loadHiddenSources()).toEqual(DEFAULT_HIDDEN_SOURCES);
  });

  it("保存后立即可读（withSkipCache 无 10s 延迟）", async () => {
    const cfg: HiddenSourcesConfig = {
      upstreams: ["deepseek", "openai"],
      virtualKeys: ["old-agent"],
      excludedUpstreams: ["openai"],
      excludedVirtualKeys: ["legacy-agent"],
    };
    await setHiddenSourcesSetting(cfg);
    expect(await loadHiddenSources()).toEqual(cfg);
  });

  it("保存脏数据后读取回退默认（防御手改 DB）", async () => {
    const { setSetting } = await import("@/lib/auth/settings");
    await setSetting("hidden_sources", "{broken");
    const cfg = await loadHiddenSources();
    expect(cfg.upstreams).toEqual([]);
    expect(cfg.virtualKeys).toEqual([]);
    expect(cfg.excludedUpstreams).toEqual([]);
    expect(cfg.excludedVirtualKeys).toEqual([]);
  });
});
