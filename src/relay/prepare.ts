// relay 侧唯一读 body 的地方：model / stream / 会话指纹 / token 估算 / vkFp / 客户端 header 名。
//
// 大 body 分治与中心同口径：≤1MB 整包 JSON.parse；>1MB 顶层扫描（json-scan），不物化消息树
// —— 否则最大那批请求正好在 relay 上把内存吃掉，与方案动机对撞（§10.2）。
import {
  detectRequestProtocol,
  extractRequestModel,
  type Protocol,
} from "@/lib/gateway/model-router";
import {
  isNonEmptyArraySpan,
  scanTopLevelObject,
  spliceBytes,
  type ScanResult,
} from "@/lib/gateway/json-scan";
import {
  computeSessionId,
  extractSessionInput,
  extractSessionInputFromBytes,
} from "@/lib/gateway/session";
import { estimateInputTokens, estimateInputTokensFromSpans } from "@/lib/gateway/estimate";
import { extractVirtualKeyToken, MAX_SESSION_ID_LENGTH } from "@/lib/gateway/proxy-headers";
import { stripRawPassthroughPrefix } from "@/lib/gateway/url-utils";
import { virtualKeyFingerprint } from "@/lib/gateway/vk-fingerprint";

const FULL_PARSE_LIMIT_BYTES = 1024 * 1024;
const SCANNED_BODY_KEYS = ["model", "stream", "stream_options", "messages", "input", "contents"];
const SESSION_ID_HEADERS = [
  "x-claude-code-session-id",
  "x-opencode-session",
  "session-id",
  "x-session-id",
  "session_id",
  "x-session-affinity",
  "x-conversation-id",
] as const;

export class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string
  ) {
    super(message);
  }
}

export interface PreparedRequest {
  method: string;
  path: string; // 含 query（`?key=` 已剥）
  protocol: Protocol;
  model: string | null;
  stream: boolean | undefined;
  nativeSessionId: string | null;
  sessionFingerprint: string | null;
  hasMessages: boolean;
  estimatedInputTokens: number;
  vkFp: string | null;
  headerNames: string[];
  bodyBuffer: Uint8Array;
  bodyScan: ScanResult | null;
  bodyJson: unknown;
}

export function maxBodyBytes(): number {
  const mb = Number(process.env.GATEWAY_MAX_BODY_MB);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 32 * 1024 * 1024;
}

// 读取顺序与中心 readRequestBody 逐条一致：
// 1) content-length 先判（超限立即 413，不读 body）
// 2) 已知长度走单趟 arrayBuffer（免 2× 瞬时字节）
// 3) chunked 边读边计，超限中断
async function readBody(request: Request): Promise<Uint8Array> {
  const maxBytes = maxBodyBytes();
  const declared = request.headers.get("content-length");
  const declaredN = declared !== null ? Number(declared) : NaN;
  if (Number.isFinite(declaredN) && declaredN > maxBytes) {
    throw new RelayHttpError(413, "invalid_request_error", "Request body exceeds size limit");
  }
  const raw = request.body;
  if (!raw) {
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new RelayHttpError(413, "invalid_request_error", "Request body exceeds size limit");
    }
    return buf;
  }
  if (declaredN >= 0 && Number.isFinite(declaredN)) {
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new RelayHttpError(413, "invalid_request_error", "Request body exceeds size limit");
    }
    return buf;
  }
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RelayHttpError(413, "invalid_request_error", "Request body exceeds size limit");
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof RelayHttpError) throw err;
    throw new RelayHttpError(400, "invalid_request_error", "Failed to read request body");
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

// `?key=` 不作为认证方式，但仍从 query 里剔除（防客户端把 key 混进 query 透给上游）
export function stripQueryKey(path: string): string {
  const index = path.indexOf("?");
  if (index < 0) return path;
  try {
    const url = new URL(`http://relay.invalid${path}`);
    url.searchParams.delete("key");
    const qs = url.searchParams.toString();
    return qs ? `${url.pathname}?${qs}` : url.pathname;
  } catch {
    return path;
  }
}

function readScannedStreamFlag(bytes: Uint8Array, scan: ScanResult): unknown {
  const span = scan.fields.get("stream");
  if (!span) return undefined;
  const text = new TextDecoder().decode(bytes.subarray(span.start, span.end));
  return text === "true" ? true : text === "false" ? false : undefined;
}

function readScannedStringValue(bytes: Uint8Array, scan: ScanResult, key: string): string | null {
  const span = scan.fields.get(key);
  if (!span) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(span.start, span.end)));
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function nativeSessionIdOf(headers: Headers): string | null {
  for (const name of SESSION_ID_HEADERS) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    return trimmed.slice(0, MAX_SESSION_ID_LENGTH);
  }
  return null;
}

// 会话指纹（sha256）：素材（system + 首条 user）在 relay 本地提取后直接哈希，隔离项用
// vk 指纹（relay 唯一知道的 vk 身份）而不是中心的数值 vk id —— 中心不再需要接收
// system/首条 user 明文，plan 请求也不再携带 sessionInput。
// 同一 vk 混用直连与 relay 会得到两个指纹（隔离项取值不同），仅影响粘性不跨入口共享。
function sessionFingerprintOf(
  bodyJson: unknown,
  bodyScan: ScanResult | null,
  bodyBuffer: Uint8Array,
  model: string,
  protocol: Protocol,
  vkFp: string
): string {
  return computeSessionId(
    bodyScan !== null
      ? extractSessionInputFromBytes(
          bodyBuffer,
          bodyScan.fields.get("messages"),
          model,
          vkFp,
          protocol
        )
      : extractSessionInput(bodyJson, model, vkFp, protocol)
  );
}

function hasMessagesOf(bodyJson: unknown, bodyScan: ScanResult | null, bodyBuffer: Uint8Array): boolean {
  if (bodyScan) {
    const span = bodyScan.fields.get("messages");
    return span !== undefined && isNonEmptyArraySpan(bodyBuffer, span);
  }
  const messages = (bodyJson as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) && messages.length > 0;
}

export async function prepare(request: Request, url: URL): Promise<PreparedRequest> {
  const path = stripQueryKey(url.pathname + url.search);
  // /raw 裸透传：协议检测 / model 提取 /（后续）usage 解析都必须在剥前缀后的内层 path 上做
  // ——与直连 stripRawPassthroughPrefix 同一实现。不剥前缀时 /raw 上的 anthropic/gemini
  // 端点会被当成 openai（协议错→usage 解析错位→估算口径也错）。
  // 内层 path 非法（空 / 逃逸）→ 400（与直连同口径）；中心 plan 会再净化一次。
  const innerPath = stripRawPassthroughPrefix(url.pathname);
  if (innerPath === null) {
    throw new RelayHttpError(400, "invalid_request_error", "Invalid request path");
  }
  const pathname = innerPath;
  const protocol = detectRequestProtocol(pathname);
  const headerNames: string[] = [];
  request.headers.forEach((_value, key) => {
    if (headerNames.length < 64) headerNames.push(key.toLowerCase());
  });

  const vkToken = extractVirtualKeyToken(request.headers);
  const vkFp = vkToken ? virtualKeyFingerprint(vkToken) : null;

  // GET /models：无 body、无 model（中心按 models 模式回快照）
  if (request.method === "GET" && pathname.endsWith("/models")) {
    return {
      method: request.method,
      path,
      protocol,
      model: null,
      stream: undefined,
      nativeSessionId: null,
      sessionFingerprint: null,
      hasMessages: false,
      estimatedInputTokens: 0,
      vkFp,
      headerNames,
      bodyBuffer: new Uint8Array(0),
      bodyScan: null,
      bodyJson: null,
    };
  }

  const bodyBuffer = await readBody(request);
  const contentType = request.headers.get("content-type") ?? "";
  const isJsonBody = bodyBuffer.length > 0 && contentType.includes("application/json");
  let bodyJson: unknown = null;
  let bodyScan: ScanResult | null = null;
  if (isJsonBody) {
    if (bodyBuffer.length <= FULL_PARSE_LIMIT_BYTES) {
      try {
        bodyJson = JSON.parse(new TextDecoder().decode(bodyBuffer));
      } catch {
        throw new RelayHttpError(400, "invalid_request_error", "Invalid JSON body");
      }
    } else {
      bodyScan = scanTopLevelObject(bodyBuffer, SCANNED_BODY_KEYS);
      if (!bodyScan.valid) {
        throw new RelayHttpError(400, "invalid_request_error", "Invalid JSON body");
      }
    }
  }

  const streamFlag: unknown =
    bodyScan !== null
      ? readScannedStreamFlag(bodyBuffer, bodyScan)
      : typeof bodyJson === "object" && bodyJson !== null
        ? (bodyJson as Record<string, unknown>).stream
        : undefined;

  const model =
    extractRequestModel(pathname, bodyJson) ??
    (bodyScan !== null ? readScannedStringValue(bodyBuffer, bodyScan, "model") : null);

  const nativeSessionId = nativeSessionIdOf(request.headers);
  // 原生 header 优先（与直连同口径）：有原生 id 时不再算指纹
  const sessionFingerprint =
    model !== null && nativeSessionId === null && vkFp !== null
      ? sessionFingerprintOf(bodyJson, bodyScan, bodyBuffer, model, protocol, vkFp)
      : null;

  const estimatedInputTokens =
    model !== null
      ? bodyScan !== null
        ? estimateInputTokensFromSpans(bodyBuffer, bodyScan.fields, protocol)
        : estimateInputTokens(bodyJson, protocol)
      : 0;

  const hasMessages = hasMessagesOf(bodyJson, bodyScan, bodyBuffer);

  return {
    method: request.method,
    path,
    protocol,
    model,
    stream: typeof streamFlag === "boolean" ? streamFlag : undefined,
    nativeSessionId,
    sessionFingerprint,
    hasMessages,
    estimatedInputTokens,
    vkFp,
    headerNames,
    bodyBuffer,
    bodyScan,
    bodyJson,
  };
}

/** 按 hop 的真实 model 改写 body（gemini 的 path 改写已烘进 plan 的 url，不动 body） */export function rewriteBodyModel(prepared: PreparedRequest, realModel: string | null): Uint8Array {
  if (realModel === null) return prepared.bodyBuffer;
  if (prepared.protocol === "gemini") return prepared.bodyBuffer;
  const { bodyScan, bodyBuffer, bodyJson } = prepared;
  if (bodyScan) {
    const span = bodyScan.fields.get("model");
    if (!span) return bodyBuffer;
    const replacement = new TextEncoder().encode(JSON.stringify(realModel));
    const out = new Uint8Array(bodyBuffer.length - (span.end - span.start) + replacement.length);
    out.set(bodyBuffer.subarray(0, span.start), 0);
    out.set(replacement, span.start);
    out.set(bodyBuffer.subarray(span.end), span.start + replacement.length);
    return out;
  }
  if (typeof bodyJson === "object" && bodyJson !== null) {
    return new TextEncoder().encode(
      JSON.stringify({ ...(bodyJson as Record<string, unknown>), model: realModel })
    );
  }
  return bodyBuffer;
}

// OpenAI chat 流式补 `stream_options.include_usage: true`（与直连 proxy.ts 同口径）：
// 客户端/agent 常不带它，上游（尤其第三方中转）因此不在流里发 usage chunk，中心只能记
// no_usage。何时调用由中心的 plan 决定（resolveBodyDirectives），relay 不写策略 if。
// 必须在所有 scan 读取（model / session / messages / 估算）之后、rewriteBodyModel 之前：
// - ≤1MB 走 parse：重建 bodyJson + bodyBuffer（直连同样重建）
// - >1MB 走 scan：只在缺 stream_options 键时从根 } 前追加（既有键区间不受影响）；
//   已有该键但缺 include_usage 时不动（大 body 罕见，落 executor 的估算兜底）
// 幂等：显式设置（含非法值）一律保留，返回原对象。
export function ensureIncludeUsage(prepared: PreparedRequest): PreparedRequest {
  const { bodyScan } = prepared;
  if (bodyScan !== null) {
    if (bodyScan.fields.has("stream_options") || bodyScan.rootClose < 0) return prepared;
    const prefix = bodyScan.memberCount > 0 ? "," : "";
    return {
      ...prepared,
      bodyBuffer: spliceBytes(
        prepared.bodyBuffer,
        bodyScan.rootClose,
        bodyScan.rootClose,
        new TextEncoder().encode(`${prefix}"stream_options":{"include_usage":true}`)
      ),
    };
  }
  const { bodyJson } = prepared;
  if (typeof bodyJson !== "object" || bodyJson === null || Array.isArray(bodyJson)) return prepared;
  const bodyObj = bodyJson as Record<string, unknown>;
  const existing = bodyObj.stream_options;
  const existingObj =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : null;
  // 客户端显式设置（含非法值）一律保留：非法请求交上游校验，不在网关上静默修正
  if (existingObj !== null && Object.prototype.hasOwnProperty.call(existingObj, "include_usage")) {
    return prepared;
  }
  const nextJson = { ...bodyObj, stream_options: { ...(existingObj ?? {}), include_usage: true } };
  return {
    ...prepared,
    bodyJson: nextJson,
    bodyBuffer: new TextEncoder().encode(JSON.stringify(nextJson)),
  };
}
