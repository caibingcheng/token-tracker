// relay 执行器：哑循环（§10.1）。
// 所有策略都来自中心下发的 plan —— relay 不判断路由、不做健康决策、不写库。
// 循环唯一的 if 就是「这个状态码在 continueOn 里吗」「要不要保留这个失败响应」。
import type { Protocol } from "@/lib/gateway/model-router";
import { isLeaseExpired, openLease, type LeasePayload } from "@/lib/gateway/lease";
import { getOutboundDispatcher } from "@/lib/gateway/proxy-dispatcher";
import { outboundFetch } from "@/lib/gateway/outbound-fetch";
import { assertOutboundUrlAllowed, privateUpstreamsAllowed } from "@/lib/gateway/url-guard";
import { buildUpstreamHeaders } from "@/lib/gateway/upstream-headers";
import {
  createSseModelRewriter,
  rewriteModelNonStreamingBytes,
} from "@/lib/gateway/response-rewriter";
import { StreamUsageExtractor } from "@/lib/gateway/parsers/stream-usage";
import {
  parseAnthropicNonStreaming,
  parseGeminiNonStreaming,
  parseOpenAiNonStreaming,
} from "@/lib/gateway/parsers";
import type { ParsedUsage } from "@/lib/gateway/parsers/types";
import { scanTopLevelObject } from "@/lib/gateway/json-scan";
import { rewriteBodyModel, type PreparedRequest } from "./prepare";
import { sendReport, type PlanHopWire, type PlanWire, type ReportPayload } from "./plan-client";

const MAX_NON_STREAMING_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_RETAINED_ERROR_BYTES = 256 * 1024;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface ExecuteOptions {
  plan: PlanWire;
  deviceToken: string;
  devicePrivateKeyPem: string;
  prepared: PreparedRequest;
  request: Request;
  /** 流式空闲超时（来自 plan.policy，缺省 30min） */
  streamIdleTimeoutMs?: number;
  /** /pair 页展示「最近一次 plan 结果」用 */
  onOutcome?: (label: string) => void;
}

type Failure = ReportPayload["failures"][number];
type ReportStatus = ReportPayload["status"];
type FinishFn = (
  status: ReportStatus,
  winner: ReportPayload["winner"],
  usage: ReportPayload["usage"],
  extra?: { responseId?: string | null; ttftMs?: number | null; label?: string }
) => void;

// 弱匹配兜底：中心少发字段的 hop 按标准路由语义默认（同 plan.ts 的 ROUTER_CONTINUE_ON /
// SKIP_SIBLINGS_ON；retries 是每 key 总尝试次数，标同 plan.ts 的 MAX_RETRY=2），
// passthrough 缺省不透传。保证「只要满足基础功能就能用」。
const DEFAULT_CONTINUE_ON = ["401", "403", "404", "429", "5xx", "network", "timeout"];
const DEFAULT_SKIP_SIBLINGS_ON = ["403", "404"];
const DEFAULT_RETRIES = 2;

function normalizeHop(hop: PlanHopWire): Required<PlanHopWire> {
  return {
    ...hop,
    retries: Math.max(1, Math.floor(Number.isFinite(hop.retries) ? (hop.retries as number) : DEFAULT_RETRIES)),
    continueOn: Array.isArray(hop.continueOn) ? hop.continueOn : [...DEFAULT_CONTINUE_ON],
    stopOn: Array.isArray(hop.stopOn) ? hop.stopOn : [],
    passthrough: hop.passthrough ?? null,
    timeoutMs: hop.timeoutMs ?? null,
    suppressHealth: Array.isArray(hop.suppressHealth) ? hop.suppressHealth : [],
    skipSiblingsOn: Array.isArray(hop.skipSiblingsOn) ? hop.skipSiblingsOn : [...DEFAULT_SKIP_SIBLINGS_ON],
  };
}

function matchesCondition(
  conditions: string[],
  status: number,
  cause?: "network" | "timeout"
): boolean {
  for (const condition of conditions) {
    if (condition === "5xx") {
      if (status >= 500 && status < 600) return true;
      continue;
    }
    if (condition === "network") {
      if (cause === "network") return true;
      continue;
    }
    if (condition === "timeout") {
      if (cause === "timeout") return true;
      continue;
    }
    if (Number(condition) === status) return true;
  }
  return false;
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function is3xx(status: number): boolean {
  return status >= 300 && status < 400;
}

function bodyKindOf(headers: Headers): "json" | "html" | "other" {
  const contentType = (headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("json")) return "json";
  if (contentType.includes("html")) return "html";
  return "other";
}

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function copyHeader(from: Headers, to: Headers, name: string): void {
  const value = from.get(name);
  if (value) to.set(name, value);
}

function usageFromBytes(bytes: Uint8Array, protocol: Protocol): ParsedUsage | null {
  const key = protocol === "gemini" ? "usageMetadata" : "usage";
  const scan = scanTopLevelObject(bytes, [key]);
  if (!scan.valid || !scan.isObject) return null;
  const span = scan.fields.get(key);
  if (!span) return null;
  try {
    const usageJson: unknown = JSON.parse(
      new TextDecoder().decode(bytes.subarray(span.start, span.end))
    );
    switch (protocol) {
      case "anthropic":
        return parseAnthropicNonStreaming({ usage: usageJson });
      case "gemini":
        return parseGeminiNonStreaming({ usageMetadata: usageJson });
      default:
        return parseOpenAiNonStreaming({ usage: usageJson });
    }
  } catch {
    return null;
  }
}

function responseIdFromBytes(bytes: Uint8Array): string | null {
  const scan = scanTopLevelObject(bytes, ["id"]);
  if (!scan.valid || !scan.isObject) return null;
  const span = scan.fields.get("id");
  if (!span) return null;
  try {
    const id: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(span.start, span.end)));
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

function toUsage(parsed: ParsedUsage | null): ReportPayload["usage"] {
  if (!parsed) {
    return { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, hasUsage: false };
  }
  return {
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheRead: parsed.cacheRead,
    cacheWrite: parsed.cacheWrite,
    hasUsage: true,
  };
}

// 保留的失败响应：最多读 256KB（§10.1.1），其余取消，避免把大错误体全拉进内存
async function bufferRetained(resp: Response): Promise<{ bytes: Uint8Array; headers: Headers; status: number }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (resp.body) {
    const reader = resp.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_RETAINED_ERROR_BYTES) {
          const keep = value.subarray(0, Math.max(0, value.length - (total - MAX_RETAINED_ERROR_BYTES)));
          if (keep.length > 0) chunks.push(keep);
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => {});
    }
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: merged, headers: resp.headers, status: resp.status };
}

export async function executePlan(opts: ExecuteOptions): Promise<Response> {
  const { plan, prepared, request } = opts;
  const hops = plan.hops.map(normalizeHop);
  const startTime = Date.now();
  const failures: Failure[] = [];
  let retained: { bytes: Uint8Array; headers: Headers; status: number } | null = null;
  // 保留响应来自哪个 hop（全链耗尽时用它写零 token 的 no_usage 记录，与直连同口径）
  let retainedBy: ReportPayload["winner"] = null;
  // 403/404 命中的 upstream：跳过它的剩余 key（直连侧语义）。hop 列表按 upstream 分组升序，
  // 所以单个 id 就够——不会出现跳过一个 upstream 后又回到它的情况。
  let skipUpstream: number | null = null;

  const finish: FinishFn = (status, winner, usage, extra) => {
    const payload: ReportPayload = {
      planId: plan.planId,
      status,
      winner,
      failures,
      usage,
      latencyMs: Date.now() - startTime,
      ttftMs: extra?.ttftMs ?? null,
      responseId: extra?.responseId ?? null,
    };
    sendReport(opts.deviceToken, payload);
    opts.onOutcome?.(extra?.label ?? status);
  };

  hopLoop: for (const hop of hops) {
    if (skipUpstream !== null && hop.upstreamId === skipUpstream) continue;
    const lease: LeasePayload | null = openLease(hop.keyLease, opts.devicePrivateKeyPem, {
      planId: plan.planId,
      upstreamId: hop.upstreamId,
      keyId: hop.keyId,
    });
    if (!lease || isLeaseExpired(lease)) {
      // lease 解不开/过期：本端问题，不算上游失败（不参与健康判定）
      console.warn(`[relay] hop ${hop.hopIndex}: lease unavailable or expired`);
      continue;
    }
    if (lease.requiresPrivateNetwork && !privateUpstreamsAllowed()) {
      console.warn(`[relay] hop ${hop.hopIndex}: private upstream blocked by local policy`);
      continue;
    }
    try {
      assertOutboundUrlAllowed(lease.url, "upstream");
      if (lease.proxyUrl) assertOutboundUrlAllowed(lease.proxyUrl, "proxy");
    } catch {
      console.warn(`[relay] hop ${hop.hopIndex}: outbound URL rejected`);
      continue;
    }

    const body = rewriteBodyModel(prepared, hop.realModel);
    for (let attempt = 0; attempt < hop.retries; attempt++) {
      let resp: Response;
      try {
        resp = await outboundFetch(lease.url, {
          method: request.method,
          headers: buildHopHeaders(request.headers, lease),
          body: body.length > 0 ? body : null,
          duplex: "half",
          redirect: "manual",
          scope: "upstream",
          dispatcher: getOutboundDispatcher(lease.proxyUrl),
          signal: hop.timeoutMs ? AbortSignal.timeout(hop.timeoutMs) : request.signal,
        } as never);
      } catch (err) {
        const cause = (err as { name?: string })?.name === "TimeoutError" ? "timeout" : "network";
        failures.push({
          hopIndex: hop.hopIndex,
          upstreamId: hop.upstreamId,
          keyId: hop.keyId,
          status: null,
          bodyKind: null,
          cause,
        });
        // 重试决策读 plan 字段（与状态码同一条路径）：continueOn 不含该 cause 时
        // plan 决定终止全链（无响应可透传，与 4xx-other 口径同）。
        if (!matchesCondition(hop.continueOn, -1, cause)) break hopLoop;
        continue;
      }

      if (is3xx(resp.status)) {
        // 手动模式：3xx 一律视为失败（防 key 跨源泄露），不跟随、不保留
        failures.push({
          hopIndex: hop.hopIndex,
          upstreamId: hop.upstreamId,
          keyId: hop.keyId,
          status: resp.status,
          bodyKind: bodyKindOf(resp.headers),
          cause: "http",
        });
        await resp.body?.cancel().catch(() => {});
        break;
      }

      if (is2xx(resp.status)) {
        return await passThroughSuccess(resp, hop, opts, finish, startTime);
      }

      failures.push({
        hopIndex: hop.hopIndex,
        upstreamId: hop.upstreamId,
        keyId: hop.keyId,
        status: resp.status,
        bodyKind: bodyKindOf(resp.headers),
        cause: "http",
      });
      if (matchesCondition(hop.continueOn, resp.status)) {
        // 保留规则（与直连 fallbackBusinessResponse 同口径）：
        // - last-4xx：只保留 403/404（401/429/5xx 直连都 cancel 掉了）
        // - last-business（subresource）：另加 429/5xx
        const keep =
          resp.status !== 401 &&
          (hop.passthrough === "last-business" || resp.status === 403 || resp.status === 404);
        if (keep) {
          retained = await bufferRetained(resp);
          retainedBy = { hopIndex: hop.hopIndex, upstreamId: hop.upstreamId, keyId: hop.keyId };
        } else await resp.body?.cancel().catch(() => {});
        // 同 key 重试只给 429/5xx；403/404 是 upstream 级判定 → 跳过它的剩余 key；401 等只换 key
        if (resp.status === 429 || resp.status >= 500) continue;
        if (hop.skipSiblingsOn.includes(String(resp.status))) skipUpstream = hop.upstreamId;
        break;
      }
      // 不在 continueOn（即 stopOn 的 "4xx-other"）：业务错误直接透传并终止全链
      //（与直连把 lastResponse 当成功落点同口径；不继续试其他 upstream，否则会把
      // 客户端参数错误放大成“多跳重试 + 最终 502”）。
      // 直连在这个 4xx 透传路径上会写一条零 token 的 no_usage 记录，relay 用同样形状的
      // report 复现（usage 全零 + hasUsage:false + winner = 该 hop）。
      const passthrough = await bufferRetained(resp);
      finish(
        "failed",
        { hopIndex: hop.hopIndex, upstreamId: hop.upstreamId, keyId: hop.keyId },
        { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, hasUsage: false },
        { label: String(resp.status) }
      );
      // 同尾部透传：body 可能截断，剥 content-length（见函数尾注释）
      const passHeaders = new Headers(passthrough.headers);
      passHeaders.delete("content-length");
      return new Response(new Blob([new Uint8Array(passthrough.bytes)]), {
        status: passthrough.status,
        headers: passHeaders,
      });
    }
  }

  finish("failed", retained ? retainedBy : null, retained
    ? { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, hasUsage: false }
    : null, { label: retained ? String(retained.status) : "502" });
  if (retained) {
    // 全链耗尽但最后一份业务 4xx 还在：原响应透传 + 记一条零 token 的 no_usage
    //（直连 fallbackBusinessResponse 路径同样会写这条记录）。
    // content-length 必须删：body 可能已按 256KB 上限截断，保留会让长度/实际字节不符
    //（content-encoding 保留：截断的 gzip 流与连接截断同形，客户端按正常截断处理）。
    const headers = new Headers(retained.headers);
    headers.delete("content-length");
    headers.set("cache-control", "no-store");
    return new Response(new Blob([new Uint8Array(retained.bytes)]), { status: retained.status, headers });
  }
  return errorResponse(502, "upstream_error", "Upstream request failed");
}

function buildHopHeaders(clientHeaders: Headers, lease: LeasePayload): Headers {
  const headers = buildUpstreamHeaders(clientHeaders, lease.protocol, lease.apiKey);
  for (const [name, value] of Object.entries(lease.headers)) headers.set(name, value);
  return headers;
}

async function passThroughSuccess(
  resp: Response,
  hop: PlanHopWire,
  opts: ExecuteOptions,
  finish: FinishFn,
  startTime: number
): Promise<Response> {
  const { prepared } = opts;
  const winner = { hopIndex: hop.hopIndex, upstreamId: hop.upstreamId, keyId: hop.keyId };
  const headers = new Headers({ "cache-control": "no-store", "x-accel-buffering": "no" });
  copyHeader(resp.headers, headers, "content-type");
  copyHeader(resp.headers, headers, "x-ratelimit-remaining-requests");
  copyHeader(resp.headers, headers, "x-ratelimit-remaining-tokens");

  // responses 子资源：无 model、不解析 usage、不改写（与直连同口径）
  if (hop.realModel === null) {
    finish("ok", winner, null, { label: "ok" });
    return new Response(resp.body, { status: resp.status, headers });
  }

  const virtualModel =
    prepared.model !== null && prepared.model !== hop.realModel ? prepared.model : null;
  const isStreaming = (resp.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");

  if (!resp.body) {
    finish("ok", winner, toUsage(null), { label: "ok" });
    return new Response(null, { status: resp.status, headers });
  }

  if (isStreaming) {
    const protocol = prepared.protocol;
    const extractor = new StreamUsageExtractor(protocol);
    const rewriter = virtualModel ? createSseModelRewriter(protocol, virtualModel) : null;
    const reader = resp.body.getReader();
    const idleTimeoutMs = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    let ttftMs: number | null = null;
    let responseComplete = false;
    let interrupted = false;
    let clientAborted = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        opts.request.signal.addEventListener("abort", () => {
          if (!responseComplete) clientAborted = true;
          void reader.cancel().catch(() => {});
        });
        const pump = async () => {
          try {
            for (;;) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              const read = await Promise.race([
                reader.read(),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("stream idle timeout")),
                    idleTimeoutMs
                  );
                }),
              ]).finally(() => clearTimeout(timer));
              const { done, value } = read;
              if (done) break;
              if (ttftMs === null) ttftMs = Date.now() - startTime;
              extractor.feed(value);
              controller.enqueue(rewriter ? rewriter.transform(value) : value);
            }
            if (rewriter) {
              const rest = rewriter.flush();
              if (rest.length > 0) controller.enqueue(rest);
            }
            responseComplete = true;
            controller.close();
          } catch {
            interrupted = true;
            await reader.cancel().catch(() => {});
            controller.error(new Error("stream interrupted"));
          }
        };
        void pump().finally(() => {
          const status = clientAborted
            ? "client_aborted"
            : interrupted
              ? "stream_interrupted"
              : "ok";
          finish(
            status,
            winner,
            status === "ok" ? toUsage(extractor.finish()) : null,
            {
              ttftMs,
              responseId: extractor.responseId ?? null,
              label: status,
            }
          );
        });
      },
      cancel() {
        if (!responseComplete) clientAborted = true;
        void reader.cancel().catch(() => {});
      },
    });
    return new Response(stream, { status: resp.status, headers });
  }

  // 非流式：整包缓冲（上限 centerMaxResponseBufferMb，缺省/非法兑退 50MB）→ model 区间改写 → 顶层 usage 切片解析
  // 直连用的是自己的 50MB 常量（proxy.ts），两者同值只因中心常量也是 50；这个上限护的是
  // 上游可控数据的内存占用，策略字段异常时兑退而非放开。
  const policyMb = opts.plan.policy?.centerMaxResponseBufferMb;
  const maxResponseBytes =
    typeof policyMb === "number" && Number.isFinite(policyMb) && policyMb > 0 && policyMb <= 1024
      ? policyMb * 1024 * 1024
      : MAX_NON_STREAMING_RESPONSE_BYTES;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = resp.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        // 上游已产生真实输出但读不完：与直连同口径记 stream_interrupted（超限的 throw 走同个 catch），
        // 不发 report 会让 device_plans 预留空等到期清扫、真实 usage 丢失、健康不标。
        finish("stream_interrupted", winner, null, { label: "stream_interrupted" });
        return errorResponse(502, "upstream_error", "Upstream response exceeds size limit");
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    finish("stream_interrupted", winner, null, { label: "stream_interrupted" });
    return errorResponse(502, "upstream_error", "Upstream response interrupted");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const rewritten = virtualModel
    ? rewriteModelNonStreamingBytes(bytes, prepared.protocol, virtualModel)
    : bytes;
  const usage = toUsage(usageFromBytes(bytes, prepared.protocol));
  const responseId = responseIdFromBytes(bytes);
  finish("ok", winner, usage, { responseId, label: "ok" });
  return new Response(new Blob([new Uint8Array(rewritten)]), { status: resp.status, headers });
}
