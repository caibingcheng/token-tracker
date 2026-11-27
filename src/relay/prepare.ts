// relay 侧唯一读 body 的地方：model / stream / 会话素材 / token 估算 / vkFp / 客户端 header 名。
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
  type ScanResult,
} from "@/lib/gateway/json-scan";
import {
  computeSessionIdFromInput,
  extractSessionInput,
  extractSessionInputFromBytes,
} from "@/lib/gateway/session";
import { estimateInputTokens, estimateInputTokensFromSpans } from "@/lib/gateway/estimate";
import { extractVirtualKeyToken, MAX_SESSION_ID_LENGTH } from "@/lib/gateway/proxy-headers";
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
  sessionInput: string | null;
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

// 指纹素材 = extractSessionInput 去掉尾部 \u0000model\u0000vkId\u0000protocol（relay 不知道 vk ID）
function sessionInputOf(
  bodyJson: unknown,
  bodyScan: ScanResult | null,
  bodyBuffer: Uint8Array,
  model: string,
  protocol: Protocol
): string {
  // vk id 用 0 占位：只借它的 tail 拼接来剥离后缀，值与中心无关
  const joined =
    bodyScan !== null
      ? extractSessionInputFromBytes(bodyBuffer, bodyScan.fields.get("messages"), model, 0, protocol)
      : extractSessionInput(bodyJson, model, 0, protocol);
  const suffix = computeSessionIdFromInput("", model, 0, protocol); // "\u0000model\u00000\u0000protocol"
  return joined.endsWith(suffix) ? joined.slice(0, joined.length - suffix.length) : joined;
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
  const pathname = url.pathname;
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
      sessionInput: null,
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
  const sessionInput =
    model !== null && nativeSessionId === null
      ? sessionInputOf(bodyJson, bodyScan, bodyBuffer, model, protocol)
      : null;

  const estimatedInputTokens =
    model !== null
      ? bodyScan !== null
        ? estimateInputTokensFromSpans(bodyBuffer, bodyScan.fields, protocol)
        : estimateInputTokens(bodyJson, protocol)
      : 0;

  return {
    method: request.method,
    path,
    protocol,
    model,
    stream: typeof streamFlag === "boolean" ? streamFlag : undefined,
    nativeSessionId,
    sessionInput,
    hasMessages: hasMessagesOf(bodyJson, bodyScan, bodyBuffer),
    estimatedInputTokens,
    vkFp,
    headerNames,
    bodyBuffer,
    bodyScan,
    bodyJson,
  };
}

/** 按 hop 的真实 model 改写 body（gemini 的 path 改写已烘进 plan 的 url，不动 body） */
export function rewriteBodyModel(prepared: PreparedRequest, realModel: string | null): Uint8Array {
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
