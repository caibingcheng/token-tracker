// upstream / model 健康状态管理 + 定时探活调度（内存缓存 + DB 持久化，重启不丢失）。
// healthy（默认）→ unhealthy：某次真实请求中该 upstream 所有 key 均失败
// unhealthy → healthy：定时探活成功 / 手动测试成功 / 兜底真实请求 2xx 成功
// unhealthy 的 upstream 不进入请求候选池（仅当存在健康候选时）；全部候选不健康时
// 代理链路兜底尝试 unhealthy 候选（不留 502），拿到 2xx 立即 markHealthy + markModelHealthy 自愈

export type UpstreamHealth = "healthy" | "unhealthy";

export const DEFAULT_PROBE_INTERVAL_MS = 30 * 60 * 1000;
// model 级不可用标记的 TTL：到期自动恢复，不额外探活（404 探活同样 404，无意义）
export const MODEL_UNAVAILABLE_TTL_MS = 30 * 60 * 1000;

export interface ProbeFn {
  (upstreamId: number): Promise<boolean>;
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
    const timer = setTimeout(() => {
      this.timers.delete(upstreamId);
      void this.runProbe(upstreamId);
    }, this.intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(upstreamId, timer);
  }

  private async runProbe(upstreamId: number): Promise<void> {
    let ok = false;
    try {
      ok = await this.probeFn(upstreamId);
    } catch {
      ok = false;
    }
    if (ok) {
      await this.markHealthy(upstreamId);
    } else if (this.states.get(upstreamId) === "unhealthy") {
      this.scheduleProbe(upstreamId);
    }
  }

  private clearTimer(upstreamId: number): void {
    const timer = this.timers.get(upstreamId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(upstreamId);
    }
  }
}
