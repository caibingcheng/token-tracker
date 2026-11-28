// relay ⇄ 中心 的两个 HTTP 调用：plan（同步，失败即返回客户端错误）与 report（异步重试）。
// 出站统一走 outboundFetch（连接时地址校验 + dispatcher + redirect manual），不裸 fetch。
import { outboundFetch } from "@/lib/gateway/outbound-fetch";
import { getOutboundDispatcher } from "@/lib/gateway/proxy-dispatcher";
import { recordRtt, rttSnapshot, type RttBucketWire, type RttKind } from "./latency";

export const RELAY_VERSION = "1.0.0";

export interface PlanHopWire {
  hopIndex: number;
  upstreamId: number;
  keyId: number;
  keyLease: string;
  leaseExpiresAt: number;
  realModel: string | null;
  retries: number;
  continueOn: string[];
  stopOn: string[];
  passthrough: "last-4xx" | "last-business" | null;
  timeoutMs: number | null;
  suppressHealth: string[];
  skipSiblingsOn: string[];
}

export interface PlanWire {
  planId: string;
  expiresAt: number;
  quota: { reservedTokens: number; reservedRpm: number };
  hops: PlanHopWire[];
  modelsSnapshot: string[] | null;
  /** 中心的权威设备名（可缺：旧中心不返回）；relay 只用于展示 */
  device?: { id: number; name: string | null };
  policy: {
    streamIdleTimeoutMinutes: number;
    centerMaxBodyMb: number;
    /** 可缺：旧中心不下发（relay 用本地 50MB 兜底） */
    centerMaxResponseBufferMb?: number;
  };
}

export interface PlanRequest {
  vkFp: string;
  path: string;
  model: string | null;
  protocol: string;
  stream: boolean | undefined;
  nativeSessionId: string | null;
  sessionInput: string | null;
  hasMessages: boolean;
  responseId: string | null;
  userAgent: string | null;
  estimatedInputTokens: number;
  headerNames: string[];
}

export interface PlanErrorBody {
  error: { message: string; type: string };
}

function centerUrl(): string {
  const url = process.env.CENTER_URL ?? "";
  return url.replace(/\/+$/, "");
}

// kind 非空时顺便记 RTT（relay 发出 → 中心响应头到达）。不读 body：中心响应都很小，
// 差那几毫秒不影响「链路 RTT」的判断，而读 body 会把调用方的解析语义搅在一起。
async function postCenter(
  path: string,
  body: unknown,
  deviceToken: string,
  kind?: RttKind
): Promise<Response> {
  const startedAt = Date.now();
  const response = await postCenterRaw(path, body, deviceToken);
  if (kind) recordRtt(kind, Date.now() - startedAt);
  return response;
}

async function postCenterRaw(path: string, body: unknown, deviceToken: string): Promise<Response> {
  return outboundFetch(`${centerUrl()}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deviceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    // 中心可能在环回/内网：sync scope 允许 loopback，私网需 ALLOW_PRIVATE_UPSTREAMS。
    // dispatcher 必须同步开 allowLoopback，否则 CENTER_URL 用 localhost 主机名时
    // URL 断言层放行、连接层 guarded lookup 拒绝（与 sync/pusher 同口径）。
    scope: "sync",
    redirect: "manual",
    dispatcher: getOutboundDispatcher(null, { allowLoopback: true }),
    signal: AbortSignal.timeout(15_000),
  });
}

export interface PlanFailure {
  status: number;
  error: PlanErrorBody;
  /** true = 中心明确拒绝 device token（轮换/删除/未授权），不是 vk 或模型问题 */
  deviceTokenRejected?: boolean;
  /** true = 该 device 被撤销（reason=revoked）：**不清 token**，中心 unrevoke 后自动恢复 */
  deviceRevoked?: boolean;
}

/**
 * 解析中心返回的 plan 失败体。两种形状：
 *   - 业务错误 `{error:{message,type}}`（planError）
 *   - **device token 被拒** `{success:false, error:"Invalid or revoked device token"}`（withDeviceAuth）
 * 后者以前会被归成 type=upstream_error，relay 只能给客户端一个 401 糊状错误，也无法自愈。
 */
export function parsePlanFailure(status: number, body: unknown): PlanFailure {
  const raw = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const errorObj =
    raw && typeof raw.error === "object" && raw.error !== null
      ? (raw.error as { message?: unknown; type?: unknown })
      : null;
  const deviceTokenRejected = status === 401 && raw?.success === false && typeof raw.error === "string";
  return {
    status,
    error: {
      error: {
        message:
          (typeof errorObj?.message === "string" ? errorObj.message : null) ??
          (typeof raw?.error === "string" ? raw.error : null) ??
          "plan failed",
        type: (typeof errorObj?.type === "string" ? errorObj.type : null) ?? "upstream_error",
      },
    },
    ...(deviceTokenRejected ? { deviceTokenRejected: true } : {}),
    ...(deviceTokenRejected && raw?.reason === "revoked" ? { deviceRevoked: true } : {}),
  };
}

export async function requestPlan(
  deviceToken: string,
  request: PlanRequest
): Promise<{ ok: true; plan: PlanWire } | ({ ok: false } & PlanFailure)> {
  const res = await postCenter(
    "/api/device/plan",
    { ...request, relayVersion: RELAY_VERSION },
    deviceToken,
    "plan"
  );
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, status: res.status, error: { error: { message: "center redirected", type: "redirect" } } };
  }
  if (!res.ok) {
    return { ok: false, ...parsePlanFailure(res.status, body) };
  }
  return { ok: true, plan: body as PlanWire };
}

export interface ReportPayload {
  planId: string;
  status: "ok" | "failed" | "client_aborted" | "stream_interrupted";
  winner: { hopIndex: number; upstreamId: number; keyId: number } | null;
  failures: {
    hopIndex: number;
    upstreamId: number;
    keyId: number;
    status: number | null;
    bodyKind: "json" | "html" | "other" | null;
    cause: "http" | "timeout" | "network";
  }[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    hasUsage: boolean;
  } | null;
  latencyMs: number;
  ttftMs: number | null;
  responseId: string | null;
  /** relay 自己测的 RTT 分钟桶（由 sendReport 填充，调用方不必传） */
  centerRtt?: RttBucketWire[];
}

// fire-and-forget：指数退避 1s/4s/16s，仍失败则丢弃并本地计数（不落盘，§17）
const reportFailures = { count: 0 };
export function reportDroppedCount(): number {
  return reportFailures.count;
}

export function sendReport(deviceToken: string, payload: ReportPayload): void {
  // 桶快照只取一次：重试复用同一份（中心覆盖写，重传不会重复累加）
  const body: ReportPayload = { ...payload, centerRtt: rttSnapshot() };
  const delays = [0, 1000, 4000, 16_000];
  const attempt = (index: number) => {
    if (index >= delays.length) {
      reportFailures.count += 1;
      console.warn(`[relay] report dropped after ${delays.length} attempts (plan ${payload.planId})`);
      return;
    }
    setTimeout(() => {
      void postCenter("/api/device/report", body, deviceToken, "report")
        .then((res) => {
          if (!res.ok) attempt(index + 1);
        })
        .catch(() => attempt(index + 1));
    }, delays[index]).unref?.();
  };
  attempt(0);
}
