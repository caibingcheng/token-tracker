// relay plan 的依赖装配（仅中心）：把 ProxyDeps 的同一份实现接到 PlanDeps 上。
// 复用 createProxyDeps()：健康、session 粘性、命名路由/分类器、配额读口径全部同一份代码，
// 新增的只有「带 key id + 按 device 过滤」的 key 解析（per-device key 开关）。
//
// apiKeyOf：lease 需要 key 明文，但 plan 结果里**不放**明文（避免将来被直接回显）。
// 明文只在本次请求的闭包里驻留，不落盘、不进日志。
import { createProxyDeps, loadPlainUpstreamKeysForDevice } from "@/lib/gateway/proxy-deps";
import { withSkipCache } from "@/lib/db/cache";
import type { PlanDeps } from "@/lib/gateway/plan";

export function createPlanDeps(): {
  deps: PlanDeps;
  apiKeyOf: (keyId: number) => string | null;
} {
  const proxy = createProxyDeps();
  const apiKeys = new Map<number, string>();
  const deps: PlanDeps = {
    loadUpstreams: proxy.loadUpstreams,
    resolveUpstreamKeys: async (upstreamId, deviceId) => {
      const keys = await withSkipCache(() =>
        loadPlainUpstreamKeysForDevice(upstreamId, deviceId)
      );
      for (const key of keys) apiKeys.set(key.id, key.apiKey);
      return keys;
    },
    loadNamedRoutes: proxy.loadNamedRoutes,
    loadNamedRouteTargets: proxy.loadNamedRouteTargets,
    runClassifier: proxy.runClassifier,
    session: proxy.session,
    health: proxy.health,
    lookupResponseOwner: proxy.lookupResponseOwner,
    quota: proxy.quota,
    // 分类器自身的 token 成本照旧写 token_records（无 device_id：那是中心侧开销，不是 relay 流量）
    onClassifierUsage: proxy.onUsage,
    log: proxy.log,
  };
  return { deps, apiKeyOf: (keyId) => apiKeys.get(keyId) ?? null };
}
