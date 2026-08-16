// 响应 model 字段回写（仅手动路由命中时启用，正常流量零开销）：
// 客户端请求的是虚拟名，上游返回的是真实模型名，透传时把 model 字段改回虚拟名。
// Gemini 不改写（modelVersion 是版本信息，不回显请求名）。
import type { Protocol } from "./model-router";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function rewriteModelField(
  json: Record<string, unknown>,
  protocol: Protocol,
  virtualName: string
): boolean {
  if (protocol === "gemini") return false;
  if (typeof json.model === "string") {
    json.model = virtualName;
    return true;
  }
  return false;
}

// 非流式响应：JSON parse → 顶层 model 改写 → 重序列化；parse 失败原样返回
export function rewriteModelNonStreaming(
  text: string,
  protocol: Protocol,
  virtualName: string
): string {
  if (protocol === "gemini") return text;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof json !== "object" || json === null) return text;
  if (!rewriteModelField(json as Record<string, unknown>, protocol, virtualName)) {
    return text;
  }
  return JSON.stringify(json);
}

// 解析一个完整 SSE 事件块（不含结尾分隔符），返回改写后的块（保持 event:/data: 行结构）
function rewriteSseEventBlock(block: string, protocol: Protocol, virtualName: string): string {
  const lines = block.split("\n");
  const out: string[] = [];
  const dataLines: string[] = [];
  let hasData = false;

  for (const line of lines) {
    if (line.startsWith("data:")) {
      hasData = true;
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    } else {
      // 非 data 行（event: / : 注释 / 空行）原样保留
      out.push(line);
    }
  }

  if (!hasData) return block; // 纯注释/event 块，原样透传

  const payload = dataLines.join("\n");
  if (payload.trim() === "[DONE]") return block;

  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return block; // 损坏 JSON 事件原样透传
  }
  if (typeof json !== "object" || json === null) return block;

  if (protocol === "anthropic") {
    // 仅 message_start 事件含 message.model，其余事件不动
    if (json && (json as Record<string, unknown>).type === "message_start") {
      const message = (json as Record<string, unknown>).message;
      if (typeof message === "object" && message !== null) {
        const msg = message as Record<string, unknown>;
        if (typeof msg.model === "string") {
          msg.model = virtualName;
          return [...out, `data: ${JSON.stringify(json)}`].join("\n");
        }
      }
    }
    return block;
  }

  // OpenAI：顶层 model 改写
  if (rewriteModelField(json as Record<string, unknown>, protocol, virtualName)) {
    return [...out, `data: ${JSON.stringify(json)}`].join("\n");
  }
  return block;
}

export interface SseModelRewriter {
  // 输入上游 chunk，输出改写后的 chunk（内部按事件边界缓冲，处理跨 chunk 拆分的事件）
  transform(chunk: Uint8Array): Uint8Array;
  // 流结束时 flush 残余缓冲（未凑成完整事件的部分原样输出）
  flush(): Uint8Array;
}

// 有状态 SSE 转换器：按 \n\n / \r\n\r\n 事件边界切分，跨 chunk 事件缓存等待完整
export function createSseModelRewriter(
  protocol: Protocol,
  virtualName: string
): SseModelRewriter {
  if (protocol === "gemini") {
    // Gemini 不改写：恒等转换，零开销
    return {
      transform: (chunk) => chunk,
      flush: () => new Uint8Array(0),
    };
  }

  let buffer = "";

  return {
    transform(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let output = "";
      while (true) {
        let sep = -1;
        let sepLen = 0;
        const lf = buffer.indexOf("\n\n");
        const crlf = buffer.indexOf("\r\n\r\n");
        if (lf !== -1 && (crlf === -1 || lf < crlf)) {
          sep = lf;
          sepLen = 2;
        } else if (crlf !== -1) {
          sep = crlf;
          sepLen = 4;
        }
        if (sep === -1) break;
        const block = buffer.slice(0, sep);
        const sepRaw = buffer.slice(sep, sep + sepLen);
        buffer = buffer.slice(sep + sepLen);
        output += rewriteSseEventBlock(block, protocol, virtualName) + sepRaw;
      }
      return encoder.encode(output);
    },
    flush() {
      if (buffer.length === 0) return new Uint8Array(0);
      const rest = buffer;
      buffer = "";
      return encoder.encode(rest);
    },
  };
}
