// upstream / model 健康状态管理 + 定时探活调度（内存缓存 + DB 持久化，重启不丢失）。
// healthy（默认）→ unhealthy：某次真实请求中该 upstream 所有 key 均失败
// unhealthy → healthy：定时探活成功 / 手动测试成功 / 兜底真实请求 2xx 成功
// unhealthy 的 upstream 不进入请求候选池（仅当存在健康候选时）；全部候选不健康时
// 代理链路兜底尝试 unhealthy 候选（不留 502），拿到 2xx 立即 markHealthy + markModelHealthy 自愈

export type UpstreamHealth = "healthy" | "unhealthy";

export const DEFAULT_PROBE_INTERVAL_MS = 30 * 60 * 1000;
// model 级不可用标记的 TTL：到期自动恢复，不额外探活（404 探活同样 404，无意义）
export const MODEL_UNAVAILABLE_TTL_MS = 30 * 60 * 1000;

// 探活结果：ok 为放宽后的最终判定（proxy-deps 侧已实现 404 放宽语义），
// status/error 供探活状态展示（status=0 表示无 HTTP 响应，如网络错误）
export interface ProbeOutcome {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface ProbeFn {
  (upstreamId: number): Promise<ProbeOutcome>;
}

// 探活状态（纯内存，重启后清空显示「未探测」，零 schema 变更）
export interface ProbeStatus {
  lastAt: number; // 上次探测完成时间戳；0 = 尚未探测
  ok: boolean;
  status: number; // 0 = 无 HTTP 响应（网络层失败）
  error?: string;
  nextAt: number | null; // 待执行的定时探活时间戳；null = 无
}

// 健康状态持久化接口（实现见 proxy-deps，DB 读写）
export interface HealthPersistence {
  // 返回所有 unhealthy 的 upstream id
  loadUpstreams(): Promise<number[]>;
  // 返回所有未过期的 model 级不可用标记
  loadModels(): Promise<Array<{ upstreamId: number; model: string; expiresAt: number }>>;
  // 持久化 upstream 级状态（unhealthy=true 标记，false 清除）
  saveUpstream(upstreamId: number, unhealthy: boolean): Promise<void>;
  // 持久化 model 级标记（expiresAt 时间戳毫秒；null 表示清除）
  saveModel(upstreamId: number, model: string, expiresAt: number | null): Promise<void>;
}

function modelKey(upstreamId: number, model: string): string {
  return `${upstreamId}\u0000${model}`;
}

export class HealthTracker {
  private states = new Map<number, UpstreamHealth>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  // model 级不可用：`${upstreamId}\0${model}` -> 过期时间戳（懒清理）
  private modelUnavailableUntil = new Map<string, number>();
  private probeFn: ProbeFn;
  private persistence: HealthPersistence;
  private intervalMs: number;
  private modelTtlMs: number;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private probeStatus = new Map<number, ProbeStatus>();
  // 禁用（stopProbing）后阻止一切定时探活调度；重新启用/手动 Probe now 前保持停止
  private probeStopped = new Set<number>();
  private probeInFlight = new Map<number, Promise<ProbeStatus | null>>();

  constructor(
    probeFn: ProbeFn,
    persistence: HealthPersistence,
    intervalMs = DEFAULT_PROBE_INTERVAL_MS,
    modelTtlMs = MODEL_UNAVAILABLE_TTL_MS
  ) {
    this.probeFn = probeFn;
    this.persistence = persistence;
    this.intervalMs = intervalMs;
    this.modelTtlMs = modelTtlMs;
  }

  // 懒加载 DB 中的持久化状态（幂等，并发调用共享同一 promise）
  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (!this.loadPromise) {
      this.loadPromise = this.load()
        .catch((err) => {
          console.error("[health] load persisted state failed:", err);
        })
        .finally(() => {
          this.loaded = true;
        });
    }
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    const [unhealthyIds, models] = await Promise.all([
      this.persistence.loadUpstreams(),
      this.persistence.loadModels(),
    ]);
    for (const upstreamId of unhealthyIds) {
      if (this.states.get(upstreamId) !== "unhealthy") {
        this.states.set(upstreamId, "unhealthy");
        if (!this.timers.has(upstreamId)) this.scheduleProbe(upstreamId);
      }
    }
    const now = Date.now();
    for (const item of models) {
      if (item.expiresAt > now) {
        this.modelUnavailableUntil.set(modelKey(item.upstreamId, item.model), item.expiresAt);
      }
    }
  }

  async isHealthy(upstreamId: number): Promise<boolean> {
    await this.ensureLoaded();
    return this.states.get(upstreamId) !== "unhealthy";
  }

  async markUnhealthy(upstreamId: number): Promise<void> {
    await this.ensureLoaded();
    if (this.states.get(upstreamId) === "unhealthy") return;
    this.states.set(upstreamId, "unhealthy");
    if (!this.timers.has(upstreamId)) {
      this.scheduleProbe(upstreamId);
    }
    await this.persist("saveUpstream", upstreamId, true);
  }

  async markHealthy(upstreamId: number): Promise<void> {
    await this.ensureLoaded();
    this.states.delete(upstreamId);
    this.clearTimer(upstreamId);
    // healthy 后不再有待执行探活（保留 lastAt 供 UI 展示上次结果）
    const status = this.probeStatus.get(upstreamId);
    if (status) status.nextAt = null;
    await this.persist("saveUpstream", upstreamId, false);
  }

  async isModelHealthy(upstreamId: number, model: string): Promise<boolean> {
    await this.ensureLoaded();
    const key = modelKey(upstreamId, model);
    const until = this.modelUnavailableUntil.get(key);
    if (until === undefined) return true;
    if (until <= Date.now()) {
      this.modelUnavailableUntil.delete(key); // 懒清理：TTL 过期自动恢复
      await this.persist("saveModel", upstreamId, model, null);
      return true;
    }
    return false;
  }

  async markModelUnhealthy(upstreamId: number, model: string): Promise<void> {
    await this.ensureLoaded();
    const expiresAt = Date.now() + this.modelTtlMs;
    this.modelUnavailableUntil.set(modelKey(upstreamId, model), expiresAt);
    await this.persist("saveModel", upstreamId, model, expiresAt);
  }

  async markModelHealthy(upstreamId: number, model: string): Promise<void> {
    await this.ensureLoaded();
    if (this.modelUnavailableUntil.delete(modelKey(upstreamId, model))) {
      await this.persist("saveModel", upstreamId, model, null);
    }
  }

  // 列出该 upstream 当前被标记不可用的 model（供 Admin UI 展示，顺带清理过期项）
  async listModelUnhealthy(upstreamId: number): Promise<string[]> {
    await this.ensureLoaded();
    const prefix = `${upstreamId}\u0000`;
    const now = Date.now();
    const result: string[] = [];
    for (const [key, until] of Array.from(this.modelUnavailableUntil)) {
      if (!key.startsWith(prefix)) continue;
      if (until <= now) {
        this.modelUnavailableUntil.delete(key);
        await this.persist("saveModel", upstreamId, key.slice(prefix.length), null);
        continue;
      }
      result.push(key.slice(prefix.length));
    }
    return result;
  }

  // fire-and-forget 持久化：DB 写失败不阻塞主流程，仅记录日志
  private async persist(
    method: "saveUpstream" | "saveModel",
    upstreamId: number,
    modelOrUnhealthy: string | boolean,
    expiresAt?: number | null
  ): Promise<void> {
    try {
      if (method === "saveUpstream") {
        await this.persistence.saveUpstream(upstreamId, modelOrUnhealthy as boolean);
      } else {
        await this.persistence.saveModel(upstreamId, modelOrUnhealthy as string, expiresAt ?? null);
      }
    } catch (err) {
      console.error("[health] persist failed:", err);
    }
  }

  private scheduleProbe(upstreamId: number): void {
    // 禁用（stopProbing）后不再挂任何定时探活，直到显式恢复
    if (this.probeStopped.has(upstreamId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(upstreamId);
      void this.runProbe(upstreamId);
    }, this.intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(upstreamId, timer);
    this.setProbeNext(upstreamId, Date.now() + this.intervalMs);
  }

  private setProbeNext(upstreamId: number, nextAt: number | null): void {
    const status = this.probeStatus.get(upstreamId);
    if (status) {
      status.nextAt = nextAt;
    } else if (nextAt !== null) {
      // 已调度但从未探测：先建占位条目（lastAt=0），UI 显示「未探测」+ 下次倒计时
      this.probeStatus.set(upstreamId, { lastAt: 0, ok: false, status: 0, nextAt });
    }
  }

  private async runProbe(upstreamId: number): Promise<void> {
    let ok = false;
    let status = 0;
    let error: string | undefined;
    try {
      const result = await this.probeFn(upstreamId);
      // 严格判定：dev/HMR 或部分部署场景下 probeFn 可能来自旧版本（返回 boolean 或
      // 其他 truthy 对象），宽松真值判断会把失败探活误判为成功并 markHealthy
      ok = result?.ok === true;
      status = typeof result?.status === "number" ? result.status : 0;
      error = typeof result?.error === "string" ? result.error : undefined;
    } catch (err) {
      ok = false;
      status = 0;
      error = err instanceof Error ? err.message : String(err);
    }
    this.probeStatus.set(upstreamId, { lastAt: Date.now(), ok, status, error, nextAt: null });
    if (ok) {
      await this.markHealthy(upstreamId);
    } else if (this.states.get(upstreamId) === "unhealthy") {
      this.scheduleProbe(upstreamId);
    }
  }

  // 只读探活状态（供 Admin API）；从未有过记录返回 null
  getProbeStatus(upstreamId: number): ProbeStatus | null {
    return this.probeStatus.get(upstreamId) ?? null;
  }

  // 立即执行一次探活并返回最新状态；并发重入共享同一次探测。
  // 不恢复定时探活调度（resumeProbing 负责），禁用状态下失败也不会重新挂 timer。
  probeNow(upstreamId: number): Promise<ProbeStatus | null> {
    const inFlight = this.probeInFlight.get(upstreamId);
    if (inFlight) return inFlight;
    const p = (async () => {
      // 先加载持久化状态：重启后首次 probeNow 时 states 可能为空，
      // 否则探测失败后无法判断是否需要重排定时探活（会静默丢失自动恢复）
      await this.ensureLoaded();
      await this.runProbe(upstreamId);
      return this.probeStatus.get(upstreamId) ?? null;
    })();
    this.probeInFlight.set(upstreamId, p);
    return p.finally(() => {
      this.probeInFlight.delete(upstreamId);
    });
  }

  // 停止定时探活（禁用 upstream）：停 timer、清 nextAt，保留 lastAt 供重新启用时展示
  stopProbing(upstreamId: number): void {
    this.probeStopped.add(upstreamId);
    this.clearTimer(upstreamId);
    this.setProbeNext(upstreamId, null);
  }

  // 恢复定时探活调度（重新启用 upstream）
  resumeProbing(upstreamId: number): void {
    this.probeStopped.delete(upstreamId);
  }

  // 移除 upstream 的全部内存态（DB 残留清理由调用方负责）
  removeUpstream(upstreamId: number): void {
    this.clearTimer(upstreamId);
    this.probeStopped.delete(upstreamId);
    this.states.delete(upstreamId);
    const prefix = `${upstreamId}\u0000`;
    for (const key of Array.from(this.modelUnavailableUntil.keys())) {
      if (key.startsWith(prefix)) this.modelUnavailableUntil.delete(key);
    }
    this.probeStatus.delete(upstreamId);
  }

  private clearTimer(upstreamId: number): void {
    const timer = this.timers.get(upstreamId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(upstreamId);
    }
  }
}
