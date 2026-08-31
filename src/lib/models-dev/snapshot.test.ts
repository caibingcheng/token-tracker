import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  sanitizeModelsDevData,
  uploadSnapshot,
  getSnapshot,
  refreshSnapshot,
  resetSnapshotCache,
  fetchModelsDevData,
  convertLitellmToModelsDev,
  looksLikeLitellmStructure,
  readSnapshotFile,
  isValidModelsDevData,
  isFiniteNonNegative,
  MODELS_DEV_SOURCE_DEFAULT,
  LITELLM_MODEL_PRICES_URL,
  LITELLM_MODEL_PRICES_FALLBACK_URL,
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

  it("writes the snapshot file to disk (default source models.dev)", async () => {
    await uploadSnapshot(GOOD, { filePath, now: NOW });
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(onDisk).toEqual({
      fetchedAt: NOW.toISOString(),
      source: "models.dev",
      data: GOOD,
    });
  });

  it("tags the snapshot file with an explicit source", async () => {
    await uploadSnapshot(GOOD, { filePath, now: NOW, source: "github" });
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(onDisk.source).toBe("github");
    const snap = await getSnapshot({ filePath, fetchImpl: vi.fn() });
    expect(snap?.source).toBe("github");
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

describe("refreshSnapshot", () => {
  it("reports HTTP failure with status (no fake success with stale snapshot)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const snap = await refreshSnapshot({ filePath, fetchImpl, now: new Date() });
    expect(snap).toEqual({ ok: false, error: { kind: "http", status: 500 } });
  });

  it("reports network failure and keeps the stale snapshot readable", async () => {
    const old = new Date("2026-08-21T13:30:49.211Z");
    await uploadSnapshot(GOOD, { filePath, now: old });
    resetSnapshotCache();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const snap = await refreshSnapshot({ filePath, fetchImpl, now: new Date() });
    expect(snap).toEqual({ ok: false, error: { kind: "network" } });
    const oldSnap = await getSnapshot({ filePath });
    expect(oldSnap?.fetchedAt).toBe(old.toISOString());
    expect(oldSnap?.data).toEqual(GOOD);
  });

  it("reports invalid response shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ p1: { id: "p1" } }),
    });
    const snap = await refreshSnapshot({ filePath, fetchImpl, now: new Date() });
    expect(snap).toEqual({ ok: false, error: { kind: "invalid" } });
  });

  it("rebuilds snapshot freshness after successful fetch", async () => {
    const old = new Date("2026-08-21T13:30:49.211Z");
    await uploadSnapshot(GOOD, { filePath, now: old });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => GOOD,
    });
    const now = new Date("2026-08-25T10:00:00.000Z");
    const snap = await refreshSnapshot({ filePath, fetchImpl, now });
    expect(snap).toEqual({
      ok: true,
      snapshot: { fetchedAt: now.toISOString(), source: "models.dev", data: GOOD },
    });
  });
});

describe("readSnapshotFile", () => {
  it("falls back to default source for legacy files without source field", () => {
    writeFileSync(
      filePath,
      JSON.stringify({ fetchedAt: "2026-08-01T00:00:00.000Z", data: GOOD }),
      "utf-8"
    );
    const snap = readSnapshotFile(filePath);
    expect(snap?.source).toBe(MODELS_DEV_SOURCE_DEFAULT);
    expect(snap?.data).toEqual(GOOD);
  });

  it("preserves a valid source tag and rejects bad ones", () => {
    writeFileSync(
      filePath,
      JSON.stringify({ fetchedAt: "2026-08-01T00:00:00.000Z", source: "github", data: GOOD }),
      "utf-8"
    );
    expect(readSnapshotFile(filePath)?.source).toBe("github");
    writeFileSync(
      filePath,
      JSON.stringify({ fetchedAt: "2026-08-01T00:00:00.000Z", source: "unknown", data: GOOD }),
      "utf-8"
    );
    expect(readSnapshotFile(filePath)?.source).toBe(MODELS_DEV_SOURCE_DEFAULT);
  });
});

// LiteLLM 样例（per-token 价格，扁平结构）
const LITELLM_FLAT: Record<string, Record<string, unknown>> = {
  sample_spec: {
    input_cost_per_token: 0,
    output_cost_per_token: 0,
    litellm_provider: "",
    description: "placeholder doc entry",
  },
  "gpt-4o": {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 4e-6,
    litellm_provider: "openai",
    mode: "chat",
  },
  "claude-sonnet-4-6": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    litellm_provider: "anthropic",
  },
  "bedrock/us-east-1/amazon.nova-1": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.2e-5,
    litellm_provider: "bedrock",
  },
  "text-embedding-3-small": {
    input_cost_per_token: 2e-8,
    output_cost_per_token: null,
    litellm_provider: "openai",
    mode: "embedding",
  },
  "no-provider-field": { input_cost_per_token: 1e-6 },
  "image-gen-x": {
    output_cost_per_image: 0.04,
    litellm_provider: "openai",
  },
  "bad-values": {
    input_cost_per_token: -1e-6,
    output_cost_per_token: "x",
    litellm_provider: "openai",
  },
};

describe("looksLikeLitellmStructure", () => {
  it("detects a litellm-style flat map", () => {
    expect(looksLikeLitellmStructure(LITELLM_FLAT)).toBe(true);
    expect(looksLikeLitellmStructure({ a: { litellm_provider: "openai" } })).toBe(true);
  });

  it("rejects non-objects / arrays / empty provider / models.dev shapes", () => {
    expect(looksLikeLitellmStructure(null)).toBe(false);
    expect(looksLikeLitellmStructure([])).toBe(false);
    expect(looksLikeLitellmStructure("x")).toBe(false);
    expect(looksLikeLitellmStructure({})).toBe(false);
    expect(looksLikeLitellmStructure({ a: { litellm_provider: "" } })).toBe(false);
    expect(looksLikeLitellmStructure({ a: { litellm_provider: 1 } })).toBe(false);
    // models.dev 结构（provider → models 对象）不含 litellm_provider → 识别为否
    expect(looksLikeLitellmStructure(GOOD)).toBe(false);
  });
});

describe("convertLitellmToModelsDev", () => {
  it("converts per-token prices to per-million (×1e6)", () => {
    const data = convertLitellmToModelsDev(LITELLM_FLAT);
    expect(data.openai.models["gpt-4o"].cost.input).toBe(2.5);
    expect(data.openai.models["gpt-4o"].cost.output).toBe(10);
    expect(data.openai.models["gpt-4o"].cost.cache_read).toBeCloseTo(0.1, 10);
    expect(data.openai.models["gpt-4o"].cost.cache_write).toBeCloseTo(4, 10);
    expect(data.anthropic.models["claude-sonnet-4-6"].cost.input).toBe(3);
    expect(data.anthropic.models["claude-sonnet-4-6"].cost.output).toBe(15);
  });

  it("preserves model ids containing slashes", () => {
    const data = convertLitellmToModelsDev(LITELLM_FLAT);
    expect(data.bedrock.models["bedrock/us-east-1/amazon.nova-1"].cost.input).toBe(3);
  });

  it("skips sample_spec and entries without litellm_provider", () => {
    const data = convertLitellmToModelsDev(LITELLM_FLAT);
    expect(data.sample_spec).toBeUndefined();
    expect(data["no-provider-field"]).toBeUndefined();
    expect(Object.keys(data).sort()).toEqual(["anthropic", "bedrock", "openai"]);
  });

  it("keeps entries without token prices with no cost field (no-price semantics)", () => {
    const data = convertLitellmToModelsDev(LITELLM_FLAT);
    const img = data.openai.models["image-gen-x"] as Record<string, unknown>;
    expect(img).toBeTruthy();
    expect(img.cost).toBeUndefined();
  });

  it("ignores negative / NaN string prices for a field", () => {
    const data = convertLitellmToModelsDev(LITELLM_FLAT);
    const bad = data.openai.models["bad-values"];
    // 两个字段都被忽略 → cost 省略（无价条目）
    expect(bad.cost).toBeUndefined();
  });

  it("returns empty object for non-object input", () => {
    expect(convertLitellmToModelsDev(null)).toEqual({});
    expect(convertLitellmToModelsDev([])).toEqual({});
  });

  it("output is valid ModelsDevData (downstream-consumable)", () => {
    const data = convertLitellmToModelsDev(LITELLM_FLAT);
    expect(
      sanitizeModelsDevData(data).dropped
    ).toBe(0);
  });
});

describe("fetchModelsDevData (github source)", () => {
  it("tries raw GitHub URL first, falls back to jsDelivr on HTTP failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => LITELLM_FLAT,
      });
    const res = await fetchModelsDevData(fetchImpl, "github");
    expect(fetchImpl.mock.calls[0][0]).toBe(LITELLM_MODEL_PRICES_URL);
    expect(fetchImpl.mock.calls[1][0]).toBe(LITELLM_MODEL_PRICES_FALLBACK_URL);
    expect(res.ok).toBe(true);
    if (res.ok) expect(isValidModelsDevData(res.data)).toBe(true);
  });

  it("falls back on network error too", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => LITELLM_FLAT })
      .mockRejectedValueOnce(new Error("down"));
    // 顺序注意：raw 成功就返回，不再尝试第二个
    const res = await fetchModelsDevData(fetchImpl, "github");
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports the last error classification when both URLs fail", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ bad: 1 }) });
    const res = await fetchModelsDevData(fetchImpl, "github");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ kind: "invalid" });

    const netImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockRejectedValueOnce(new Error("offline"));
    const netRes = await fetchModelsDevData(netImpl, "github");
    expect(netRes.ok).toBe(false);
    if (!netRes.ok) expect(netRes.error).toEqual({ kind: "network" });
  });

  it("defaults to models.dev source when omitted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => GOOD,
    });
    const res = await fetchModelsDevData(fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://models.dev/api.json");
    expect(res.ok).toBe(true);
  });
});

describe("refreshSnapshot source plumbing", () => {
  it("refreshes with explic source and writes tagged snapshot", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => LITELLM_FLAT,
    });
    const snap = await refreshSnapshot({
      filePath,
      fetchImpl,
      now: new Date("2026-08-25T10:00:00.000Z"),
      source: "github",
    });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.snapshot.source).toBe("github");
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(onDisk.source).toBe("github");
    expect(onDisk.data.anthropic.models["claude-sonnet-4-6"].cost.input).toBe(3);
  });
});

describe("in-flight refresh dedupe/serialization", () => {
  it("reuses the same in-flight refresh for identical sources", async () => {
    let resolveFetch!: (v: unknown) => void;
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Promise((res) => {
          resolveFetch = () =>
            res({ ok: true, status: 200, json: async () => LITELLM_FLAT });
        })
    );
    const p1 = refreshSnapshot({ filePath, fetchImpl, source: "github" });
    const p2 = refreshSnapshot({ filePath, fetchImpl, source: "github" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch(undefined);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent refreshes of different sources (no out-of-order overwrite)", async () => {
    let resolveA!: (v: unknown) => void;
    const fetchA = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((res) => {
            resolveA = () => res({ ok: true, status: 200, json: async () => GOOD });
          })
      );
    const p1 = refreshSnapshot({
      filePath,
      fetchImpl: fetchA,
      source: "models.dev",
      now: new Date("2026-08-25T10:00:00.000Z"),
    });
    const fetchB = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => LITELLM_FLAT,
    });
    const p2 = refreshSnapshot({
      filePath,
      fetchImpl: fetchB,
      source: "github",
      now: new Date("2026-08-25T11:00:00.000Z"),
    });
    // 异源：B 必须等待 A settle 后才发起
    expect(fetchB).not.toHaveBeenCalled();
    resolveA(undefined);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(fetchB).toHaveBeenCalledTimes(1);
    // 写盘顺序 = 发起顺序，后完成者覆盖（github 为当前快照）
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(onDisk.source).toBe("github");
    const snap = await getSnapshot({ filePath, fetchImpl: vi.fn() });
    expect(snap?.source).toBe("github");
  });
});
