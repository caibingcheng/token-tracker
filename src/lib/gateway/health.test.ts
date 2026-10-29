import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HealthTracker, DEFAULT_PROBE_INTERVAL_MS } from "./health";
import type { HealthPersistence, ProbeOutcome } from "./health";

const probeOk = (status = 200): ProbeOutcome => ({ ok: true, status });
const probeFail = (status = 500, error = "boom"): ProbeOutcome => ({ ok: false, status, error });

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
    const tracker = new HealthTracker(vi.fn(async () => probeOk()), mkPersistence());
    expect(await tracker.isHealthy(1)).toBe(true);
  });

  it("marks unhealthy and keeps it until probe succeeds", async () => {
    const tracker = new HealthTracker(vi.fn(async () => probeFail()), mkPersistence());
    await tracker.markUnhealthy(1);
    expect(await tracker.isHealthy(1)).toBe(false);
    expect(await tracker.isHealthy(2)).toBe(true);
  });

  it("persists upstream health state on change", async () => {
    const persistence = mkPersistence();
    const tracker = new HealthTracker(vi.fn(async () => probeOk()), persistence);
    await tracker.markUnhealthy(1);
    expect(persistence.saveUpstream).toHaveBeenCalledWith(1, true);
    await tracker.markHealthy(1);
    expect(persistence.saveUpstream).toHaveBeenCalledWith(1, false);
  });

  it("recovers to healthy after successful probe", async () => {
    const probe = vi.fn(async () => probeOk());
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    expect(await tracker.isHealthy(1)).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledWith(1);
    expect(await tracker.isHealthy(1)).toBe(true);
  });

  it("stays unhealthy and reschedules when probe fails", async () => {
    const probe = vi.fn(async () => probeFail());
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
    const probe = vi.fn(async (): Promise<ProbeOutcome> => {
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
    const probe = vi.fn(async () => probeOk());
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    await tracker.markUnhealthy(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await tracker.isHealthy(1)).toBe(true);
  });

  it("stops probing after recovery", async () => {
    const probe = vi.fn(async () => probeOk());
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

  it("backs off 30s → 1min → 5min → 30min and caps at 30min", async () => {
    const probe = vi.fn(async () => probeFail());
    const tracker = new HealthTracker(probe, mkPersistence());
    await tracker.markUnhealthy(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(probe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_999); // 第二档 1min 未到
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(probe).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(probe).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(30 * 60_000); // 末档封顶
    expect(probe).toHaveBeenCalledTimes(5);
    expect(await tracker.isHealthy(1)).toBe(false);
  });

  it("exposes the ladder in probe nextAt", async () => {
    const tracker = new HealthTracker(vi.fn(async () => probeFail()), mkPersistence());
    await tracker.markUnhealthy(1);
    const first = tracker.getProbeStatus(1)?.nextAt ?? 0;
    expect(first - Date.now()).toBe(30_000); // 首档 30s

    await vi.advanceTimersByTimeAsync(30_000);
    const second = tracker.getProbeStatus(1)?.nextAt ?? 0;
    expect(second - Date.now()).toBe(60_000); // 失败一次 → 1min
  });

  it("resets the ladder to the first step after recovery", async () => {
    let probeOkNow = false;
    const probe = vi.fn(async () => (probeOkNow ? probeOk() : probeFail()));
    const tracker = new HealthTracker(probe, mkPersistence());
    await tracker.markUnhealthy(1);

    await vi.advanceTimersByTimeAsync(30_000); // 第一档失败 → 进 1min 档
    await vi.advanceTimersByTimeAsync(60_000); // 第二档失败 → 进 5min 档
    expect(probe).toHaveBeenCalledTimes(2);

    probeOkNow = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 5min 档探活成功 → 恢复
    expect(await tracker.isHealthy(1)).toBe(true);

    probeOkNow = false;
    await tracker.markUnhealthy(1); // 再次故障：回到首档 30s
    expect((tracker.getProbeStatus(1)?.nextAt ?? 0) - Date.now()).toBe(30_000);
  });

  it("gives up the fallback slot after the ladder caps and keeps probing", async () => {
    const probe = vi.fn(async () => probeFail());
    const tracker = new HealthTracker(probe, mkPersistence());
    await tracker.markUnhealthy(1);

    await vi.advanceTimersByTimeAsync(30_000); // 第 1 次失败
    await vi.advanceTimersByTimeAsync(60_000); // 2
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 3
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(30 * 60_000); // 4-6（末档）
    expect(probe).toHaveBeenCalledTimes(6);
    expect(tracker.isGivenUp(1)).toBe(false);

    await vi.advanceTimersByTimeAsync(30 * 60_000); // 7：末档内第 4 次失败 → 放弃兜底
    expect(probe).toHaveBeenCalledTimes(7);
    expect(tracker.isGivenUp(1)).toBe(true);
    expect(tracker.getProbeStatus(1)?.givenUp).toBe(true);

    await vi.advanceTimersByTimeAsync(30 * 60_000); // 探活不因放弃而停止
    expect(probe).toHaveBeenCalledTimes(8);
    expect(await tracker.isHealthy(1)).toBe(false);
  });

  it("clears the give-up flag once a probe succeeds", async () => {
    let probeOkNow = false;
    const probe = vi.fn(async () => (probeOkNow ? probeOk() : probeFail()));
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);

    await vi.advanceTimersByTimeAsync(7000); // 档位 1000ms × 7 次失败
    expect(tracker.isGivenUp(1)).toBe(true);
    expect(tracker.getProbeStatus(1)?.givenUp).toBe(true);

    probeOkNow = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(tracker.isGivenUp(1)).toBe(false);
    expect(tracker.getProbeStatus(1)?.givenUp).toBe(false); // 状态对象不残留旧值
    expect(await tracker.isHealthy(1)).toBe(true);
  });

  it("does not double-schedule timers when a manual probe fails while a timer is pending", async () => {
    const probe = vi.fn(async () => probeFail());
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);

    await tracker.probeNow(1); // 手动探活失败：档位 1，重排定时器（旧 timer 需被清掉）
    expect(probe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(2); // 只有一次定时探活
  });

  it("shares one in-flight probe between concurrent probeNow calls", async () => {
    let resolveProbe: ((o: ProbeOutcome) => void) | undefined;
    const probe = vi.fn(
      () =>
        new Promise<ProbeOutcome>((resolve) => {
          resolveProbe = resolve;
        })
    );
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    const first = tracker.probeNow(1);
    const second = tracker.probeNow(1);
    while (!resolveProbe) await vi.advanceTimersByTimeAsync(0); // 等 ensureLoaded 完成

    resolveProbe(probeFail());
    await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledTimes(1); // 单飞：两次 probeNow 只探一次
  });

  it("resumeProbing clears the give-up flag so a re-enabled upstream is retried", async () => {
    const tracker = new HealthTracker(vi.fn(async () => probeFail()), mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    await vi.advanceTimersByTimeAsync(7000);
    expect(tracker.isGivenUp(1)).toBe(true);

    tracker.stopProbing(1);
    expect(tracker.isGivenUp(1)).toBe(true); // 仅停探活，不改兜底资格
    tracker.resumeProbing(1);
    expect(tracker.isGivenUp(1)).toBe(false);
  });

  it("probes each upstream independently", async () => {
    const probe = vi.fn(async () => probeOk());
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
    const tracker = new HealthTracker(vi.fn(async () => probeOk()), mkPersistence());
    expect(await tracker.isModelHealthy(1, "gpt-4o")).toBe(true);
  });

  it("marks single model unavailable without affecting others or upstream", async () => {
    const tracker = new HealthTracker(vi.fn(async () => probeOk()), mkPersistence());
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
    const tracker = new HealthTracker(vi.fn(async () => probeOk()), persistence);
    await tracker.markModelUnhealthy(1, "gpt-4o");
    expect(persistence.saveModel).toHaveBeenCalledWith(1, "gpt-4o", expect.any(Number));
    await tracker.markModelHealthy(1, "gpt-4o");
    expect(persistence.saveModel).toHaveBeenCalledWith(1, "gpt-4o", null);
  });

  it("auto-recovers after ttl", async () => {
    vi.useFakeTimers();
    const tracker = new HealthTracker(vi.fn(async () => probeOk()), mkPersistence(), 1000, 1000);
    await tracker.markModelUnhealthy(1, "gpt-4o");
    expect(await tracker.isModelHealthy(1, "gpt-4o")).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(await tracker.isModelHealthy(1, "gpt-4o")).toBe(true);
  });

  it("listModelUnhealthy cleans expired entries", async () => {
    vi.useFakeTimers();
    const tracker = new HealthTracker(vi.fn(async () => probeOk()), mkPersistence(), 1000, 1000);
    await tracker.markModelUnhealthy(1, "gpt-4o");
    vi.advanceTimersByTime(1001);
    expect(await tracker.listModelUnhealthy(1)).toEqual([]);
    expect(await tracker.isModelHealthy(1, "gpt-4o")).toBe(true);
  });

  it("markModelHealthy only persists when a marker existed", async () => {
    const persistence = mkPersistence();
    const tracker = new HealthTracker(vi.fn(async () => probeOk()), persistence);
    await tracker.markModelHealthy(1, "gpt-4o"); // 无标记：不写 DB
    expect(persistence.saveModel).not.toHaveBeenCalled();
  });
});

describe("HealthTracker - persistence load", () => {
  it("loads persisted unhealthy upstreams and reschedules probing", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => probeOk());
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
    const tracker = new HealthTracker(vi.fn(async () => probeOk()), persistence);
    expect(await tracker.isModelHealthy(3, "claude-3-5-sonnet")).toBe(false);
    expect(await tracker.isModelHealthy(3, "other-model")).toBe(true);
  });

  it("ignores expired persisted model markers", async () => {
    const persistence = mkPersistence({
      loadUpstreams: vi.fn(async () => []),
      loadModels: vi.fn(async () => [{ upstreamId: 3, model: "claude-3-5-sonnet", expiresAt: Date.now() - 1000 }]),
    });
    const tracker = new HealthTracker(vi.fn(async () => probeOk()), persistence);
    expect(await tracker.isModelHealthy(3, "claude-3-5-sonnet")).toBe(true);
  });

  it("loads only once even with concurrent calls", async () => {
    const persistence = mkPersistence({
      loadUpstreams: vi.fn(async () => [1]),
      loadModels: vi.fn(async () => []),
    });
    const tracker = new HealthTracker(vi.fn(async () => probeOk()), persistence);
    await Promise.all([
      tracker.isHealthy(1),
      tracker.isHealthy(1),
      tracker.isModelHealthy(1, "m"),
    ]);
    expect(persistence.loadUpstreams).toHaveBeenCalledTimes(1);
  });
});

describe("HealthTracker - probe status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records probe result and reschedules nextAt on failure", async () => {
    const probe = vi.fn(async () => probeFail(503, "service unavailable"));
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    expect(tracker.getProbeStatus(1)).toBeNull();

    await tracker.markUnhealthy(1);
    const scheduled = tracker.getProbeStatus(1)!;
    expect(scheduled.lastAt).toBe(0); // 已调度但从未探测
    expect(scheduled.nextAt).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(1);
    const after = tracker.getProbeStatus(1)!;
    expect(after.lastAt).toBeGreaterThan(0);
    expect(after.ok).toBe(false);
    expect(after.status).toBe(503);
    expect(after.error).toBe("service unavailable");
    expect(after.nextAt).not.toBeNull(); // 失败自我再调度

    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("clears nextAt after recovery and stops scheduling", async () => {
    const probe = vi.fn(async () => probeOk());
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    await vi.advanceTimersByTimeAsync(1000);
    const status = tracker.getProbeStatus(1)!;
    expect(status.ok).toBe(true);
    expect(status.nextAt).toBeNull();
    expect(status.lastAt).toBeGreaterThan(0); // lastAt 保留供展示

    await vi.advanceTimersByTimeAsync(3000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("records thrown probe as failure with error message", async () => {
    const probe = vi.fn(async (): Promise<ProbeOutcome> => {
      throw new Error("net down");
    });
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    await vi.advanceTimersByTimeAsync(1000);
    const status = tracker.getProbeStatus(1)!;
    expect(status.ok).toBe(false);
    expect(status.status).toBe(0);
    expect(status.error).toBe("net down");
  });

  it("stopProbing halts timer, clears nextAt, keeps lastAt; probeNow failure does not reschedule", async () => {
    const probe = vi.fn(async () => probeFail(503));
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    await vi.advanceTimersByTimeAsync(1000); // 探测一次失败并再调度
    expect(probe).toHaveBeenCalledTimes(1);

    tracker.stopProbing(1);
    const stopped = tracker.getProbeStatus(1)!;
    expect(stopped.nextAt).toBeNull();
    expect(stopped.lastAt).toBeGreaterThan(0); // lastAt 保留

    await vi.advanceTimersByTimeAsync(3000);
    expect(probe).toHaveBeenCalledTimes(1); // timer 已停

    await tracker.probeNow(1); // 手动探测失败也不恢复定时探活（禁用语义）
    expect(probe).toHaveBeenCalledTimes(2);
    expect(tracker.getProbeStatus(1)!.nextAt).toBeNull();
    expect(await tracker.isHealthy(1)).toBe(false);
  });

  it("resumeProbing restores scheduled probing after re-enable", async () => {
    const probe = vi.fn(async () => probeFail(503));
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    tracker.stopProbing(1);

    tracker.resumeProbing(1);
    await tracker.probeNow(1); // 失败 → 恢复定时调度
    expect(tracker.getProbeStatus(1)!.nextAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(2); // 定时探活恢复
  });

  it("removeUpstream clears state, model markers and probe status", async () => {
    const tracker = new HealthTracker(vi.fn(async () => probeOk()), mkPersistence());
    await tracker.markUnhealthy(1);
    await tracker.markModelUnhealthy(1, "gpt-4o");
    await vi.advanceTimersByTimeAsync(1000);

    tracker.removeUpstream(1);
    expect(await tracker.isHealthy(1)).toBe(true);
    expect(await tracker.listModelUnhealthy(1)).toEqual([]);
    expect(tracker.getProbeStatus(1)).toBeNull();
  });

  it("probeNow recovers an unhealthy upstream immediately", async () => {
    const probe = vi.fn(async () => probeOk());
    const persistence = mkPersistence();
    const tracker = new HealthTracker(probe, persistence, 1000);
    await tracker.markUnhealthy(1);

    const status = await tracker.probeNow(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(status?.ok).toBe(true);
    expect(status?.lastAt).toBeGreaterThan(0);
    expect(await tracker.isHealthy(1)).toBe(true);
    expect(persistence.saveUpstream).toHaveBeenCalledWith(1, false);
    expect(tracker.getProbeStatus(1)!.nextAt).toBeNull();
  });

  it("probeNow 作为首个调用时先加载持久化状态：失败仍重排定时探活", async () => {
    const probe = vi.fn(async () => probeFail(503));
    const persistence = mkPersistence({
      loadUpstreams: vi.fn(async () => [1]),
      loadModels: vi.fn(async () => []),
    });
    const tracker = new HealthTracker(probe, persistence, 1000);
    // 重启后第一个触碰 tracker 的操作就是 probeNow（loaded=false）
    const status = await tracker.probeNow(1);
    expect(status?.ok).toBe(false);
    expect(await tracker.isHealthy(1)).toBe(false);
    expect(tracker.getProbeStatus(1)!.nextAt).not.toBeNull(); // 定时探活不被静默丢失
  });

  it("旧版 boolean 返回值的 probeFn 不被误判为探活成功", async () => {
    // dev/HMR 或部分部署场景下 probeFn 可能来自旧版本（返回 boolean）
    const probe = vi.fn(async () => true as unknown as ProbeOutcome);
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);
    const status = await tracker.probeNow(1);
    expect(status?.ok).toBe(false); // truthy 非对象 ≠ 成功，不得 markHealthy
    expect(await tracker.isHealthy(1)).toBe(false);
  });

  it("probeNow concurrent re-entry shares a single probe", async () => {
    let resolveProbe: ((v: ProbeOutcome) => void) | undefined;
    const probe = vi.fn(
      () => new Promise<ProbeOutcome>((res) => {
        resolveProbe = res;
      })
    );
    const tracker = new HealthTracker(probe, mkPersistence(), 1000);
    await tracker.markUnhealthy(1);

    const p1 = tracker.probeNow(1);
    const p2 = tracker.probeNow(1);
    // probeNow 先 ensureLoaded 再调 probeFn：flush 微任务等待 probeFn 被调用
    await vi.advanceTimersByTimeAsync(0);
    resolveProbe!(probeFail(404));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });
});
