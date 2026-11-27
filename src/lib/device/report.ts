// report → 健康标记的纯逻辑（分 mode，与 proxy.ts 的判定逐项对齐）。
// 放在这里而不是 route 里：可单测，且避免把「哪条链怎么标记」散进 HTTP 处理。
//
// 关键差异（最容易搞错的地方）：
// - router：403/404 → model 级标记（403 仅当不是边缘拦截 html）；401/网络 → 同 upstream 全 key 失败才
//   markUnhealthy；429/5xx 不标记
// - responses-create：403/404 **不打** model 级标记（可能是"上游不支持 responses API"）
// - responses-subresource：404/403 零健康标记（response id 每次不同，标记会污染）
import type { PlanMode } from "@/lib/gateway/plan";

export interface ReportHop {
  hopIndex: number;
  upstreamId: number;
  keyId: number;
  realModel: string | null;
}

export interface ReportFailure {
  hopIndex: number;
  upstreamId: number;
  keyId: number;
  status: number | null;
  bodyKind: "json" | "html" | "other" | null;
  cause: "http" | "timeout" | "network";
}

export interface ReportWinner {
  hopIndex: number;
  upstreamId: number;
  keyId: number;
}

export type HealthAction =
  | { type: "markUnhealthy"; upstreamId: number }
  | { type: "markModelUnhealthy"; upstreamId: number; model: string }
  | { type: "markHealthy"; upstreamId: number }
  | { type: "markModelHealthy"; upstreamId: number; model: string };

export function planHealthActions(input: {
  mode: PlanMode;
  hops: ReportHop[];
  failures: ReportFailure[];
  winner: ReportWinner | null;
}): HealthAction[] {
  const { mode, hops, failures, winner } = input;
  const actions: HealthAction[] = [];
  const seen = new Set<string>();
  const push = (action: HealthAction) => {
    const key =
      action.type === "markModelUnhealthy" || action.type === "markModelHealthy"
        ? `${action.type}:${action.upstreamId}:${action.model}`
        : `${action.type}:${action.upstreamId}`;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(action);
  };

  const hopOf = (hopIndex: number) => hops.find((h) => h.hopIndex === hopIndex) ?? null;
  const keysByUpstream = new Map<number, Set<number>>();
  for (const hop of hops) {
    const set = keysByUpstream.get(hop.upstreamId) ?? new Set<number>();
    set.add(hop.keyId);
    keysByUpstream.set(hop.upstreamId, set);
  }

  // 每个 upstream 的「auth/网络类失败」覆盖到的 key（决定是否 markUnhealthy）
  const authFailedKeys = new Map<number, Set<number>>();

  for (const failure of failures) {
    const hop = hopOf(failure.hopIndex);
    if (!hop || hop.upstreamId !== failure.upstreamId || hop.keyId !== failure.keyId) {
      // hopIndex 与中心副本对不上：report 来自不可信 sub node，整条丢弃
      continue;
    }
    const status = failure.status;
    if (failure.cause === "network" || failure.cause === "timeout") {
      const set = authFailedKeys.get(hop.upstreamId) ?? new Set<number>();
      set.add(hop.keyId);
      authFailedKeys.set(hop.upstreamId, set);
      continue;
    }
    if (status === 401) {
      const set = authFailedKeys.get(hop.upstreamId) ?? new Set<number>();
      set.add(hop.keyId);
      authFailedKeys.set(hop.upstreamId, set);
      continue;
    }
    if (status === 403 || status === 404) {
      // 子资源：该 upstream 不认这个 response id，零健康标记
      if (mode === "responses-subresource") continue;
      // responses-create：可能是"不支持 responses API"，不打 model 级标记
      if (mode === "responses-create") continue;
      // 403 + html = 边缘/反 bot 拦截（同 sawEdgeBlock）：不标记任何健康
      if (status === 403 && failure.bodyKind === "html") continue;
      if (hop.realModel) push({ type: "markModelUnhealthy", upstreamId: hop.upstreamId, model: hop.realModel });
      continue;
    }
    // 429 / 5xx / 其他：不标记
  }

  for (const [upstreamId, failedKeys] of authFailedKeys) {
    const allKeys = keysByUpstream.get(upstreamId);
    if (!allKeys || allKeys.size === 0) continue;
    let covered = true;
    for (const keyId of allKeys) {
      if (!failedKeys.has(keyId)) {
        covered = false;
        break;
      }
    }
    if (covered) push({ type: "markUnhealthy", upstreamId });
  }

  if (winner) {
    const hop = hopOf(winner.hopIndex);
    if (hop && hop.upstreamId === winner.upstreamId && hop.keyId === winner.keyId) {
      push({ type: "markHealthy", upstreamId: hop.upstreamId });
      if (hop.realModel) {
        push({ type: "markModelHealthy", upstreamId: hop.upstreamId, model: hop.realModel });
      }
    }
  }

  return actions;
}
