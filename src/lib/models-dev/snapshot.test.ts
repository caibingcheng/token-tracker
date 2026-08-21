import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  sanitizeModelsDevData,
  uploadSnapshot,
  getSnapshot,
  resetSnapshotCache,
  isFiniteNonNegative,
  type ModelsDevData,
} from "./snapshot";

const GOOD: ModelsDevData = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        cost: { input: 2.5, output: 10, cache_read: 0.1, cache_write: 0.2 },
      },
      "gpt-4o-mini": { id: "gpt-4o-mini", cost: { input: 0.15, output: 0.6 } },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        cost: { input: 3, output: 15 },
      },
    },
  },
};

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-snapshot-"));
  filePath = join(dir, "models-dev-cache.json");
  resetSnapshotCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isFiniteNonNegative", () => {
  it("accepts finite non-negative numbers", () => {
    expect(isFiniteNonNegative(0)).toBe(true);
    expect(isFiniteNonNegative(2.5)).toBe(true);
  });

  it("rejects negative / NaN / Infinity / non-numbers", () => {
    expect(isFiniteNonNegative(-1)).toBe(false);
    expect(isFiniteNonNegative(NaN)).toBe(false);
    expect(isFiniteNonNegative(Infinity)).toBe(false);
    expect(isFiniteNonNegative(-Infinity)).toBe(false);
    expect(isFiniteNonNegative("2.5")).toBe(false);
    expect(isFiniteNonNegative(null)).toBe(false);
    expect(isFiniteNonNegative(undefined)).toBe(false);
  });
});

describe("sanitizeModelsDevData", () => {
  it("keeps valid data untouched (structure preserved)", () => {
    const { data, dropped } = sanitizeModelsDevData(GOOD);
    expect(dropped).toBe(0);
    expect(data).toEqual(GOOD);
    expect(Object.keys(data)).toEqual(["openai", "anthropic"]);
    expect(data.openai.models["gpt-4o"].cost.cache_read).toBe(0.1);
  });

  it("returns a new object, does not mutate the input", () => {
    const input = structuredClone(GOOD);
    sanitizeModelsDevData(input);
    expect(input).toEqual(GOOD);
  });

  it("drops entries with invalid prices / structures, keeps no-price entries", () => {
    const bad: ModelsDevData = {
      p1: {
        id: "p1",
        models: {
          neg: { id: "neg", cost: { input: -1, output: 2 } },
          str: { id: "str", cost: { input: "2.5", output: 2 } },
          badCache: {
            id: "badCache",
            cost: { input: 1, output: 2, cache_read: -0.1 },
          },
          nonObjectCost: { id: "nonObjectCost", cost: "oops" } as any,
          nullModel: null as any,
          noCost: { id: "noCost" } as any,
          nullCost: { id: "nullCost", cost: null } as any,
          ok: { id: "ok", cost: { input: 1, output: 2 } },
        },
      },
    };
    const { data, dropped } = sanitizeModelsDevData(bad);
    expect(dropped).toBe(5);
    expect(Object.keys(data.p1.models)).toEqual(["noCost", "nullCost", "ok"]);
  });

  it("removes providers left empty after filtering", () => {
    const empty: ModelsDevData = {
      p1: { id: "p1", models: {} },
      p2: {
        id: "p2",
        models: { m: { id: "m", cost: { input: -5, output: 1 } } },
      },
    };
    const { data, dropped } = sanitizeModelsDevData(empty);
    expect(dropped).toBe(1);
    expect(Object.keys(data)).toEqual([]);
  });
});

describe("uploadSnapshot", () => {
  const NOW = new Date();

  it("makes data available via getSnapshot immediately without network fetch", async () => {
    const fetchImpl = vi.fn();
    const snap = await uploadSnapshot(GOOD, { filePath, now: NOW });
    expect(snap.fetchedAt).toBe(NOW.toISOString());
    const read = await getSnapshot({ filePath, fetchImpl });
    expect(read?.data).toEqual(GOOD);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("writes the snapshot file to disk", async () => {
    await uploadSnapshot(GOOD, { filePath, now: NOW });
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(onDisk).toEqual({ fetchedAt: NOW.toISOString(), data: GOOD });
  });

  it("survives memory cache reset (read back from disk)", async () => {
    await uploadSnapshot(GOOD, { filePath, now: NOW });
    resetSnapshotCache();
    const read = await getSnapshot({ filePath });
    expect(read?.data).toEqual(GOOD);
    expect(read?.fetchedAt).toBe(NOW.toISOString());
  });

  it("does not trigger background refresh after reset (uploaded data is fresh)", async () => {
    await uploadSnapshot(GOOD, { filePath, now: NOW });
    resetSnapshotCache();
    const fetchImpl = vi.fn();
    const read = await getSnapshot({ filePath, fetchImpl });
    expect(read?.data).toEqual(GOOD);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
