// 认证端点（login / setup）的请求体读取：64KB 上限 + 流式读取。
// 为什么不用 request.json()：
// - request.json() 无体积上限，超大 body 会被完整读进内存（DoS）
// - content-length 可缺省（chunked），必须在读流时边读边累计
// 限流必须在读 body 之前执行（调用方顺序保证），缺失 key / 坏 JSON / 超大 body 均不得绕过限流。

export const MAX_AUTH_BODY_BYTES = 64 * 1024;

export class BodyTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number = MAX_AUTH_BODY_BYTES) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
    this.limit = limit;
  }
}

export class InvalidJsonBodyError extends Error {
  constructor() {
    super("Invalid JSON body");
    this.name = "InvalidJsonBodyError";
  }
}

function parseContentLength(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

// 读取并解析 JSON body：超限 → BodyTooLargeError；坏 JSON/空 body → InvalidJsonBodyError。
// 非对象 JSON（字符串/数组/null）归一为 {}，与历史 request.json() 后的访问口径一致。
export async function readJsonBodyLimited(
  request: Request,
  maxBytes: number = MAX_AUTH_BODY_BYTES
): Promise<Record<string, unknown>> {
  const declared = parseContentLength(request.headers.get("content-length"));
  if (declared !== null && declared > maxBytes) {
    // 声明超限：不读 body 直接拒绝（chunked 无 length 时走下面的流式累计）
    throw new BodyTooLargeError(maxBytes);
  }

  const body = request.body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (body) {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new BodyTooLargeError(maxBytes);
        }
        chunks.push(value);
      }
    } finally {
      // 超限/异常时主动取消，释放底层连接
      reader.cancel().catch(() => {});
    }
  }

  if (total === 0) throw new InvalidJsonBodyError();

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(merged));
  } catch {
    throw new InvalidJsonBodyError();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}
