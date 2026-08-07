import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HealthTracker, DEFAULT_PROBE_INTERVAL_MS } from "./health";
import type { HealthPersistence } from "./health";

function mkPersistence(overrides: Partial<HealthPersistence> = {}): HealthPersistence & {
  saveUpstream: ReturnType<typeof vi.fn>;
  saveModel: ReturnType<typeof vi.fn>;
} {
  const saveUpstream = vi.fn(async () => {});
  const saveModel = vi.fn(async () => {});
  return {
    loadUpstreams: vi.fn(async () => []),
    loadModels: vi.fn(async () => []),
    saveUpstream,
    saveModel,
    ...overrides,
  };
}

describe("HealthTracker - upstream level", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is healthy by default", async () => {
    const tracker = new HealthTracker(vi.fn(async () => true), mkPersistence());
    expect(await tracker.isHealthy(1)).toBe(true);
  });

  it("marks unhealthy and keeps it until probe succeeds", async () => {
    const tracker = new HealthTracker(vi.fn(async () => false), mkPersistence());
    await tracker.markUnhealthy(1);
    expect(await tracker.isHealthy(1)).toBe(false);
    expect(await tracker.isHealthy(2)).toBe(true);
  });

  it("persists upstream health state on change", async () => {
    const persistence = mkPersistence();
    const tracker = new HealthTracker(vi.fn(async () => true), persistence);
    await tracker.markUnhealthy(1);
    expect(persistence.saveUpstream).toHaveBeenCalledWith(1, true);
    await tracker.markHealthy(1);
    expect(persistence.saveUpstream).toHaveBeenCalledWith(1, false);
  });

  it("recovers to healthy after successful probe", async () => {
    const probe = vi.fn(async () => true);
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    expect(await tracker.isHealthy(1)).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledWith(1);
    expect(await tracker.isHealthy(1)).toBe(true);
  });

  it("stays unhealthy and reschedules when probe fails", async () => {
    const probe = vi.fn(async () => false);
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(await tracker.isHealthy(1)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(await tracker.isHealthy(1)).toBe(false);
  });

  it("recovers when probe throws", async () => {
    const probe = vi.fn(async () => {
      throw new Error("boom");
    });
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await tracker.isHealthy(1)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("markUnhealthy is idempotent and schedules only one timer", async () => {
    const probe = vi.fn(async () => true);
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    await tracker.markUnhealthy(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await tracker.isHealthy(1)).toBe(true);
  });

  it("stops probing after recovery", async () => {
    const probe = vi.fn(async () => true);
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await tracker.isHealthy(1)).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    expect(probe).toHaveBeenCalledTimes(1); // 不再继续调度
  });

  it("uses default probe interval of 30 minutes", () => {
    expect(DEFAULT_PROBE_INTERVAL_MS).toBe(30 * 60 * 1000);
  });

  it("probes each upstream independently", async () => {
    const probe = vi.fn(async () => true);
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    await tracker.markUnhealthy(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenNthCalledWith(1, 1);
    expect(probe).toHaveBeenNthCalledWith(2, 2);
    expect(await tracker.isHealthy(1)).toBe(true);
    expect(await tracker.isHealthy(2)).toBe(true);
  });
});

describe("HealthTracker - model level", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is model healthy by default", async () => {
    const tracker = new HealthTracker(vi.fn(async () => true), mkPersistence());
    expect(await tracker.isModelHealthy(1, "gpt-4o")).toBe(true);
  });

  it("marks single model unavailable without affecting others or upstream", async () => {
    const tracker = new HealthTracker(vi.fn(async () => true), mkPersistence());
    await tracker.markModelUnhealthy(1, "gpt-4o");
    expect(await tracker.isModelHealthy(1, "gpt-4o")).toBe(false);
    expect(await tracker.isModelHealthy(1, "gpt-4o-mini")).toBe(true); // 同 upstream 其他 model 不受影响
    expect(await tracker.isModelHealthy(2, "gpt-4o")).toBe(true); // 其他 upstream 不受影响
    expect(await tracker.isHealthy(1)).toBe(true); // upstream 级仍 healthy
    expect(await tracker.listModelUnhealthy(1)).toEqual(["gpt-4o"]);
    expect(await tracker.listModelUnhealthy(2)).toEqual([]);
  });

  it("persists model health state", async () => {
    const persistence = mkPersistence();
    const tracker = new HealthTracker(vi.fn(async () => true), persistence);
    await tracker.markModelUnhealthy(1, "gpt-4o");
    expect(persistence.saveModel).toHaveBeenCalledWith(1, "gpt-4o", expect.any(Number));
    await tracker.markModelHealthy(1, "gpt-4o");
    expect(persistence.saveModel).toHaveBeenCalledWith(1, "gpt-4o", null);
  });

  it("auto-recovers after ttl", async () => {
    vi.useFakeTimers();
    const tracker = new HealthTracker(vi.fn(async () => true), mkPersistence(), 1000, 1000);
    await tracker.markModelUnhealthy(1, "gpt-4o");
    expect(await tracker.isModelHealthy(1, "gpt-4o")).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(await tracker.isModelHealthy(1, "gpt-4o")).toBe(true);
  });

  it("listModelUnhealthy cleans expired entries", async () => {
    vi.useFakeTimers();
    const tracker = new HealthTracker(vi.fn(async () => true), mkPersistence(), 1000, 1000);
    await tracker.markModelUnhealthy(1, "gpt-4o");
    vi.advanceTimersByTime(1001);
    expect(await tracker.listModelUnhealthy(1)).toEqual([]);
    expect(await tracker.isModelHealthy(1, "gpt-4o")).toBe(true);
  });

  it("markModelHealthy only persists when a marker existed", async () => {
    const persistence = mkPersistence();
    const tracker = new HealthTracker(vi.fn(async () => true), persistence);
    await tracker.markModelHealthy(1, "gpt-4o"); // 无标记：不写 DB
    expect(persistence.saveModel).not.toHaveBeenCalled();
  });
});

describe("HealthTracker - persistence load", () => {
  it("loads persisted unhealthy upstreams and reschedules probing", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => true);
    const persistence = mkPersistence({
      loadUpstreams: vi.fn(async () => [7]),
      loadModels: vi.fn(async () => []),
    });
    const tracker = new HealthTracker(probe, persistence, 1000);
    expect(await tracker.isHealthy(7)).toBe(false);
    expect(await tracker.isHealthy(8)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledWith(7);
    vi.useRealTimers();
  });

  it("loads persisted model markers within ttl", async () => {
    const future = Date.now() + 60_000;
    const persistence = mkPersistence({
      loadUpstreams: vi.fn(async () => []),
      loadModels: vi.fn(async () => [{ upstreamId: 3, model: "claude-3-5-sonnet", expiresAt: future }]),
    });
    const tracker = new HealthTracker(vi.fn(async () => true), persistence);
    expect(await tracker.isModelHealthy(3, "claude-3-5-sonnet")).toBe(false);
    expect(await tracker.isModelHealthy(3, "other-model")).toBe(true);
  });

  it("ignores expired persisted model markers", async () => {
    const persistence = mkPersistence({
      loadUpstreams: vi.fn(async () => []),
      loadModels: vi.fn(async () => [{ upstreamId: 3, model: "claude-3-5-sonnet", expiresAt: Date.now() - 1000 }]),
    });
    const tracker = new HealthTracker(vi.fn(async () => true), persistence);
    expect(await tracker.isModelHealthy(3, "claude-3-5-sonnet")).toBe(true);
  });

  it("loads only once even with concurrent calls", async () => {
    const persistence = mkPersistence({
      loadUpstreams: vi.fn(async () => [1]),
      loadModels: vi.fn(async () => []),
    });
    const tracker = new HealthTracker(vi.fn(async () => true), persistence);
    await Promise.all([
      tracker.isHealthy(1),
      tracker.isHealthy(1),
      tracker.isModelHealthy(1, "m"),
    ]);
    expect(persistence.loadUpstreams).toHaveBeenCalledTimes(1);
  });
});
