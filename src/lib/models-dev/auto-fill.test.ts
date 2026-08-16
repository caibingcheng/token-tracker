import { describe, it, expect, vi } from "vitest";
import { autoFillModelPrices } from "./auto-fill";
import type { ModelsDevSnapshot } from "./snapshot";

const SNAPSHOT: ModelsDevSnapshot = {
  fetchedAt: "2026-08-01T00:00:00.000Z",
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
});
