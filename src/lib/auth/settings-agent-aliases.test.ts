import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseAgentAliases,
  isValidAgentAliases,
  loadAgentAliases,
  setAgentAliasesSetting,
  deleteSetting,
  setSetting,
} from "@/lib/auth/settings";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-settings-agent-aliases-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

beforeEach(async () => {
  await deleteSetting("agent_aliases").catch(() => {});
});

describe("isValidAgentAliases / parseAgentAliases", () => {
  it("valid rules pass, invalid shapes rejected", () => {
    expect(
      isValidAgentAliases([{ name: "Codex", aliases: ["codex"] }])
    ).toBe(true);
    expect(isValidAgentAliases([])).toBe(true);
    // 缺失 name / 空 name
    expect(isValidAgentAliases([{ aliases: ["codex"] }])).toBe(false);
    expect(isValidAgentAliases([{ name: "", aliases: ["codex"] }])).toBe(false);
    expect(isValidAgentAliases([{ name: "  ", aliases: ["codex"] }])).toBe(false);
    // aliases 非数组 / 含非字符串
    expect(isValidAgentAliases([{ name: "Codex", aliases: "codex" }])).toBe(false);
    expect(isValidAgentAliases([{ name: "Codex", aliases: [1] }])).toBe(false);
    // 额外 key 拒绝
    expect(
      isValidAgentAliases([{ name: "Codex", aliases: ["codex"], extra: 1 }])
    ).toBe(false);
    expect(isValidAgentAliases({ name: "Codex", aliases: ["codex"] })).toBe(false);
    expect(isValidAgentAliases(null)).toBe(false);
  });
});

describe("parseAgentAliases", () => {
  it("null / 非法 JSON 回退空数组", () => {
    expect(parseAgentAliases(null)).toEqual([]);
    expect(parseAgentAliases("not json")).toEqual([]);
    expect(parseAgentAliases("{}")).toEqual([]);
  });

  it("过滤非法条目（非对象 / 空 name / aliases 非字符串数组）", () => {
    const raw = JSON.stringify([
      { name: "Codex", aliases: ["codex", "codex_cli_rs"] },
      { aliases: ["no-name"] },
      "junk",
      { name: "Bad", aliases: [1] },
      { name: "Good", aliases: [] },
    ]);
    expect(parseAgentAliases(raw)).toEqual([
      { name: "Codex", aliases: ["codex", "codex_cli_rs"] },
      { name: "Good", aliases: [] },
    ]);
  });

  it("返回全新对象，不污染共享默认", () => {
    const a = parseAgentAliases(null);
    const b = parseAgentAliases(null);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });
});

describe("loadAgentAliases / setAgentAliasesSetting", () => {
  it("默认（未配置）返回空数组", async () => {
    expect(await loadAgentAliases()).toEqual([]);
  });

  it("set 后立即可读（withSkipCache 无 10s 延迟）", async () => {
    const rules = [
      { name: "Codex", aliases: ["codex", "codex_cli_rs"] },
      { name: "Claude Code", aliases: ["claude-cli"] },
    ];
    await setAgentAliasesSetting(rules);
    expect(await loadAgentAliases()).toEqual(rules);
  });

  it("损坏的存储值回退空数组", async () => {
    await setSetting("agent_aliases", "oops");
    expect(await loadAgentAliases()).toEqual([]);
  });

  it("set 后主动 invalidateQueryCache（派生结果变化无 DB 写入需主动失效）", async () => {
    const cache = await import("@/lib/db/cache");
    const spy = vi.spyOn(cache, "invalidateQueryCache");
    try {
      await setAgentAliasesSetting([{ name: "A", aliases: ["a"] }]);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});