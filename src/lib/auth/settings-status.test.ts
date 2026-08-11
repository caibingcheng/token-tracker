import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseStatusPageConfig,
  isValidStatusPageConfig,
  getStatusPageConfig,
  setStatusPageConfig,
  deleteSetting,
  DEFAULT_STATUS_PAGE_CONFIG,
  DEFAULT_STATUS_PAGE_ELEMENTS,
  type StatusPageConfig,
} from "@/lib/auth/settings";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-status-settings-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

beforeEach(async () => {
  await deleteSetting("status_page_config").catch(() => {});
});

describe("parseStatusPageConfig 默认值合并", () => {
  it("null 时返回 fail-closed 默认配置（enabled=false）", () => {
    const cfg = parseStatusPageConfig(null);
    expect(cfg).toEqual(DEFAULT_STATUS_PAGE_CONFIG);
  });

  it("空字符串时返回默认配置", () => {
    expect(parseStatusPageConfig("")).toEqual(DEFAULT_STATUS_PAGE_CONFIG);
  });

  it("非法 JSON 时返回默认配置（不抛错）", () => {
    expect(parseStatusPageConfig("{not-json")).toEqual(DEFAULT_STATUS_PAGE_CONFIG);
  });

  it("部分配置时与默认值逐 key 合并，不污染共享默认对象", () => {
    const cfg = parseStatusPageConfig(
      JSON.stringify({ enabled: true, elements: { heatmap: true } })
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.elements.heatmap).toBe(true);
    expect(cfg.elements.total).toBe(true);
    expect(cfg.elements.today).toBe(true);
    expect(cfg.elements.daily).toBe(true);
    expect(cfg.elements.hourly).toBe(false);
    expect(cfg.elements.topModels).toBe(false);
    expect(cfg.elements.cost).toBe(false);
    // 默认对象未被污染
    expect(DEFAULT_STATUS_PAGE_CONFIG.enabled).toBe(false);
    expect(DEFAULT_STATUS_PAGE_ELEMENTS.heatmap).toBe(false);
  });

  it("非法字段类型（字符串 enabled / 数字元素）被忽略", () => {
    const cfg = parseStatusPageConfig(
      JSON.stringify({ enabled: "yes", elements: { total: "true", cost: 1 } })
    );
    expect(cfg.enabled).toBe(false);
    expect(cfg.elements.total).toBe(true);
    expect(cfg.elements.cost).toBe(false);
  });

  it("未知元素 key 被忽略", () => {
    const cfg = parseStatusPageConfig(
      JSON.stringify({ enabled: true, elements: { secret: true, daily: false } })
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.elements.daily).toBe(false);
  });
});

describe("isValidStatusPageConfig 校验", () => {
  it("完整合法配置通过", () => {
    const cfg: StatusPageConfig = {
      enabled: true,
      elements: { ...DEFAULT_STATUS_PAGE_ELEMENTS },
    };
    expect(isValidStatusPageConfig(cfg)).toBe(true);
  });

  it("enabled 缺失/非 boolean 拒绝", () => {
    expect(isValidStatusPageConfig({ elements: { ...DEFAULT_STATUS_PAGE_ELEMENTS } })).toBe(false);
    expect(isValidStatusPageConfig({ enabled: 1, elements: { ...DEFAULT_STATUS_PAGE_ELEMENTS } })).toBe(false);
  });

  it("元素缺失/非 boolean/含未知 key 拒绝", () => {
    expect(isValidStatusPageConfig({ enabled: true, elements: { total: true } })).toBe(false);
    expect(
      isValidStatusPageConfig({ enabled: true, elements: { ...DEFAULT_STATUS_PAGE_ELEMENTS, total: "x" } })
    ).toBe(false);
    expect(
      isValidStatusPageConfig({ enabled: true, elements: { ...DEFAULT_STATUS_PAGE_ELEMENTS, hacked: true } })
    ).toBe(false);
  });

  it("非对象（null/字符串/数组）拒绝", () => {
    expect(isValidStatusPageConfig(null)).toBe(false);
    expect(isValidStatusPageConfig("abc")).toBe(false);
    expect(isValidStatusPageConfig([])).toBe(false);
  });
});

describe("getStatusPageConfig / setStatusPageConfig", () => {
  it("未保存时 fail-closed", async () => {
    const cfg = await getStatusPageConfig();
    expect(cfg.enabled).toBe(false);
  });

  it("保存后立即可读（withSkipCache 无 10s 延迟）", async () => {
    const cfg: StatusPageConfig = {
      enabled: true,
      elements: { ...DEFAULT_STATUS_PAGE_ELEMENTS, heatmap: true, topModels: false },
    };
    await setStatusPageConfig(cfg);
    expect(await getStatusPageConfig()).toEqual(cfg);
  });

  it("保存脏数据后读取回退默认（防御手改 DB）", async () => {
    const { setSetting } = await import("@/lib/auth/settings");
    await setSetting("status_page_config", "{broken");
    const cfg = await getStatusPageConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.elements.total).toBe(true);
  });
});
