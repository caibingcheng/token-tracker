import { describe, it, expect, beforeEach } from "vitest";
import { normalizeModel, getDisplayName, invalidateModelCache } from "./model-registry";
import type { ModelAliasRule } from "./model-registry";
import { parseModelAliases, isValidModelAliases } from "@/lib/auth/settings";

const ALIASES: ModelAliasRule[] = [
  {
    name: "Claude Sonnet 4.6",
    aliases: ["claude-sonnet-4-6", "anthropic/claude-sonnet-4-6", "claude-sonnet-4-6-*"],
  },
  { name: "DeepSeek V4 Pro", aliases: ["deepseek-v4-pro"] },
];

beforeEach(() => {
  invalidateModelCache();
});

describe("normalizeModel with injected aliases", () => {
  it("exact match on rule name (priority 1)", () => {
    expect(normalizeModel("Claude Sonnet 4.6", undefined, [], ALIASES)).toBe(
      "Claude Sonnet 4.6"
    );
  });

  it("provider/model alias match (priority 2)", () => {
    expect(normalizeModel("anthropic/claude-sonnet-4-6", "anthropic", [], ALIASES)).toBe(
      "Claude Sonnet 4.6"
    );
    expect(normalizeModel("claude-sonnet-4-6", "anthropic", [], ALIASES)).toBe(
      "Claude Sonnet 4.6"
    );
  });

  it("hidden provider falls back to model-only alias (priority 3)", () => {
    const groups = [{ name: "CustomA", patterns: ["custom-provider"] }];
    // provider 未配置 combo 别名时，model-only 别名在隐藏/未隐藏下均命中
    expect(
      normalizeModel("claude-sonnet-4-6", "custom-provider", groups, ALIASES)
    ).toBe("Claude Sonnet 4.6");
    expect(
      normalizeModel("claude-sonnet-4-6", "custom-provider", [], ALIASES)
    ).toBe("Claude Sonnet 4.6");
  });

  it("model alias match (priority 4)", () => {
    expect(normalizeModel("deepseek-v4-pro", "deepseek", [], ALIASES)).toBe(
      "DeepSeek V4 Pro"
    );
    // 含 provider 前缀的 raw 名：combo 未配置时保持原名（与旧行为一致）
    expect(normalizeModel("deepseek/deepseek-v4-pro", "deepseek", [], ALIASES)).toBe(
      "deepseek/deepseek-v4-pro"
    );
  });

  it("unmatched keeps original name (priority 5)", () => {
    expect(normalizeModel("gpt-4o", "openai", [], ALIASES)).toBe("gpt-4o");
  });

  it("empty aliases behave like passthrough", () => {
    expect(normalizeModel("claude-sonnet-4-6", "anthropic", [])).toBe(
      "claude-sonnet-4-6"
    );
  });

  it("rule order matters: first matching rule wins", () => {
    const dup = [
      { name: "First", aliases: ["shared-name"] },
      { name: "Second", aliases: ["shared-name"] },
    ];
    expect(normalizeModel("shared-name", undefined, [], dup)).toBe("First");
  });

  it("caches results per (provider, raw) key", () => {
    normalizeModel("claude-sonnet-4-6", "anthropic", [], ALIASES);
    expect(
      normalizeModel("claude-sonnet-4-6", "anthropic", [], ALIASES)
    ).toBe("Claude Sonnet 4.6");
    // 不同 provider 是不同缓存键，结果一致（model-only 别名命中）
    expect(normalizeModel("claude-sonnet-4-6", "openai", [], ALIASES)).toBe(
      "Claude Sonnet 4.6"
    );
  });

  it("invalidates cache and recomputes after config change", () => {
    expect(normalizeModel("claude-sonnet-4-6", "anthropic", [], ALIASES)).toBe(
      "Claude Sonnet 4.6"
    );
    invalidateModelCache();
    expect(normalizeModel("claude-sonnet-4-6", "anthropic", [], [])).toBe(
      "claude-sonnet-4-6"
    );
  });
});

describe("getDisplayName with injected aliases", () => {
  it("returns configured name for known canonical", () => {
    expect(getDisplayName("Claude Sonnet 4.6", ALIASES)).toBe("Claude Sonnet 4.6");
  });

  it("falls back to model part for unknown", () => {
    expect(getDisplayName("anthropic/claude-3-opus", ALIASES)).toBe("claude-3-opus");
    expect(getDisplayName("gpt-4o", ALIASES)).toBe("gpt-4o");
  });
});

describe("model_aliases settings helpers", () => {
  it("isValidModelAliases accepts valid rules", () => {
    expect(
      isValidModelAliases([
        { name: "A", aliases: ["a", "b/c"] },
        { name: "B", aliases: [] },
      ])
    ).toBe(true);
  });

  it("rejects non-array, empty names, non-string aliases and unknown keys", () => {
    expect(isValidModelAliases(null)).toBe(false);
    expect(isValidModelAliases("x")).toBe(false);
    expect(isValidModelAliases([{ name: "", aliases: ["a"] }])).toBe(false);
    expect(isValidModelAliases([{ name: "A", aliases: ["a", 1] }])).toBe(false);
    expect(isValidModelAliases([{ name: "A", aliases: "a" }])).toBe(false);
    expect(isValidModelAliases([{ name: "A", aliases: [], extra: true }])).toBe(false);
  });

  it("parseModelAliases handles missing/illegal input gracefully", () => {
    expect(parseModelAliases(null)).toEqual([]);
    expect(parseModelAliases("not json")).toEqual([]);
    expect(parseModelAliases('{"a":1}')).toEqual([]);
    expect(parseModelAliases('[{"name":"A","aliases":["a"]},{"name":"B","aliases":[1]}]')).toEqual([
      { name: "A", aliases: ["a"] },
    ]);
  });
});
