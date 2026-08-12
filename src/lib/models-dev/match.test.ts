import { describe, it, expect } from "vitest";
import {
  matchModelsDevModel,
  providerPriority,
  normalizeModelKey,
  stripDateVariant,
  searchModelsDevModel,
  SEARCH_RESULT_LIMIT,
} from "./match";
import type { ModelsDevData } from "./snapshot";

function mkModel(id: string, cost: object, extra: object = {}): any {
  return { id, cost, ...extra };
}

const DATA: ModelsDevData = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-sonnet-4-6": mkModel("claude-sonnet-4-6", {
        input: 3,
        output: 15,
        cache_read: 0.3,
        cache_write: 3.75,
      }),
      "claude-sonnet-4-5-20250929": mkModel("claude-sonnet-4-5-20250929", {
        input: 3,
        output: 15,
      }),
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o": mkModel("gpt-4o", { input: 2.5, output: 10 }),
      "gpt-4.1": mkModel("gpt-4.1", { input: 2, output: 8 }),
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    models: {
      "deepseek-chat": mkModel("deepseek-chat", { input: 0.27, output: 1.1 }),
    },
  },
  xai: {
    id: "xai",
    name: "xAI",
    models: {
      "gpt-4o": mkModel("gpt-4o", { input: 2.5, output: 10 }), // 与 openai 同价
    },
  },
  meta: {
    id: "meta",
    name: "Meta",
    models: {
      "claude-sonnet-4-6": mkModel("claude-sonnet-4-6", {
        input: 1,
        output: 4,
      }), // 与 anthropic 不同价
    },
  },
};

describe("normalizeModelKey / stripDateVariant", () => {
  it("normalizes case and separators", () => {
    expect(normalizeModelKey("claude-sonnet-4.6")).toBe("claudesonnet46");
    expect(normalizeModelKey("Claude_Sonnet_4_6")).toBe("claudesonnet46");
    expect(normalizeModelKey("gpt-4.1-mini")).toBe("gpt41mini");
  });

  it("strips trailing date suffix", () => {
    expect(stripDateVariant("claude-sonnet-4-5-20250929")).toBe(
      "claude-sonnet-4-5"
    );
    expect(stripDateVariant("gpt-4o")).toBe("gpt-4o");
    expect(stripDateVariant("gpt-4o-1234-56")).toBe("gpt-4o-1234-56"); // 非 8 位不动
  });

  it("providerPriority puts known providers first", () => {
    expect(providerPriority("anthropic")).toBeLessThan(providerPriority("openai"));
    expect(providerPriority("meta")).toBeLessThan(providerPriority("unknown"));
  });
});

describe("matchModelsDevModel", () => {
  it("exact match picks the highest-priority provider on price conflict", () => {
    const result = matchModelsDevModel("claude-sonnet-4-6", DATA);
    expect(result.matched?.modelsDevId).toBe("anthropic/claude-sonnet-4-6");
    expect(result.candidates).toHaveLength(2);
  });

  it("exact match with identical prices does not treat as conflict", () => {
    const result = matchModelsDevModel("gpt-4o", DATA);
    expect(result.matched?.modelsDevId).toBe("openai/gpt-4o");
    expect(result.candidates).toHaveLength(2);
  });

  it("normalized match ignores separator/case differences", () => {
    const result = matchModelsDevModel("Claude-Sonnet-4.6", DATA);
    expect(result.matched?.modelsDevId).toBe("anthropic/claude-sonnet-4-6");
  });

  it("date variant strip matches base model", () => {
    const result = matchModelsDevModel("claude-sonnet-4-5-20250929", DATA);
    expect(result.matched?.modelsDevId).toBe(
      "anthropic/claude-sonnet-4-5-20250929"
    );
    // 归一化变体：日期剥离后匹配
    const result2 = matchModelsDevModel("claude-sonnet-4.5-20250929", DATA);
    expect(result2.matched?.modelsDevId).toBe(
      "anthropic/claude-sonnet-4-5-20250929"
    );
  });

  it("returns empty when nothing matches", () => {
    const result = matchModelsDevModel("totally-unknown-model", DATA);
    expect(result.matched).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it("returns empty for empty input", () => {
    const result = matchModelsDevModel("  ", DATA);
    expect(result.matched).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it("no candidates when data is empty", () => {
    const result = matchModelsDevModel("gpt-4o", {});
    expect(result.matched).toBeNull();
  });

  it("candidate carries full price info", () => {
    const result = matchModelsDevModel("claude-sonnet-4-6", DATA);
    const c = result.matched!;
    expect(c.inputPrice).toBe(3);
    expect(c.outputPrice).toBe(15);
    expect(c.cacheReadPrice).toBe(0.3);
    expect(c.cacheWritePrice).toBe(3.75);
  });
});

describe("searchModelsDevModel", () => {
  it("matches model id by normalized substring", () => {
    const results = searchModelsDevModel("claude-sonnet", DATA);
    const ids = results.map((c) => c.modelsDevId);
    expect(ids).toContain("anthropic/claude-sonnet-4-6");
    expect(ids).toContain("anthropic/claude-sonnet-4-5-20250929");
    expect(ids).toContain("meta/claude-sonnet-4-6");
  });

  it("matches across separator/case differences", () => {
    const results = searchModelsDevModel("CLAUDE-SONNET-4.6", DATA);
    expect(results.map((c) => c.modelsDevId)).toContain(
      "anthropic/claude-sonnet-4-6"
    );
  });

  it("matches provider name (not only model id)", () => {
    const results = searchModelsDevModel("deep", DATA);
    expect(results.map((c) => c.modelsDevId)).toContain("deepseek/deepseek-chat");
    // provider name "xAI" → 归一化 "xai" 命中
    const xai = searchModelsDevModel("xai", DATA);
    expect(xai.map((c) => c.modelsDevId)).toContain("xai/gpt-4o");
  });

  it("returns empty for empty or whitespace query", () => {
    expect(searchModelsDevModel("", DATA)).toEqual([]);
    expect(searchModelsDevModel("   ", DATA)).toEqual([]);
  });

  it("returns empty when nothing matches", () => {
    expect(searchModelsDevModel("zzz-not-in-snapshot", DATA)).toEqual([]);
  });

  it("caps results at SEARCH_RESULT_LIMIT", () => {
    // 构造超过上限的 provider（每个 provider 一个 model，均命中 "hit"）
    const big: ModelsDevData = {};
    for (let i = 0; i < SEARCH_RESULT_LIMIT + 10; i++) {
      big[`p${i}`] = {
        id: `p${i}`,
        name: `Provider ${i}`,
        models: {
          [`hit-${i}`]: mkModel(`hit-${i}`, { input: 1, output: 2 }),
        },
      };
    }
    const results = searchModelsDevModel("hit", big);
    expect(results).toHaveLength(SEARCH_RESULT_LIMIT);
  });

  it("carries providerName fallback to providerId and full price info", () => {
    const results = searchModelsDevModel("gpt-4o", DATA);
    const openai = results.find((c) => c.providerId === "openai")!;
    expect(openai.providerName).toBe("OpenAI");
    expect(openai.inputPrice).toBe(2.5);
    expect(openai.cacheReadPrice).toBeNull();
  });
});
