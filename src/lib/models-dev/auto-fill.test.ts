import { describe, it, expect, vi } from "vitest";
import { autoFillModelPrices } from "./auto-fill";
import type { ModelsDevSnapshot } from "./snapshot";

const SNAPSHOT: ModelsDevSnapshot = {
  fetchedAt: "2026-08-01T00:00:00.000Z",
  source: "models.dev",
  data: {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-sonnet-4-6": {
          id: "claude-sonnet-4-6",
          cost: { input: 3, output: 15, cache_read: 0.3 },
        },
      },
    },
  },
};

function mkOptions(overrides: Partial<Parameters<typeof autoFillModelPrices>[1]> = {}) {
  const isPriced = vi.fn(async () => false);
  const write = vi.fn();
  return {
    snapshot: SNAPSHOT,
    isPriced,
    write,
    now: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  };
}

describe("autoFillModelPrices", () => {
  it("fills unmatched models and skips already-priced ones", async () => {
    const opts = mkOptions({
      isPriced: vi.fn(async (m: string) => m === "already-priced"),
    });
    const result = await autoFillModelPrices(
      ["claude-sonnet-4-6", "already-priced", "unknown-model"],
      opts
    );
    expect(result.filled).toEqual(["claude-sonnet-4-6"]);
    expect(result.skipped).toEqual(["already-priced"]);
    expect(result.unmatched).toEqual(["unknown-model"]);
    expect(opts.write).toHaveBeenCalledWith({
      model: "claude-sonnet-4-6",
      inputPrice: 3,
      outputPrice: 15,
      cacheReadPrice: 0.3,
      cacheWritePrice: null,
      source: "models.dev",
      modelsDevId: "anthropic/claude-sonnet-4-6",
      updatedAt: "2026-08-10T00:00:00.000Z",
    });
  });

  it("never overwrites priced rows (isPriced true → skip)", async () => {
    const opts = mkOptions({ isPriced: vi.fn(async () => true) });
    const result = await autoFillModelPrices(["claude-sonnet-4-6"], opts);
    expect(result.filled).toEqual([]);
    expect(result.skipped).toEqual(["claude-sonnet-4-6"]);
    expect(opts.write).not.toHaveBeenCalled();
  });

  it("marks all as unmatched when snapshot is null", async () => {
    const opts = mkOptions({ snapshot: null });
    const result = await autoFillModelPrices(["a", "b"], opts);
    expect(result.unmatched).toEqual(["a", "b"]);
    expect(opts.write).not.toHaveBeenCalled();
  });

  it("trims input models and ignores empties", async () => {
    const opts = mkOptions();
    const result = await autoFillModelPrices([" claude-sonnet-4-6 ", "   "], opts);
    expect(result.filled).toEqual(["claude-sonnet-4-6"]);
  });

  it("fill mode never touches priced rows (updated stays empty)", async () => {
    const opts = mkOptions({ isPriced: vi.fn(async () => true) });
    const result = await autoFillModelPrices(["claude-sonnet-4-6"], { ...opts, overwrite: false });
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual(["claude-sonnet-4-6"]);
    expect(opts.write).not.toHaveBeenCalled();
  });

  it("force mode overwrites a non-manual priced row and reports updated", async () => {
    const opts = mkOptions({
      overwrite: true,
      isPriced: vi.fn(async () => true),
      isManual: vi.fn(async () => false),
    });
    const result = await autoFillModelPrices(["claude-sonnet-4-6", "unmatched-xyz"], opts);
    expect(result.updated).toEqual(["claude-sonnet-4-6"]);
    expect(result.unmatched).toEqual(["unmatched-xyz"]);
    expect(result.filled).toEqual([]);
    expect(opts.write).toHaveBeenCalledTimes(1);
    expect(opts.write).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" })
    );
  });

  it("force mode skips manual rows (never overwritten by any auto pass)", async () => {
    const opts = mkOptions({
      overwrite: true,
      isPriced: vi.fn(async () => true),
      isManual: vi.fn(async (m: string) => m === "claude-sonnet-4-6"),
    });
    const result = await autoFillModelPrices(["claude-sonnet-4-6"], opts);
    expect(result.skipped).toEqual(["claude-sonnet-4-6"]);
    expect(result.updated).toEqual([]);
    expect(opts.write).not.toHaveBeenCalled();
  });

  it("force mode fills unpriced rows as usual (filled, not updated)", async () => {
    const opts = mkOptions({ overwrite: true, isManual: vi.fn(async () => false) });
    const result = await autoFillModelPrices(["claude-sonnet-4-6"], opts);
    expect(result.filled).toEqual(["claude-sonnet-4-6"]);
    expect(result.updated).toEqual([]);
  });
});

// 快照保留无价条目（cost 缺失 / 只提供部分字段）——这些条目绝不得参与写库
const COSTLESS_SNAPSHOT: ModelsDevSnapshot = {
  fetchedAt: "2026-08-01T00:00:00.000Z",
  source: "models.dev",
  data: {
    openai: {
      id: "openai",
      name: "OpenAI",
      models: {
        "gpt-4o": { id: "gpt-4o" } as any,
        "gpt-4o-mini": { id: "gpt-4o-mini", cost: { input: 0.15 } } as any,
        "gpt-free": { id: "gpt-free", cost: { input: 0, output: 0 } },
      },
    },
  },
};

describe("autoFillModelPrices 无价条目保护（D1/D3）", () => {
  it("force 模式：无价条目与部分字段条目都不写库，计入 unmatched", async () => {
    const opts = mkOptions({
      snapshot: COSTLESS_SNAPSHOT,
      overwrite: true,
      // 两行均已定价（正是会被旧实现覆盖成 0 的场景）
      isPriced: vi.fn(async (m: string) => m !== "gpt-free"),
      isManual: vi.fn(async () => false),
    });
    const result = await autoFillModelPrices(["gpt-4o", "gpt-4o-mini", "gpt-free"], opts);
    expect(result.unmatched).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(opts.write).toHaveBeenCalledTimes(1);
    expect(opts.write).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-free", inputPrice: 0, outputPrice: 0 })
    );
  });

  it("fill 模式：无价条目同样计入 unmatched（且不写库）", async () => {
    const opts = mkOptions({ snapshot: COSTLESS_SNAPSHOT });
    const result = await autoFillModelPrices(["gpt-4o", "gpt-4o-mini", "gpt-free"], opts);
    expect(result.unmatched).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(result.filled).toEqual(["gpt-free"]);
    expect(opts.write).toHaveBeenCalledTimes(1);
  });

  it("显式 cost {input:0,output:0} 算有价，仍写入", async () => {
    const opts = mkOptions({ snapshot: COSTLESS_SNAPSHOT });
    const result = await autoFillModelPrices(["gpt-free"], opts);
    expect(result.filled).toEqual(["gpt-free"]);
    expect(opts.write).toHaveBeenCalledWith(
      expect.objectContaining({ inputPrice: 0, outputPrice: 0, cacheReadPrice: null })
    );
  });

  it("多 provider 同名时选中价格完整的有价条目（无价条目不得胜出）", async () => {
    const snapshot: ModelsDevSnapshot = {
      fetchedAt: "2026-08-01T00:00:00.000Z",
      source: "models.dev",
      data: {
        anthropic: { id: "anthropic", name: "Anthropic", models: { "kimi-k3": { id: "kimi-k3" } as any } },
        openrouter: { id: "openrouter", name: "OpenRouter", models: { "kimi-k3": { id: "kimi-k3", cost: { input: 0, output: 0 } } } },
      },
    };
    const opts = mkOptions({ snapshot, overwrite: true, isPriced: vi.fn(async () => true), isManual: vi.fn(async () => false) });
    const result = await autoFillModelPrices(["kimi-k3"], opts);
    expect(result.updated).toEqual(["kimi-k3"]);
    expect(opts.write).toHaveBeenCalledWith(
      expect.objectContaining({ modelsDevId: "openrouter/kimi-k3" })
    );
  });
});
