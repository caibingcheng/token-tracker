import type { Protocol } from "./model-router";
import { GatewaySecretMissingError } from "./crypto";
import {
  extractRequestModel,
  routeModel,
  routeModelByProtocol,
  modelMatchesPattern,
  parseEnabledModels,
  detectRequestProtocol,
  findNamedRoute,
  sortNamedRouteTargets,
  expandNamedRouteTargets,
} from "./model-router";
import type { UpstreamRoute, ModelCandidate } from "./model-router";
import { isEdgeBlockStatus } from "./upstream-client";
import { joinUrlPath, sanitizePathSegments } from "./url-utils";
import { buildSessionId, computeSessionId, extractSessionInputFromBytes } from "./session";
import type { SessionBinding } from "./session";
import {
  parseOpenAiNonStreaming,
  parseAnthropicNonStreaming,
  parseGeminiNonStreaming,
} from "./parsers";
import { StreamUsageExtractor } from "./parsers/stream-usage";
import type { ParsedUsage } from "./parsers/types";
import { estimateInputTokens, estimateInputTokensFromSpans, estimateOutputTokens } from "./estimate";
import { checkQuota, hasQuotaLimits } from "./quota";
import type { QuotaUsage } from "./quota";
import { reserveInflight, getInflight } from "./quota-inflight";
import { rewriteModelNonStreamingBytes, createSseModelRewriter } from "./response-rewriter";
import {
  isNonEmptyArraySpan,
  isStringSpan,
  parseJsonSpan,
  scanTopLevelObject,
  spliceBytes,
} from "./json-scan";
import type { ScanResult } from "./json-scan";
import { getOutboundDispatcher } from "./proxy-dispatcher";
import { outboundFetch } from "./outbound-fetch";
import { parseClassifierModels } from "./classifier/types";
import type { ClassifierKind, ClassifierModelEntry, ClassifierUsage } from "./classifier/types";

export const MAX_RETRY = 2; // 每个 key 内最多尝试次数
const NON_STREAMING_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 流式空闲超时默认 30min（面板可调）

// 请求体上限：默认 32MB（覆盖多图 base64 场景，base64 膨胀 33%），env GATEWAY_MAX_BODY_MB 可调
const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
// 非流式响应整包缓冲上限：仅 usage 解析需要（流式路径 O(1) 不受影响）
const MAX_NON_STREAMING_RESPONSE_BYTES = 50 * 1024 * 1024;
// 大 body 分治阈值：≤1MB 保持 JSON.parse（400 契约与全部既有语义）；>1MB 顶层扫描，
// 不物化消息树——大图 base64 请求的 V8 堆峰值（~42MB/路）与 128MB 堆顶 OOM 风险由此消除
const FULL_PARSE_LIMIT_BYTES = 1024 * 1024;
// scan 路径物化的顶层键：路由 model、流式标志与 stream_options 注入、会话指纹、估算容器
const SCANNED_BODY_KEYS = ["model", "stream", "stream_options", "messages", "input", "contents"];

function readScannedStreamFlag(bytes: Uint8Array, scan: ScanResult): unknown {
  const span = scan.fields.get("stream");
  if (!span) return undefined;
  const t = new TextDecoder().decode(bytes.subarray(span.start, span.end));
  return t === "true" ? true : t === "false" ? false : undefined;
}

function readScannedStringValue(bytes: Uint8Array, scan: ScanResult, key: string): string | null {
  const span = scan.fields.get(key);
  if (!span) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(span.start, span.end)));
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function getMaxRequestBodyBytes(): number {
  const mb = Number(process.env.GATEWAY_MAX_BODY_MB);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : DEFAULT_MAX_REQUEST_BODY_BYTES;
}

// 读取请求体并限制大小：超限返回 null（调用方返回 413）；
// content-length 超限直接拒绝，chunked（无 content-length）边读边计数，超限即中断
async function readRequestBody(request: Request): Promise<Uint8Array | null> {
  const maxBytes = getMaxRequestBodyBytes();
  const declared = request.headers.get("content-length");
  const declaredN = declared !== null ? Number(declared) : NaN;
  if (Number.isFinite(declaredN) && declaredN > maxBytes) return null;
  const raw = request.body;
  if (!raw) {
    return new Uint8Array(await request.arrayBuffer());
  }
  // content-length 已知且未超限：HTTP 分帧下实际字节数 == content-length → 单趟读取，
  // 免去 chunk 收集 + concat 的 2× 瞬时字节（大图请求峰值砍半）；
  // chunked（无 content-length）仍走下方边读边计数（超限即中断）
  if (declaredN >= 0 && Number.isFinite(declaredN)) {
    try {
      const buf = new Uint8Array(await request.arrayBuffer());
      return buf.length > maxBytes ? null : buf; // 防御：分帧异常导致实长大于声明
    } catch {
      throw new Error("Failed to read request body");
    }
  }
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("Failed to read request body");
  }
  if (chunks.length === 0) return new Uint8Array(0);
  return concatUint8Arrays(chunks);
}

export interface VirtualKeyInfo {
  id: number;
  name: string;
  enabled: boolean;
  enabledModels?: string | string[];
  maxRpm?: number | null;
  maxTpm?: number | null;
  maxDailyTokens?: number | null;
  maxMonthlyTokens?: number | null;
}

export interface RecordUsageMeta {
  model: string; // 发往 upstream 的真实 model 名（路由重写时用 targetModel）
  provider: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  status?: string;
  latencyMs?: number;
  ttftMs?: number; // 流式首 token 延迟（首 chunk 到达 - 请求开始），非流式无此概念不写
  virtualKeyId?: number;
  userAgent?: string | null;
  sessionId?: string | null; // 客户端原生 session ID 优先，否则为网关指纹；无法识别会话时 NULL
  requestModel?: string | null; // 客户端原始请求名（虚拟名路由场景可追溯）
}

// 命名路由配置（named_routes 表行）：自带目标池与可选分类器，命中后目标池整体构成 failover 链
export interface NamedRouteInfo {
  id: number;
  name: string;
  protocol: Protocol;
  instruction: string;
  classifierUpstreamId: number; // kind='priority' 时为占位 0
  classifierModel: string; // kind='priority' 时为占位 ''
  classifierKind: ClassifierKind; // 'priority' = 规则分类器（按优先级+可用性选链首）| 'model' = LLM 分类器
  enabled: boolean;
}

// 命名路由的目标（named_route_targets 表行）；upstreamId = null → 无 provider 目标，按路由解析
export interface NamedRouteTargetInfo {
  id: number;
  upstreamId: number | null;
  targetModel: string;
  description: string | null;
  priority: number;
}

// 分类器决策调用（由 proxy-deps 装配真实实现；测试可 mock）
export type RunClassifierFn = (opts: {
  upstream: UpstreamRoute;
  entry: ClassifierModelEntry;
  instruction: string;
  routes: { routeId: number; targetModel: string; description: string | null }[];
  bodyJson: unknown;
  protocol: Protocol;
}) => Promise<{ routeId: number | null; usage: ClassifierUsage | null }>;

export interface ProxyDeps {
  // 虚拟 key 校验：全表解密比对
  resolveVirtualKey: (token: string) => Promise<VirtualKeyInfo | null>;
  // 上游 key 链（解密后的明文，按配置顺序，已过滤禁用）
  resolveUpstreamKeys: (upstreamId: number) => Promise<string[]>;
  // 加载所有启用的上游（含 enabledModels）
  loadUpstreams: () => Promise<UpstreamRoute[]>;
  // 加载全部命名路由（可选；未实现则命名路由不生效）
  loadNamedRoutes?: () => Promise<NamedRouteInfo[]>;
  // 加载某条命名路由的目标池（可选；空数组 = 该路由无有效目标）
  loadNamedRouteTargets?: (namedRouteId: number) => Promise<NamedRouteTargetInfo[]>;
  // 分类器决策（可选；kind='model' 的命名路由才启用）
  runClassifier?: RunClassifierFn;
  // usage 解析完成回调（写库）
  onUsage?: (meta: RecordUsageMeta) => Promise<void>;
  // 请求完成回调（更新 last_used_at 等）
  onComplete?: (meta: { virtualKeyId: number }) => Promise<void>;
  // responses create 成功后的 response id 归属记录（可选；缺省则不记录，子路径不校验）
  onResponseCreated?: (responseId: string, virtualKeyId: number) => Promise<void>;
  // response id 归属查询（可选；返回 null = 无映射 → 放行）
  lookupResponseOwner?: (responseId: string) => Promise<number | null>;
  // 流式空闲超时（毫秒，可选；缺省 DEFAULT_STREAM_IDLE_TIMEOUT_MS）
  resolveStreamIdleTimeoutMs?: () => Promise<number>;
  // 配额用量加载（必填依赖；实现见 proxy-deps）
  quota: {
    loadUsage: (virtualKeyId: number, now: Date) => Promise<QuotaUsage>;
  };
  // 会话粘性 binding（跨 upstream failover 时保存/查询；可选，缺省则无粘性）
  session?: {
    getBinding: (sessionId: string) => SessionBinding | undefined;
    setBinding: (sessionId: string, upstreamId: number, targetModel?: string) => void;
  };
  // upstream / model 健康状态（可选，缺省视为全部健康且不标记）
  health?: {
    isHealthy: (upstreamId: number) => Promise<boolean>;
    markUnhealthy: (upstreamId: number) => Promise<void> | void;
    markHealthy?: (upstreamId: number) => Promise<void> | void;
    isModelHealthy?: (upstreamId: number, model: string) => Promise<boolean>;
    markModelUnhealthy?: (upstreamId: number, model: string) => Promise<void> | void;
    markModelHealthy?: (upstreamId: number, model: string) => Promise<void> | void;
    // 已放弃兜底（末档连续探活失败达标）：不再进尝试链，只靠探活/手动测试恢复
    isGivenUp?: (upstreamId: number) => boolean;
  };
  log?: (message: string) => void;
}

// 客户端凭证 / 原生会话 header 的提取：实现已搬到 proxy-headers.ts（relay 也要用，
// 但 relay 不得 import proxy.ts）；这里保留同名导出，调用方与历史测试不受影响。
import { extractSessionId, extractVirtualKeyToken } from "./proxy-headers";
export { MAX_SESSION_ID_LENGTH, extractSessionId, extractVirtualKeyToken } from "./proxy-headers";

// 构造发往上游的请求头：实现已搬到 upstream-headers.ts（relay 也要用，
// 但 relay 不得 import proxy.ts）；保留同名导出，调用方与历史测试不受影响。
import { buildUpstreamHeaders } from "./upstream-headers";
export { buildUpstreamHeaders } from "./upstream-headers";

export function isStreamingResponse(headers: Headers): boolean {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/event-stream");
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// 重定向：手动模式不跟随（防上游 key 随重定向跨源泄露），3xx 一律视为失败
function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

// 认证类错误（key 无效/无权限）：该 key 不可用，不重试，
// 尝试下一个 key；全部 key 均失败则 failover 到下一个 upstream
function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

// fetch 失败的 cause 链摘要：只进内部日志（502 响应仍是静态文案，不回显），
// 用于区分 ECONNRESET / headers timeout / socket closed 等真实断点
function describeErrorCauses(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  let depth = 0;
  while (cur && typeof cur === "object" && depth < 5) {
    const e = cur as { name?: string; message?: string; code?: unknown; cause?: unknown };
    const code = e.code !== undefined ? ` code=${String(e.code)}` : "";
    const msg = depth > 0 && e.message ? ` ${e.message}` : "";
    parts.push(`${e.name ?? "Error"}${code}${msg}`);
    cur = e.cause;
    depth++;
  }
  return parts.length > 1 ? ` | cause: ${parts.slice(1).join(" <- ")}` : "";
}

export const PROXY_RESPONSE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-accel-buffering": "no",
};

// /raw 裸透传入口前缀：客户端打 /raw/<upstream base URL 之后的部分>，网关剥掉前缀后原样拼到 base URL（上游永远看不到 /raw），
// 用于 /v1、/v1beta 之外的上游端点（如 OpenRouter 的 /alpha/*，base = https://openrouter.ai/api）。
const RAW_PASSTHROUGH_PREFIX = "/raw";

// 剥离 /raw 前缀：非 /raw 路径原样返回；内层路径再过一次净化（防 .. 逃逸），
// 空内层路径（/raw、/raw/）或逃逸路径返回 null（调用方 400）。
export function stripRawPassthroughPrefix(path: string): string | null {
  if (path !== RAW_PASSTHROUGH_PREFIX && !path.startsWith(`${RAW_PASSTHROUGH_PREFIX}/`)) {
    return path;
  }
  const inner = sanitizePathSegments(path.slice(RAW_PASSTHROUGH_PREFIX.length));
  if (inner === null || inner === "/") return null;
  return inner;
}

// 配额 in-flight 预留的异常安全网。
// 预留（reserveInflight）到请求结束（onComplete）之间还有不少 await：
// resolveUpstreamKeys 的 DB 读、session.setBinding、上游请求构造……任一处未捕获的
// throw 都会跳过 onComplete，让 reservation 永久驻留 → 反复触发可把该 vk 的在途
// 计数刷高，把它自己的合法请求挤成 429。包装层只做「throw 时兜底释放」：
// 正常返回时什么也不做（成功/失败/流结束仍由 onComplete 释放，release 幂等）。
type InflightScope = { release?: () => void };

async function withInflightRelease<T>(
  scope: InflightScope,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    scope.release?.();
    throw err;
  }
}

// 核心代理流程
export async function handleProxyRequest(
  request: Request,
  deps: ProxyDeps
): Promise<Response> {
  const scope: InflightScope = {};
  return withInflightRelease(scope, () => handleProxyRequestInner(request, deps, scope));
}

async function handleProxyRequestInner(
  request: Request,
  deps: ProxyDeps,
  scope: InflightScope
): Promise<Response> {
  const url = new URL(request.url);
  const rawPath = url.pathname;
  // 编码斜杠/反斜杠：URL 解析不会解开 %2f，但上游（或中间反代）若解码就能跳出
  // base 前缀（/v1/chat/completions%2f..%2f.. → /v1/chat/../../）。LLM 端点
  // 不需要编码斜杠，一律 fail-closed 400。只查 pathname（query 里的 %2f 不影响路由）。
  // /raw 裸透传的内层路径也在同一 pathname 里，天然覆盖。
  if (/%2f|%5c/i.test(rawPath)) {
    return proxyError(400, "Invalid request path", "invalid_request_error");
  }
  // `..` 段净化：拒绝逃逸出上游 base 前缀的路径（/v1/../internal 等）
  const sanitizedPath = sanitizePathSegments(rawPath);
  if (sanitizedPath === null) {
    return proxyError(400, "Invalid request path", "invalid_request_error");
  }
  // /raw 裸透传：剥掉 /raw 前缀后按内层路径复用下述协议检测/model 提取/路由/转发逻辑
  const path = stripRawPassthroughPrefix(sanitizedPath);
  if (path === null) {
    return proxyError(400, "Invalid request path", "invalid_request_error");
  }
  const token = extractVirtualKeyToken(request.headers);

  const rawUA = request.headers.get("user-agent");
  const userAgent = rawUA && rawUA.trim() !== "" ? rawUA.slice(0, 512) : null;
  const clientSessionId = extractSessionId(request.headers);

  if (!token) {
    return proxyError(401, "Missing virtual key", "authentication_error");
  }

  let virtualKey;
  try {
    virtualKey = await deps.resolveVirtualKey(token);
  } catch (err) {
    if (err instanceof GatewaySecretMissingError) {
      return proxyError(503, "Gateway secret is not configured", "gateway_error");
    }
    throw err;
  }
  if (!virtualKey || !virtualKey.enabled) {
    return proxyError(401, "Invalid or revoked virtual key", "authentication_error");
  }

  // GET /v1/models：返回所有启用上游模型的并集 + 命名路由虚拟名（按请求协议过滤，均过 vk allowlist）
  if (request.method === "GET" && path.endsWith("/models")) {
    const upstreams = await deps.loadUpstreams();
    const protocol = detectRequestProtocol(path);
    const routes = deps.loadNamedRoutes ? await deps.loadNamedRoutes() : [];
    // disabled 路由与请求时 findNamedRoute 口径一致：不进模型列表（命中即 404/自动路由）
    const namedNames = routes
      .filter((r) => r.protocol === protocol && r.enabled)
      .map((r) => r.name);
    const models = collectEnabledModels(upstreams, namedNames).filter((id) =>
      isModelAllowedByVirtualKey(virtualKey, id)
    );
    return Response.json(
      {
        object: "list",
        data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "gateway" })),
      },
      { headers: PROXY_RESPONSE_HEADERS }
    );
  }

  // responses 辅助端点（/v1/responses/{id} 及子路径：retrieve/cancel/update/input_items/output_items）：
  // 请求体无 model 字段，无法按 model 路由；response id 由创建它的 upstream 记忆，
  // 无状态遍历收敛（其余 upstream 必然 404/403）。纯透传：过 vk 认证、不过配额、不记录 usage。
  if (path.startsWith("/v1/responses/")) {
    return handleSubresourcePassthrough(request, { path, url, deps, virtualKey, userAgent });
  }

  if (!["POST", "PUT", "PATCH"].includes(request.method)) {
    return proxyError(405, "Method not allowed", "method_not_allowed");
  }

  let bodyBuffer = await readRequestBody(request);
  if (bodyBuffer === null) {
    return proxyError(413, "Request body exceeds size limit", "invalid_request_error");
  }
  const contentType = request.headers.get("content-type") ?? "";
  let bodyJson: unknown = null;
  let bodyScan: ScanResult | null = null;
  const isJsonBody = bodyBuffer.length > 0 && contentType.includes("application/json");
  if (isJsonBody) {
    if (bodyBuffer.length <= FULL_PARSE_LIMIT_BYTES) {
      try {
        bodyJson = JSON.parse(new TextDecoder().decode(bodyBuffer));
      } catch {
        return proxyError(400, "Invalid JSON body", "invalid_request_error");
      }
    } else {
      bodyScan = scanTopLevelObject(bodyBuffer, SCANNED_BODY_KEYS);
      if (!bodyScan.valid) {
        return proxyError(400, "Invalid JSON body", "invalid_request_error");
      }
      // 根非对象（isObject=false）不在这里报错：model 取不到 → 与 parse 路径同样
      // 落进下方「Unable to determine model」400；深层语法交上游校验（json-scan 边界）
    }
  }
  const scannedMode = bodyScan !== null && bodyJson === null;
  // stream 标志只读一次：scan 区间在后续字节改写（stream_options 注入）前读取，避免偏移
  const streamFlag: unknown = scannedMode
    ? readScannedStreamFlag(bodyBuffer, bodyScan!)
    : typeof bodyJson === "object" && bodyJson !== null
      ? (bodyJson as Record<string, unknown>).stream
      : undefined;
  // 惰性全量 parse：仅分类器命中大 body 时调用（罕见配置，保留原成本）
  let scannedJsonCache: unknown;
  const ensureBodyJson = (): unknown => {
    if (!scannedMode) return bodyJson;
    if (scannedJsonCache !== undefined) return scannedJsonCache;
    try {
      scannedJsonCache = JSON.parse(new TextDecoder().decode(bodyBuffer!)); // 此处必非 null（入口已判）
    } catch {
      scannedJsonCache = null;
    }
    return scannedJsonCache;
  };

  const model =
    extractRequestModel(path, bodyJson) ??
    (scannedMode ? readScannedStringValue(bodyBuffer, bodyScan!, "model") : null);
  if (!model) {
    return proxyError(400, "Unable to determine model from request", "invalid_request_error");
  }
  // model 名长度上限：防超长 model 写入健康持久化 / 缓存 key 膨胀
  if (model.length > 256) {
    return proxyError(400, "Model name too long", "invalid_request_error");
  }

  // responses create（POST /v1/responses）：404/403 可能是"该 upstream 不支持 responses API"
  // 而非"model 不存在"，不触发 model 级健康标记（防误伤）
  const isResponsesCreate = path === "/v1/responses";

  // vk model allowlist 检查：'*' 全放行，其余按通配规则匹配
  if (!isModelAllowedByVirtualKey(virtualKey, model)) {
    return proxyError(403, `Model not allowed for this virtual key: ${model}`, "model_not_allowed");
  }

  const upstreams = await deps.loadUpstreams();
  const protocol = detectRequestProtocol(path);
  // 请求级会话 ID：原生 header 优先，否则至多计算一次指纹；Records、路由粘性和出站变量共用。
  // Records 无原生 ID 时仍要求非空 messages，避免 Gemini / 非 chat 端点写入退化的常量指纹。
  const sessionId =
    clientSessionId ??
    (bodyScan
      ? computeSessionId(
          extractSessionInputFromBytes(
            bodyBuffer,
            bodyScan.fields.get("messages"),
            model,
            virtualKey.id,
            protocol
          )
        )
      : buildSessionId(bodyJson, model, virtualKey.id, protocol));
  // 原生 ID 也需保留原指纹的 model / vk / protocol 隔离，避免跨 key、跨路由共享 binding。
  const routeSessionId = clientSessionId
    ? computeSessionId(
        `native\u0000${clientSessionId}\u0000${model}\u0000${virtualKey.id}\u0000${protocol}`
      )
    : sessionId;
  const messagesSpan = bodyScan?.fields.get("messages");
  const hasMessages = bodyScan
    ? messagesSpan !== undefined && isNonEmptyArraySpan(bodyBuffer, messagesSpan)
    : (() => {
        const m = (bodyJson as { messages?: unknown } | null)?.messages;
        return Array.isArray(m) && m.length > 0;
      })();
  const recordSessionId = clientSessionId ?? (hasMessages ? sessionId : null);
  // input 估算闭包：scan 路径捕获注入前的字节快照与区间（stream_options 注入在下方；
  // 估算只在上游无 usage 的罕见兑底分支执行，届时不整包 parse、零解码）
  const bodyBufferSnapshot = bodyBuffer;
  const estimateInput = (): number =>
    bodyScan
      ? estimateInputTokensFromSpans(bodyBufferSnapshot, bodyScan.fields, protocol)
      : estimateInputTokens(bodyJson, protocol);

  // OpenAI chat 流式：客户端/agent 常不带 stream_options.include_usage，上游（尤其
  // 第三方中转）因此不在流里发 usage chunk → 记成 no_usage。缺省时注入 true；
  // 客户端显式设置（含非法值）一律保留：非法请求应交上游校验，不在网关上静默修正。
  // 置于所有 scan 读取（model/session/messages/估算快照）之后：缺省键从根 } 前插入
  //（既有键区间不受影响）；替换既有 stream_options 会使后续键偏移 → 置 scanSpansShifted
  let scanSpansShifted = false;
  if (path === "/v1/chat/completions" && streamFlag === true) {
    if (bodyScan) {
      const span = bodyScan.fields.get("stream_options");
      if (!span) {
        const prefix = bodyScan.memberCount > 0 ? "," : "";
        bodyBuffer = spliceBytes(
          bodyBuffer,
          bodyScan.rootClose,
          bodyScan.rootClose,
          new TextEncoder().encode(`${prefix}"stream_options":{"include_usage":true}`)
        );
      } else {
        const existing = parseJsonSpan(bodyBuffer, span);
        const existingObj =
          existing && typeof existing === "object" && !Array.isArray(existing)
            ? (existing as Record<string, unknown>)
            : null;
        const hasExplicit =
          existingObj !== null &&
          Object.prototype.hasOwnProperty.call(existingObj, "include_usage");
        if (!hasExplicit) {
          bodyBuffer = spliceBytes(
            bodyBuffer,
            span.start,
            span.end,
            new TextEncoder().encode(
              JSON.stringify({ ...(existingObj ?? {}), include_usage: true })
            )
          );
          scanSpansShifted = true;
        }
      }
    } else if (typeof bodyJson === "object" && bodyJson !== null) {
      const bodyObj = bodyJson as Record<string, unknown>;
      const existing = bodyObj.stream_options;
      const existingObj =
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : null;
      const hasExplicit =
        existingObj !== null &&
        Object.prototype.hasOwnProperty.call(existingObj, "include_usage");
      if (!hasExplicit) {
        bodyJson = {
          ...bodyObj,
          stream_options: { ...(existingObj ?? {}), include_usage: true },
        };
        bodyBuffer = new TextEncoder().encode(JSON.stringify(bodyJson));
      }
    }
  }

  // ---- 命名路由解析：命中后目标池整体构成 failover 链（同名自动路由完全失效） ----
  // 链首：session binding 预选 > 分类器（kind='model'）> 首个健康目标（按 priority）；
  // 其余目标按 priority 接链尾；健康者在前，degraded 排尾（兜底成功走统一自愈）。
  type RouteHop = { upstream: UpstreamRoute; targetModel: string };

  let namedRoute: { name: string } | null = null;
  // 健康过滤时被跳过的目标（兜底成功时自愈清除标记，命名/自动路由统一）
  const degradedUpstreams = new Set<number>();
  // 本次请求决策选中的目标 hop（路由内 failover 落点漂移时用于重绑 binding）
  let decisionHop: RouteHop | null = null;
  let hops: RouteHop[] = [];

  const hopHealth = async (hop: RouteHop): Promise<boolean> => {
    const upDown = deps.health && !(await deps.health.isHealthy(hop.upstream.id));
    const modelDown =
      deps.health?.isModelHealthy &&
      !(await deps.health.isModelHealthy(hop.upstream.id, hop.targetModel));
    return !(upDown || modelDown);
  };

  {
    const allRoutes = deps.loadNamedRoutes ? await deps.loadNamedRoutes() : [];
    const route = findNamedRoute(model, protocol, allRoutes);
    if (route) {
      namedRoute = { name: model };

      // 预取目标池：本路由 + auto 目标嵌套可达的路由（visited 防环）
      const targetsByRouteId = new Map<number, NamedRouteTargetInfo[]>();
      const loadTargetsDeep = async (routeId: number, visited: Set<number>): Promise<void> => {
        if (visited.has(routeId)) return;
        visited.add(routeId);
        const targets = deps.loadNamedRouteTargets ? await deps.loadNamedRouteTargets(routeId) : [];
        targetsByRouteId.set(routeId, targets);
        for (const t of targets) {
          if (t.upstreamId !== null) continue;
          const nested = allRoutes.find(
            (r) => r.enabled && r.protocol === protocol && r.name === t.targetModel
          );
          if (nested && !visited.has(nested.id)) await loadTargetsDeep(nested.id, visited);
        }
      };
      await loadTargetsDeep(route.id, new Set());

      // 顶层目标池 → 展开 hop 链（显式目标单 hop；auto 目标嵌套命名路由 > 自动路由候选池）
      const toPoolEntry = (routeId: number) => (t: NamedRouteTargetInfo) => ({
        id: t.id,
        namedRouteId: routeId,
        upstreamId: t.upstreamId,
        upstreamModel: t.targetModel,
        description: t.description,
        priority: t.priority,
      });
      const expandTarget = (t: NamedRouteTargetInfo): RouteHop[] =>
        expandNamedRouteTargets({
          protocol,
          upstreams,
          routes: allRoutes,
          targets: [toPoolEntry(route.id)(t)],
          resolveTargets: (id) => (targetsByRouteId.get(id) ?? []).map(toPoolEntry(id)),
          rootRouteId: route.id,
          log: deps.log,
        }).map((p) => ({ upstream: p.upstream, targetModel: p.targetModel }));

      const targets = sortNamedRouteTargets(targetsByRouteId.get(route.id) ?? []);
      if (targets.length === 0) {
        // 命名路由存在但目标池为空 → 502，不回退自动路由
        return proxyError(
          502,
          "Named route target unavailable: no valid upstream targets",
          "named_route_unavailable"
        );
      }
      const hopsByTarget = new Map<number, RouteHop[]>();
      for (const t of targets) hopsByTarget.set(t.id, expandTarget(t));
      // 已放弃兜底的 upstream 在分类器/预选之前就从目标链剔除：
      // 否则会先付一次 LLM 分类器成本，最终选中的目标又必然被丢
      if (deps.health?.isGivenUp) {
        const isGivenUp = deps.health.isGivenUp;
        const loaded = new Set<number>();
        for (const t of targets) {
          const list = hopsByTarget.get(t.id) ?? [];
          for (const h of list) {
            if (loaded.has(h.upstream.id)) continue;
            loaded.add(h.upstream.id);
            await deps.health.isHealthy(h.upstream.id); // 触发 ensureLoaded，isGivenUp 只读内存
          }
          hopsByTarget.set(
            t.id,
            list.filter((h) => !isGivenUp(h.upstream.id))
          );
        }
      }
      // 全部目标都解析不出 hop（upstream 全禁用/删除、auto 名不可解析、嵌套成环）→ 502
      const expandable = targets.filter((t) => (hopsByTarget.get(t.id)?.length ?? 0) > 0);
      if (expandable.length === 0) {
        return proxyError(
          502,
          "Named route target unavailable: no valid upstream targets",
          "named_route_unavailable"
        );
      }

      // session 粘性（目标粒度决策、hop 粒度匹配）：binding 命中某目标展开链内的一跳
      let preselected: NamedRouteTargetInfo | null = null;
      let boundHop: RouteHop | null = null;
      if (deps.session && expandable.length > 1) {
        const binding = deps.session.getBinding(routeSessionId);
        // named-route binding 必带 targetModel（成功路径总是写 hop 粒度）；
        // undefined = 旧自动路由粒度的残留 binding，不让它通配命名路由目标
        if (binding && binding.targetModel !== undefined) {
          for (const t of expandable) {
            const hit = hopsByTarget.get(t.id)!.find(
              (h) => h.upstream.id === binding.upstreamId && h.targetModel === binding.targetModel
            );
            if (hit) {
              preselected = t;
              boundHop = hit;
              break;
            }
          }
        }
      }

      // 链首目标：binding 预选 > LLM 分类器（kind='model'）> 首个有健康 hop 的目标（规则分类器，
      // 零 LLM 开销）；决策/回退结果写 binding（hop 粒度）。pinHop = 链首目标内置顶的 hop
      //（binding 命中跳 / 规则分类器健康跳），组链时排在该目标 hops 最前
      let selected: NamedRouteTargetInfo | null = preselected;
      let pinHop: RouteHop | null = boundHop;
      if (!selected && expandable.length > 1) {
        const headHopOf = (t: NamedRouteTargetInfo) => hopsByTarget.get(t.id)![0];
        const writeBinding = (t: NamedRouteTargetInfo, hop?: RouteHop) => {
          if (deps.session) {
            const h = hop ?? headHopOf(t);
            deps.session.setBinding(routeSessionId, h.upstream.id, h.targetModel);
          }
        };
        if (route.classifierKind === "model" && deps.runClassifier && deps.session) {
          const classifierUpstream = upstreams.find((u) => u.id === route.classifierUpstreamId);
          // 已声明的 classifier_models 条目优先（保留存量 chat 类型/path 覆盖/预算配置）；
          // 未声明的一律按 jev-systemone 决策模型处理（POST /v1/systemone）
          const entry = classifierUpstream
            ? (parseClassifierModels(classifierUpstream.classifierModels).find(
                (e) => e.model === route.classifierModel
              ) ?? { model: route.classifierModel, type: "jev-systemone" as const })
            : undefined;
          if (classifierUpstream && entry) {
            const classifierStart = Date.now();
            const result = await deps.runClassifier({
              upstream: classifierUpstream,
              entry,
              instruction: route.instruction,
              routes: expandable.map((t) => ({
                routeId: t.id,
                targetModel: t.targetModel,
                description: t.description,
              })),
              bodyJson: ensureBodyJson(),
              protocol,
            });
            if (result.routeId !== null) {
              selected = expandable.find((t) => t.id === result.routeId) ?? null;
            }
            // 分类器消耗的 token 记一条（成本可见）；失败也记（status=classifier）
            if (deps.onUsage) {
              deps
                .onUsage({
                  model: route.classifierModel,
                  provider: classifierUpstream.name,
                  agent: virtualKey.name,
                  inputTokens: result.usage?.inputTokens ?? 0,
                  outputTokens: result.usage?.outputTokens ?? 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  status: "classifier",
                  latencyMs: Date.now() - classifierStart,
                  virtualKeyId: virtualKey.id,
                  userAgent,
                  sessionId: recordSessionId,
                  requestModel: model,
                })
                .catch(() => {});
            }
          } else {
            deps.log?.(
              `[gateway] named route "${model}": classifier upstream/entry not configured or unavailable; falling back to priority order`
            );
          }
          selected ??= expandable[0];
          writeBinding(selected);
        } else {
          if (route.classifierKind === "model") {
            deps.log?.(
              `[gateway] named route "${model}": classifier unavailable (deps/session); falling back to priority order`
            );
          }
          // 规则分类器：链首 = 首个有健康 hop 的目标（availability），全不健康回退 priority 最小
          let healthyHead: NamedRouteTargetInfo | null = null;
          let healthyHop: RouteHop | null = null;
          for (const t of expandable) {
            for (const h of hopsByTarget.get(t.id)!) {
              if (await hopHealth(h)) {
                healthyHead = t;
                healthyHop = h;
                break;
              }
            }
            if (healthyHead) break;
          }
          selected = healthyHead ?? expandable[0];
          pinHop = healthyHop;
          deps.log?.(
            `[gateway] named route "${model}": rule classifier (priority) picked target ${selected.id} → ${selected.targetModel}`
          );
          writeBinding(selected, healthyHop ?? undefined);
        }
      }
      const head = selected ?? expandable[0];

      // 组链：链首目标的 hops 在前（binding 命中跳置顶），其余按 priority 接链尾
      const chain: RouteHop[] = [];
      const pushTarget = (t: NamedRouteTargetInfo) => {
        const list = [...(hopsByTarget.get(t.id) ?? [])];
        if (pinHop && t.id === head.id) {
          const idx = list.findIndex(
            (h) => h.upstream.id === pinHop!.upstream.id && h.targetModel === pinHop!.targetModel
          );
          if (idx > 0) list.unshift(list.splice(idx, 1)[0]);
        }
        chain.push(...list);
      };
      pushTarget(head);
      for (const t of expandable) if (t.id !== head.id) pushTarget(t);
      decisionHop = chain[0] ?? null;

      // hop 级健康重排：健康在前，degraded 排尾（兜底成功走统一自愈）
      const healthyHops: RouteHop[] = [];
      const fallbackHops: RouteHop[] = [];
      for (const hop of chain) {
        if (await hopHealth(hop)) {
          healthyHops.push(hop);
        } else {
          degradedUpstreams.add(hop.upstream.id);
          fallbackHops.push(hop);
        }
      }
      hops = [...healthyHops, ...fallbackHops];
    }
  }

  if (!namedRoute) {
    // 自动路由：按协议路由获取所有匹配候选（exact 优先，priority 升序）
    const { candidates } = routeModelByProtocol(model, protocol, upstreams);
    if (candidates.length === 0) {
      // 保留原语义：model 仅配置在其他协议的 upstream 上 → 400 protocol_mismatch
      const global = routeModel(model, upstreams);
      if (global) {
        // 不回显内部 upstream 名称与协议配置（防拓扑泄露）
        return proxyError(
          400,
          `Protocol mismatch: model "${model}" is not configured for the ${protocol} protocol`,
          "protocol_mismatch"
        );
      }
      return proxyError(404, `No upstream configured for model: ${model}`, "model_not_found");
    }
    // 候选去重（同一 upstream 可因 exact + wildcard 命中多次）+ 过滤 unhealthy（upstream 级 + model 级）；
    // 无健康候选时兜底：回退全部候选（unhealthy 也尝试），不留 502
    const allCandidates = dedupeByUpstreamId(candidates);
    for (const candidate of allCandidates) {
      const upDown = deps.health && !(await deps.health.isHealthy(candidate.id));
      const modelDown =
        deps.health?.isModelHealthy &&
        !(await deps.health.isModelHealthy(candidate.id, model));
      if (upDown || modelDown) degradedUpstreams.add(candidate.id);
      if (upDown || modelDown) continue;
      hops.push({ upstream: candidate, targetModel: model });
    }
    if (hops.length === 0) {
      deps.log?.(
        `[gateway] no healthy candidates for model: ${model}; falling back to unhealthy upstreams`
      );
      hops = allCandidates.map((u) => ({ upstream: u, targetModel: model }));
    }
  }

  // 已放弃兜底的 upstream 从链中剔除（含命名路由目标链）：末档连续探活失败基本确认死透，
  // 再在兜底里试一次只会白等超时（非流式单次 60s × MAX_RETRY）。
  // 恢复途径：定时探活成功 / Probe now / Test / 重新启用（resumeProbing）
  if (deps.health?.isGivenUp) {
    const before = hops.length;
    hops = hops.filter((h) => !deps.health!.isGivenUp!(h.upstream.id));
    if (hops.length !== before) {
      deps.log?.(
        `[gateway] dropped ${before - hops.length} given-up upstream(s) from the attempt chain`
      );
    }
    if (hops.length === 0) {
      deps.onComplete?.({ virtualKeyId: virtualKey.id }).catch(() => {});
      return proxyError(
        502,
        `No available upstream for model: ${model}`,
        "upstream_unavailable"
      );
    }
  }

  const defaultHop: RouteHop = hops[0];
  const defaultUpstream = defaultHop.upstream;

  // 自动路由的多候选 session 粘性（upstream 粒度；命名路由的粘性已在组装时按 route 粒度处理）
  if (!namedRoute && hops.length > 1 && deps.session) {
    const binding = deps.session.getBinding(routeSessionId);
    if (binding && hops.some((h) => h.upstream.id === binding.upstreamId)) {
      const bound = hops.filter((h) => h.upstream.id === binding.upstreamId);
      const rest = hops.filter((h) => h.upstream.id !== binding.upstreamId);
      hops = [...bound, ...rest];
    }
  }

  // 配额检查：选上游之后、转发之前；超限直接 429 不转发上游。
  // 无限额 vk 直接跳过（避免每次请求 3 条聚合 SQL）。
  // in-flight 预留：token_records 在响应结束后才写入，只靠 DB 用量会被并发突发绕过
  // （见 quota-inflight.ts），所以先预留再检查，请求结束（onComplete）时释放。
  if (hasQuotaLimits(virtualKey)) {
    const now = new Date();
    // token 类限额才付估算 CPU：只有 maxRpm 的 vk 不估算（普通请求零额外开销）
    const reservableTokens =
      virtualKey.maxTpm != null ||
      virtualKey.maxDailyTokens != null ||
      virtualKey.maxMonthlyTokens != null
        ? estimateInput()
        : 0;
    const release = reserveInflight(virtualKey.id, reservableTokens);
    // 抛错兜底（见 withInflightRelease）：本次请求后续任何未捕获 throw 都会释放预留
    scope.release = release;
    let quotaUsage: QuotaUsage;
    try {
      quotaUsage = await deps.quota.loadUsage(virtualKey.id, now);
    } catch (err) {
      // 读失败也要释放，否则该 vk 的额度会被一个异常请求永久占住
      release();
      throw err;
    }
    // 检查口径：DB 用量 + 进程内在途（含本次），边界沿用 checkQuota 的「> limit 才超限」
    const pending = getInflight(virtualKey.id);
    const violation = checkQuota(
      {
        virtualKeyId: virtualKey.id,
        maxRpm: virtualKey.maxRpm ?? null,
        maxTpm: virtualKey.maxTpm ?? null,
        maxDailyTokens: virtualKey.maxDailyTokens ?? null,
        maxMonthlyTokens: virtualKey.maxMonthlyTokens ?? null,
        now,
      },
      {
        rpm: quotaUsage.rpm + pending.rpm,
        tpm: quotaUsage.tpm + pending.tokens,
        dailyTokens: quotaUsage.dailyTokens + pending.tokens,
        monthlyTokens: quotaUsage.monthlyTokens + pending.tokens,
      }
    );
    if (violation) {
      release();
      return proxyError(
        429,
        `Quota exceeded (${violation.dimension}: ${violation.current} / ${violation.limit})`,
        "quota_exceeded"
      );
    }
    // 释放挂在既有唯一完成钩子上：成功（含流结束）、各失败路径都调 onComplete
    const prevOnComplete = deps.onComplete;
    deps = {
      ...deps,
      onComplete: async (info) => {
        release();
        await prevOnComplete?.(info);
      },
    };
  }

  const startTime = Date.now();
  const isNonStreaming = typeof streamFlag === "boolean" ? !streamFlag : false;

  let lastError: { status: number; text?: string } | null = null;
  let lastResponse: Response | null = null;
  let successUpstream: UpstreamRoute | null = null;
  let successHop: RouteHop | null = null;
  // 全部候选均对该 model 返回 4xx 业务错误（404/403）时，透传最后一个原始响应
  let fallbackBusinessResponse: Response | null = null;

  // 跨 upstream 故障转移链：hop 按序遍历（命名路由 = 目标池链，自动路由 = 候选链），
  // 每个 upstream 内遍历 key，每个 key 内重试 MAX_RETRY 次；
  // 只在收到响应头之前允许重试/切换（流式输出开始后不可重试）
  hopLoop: for (const hop of hops) {
    const upstream = hop.upstream;
    // per-hop 改写：命名路由多目标各自 targetModel 不同，
    // body / path 改写按当跳 upstream 计算，改用真实 model 名（与自动路由路径一致）
    const hopModel = namedRoute ? hop.targetModel : model;
    let hopPath = path;
    let hopBodyBuffer = bodyBuffer;
    if (namedRoute) {
      if (protocol === "gemini") {
        hopPath = path.replace(
          /^(\/v1(?:\/?beta)?\/models\/)[^/:]+/,
          `$1${hopModel}`
        );
      } else if (scannedMode && bodyScan) {
        // scan 路径：顶层 model 值区间切片替换，不物化树；stream_options 中段替换
        // 造成键偏移时重扫一次（该组合极罕见）
        const span = scanSpansShifted
          ? scanTopLevelObject(bodyBuffer, ["model"]).fields.get("model")
          : bodyScan.fields.get("model");
        if (span && isStringSpan(bodyBuffer, span)) {
          hopBodyBuffer = spliceBytes(
            bodyBuffer,
            span.start,
            span.end,
            new TextEncoder().encode(JSON.stringify(hopModel))
          );
        }
      } else if (bodyJson && typeof bodyJson === "object") {
        hopBodyBuffer = new TextEncoder().encode(
          JSON.stringify({ ...(bodyJson as Record<string, unknown>), model: hopModel })
        );
      }
    }

    const keys = await deps.resolveUpstreamKeys(upstream.id);
    if (keys.length === 0) {
      lastError = { status: 0, text: `No API keys configured for upstream: ${upstream.name}` };
      continue;
    }
    const targetUrl = `${joinUrlPath(upstream.baseUrl, hopPath)}${stripQueryKey(url)}`;

    let upstreamFailed = true;
    let modelNotFound = false;
    let saw403 = false; // 出现过 403（可能为 key 对该 model 无权限 → model 级处理）
    let sawEdgeBlock = false; // 出现过 403 + text/html（边缘/反 bot 拦截 → 不标记任何健康）
    for (const apiKey of keys) {
      for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        let upstreamResponse: Response | null = null;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          const controller = new AbortController();
          if (isNonStreaming) {
            timeoutHandle = setTimeout(() => controller.abort(), NON_STREAMING_TIMEOUT_MS);
          }
          const dispatcher = getOutboundDispatcher(upstream.proxyUrl);

          upstreamResponse = await outboundFetch(targetUrl, {
            method: request.method,
            headers: buildUpstreamHeaders(
              request.headers,
              protocol,
              apiKey,
              upstream.headerTransforms,
              {
                // 与 Records 共用请求级会话 ID：原生 header 优先，否则复用已计算指纹
                sessionId: () => sessionId,
                model: hopModel,
                keyName: virtualKey.name,
                upstream: upstream.name,
              }
            ),
            body: hopBodyBuffer.length > 0 ? hopBodyBuffer : null,
            duplex: "half",
            redirect: "manual",
            signal: controller.signal,
            ...(dispatcher ? { dispatcher } : {}),
          } as RequestInit & { duplex: "half" });

          if (isRedirectStatus(upstreamResponse.status)) {
            // 手动模式：3xx 一律视为失败（LLM API 不应重定向），防认证头跨源泄露
            lastError = { status: upstreamResponse.status };
            await upstreamResponse.body?.cancel();
            break; // 尝试下一个 key
          }
          if (isRetryableStatus(upstreamResponse.status)) {
            lastError = { status: upstreamResponse.status };
            await upstreamResponse.body?.cancel();
            continue; // 重试
          }
          if (isAuthStatus(upstreamResponse.status)) {
            lastError = { status: upstreamResponse.status };
            if (upstreamResponse.status === 403) {
              // 403 可能是"key 对该 model 无权限"：保留响应（全部候选失败时透传），
              // 换下一个 key；全部 key 均 403 时按 model 级标记，不误伤其他 model
              fallbackBusinessResponse = upstreamResponse;
              if (isEdgeBlockStatus(
                upstreamResponse.status,
                upstreamResponse.headers.get("content-type")
              )) {
                // 403 + text/html：边缘/反 bot 拦截页（Cloudflare 1010/challenge 等），
                // 表示客户端特征（如 UA）被上游边缘拒绝，非 key/model 问题，
                // 不标记任何健康状态（否则 UA 封禁会污染 model 健康）
                sawEdgeBlock = true;
              } else {
                saw403 = true;
              }
            } else {
              await upstreamResponse.body?.cancel();
            }
            break; // 尝试下一个 key
          }
          if (upstreamResponse.status === 404) {
            // model 在该 upstream 不存在：标记 model 级不可用（仅此 model，不影响其他），
            // 继续尝试下一个候选 upstream；全部 404 时透传最后一个 404
            lastError = { status: 404 };
            fallbackBusinessResponse = upstreamResponse; // 不 cancel：保留透传
            modelNotFound = true;
            if (!isResponsesCreate) {
              deps.health?.markModelUnhealthy?.(upstream.id, hopModel);
              deps.log?.(
                `[gateway] model "${hopModel}" marked unavailable on upstream "${upstream.name}" (404)`
              );
            }
            break;
          }
          lastResponse = upstreamResponse; // 成功（含其他 4xx 业务错误）：直接透传
          successUpstream = upstream;
          successHop = hop;
          upstreamFailed = false;
          break;
        } catch (err) {
          lastError = {
            status: 0,
            text: `${err instanceof Error ? err.message : String(err)}${describeErrorCauses(err)}`,
          };
          // 网络错误/超时 → 重试
        } finally {
          clearTimeout(timeoutHandle);
        }

        if (lastResponse) break;
      }
      if (lastResponse || modelNotFound) break;
    }

    if (lastResponse) {
      // 兜底成功（链包含不健康候选且落点为 2xx）：真实请求成功是比定时探活更强的恢复信号，
      // 立即清除健康标记，避免后续请求继续走兜底路径
      if (
        lastResponse.status >= 200 &&
        lastResponse.status < 300 &&
        degradedUpstreams.has(upstream.id)
      ) {
        deps.health?.markHealthy?.(upstream.id);
        deps.health?.markModelHealthy?.(upstream.id, hopModel);
        deps.log?.(
          `[gateway] upstream "${upstream.name}" recovered via real request; health marks cleared`
        );
      }
      // 后续候选成功：释放未透传的业务错误 body，避免连接泄漏
      await fallbackBusinessResponse?.body?.cancel().catch(() => {});
      fallbackBusinessResponse = null;
      break hopLoop;
    }
    if (modelNotFound) continue; // model 级不可用：不标记 upstream unhealthy，继续下一个
    // 该 upstream 全部 key 均失败 → 标记 unhealthy，继续下一个 upstream
    if (upstreamFailed) {
      if (saw403 && !isResponsesCreate) {
        // 全部 key 均 403：大概率是该 key 对该 model 无权限 → model 级标记，不误伤其他 model
        // （responses create 除外：403 可能是"不支持 responses"而非 key 权限问题）
        deps.health?.markModelUnhealthy?.(upstream.id, hopModel);
        deps.log?.(
          `[gateway] model "${hopModel}" marked unavailable on upstream "${upstream.name}" (403 on all keys)`
        );
      } else if (sawEdgeBlock && !saw403) {
        // 全部 key 均 403 + text/html：客户端特征被上游边缘（WAF/反 bot）拒绝，
        // 非 key/model 问题，不标记任何健康状态（failover 已由链完成）
        deps.log?.(
          `[gateway] upstream "${upstream.name}" rejected request at edge (403 HTML, likely bot/UA block); skipping health marking`
        );
      } else if (!saw403) {
        deps.health?.markUnhealthy(upstream.id);
        deps.log?.(
          `[gateway] upstream "${upstream.name}" marked unhealthy after all keys failed`
        );
      }
    }
  }

  // 全部失败：优先透传最后一个业务错误响应（404/403），其余返回 502
  if (!lastResponse) {
    deps.onComplete?.({ virtualKeyId: virtualKey.id }).catch(() => {});
    if (fallbackBusinessResponse) {
      const meta: RecordUsageMeta = {
        model: namedRoute ? defaultHop.targetModel : model,
        provider: defaultUpstream.name,
        agent: virtualKey.name,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        virtualKeyId: virtualKey.id,
        userAgent,
        sessionId: recordSessionId,
        requestModel: model,
      };
      return passthroughResponse(fallbackBusinessResponse, {
        meta,
        deps,
        estimateInput,
        protocol,
        virtualKeyId: virtualKey.id,
        virtualModelName: namedRoute?.name,
        clientSignal: request.signal,
      });
    }
    if (namedRoute) {
      // 命名路由目标链全部失败 → 502（不回退自动路由）。
      // 不回显 lastError.text（可能含内网地址等内部细节），仅日志保留
      if (lastError?.text) {
        deps.log?.(`[gateway] named route failed: ${lastError.text}`);
      }
      const detail =
        lastError && lastError.status > 0
          ? `upstream returned status ${lastError.status}`
          : "upstream request failed";
      return proxyError(502, `Named route target unavailable: ${detail}`, "named_route_unavailable");
    }
    if (lastError && lastError.status > 0) {
      return new Response(
        JSON.stringify({
          error: { message: `Upstream returned status ${lastError.status}`, type: "upstream_error" },
        }),
        { status: 502, headers: PROXY_RESPONSE_HEADERS }
      );
    }
    if (lastError?.text) {
      deps.log?.(`[gateway] upstream request failed: ${lastError.text}`);
    }
    return proxyError(502, "Upstream request failed", "upstream_error");
  }

  // 成功落点不是默认 upstream 时保存 session binding（粘性绑定）；仅 2xx 落点生效
  // manual/virtual route 落点带 targetModel（route 粒度），自动路由为 upstream 粒度；
  // vm 候选的决策 route 与实际落点漂移（vm 内 failover）时也重绑
  if (
    deps.session &&
    lastResponse.status >= 200 &&
    lastResponse.status < 300 &&
    successUpstream &&
    successHop
  ) {
    const vmDrifted =
      decisionHop !== null &&
      (successUpstream.id !== decisionHop.upstream.id ||
        successHop.targetModel !== decisionHop.targetModel);
    if (namedRoute) {
      if (successUpstream.id !== defaultUpstream.id || successHop.targetModel !== defaultHop.targetModel || vmDrifted) {
        // 值未变不重写（binding 预选/决策落点与既有 binding 一致时避免每请求重复 set）
        const existing = deps.session.getBinding(routeSessionId);
        if (
          existing?.upstreamId !== successUpstream.id ||
          existing?.targetModel !== successHop.targetModel
        ) {
          deps.session.setBinding(routeSessionId, successUpstream.id, successHop.targetModel);
        }
      }
    } else if (successUpstream.id !== defaultUpstream.id) {
      deps.session.setBinding(routeSessionId, successUpstream.id);
    }
  }

  const latencyMs = Date.now() - startTime;
  const successModel = successUpstream ?? defaultUpstream;
  const meta: RecordUsageMeta = {
    model: namedRoute ? (successHop ?? defaultHop).targetModel : model,
    provider: successModel.name,
    agent: virtualKey.name,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    latencyMs,
    virtualKeyId: virtualKey.id,
    userAgent,
    sessionId: recordSessionId,
    requestModel: model,
  };

      return passthroughResponse(lastResponse, {
        meta,
        deps,
        estimateInput,
        protocol,
        virtualKeyId: virtualKey.id,
        virtualModelName: namedRoute?.name,
        startTime,
        clientSignal: request.signal,
        // responses create 成功：记下 response id 的 vk 归属（子路径透传时拦跨 vk retrieve）
        onResponseCreated:
          isResponsesCreate && deps.onResponseCreated
            ? (id) => deps.onResponseCreated!(id, virtualKey.id)
            : undefined,
      });
}

// responses 辅助端点（/v1/responses/{id} 及子路径）纯透传：
// 无 model 可路由，response id 由创建它的 upstream 记忆（provider 侧有状态），
// 其余 upstream 对该 id 必然 404/403 → 按 priority 遍历全部 openai healthy upstream 收敛到创建者。
// 404/403 不标记任何 health（id 每次不同，标记会污染）；不解析 usage（retrieve 重复调用会重复统计）、
// 不过配额（无 model 归属维度）；仍过 vk 认证（由调用方保证）。
async function handleSubresourcePassthrough(
  request: Request,
  opts: {
    path: string;
    url: URL;
    deps: ProxyDeps;
    virtualKey: VirtualKeyInfo;
    userAgent: string | null;
  }
): Promise<Response> {
  const scope: InflightScope = {};
  return withInflightRelease(scope, () =>
    handleSubresourcePassthroughInner(request, opts, scope)
  );
}

async function handleSubresourcePassthroughInner(
  request: Request,
  opts: {
    path: string;
    url: URL;
    deps: ProxyDeps;
    virtualKey: VirtualKeyInfo;
    userAgent: string | null;
  },
  scope: InflightScope
): Promise<Response> {
  const { path, url, virtualKey, userAgent } = opts;
  // let：配额 in-flight 预留要包一层 onComplete（释放钩子），见下方配额检查
  let deps = opts.deps;

  // 归属校验：response id → 创建它的 vk。映射存在且不一致 → 403（防跨 vk
  // retrieve/取消别人的 response）。映射不存在（升级前的存量 id / 上游侧创建 /
  // 流式未捕获到 id）→ 放行：刻意的过渡期 fail-open，否则升级后旧 id 全部不可用。
  // id 取 /v1/responses/ 之后的第一段（子路径 input_items/output_items 同口径）
  const responseId = path.slice("/v1/responses/".length).split("/")[0] ?? "";
  if (responseId && deps.lookupResponseOwner) {
    const owner = await deps.lookupResponseOwner(responseId);
    if (owner !== null && owner !== virtualKey.id) {
      return proxyError(
        403,
        "Response belongs to another virtual key",
        "forbidden"
      );
    }
  }

  const upstreams = await deps.loadUpstreams();
  const chain = upstreams
    .filter((u) => u.enabled !== false && u.protocol === "openai")
    .sort((a, b) => a.priority - b.priority);

  // 健康过滤（仅 upstream 级；不过 model 级——response 记忆与 model 健康无关）；
  // 无健康候选时兜底：回退全量链（unhealthy 也尝试），不留 502
  const degradedUpstreams = new Set<number>();
  const healthy: UpstreamRoute[] = [];
  for (const upstream of chain) {
    if (deps.health && !(await deps.health.isHealthy(upstream.id))) {
      degradedUpstreams.add(upstream.id);
      continue;
    }
    healthy.push(upstream);
  }
  if (healthy.length === 0) {
    // 已放弃兜底的 upstream 不再尝试（与主链同口径，避免死透的 upstream 白等超时）
    const fallback = chain.filter((u) => !deps.health?.isGivenUp?.(u.id));
    deps.log?.(
      `[gateway] no healthy upstream available; falling back to ${fallback.length}/${chain.length} unhealthy upstream(s)`
    );
    healthy.push(...fallback);
    if (healthy.length === 0) {
      // 全候选均 givenUp：与主链同错误码，不发任何上游请求
      deps.onComplete?.({ virtualKeyId: virtualKey.id }).catch(() => {});
      return proxyError(502, "No available upstream", "upstream_unavailable");
    }
  }

  // 请求体读取必须在配额 in-flight 预留**之前**（与主链同顺序）：
  // 预留跨越读 body 的窗口时，413 / readRequestBody 抛错会直接 return/抛出，
  // 包装后的 onComplete 永不触发 → reservation 永久留在 inflight Map，
  // 反复发超大 body 可把该 vk 的在途计数刷高，把它自己的合法请求挤成 429。
  const bodyBuffer = await readRequestBody(request);
  if (bodyBuffer === null) {
    return proxyError(413, "Request body exceeds size limit", "invalid_request_error");
  }

  // 配额检查：subresource 无 model 维度，按 vk 聚合限额（RPM/TPM/Daily/Monthly）检查；
  // 无限额 vk 直接跳过。同样接 in-flight 预留（并发突发不能绕过 RPM）；
  // 辅助端点不记 usage、无请求体估算口径 → 预留 token 计 0，只计请求数。
  if (deps.quota && hasQuotaLimits(virtualKey)) {
    const now = new Date();
    const release = reserveInflight(virtualKey.id, 0);
    // 抛错兜底（见 withInflightRelease）：后续 resolveUpstreamKeys 等 await 抛错也释放
    scope.release = release;
    let quotaUsage: QuotaUsage;
    try {
      quotaUsage = await deps.quota.loadUsage(virtualKey.id, now);
    } catch (err) {
      release();
      throw err;
    }
    const pending = getInflight(virtualKey.id);
    const violation = checkQuota(
      {
        virtualKeyId: virtualKey.id,
        maxRpm: virtualKey.maxRpm ?? null,
        maxTpm: virtualKey.maxTpm ?? null,
        maxDailyTokens: virtualKey.maxDailyTokens ?? null,
        maxMonthlyTokens: virtualKey.maxMonthlyTokens ?? null,
        now,
      },
      {
        rpm: quotaUsage.rpm + pending.rpm,
        tpm: quotaUsage.tpm + pending.tokens,
        dailyTokens: quotaUsage.dailyTokens + pending.tokens,
        monthlyTokens: quotaUsage.monthlyTokens + pending.tokens,
      }
    );
    if (violation) {
      release();
      return proxyError(
        429,
        `Quota exceeded (${violation.dimension}: ${violation.current} / ${violation.limit})`,
        "quota_exceeded"
      );
    }
    // 释放挂在既有唯一完成钩子 onComplete 上（成功 / 失败 / 流结束都调）
    const prevOnComplete = deps.onComplete;
    deps = {
      ...deps,
      onComplete: async (info) => {
        release();
        await prevOnComplete?.(info);
      },
    };
  }

  let lastError: { status: number; text?: string } | null = null;
  let fallbackBusinessResponse: Response | null = null;

  for (const upstream of healthy) {
    const keys = await deps.resolveUpstreamKeys(upstream.id);
    if (keys.length === 0) {
      lastError = { status: 0, text: `No API keys configured for upstream: ${upstream.name}` };
      continue;
    }
    const targetUrl = `${joinUrlPath(upstream.baseUrl, path)}${stripQueryKey(url)}`;

    let lastResponse: Response | null = null;
    let upstreamFailed = true;
    for (const apiKey of keys) {
      for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        let upstreamResponse: Response | null = null;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          const controller = new AbortController();
          timeoutHandle = setTimeout(() => controller.abort(), NON_STREAMING_TIMEOUT_MS);
          const dispatcher = getOutboundDispatcher(upstream.proxyUrl);

          upstreamResponse = await outboundFetch(targetUrl, {
            method: request.method,
            headers: buildUpstreamHeaders(
              request.headers,
              "openai",
              apiKey,
              upstream.headerTransforms,
              {
                // 辅助端点无请求体 model：会话指纹退化为 path（response id 语义，稳定即可）
                sessionId: () => buildSessionId(null, path, virtualKey.id, "openai"),
                model: path,
                keyName: virtualKey.name,
                upstream: upstream.name,
              }
            ),
            body: bodyBuffer.length > 0 ? bodyBuffer : null,
            duplex: "half",
            redirect: "manual",
            signal: controller.signal,
            ...(dispatcher ? { dispatcher } : {}),
          } as RequestInit & { duplex: "half" });

          if (isRedirectStatus(upstreamResponse.status)) {
            // 手动模式：3xx 一律视为失败（LLM API 不应重定向），防认证头跨源泄露
            lastError = { status: upstreamResponse.status };
            await upstreamResponse.body?.cancel();
            break; // 尝试下一个 key
          }
          if (isRetryableStatus(upstreamResponse.status)) {
            lastError = { status: upstreamResponse.status };
            // 保留 5xx/429 响应用于全部失败时透传：客户端可见真实状态码与错误体
            fallbackBusinessResponse = upstreamResponse;
            continue; // 重试
          }
          if (upstreamResponse.status === 401) {
            lastError = { status: 401 };
            await upstreamResponse.body?.cancel();
            break; // key 无效：换下一个 key
          }
          if (upstreamResponse.status === 404 || upstreamResponse.status === 403) {
            // 该 upstream 不认识此 response id（非创建者）：保留业务响应，换下一个 upstream，
            // 不标记 health（response id 每次不同，标记会污染 model/upstream 健康状态）
            lastError = { status: upstreamResponse.status };
            fallbackBusinessResponse = upstreamResponse;
            upstreamFailed = false;
            break;
          }
          lastResponse = upstreamResponse; // 成功（含其他 4xx 业务错误）：直接透传
          upstreamFailed = false;
          break;
        } catch (err) {
          lastError = {
            status: 0,
            text: `${err instanceof Error ? err.message : String(err)}${describeErrorCauses(err)}`,
          };
          // 网络错误/超时 → 重试
        } finally {
          clearTimeout(timeoutHandle);
        }

        if (lastResponse) break;
      }
      if (lastResponse || !upstreamFailed) break;
    }

    if (lastResponse) {
      // 兜底成功：真实请求成功是强恢复信号，立即清除 upstream 级健康标记
      if (lastResponse.status >= 200 && lastResponse.status < 300 && degradedUpstreams.has(upstream.id)) {
        deps.health?.markHealthy?.(upstream.id);
        deps.log?.(
          `[gateway] upstream "${upstream.name}" recovered via real request; health marks cleared`
        );
      }
      // 成功：释放未透传的业务错误 body，避免连接泄漏
      await fallbackBusinessResponse?.body?.cancel().catch(() => {});
      fallbackBusinessResponse = null;
      deps.onComplete?.({ virtualKeyId: virtualKey.id }).catch(() => {});
      return passthroughResponse(lastResponse, {
        meta: {
          model: path,
          provider: upstream.name,
          agent: virtualKey.name,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          virtualKeyId: virtualKey.id,
          userAgent,
        },
        deps,
        estimateInput: () => 0,
        protocol: "openai",
        virtualKeyId: virtualKey.id,
        recordUsage: false, // 辅助端点不记录 usage（retrieve 重复调用会重复统计）
        clientSignal: request.signal,
      });
    }

    // 全部 key 均 401/网络失败：照常标记 unhealthy（key 级真实问题，与主链路一致）
    if (upstreamFailed) {
      deps.health?.markUnhealthy(upstream.id);
      deps.log?.(
        `[gateway] upstream "${upstream.name}" marked unhealthy during responses subresource request`
      );
    }
  }

  // 全部 upstream 均未命中：优先透传最后一个业务响应（404/403）
  deps.onComplete?.({ virtualKeyId: virtualKey.id }).catch(() => {});
  if (fallbackBusinessResponse) {
    return passthroughResponse(fallbackBusinessResponse, {
      meta: {
        model: path,
        provider: healthy[0]?.name ?? "unknown",
        agent: virtualKey.name,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        virtualKeyId: virtualKey.id,
        userAgent,
      },
      deps,
      estimateInput: () => 0,
      protocol: "openai",
      virtualKeyId: virtualKey.id,
      recordUsage: false,
    });
  }
  if (lastError && lastError.status > 0) {
    return new Response(
      JSON.stringify({
        error: { message: `Upstream returned status ${lastError.status}`, type: "upstream_error" },
      }),
      { status: 502, headers: PROXY_RESPONSE_HEADERS }
    );
  }
  if (lastError?.text) {
    deps.log?.(`[gateway] upstream request failed: ${lastError.text}`);
  }
  return proxyError(502, "Upstream request failed", "upstream_error");
}

// 透传上游响应（单 reader，边透传边累积副本），usage 解析与写库由 deps 完成；
// 仅命名路由命中时启用响应 model 回写（virtualModelName），正常流量零开销
async function passthroughResponse(
  upstreamResponse: Response,
  opts: {
    meta: RecordUsageMeta;
    deps: ProxyDeps;
    estimateInput: () => number; // input 估算兑底（scan 路径零 parse，见 handleProxyRequest）
    protocol: Protocol;
    virtualKeyId: number;
    virtualModelName?: string;
    recordUsage?: boolean; // 辅助端点等场景跳过 usage 解析与写库（默认 true）
    startTime?: number; // 请求开始时刻（与 latencyMs 同源），用于流式 TTFT 计算
    clientSignal?: AbortSignal; // 客户端请求 signal（断开检测）
    // responses create 的 response id 归属回调（best-effort，失败不影响透传）
    onResponseCreated?: (responseId: string) => Promise<void>;
  }
): Promise<Response> {
  const { meta, deps, estimateInput, protocol, virtualKeyId, virtualModelName, recordUsage = true, startTime, clientSignal, onResponseCreated } = opts;
  const headers = new Headers(PROXY_RESPONSE_HEADERS);
  copyHeader(upstreamResponse.headers, headers, "content-type");
  copyHeader(upstreamResponse.headers, headers, "x-ratelimit-remaining-requests");
  copyHeader(upstreamResponse.headers, headers, "x-ratelimit-remaining-tokens");

  if (!upstreamResponse.body) {
    deps.onComplete?.({ virtualKeyId }).catch(() => {});
    return new Response(null, { status: upstreamResponse.status, headers });
  }

  const isStreaming = isStreamingResponse(upstreamResponse.headers);
  const isSuccess = upstreamResponse.status >= 200 && upstreamResponse.status < 300;
  const reader = upstreamResponse.body.getReader();
  const chunks: Uint8Array[] = [];
  // 非流式响应字节只拼接一次（usage 扫描用字节零解码；估算兑底才 decode，同样只一次）
  let fullBytesCache: Uint8Array | null = null;
  const getFullBytes = (): Uint8Array => (fullBytesCache ??= concatUint8Arrays(chunks));
  let fullTextCache: string | null = null;
  const getFullText = (): string =>
    (fullTextCache ??= new TextDecoder().decode(getFullBytes()));
  // 流式响应：增量解析 usage，不持有完整响应体（内存 O(1)）
  const extractor = isStreaming ? new StreamUsageExtractor(protocol) : null;
  // 流式首 chunk 到达时刻（TTFT，相对请求开始）；非流式保持 null 不写入
  let ttftMs: number | null = null;
  let onDone: () => void = () => {};
  // 客户端断开 / 上游流中断状态标记
  let clientAborted = false;
  let streamStatus: string | undefined;
  // pump 已正常读完上游并 close。配合 extractor.sawTerminal 判定「响应完整后
  // 客户端才断开」——此时 cancel/abort 是正常收尾竞态，不标 client_aborted
  let responseComplete = false;
  const isAbortAfterComplete = () =>
    responseComplete || (extractor?.sawTerminal ?? false);

  const rewriter = virtualModelName
    ? createSseModelRewriter(protocol, virtualModelName)
    : null;

  const passthrough = new ReadableStream<Uint8Array>({
    start(controller) {
      // 监听客户端 signal abort（双保险：cancel() 钩子是主要路径）
      if (clientSignal) {
        clientSignal.addEventListener("abort", () => {
          if (!isAbortAfterComplete()) {
            clientAborted = true;
            streamStatus = "client_aborted";
          }
          reader.cancel().catch(() => {});
        });
      }
      const pump = async () => {
        let idleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS;
        try {
          idleTimeoutMs =
            (await deps.resolveStreamIdleTimeoutMs?.()) ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
        } catch {
          // 解析失败保持默认
        }
        // 每次 read 前重置空闲计时器：超时未收到任何数据则中断流（防卡死连接长期占用）
        const readWithIdleTimeout = () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          return Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`stream idle timeout after ${idleTimeoutMs}ms`)),
                idleTimeoutMs
              );
            }),
          ]).finally(() => clearTimeout(timer));
        };
        try {
          if (!isStreaming && rewriter) {
            // 非流式回写：先攒完整 body → 顶层 model 区间切片改写 → enqueue
            //（不整包 parse/重序列化；扫描无 model/不合法回退原始字节）
            let totalBytes = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              totalBytes += value.length;
              if (totalBytes > MAX_NON_STREAMING_RESPONSE_BYTES) {
                throw new Error("Upstream response exceeds size limit");
              }
              chunks.push(value);
            }
            const rewritten = rewriteModelNonStreamingBytes(
              getFullBytes(),
              protocol,
              virtualModelName!
            );
            if (rewritten.length > 0) controller.enqueue(rewritten);
            responseComplete = true;
            controller.close();
          } else {
            let totalBytes = 0;
            while (true) {
              const { done, value } = await (isStreaming
                ? readWithIdleTimeout()
                : reader.read());
              if (done) break;
              if (isStreaming) {
                // 首 chunk 到达时刻 = TTFT（仅流式；与 latencyMs 同起点）
                if (ttftMs === null && startTime !== undefined) {
                  ttftMs = Date.now() - startTime;
                }
                // feed 原始 chunk（rewriter 改写不影响 usage 提取）
                extractor!.feed(value);
              } else {
                totalBytes += value.length;
                if (totalBytes > MAX_NON_STREAMING_RESPONSE_BYTES) {
                  throw new Error("Upstream response exceeds size limit");
                }
                chunks.push(value);
              }
              controller.enqueue(rewriter ? rewriter.transform(value) : value);
            }
            if (rewriter) {
              // 流结束 flush 残余缓冲（未凑成完整事件的部分原样输出）
              const rest = rewriter.flush();
              if (rest.length > 0) controller.enqueue(rest);
            }
            responseComplete = true;
            controller.close();
          }
        } catch (err) {
          // 释放上游连接，避免超时/异常后连接泄漏
          if (!isAbortAfterComplete()) {
            streamStatus = clientAborted ? "client_aborted" : "stream_interrupted";
          }
          await reader.cancel().catch(() => {});
          // 不能把原始 err 交给 ReadableStream：@hono/node-server 的 handleResponseError 会把
          // `Error: ${err.message}` 直接写进响应体（headers 未发则 500 明文，已发则追加在末尾），
          // 超时阈值、尺寸上限这类内部文案会漏给客户端。现场留日志，客户端只看到断流。
          // 客户端主动断连（clientAborted）是常态，不刷日志。
          if (!clientAborted) {
            console.warn(
              "[gateway] upstream stream interrupted:",
              err instanceof Error ? err.message : err
            );
          }
          controller.error(new Error("stream interrupted"));
        }
      };
      pump().finally(() => onDone());
    },
    cancel() {
      if (!isAbortAfterComplete()) {
        clientAborted = true;
        streamStatus = "client_aborted";
      }
      reader.cancel();
    },
  });

  onDone = async () => {
    try {
      // responses create：记 response id 归属（best-effort，失败不影响透传）
      if (isSuccess && onResponseCreated) {
        try {
          const id = isStreaming
            ? (extractor?.responseId ?? null)
            : parseResponseIdFromBytes(getFullBytes());
          if (id) await onResponseCreated(id);
        } catch (err) {
          deps.log?.(`[gateway] response id capture failed: ${(err as Error).message}`);
        }
      }
      if (isSuccess && recordUsage) {
        const parsed =
          isStreaming && extractor
            ? extractor.finish()
            : parseUsageFromBytes(getFullBytes(), protocol);
        let usage = toRecordUsage(parsed, meta, streamStatus);
        // usage 解析失败且上游流已真正读完（responseComplete）：上游（多为第三方中转）
        // 不发 usage 时按请求 messages / 流内输出文本估算兜底，记 status='estimated'。
        // 流被提前截断（含 sawTerminal 已置位但未读完）不估算：output 可能缺尾部，
        // 残缺估算值写进统计比 no_usage 更差；估算不出任何内容也保持 no_usage。
        if (!parsed && !streamStatus && responseComplete) {
          const inputTokens = estimateInput();
          const outputTokens = isStreaming
            ? (extractor?.contentTokens ?? 0)
            : estimateOutputTokens(getFullText(), protocol);
          if (inputTokens + outputTokens > 0) {
            usage = {
              ...meta,
              inputTokens,
              outputTokens,
              cacheRead: 0,
              cacheWrite: 0,
              status: "estimated",
            };
          }
        }
        // latencyMs 必须在流完全结束后计算：proxy 主流程的初始值只覆盖到
        // 响应头（≈TTFT 窗口），不含流式生成/body 传输阶段
        const finalLatencyMs =
          startTime !== undefined ? Date.now() - startTime : meta.latencyMs;
        await deps.onUsage?.({
          ...usage,
          ttftMs: ttftMs ?? undefined,
          latencyMs: finalLatencyMs,
        });
      }
    } catch (err) {
      deps.log?.(`[gateway] usage capture failed: ${(err as Error).message}`);
    } finally {
      deps.onComplete?.({ virtualKeyId }).catch(() => {});
    }
  };

  return new Response(passthrough, { status: upstreamResponse.status, headers });
}

// vk model allowlist 匹配：'*' 全放行，空配置视为不允许（deny by default）
export function isModelAllowedByVirtualKey(
  vk: VirtualKeyInfo,
  model: string
): boolean {
  const patterns = parseEnabledModels(vk.enabledModels);
  if (patterns.includes("*")) return true;
  return patterns.some((p) => modelMatchesPattern(p, model));
}

// ---- usage 解析（按上游协议选择解析器） ----

// 非流式 usage 提取：顶层 usage / usageMetadata 区间切片后局部 parse，
// 不整包 decode+parse（大响应体零树化）。语义与原整包 parse 等价：解析器只读顶层
// usage 键；整包不合法 → 扫描 valid=false → null；合法但无 usage 键 → null。
// 深层 token 宽松（json-scan 边界注释）：畸形响应按无 usage 走估算兑底，不影响记账安全。
function parseUsageFromBytes(bytes: Uint8Array, protocol: Protocol): ParsedUsage | null {
  const key = protocol === "gemini" ? "usageMetadata" : "usage";
  const scan = scanTopLevelObject(bytes, [key]);
  if (!scan.valid || !scan.isObject) return null;
  const span = scan.fields.get(key);
  if (!span) return null;
  let usageJson: unknown;
  try {
    usageJson = JSON.parse(new TextDecoder().decode(bytes.subarray(span.start, span.end)));
  } catch {
    return null;
  }
  switch (protocol) {
    case "anthropic":
      return parseAnthropicNonStreaming({ usage: usageJson });
    case "gemini":
      return parseGeminiNonStreaming({ usageMetadata: usageJson });
    default:
      return parseOpenAiNonStreaming({ usage: usageJson });
  }
}

// responses create 的 response id：顶层 id 区间切片后局部 parse（同 usage，不整包树化）。
// 非流式响应形状 {"id":"resp_...",...}；取不到或非字符串一律 null。
function parseResponseIdFromBytes(bytes: Uint8Array): string | null {
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

function toRecordUsage(parsed: ParsedUsage | null, meta: RecordUsageMeta, interruptStatus?: string): RecordUsageMeta {
  if (!parsed) {
    return { ...meta, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, status: interruptStatus ?? "no_usage" };
  }
  if (interruptStatus) {
    return { ...meta, ...parsed, status: interruptStatus };
  }
  return { ...meta, ...parsed };
}

// ---- 工具 ----

// 候选按 upstream 去重（同一 upstream 可因 exact + wildcard 命中多次），保留首次出现顺序
function dedupeByUpstreamId(candidates: ModelCandidate[]): UpstreamRoute[] {
  const seen = new Set<number>();
  const result: UpstreamRoute[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.upstream.id)) continue;
    seen.add(candidate.upstream.id);
    result.push(candidate.upstream);
  }
  return result;
}

// `?key=` 已不再作为认证方式；转发前仍剔除以防客户端把 key 混在 query 里透给上游
// （plan.ts 复用：relay 的 lease URL 必须与直连同一口径）
export function stripQueryKey(url: URL): string {
  url.searchParams.delete("key");
  const qs = url.searchParams.toString();
  return qs ? `?${qs}` : "";
}

// （plan.ts 复用：models 模式的快照必须与直连逐字同口径）
export function collectEnabledModels(upstreams: UpstreamRoute[], manualNames: string[] = []): string[] {
  const result = new Set<string>(manualNames);
  for (const upstream of upstreams) {
    if (upstream.enabled === false) continue;
    const raw = upstream.enabledModels;
    if (Array.isArray(raw)) {
      for (const m of raw) {
        if (!m.endsWith("*")) result.add(m);
      }
    } else if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as string[];
        for (const m of parsed) {
          if (!m.endsWith("*")) result.add(m);
        }
      } catch {
        // ignore
      }
    }
  }
  return Array.from(result).sort();
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function copyHeader(from: Headers, to: Headers, name: string): void {
  const value = from.get(name);
  if (value) to.set(name, value);
}

export function proxyError(status: number, message: string, type: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type } }),
    { status, headers: PROXY_RESPONSE_HEADERS }
  );
}
