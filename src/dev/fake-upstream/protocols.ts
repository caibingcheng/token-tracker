// 各协议的响应体/错误体/SSE 帧构造。只做「形状对、数字可控」，不模拟任何厂商的真实语义。
import type { FakeProtocol } from "./types";

export interface Usage {
  prompt: number;
  completion: number;
  cached: number;
}

export interface ResponseOptions {
  model: string;
  text: string;
  usage: Usage;
  now: number;
}

export interface Frame {
  event?: string;
  /** 已序列化的 data；"[DONE]" 是 OpenAI 流结束哨兵 */
  data: string;
}

const ERROR_TYPE: Record<FakeProtocol, Record<number, string>> = {
  openai: {
    400: "invalid_request_error",
    401: "invalid_request_error",
    403: "invalid_request_error",
    404: "invalid_request_error",
    429: "rate_limit_error",
    500: "server_error",
    503: "server_error",
  },
  responses: {
    400: "invalid_request_error",
    401: "invalid_request_error",
    403: "invalid_request_error",
    404: "invalid_request_error",
    429: "rate_limit_error",
    500: "server_error",
    503: "server_error",
  },
  anthropic: {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    429: "rate_limit_error",
    500: "api_error",
    503: "overloaded_error",
  },
  gemini: {
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
    429: "RESOURCE_EXHAUSTED",
    500: "INTERNAL",
    503: "UNAVAILABLE",
  },
};

const OPENAI_ERROR_CODE: Record<number, string> = {
  400: "invalid_request_error",
  401: "invalid_api_key",
  403: "permission_denied",
  404: "model_not_found",
  429: "rate_limit_exceeded",
  500: "internal_error",
  503: "server_error",
};

export function errorBody(protocol: FakeProtocol, status: number, type?: string, message?: string): unknown {
  const kind = type ?? ERROR_TYPE[protocol][status] ?? "api_error";
  const msg = message ?? `fake upstream: ${status}`;
  if (protocol === "openai" || protocol === "responses") {
    return { error: { message: msg, type: kind, code: OPENAI_ERROR_CODE[status] ?? null } };
  }
  if (protocol === "anthropic") return { type: "error", error: { type: kind, message: msg } };
  return { error: { code: status, message: msg, status: kind } };
}

export function contentText(protocol: FakeProtocol, opts: ResponseOptions): unknown {
  const { model, text, usage, now } = opts;
  if (protocol === "openai") {
    return {
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: Math.floor(now / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
        prompt_tokens_details: { cached_tokens: usage.cached },
      },
    };
  }
  if (protocol === "responses") {
    return {
      id: "resp_fake",
      object: "response",
      created_at: Math.floor(now / 1000),
      status: "completed",
      model,
      output: [
        {
          id: "msg_fake",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: usage.prompt,
        output_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
        input_tokens_details: { cached_tokens: usage.cached },
      },
    };
  }
  if (protocol === "anthropic") {
    return {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: usage.prompt,
        output_tokens: usage.completion,
        ...(usage.cached > 0 ? { cache_read_input_tokens: usage.cached } : {}),
      },
    };
  }
  return {
    candidates: [
      { content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 },
    ],
    usageMetadata: {
      promptTokenCount: usage.prompt,
      candidatesTokenCount: usage.completion,
      totalTokenCount: usage.prompt + usage.completion,
      ...(usage.cached > 0 ? { cachedContentTokenCount: usage.cached } : {}),
    },
    modelVersion: model,
  };
}

export function streamFrames(protocol: FakeProtocol, opts: ResponseOptions): Frame[] {
  const { model, text, usage, now } = opts;
  const created = Math.floor(now / 1000);
  if (protocol === "openai" || protocol === "responses") {
    if (protocol === "openai") {
      const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created, model };
      return [
        { data: JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) },
        { data: JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) },
        { data: JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) },
        {
          data: JSON.stringify({
            ...base,
            choices: [],
            usage: {
              prompt_tokens: usage.prompt,
              completion_tokens: usage.completion,
              total_tokens: usage.prompt + usage.completion,
              prompt_tokens_details: { cached_tokens: usage.cached },
            },
          }),
        },
        { data: "[DONE]" },
      ];
    }
    const item = {
      id: "msg_fake",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    return [
      {
        event: "response.created",
        data: JSON.stringify({
          type: "response.created",
          response: { id: "resp_fake", object: "response", status: "in_progress", model, output: [] },
        }),
      },
      {
        event: "response.output_item.added",
        data: JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
      },
      {
        event: "response.output_text.delta",
        data: JSON.stringify({
          type: "response.output_text.delta",
          item_id: "msg_fake",
          output_index: 0,
          content_index: 0,
          delta: text,
        }),
      },
      {
        event: "response.output_item.done",
        data: JSON.stringify({ type: "response.output_item.done", output_index: 0, item }),
      },
      {
        event: "response.completed",
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_fake",
            object: "response",
            created_at: created,
            status: "completed",
            model,
            output: [item],
            usage: {
              input_tokens: usage.prompt,
              output_tokens: usage.completion,
              total_tokens: usage.prompt + usage.completion,
              input_tokens_details: { cached_tokens: usage.cached },
            },
          },
        }),
      },
    ];
  }
  if (protocol === "anthropic") {
    return [
      {
        event: "message_start",
        data: JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_fake",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: usage.prompt,
              output_tokens: 0,
              ...(usage.cached > 0 ? { cache_read_input_tokens: usage.cached } : {}),
            },
          },
        }),
      },
      {
        event: "content_block_start",
        data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      },
      {
        event: "content_block_delta",
        data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
      },
      { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      {
        event: "message_delta",
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: usage.completion },
        }),
      },
      { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
    ];
  }
  const total = usage.prompt + usage.completion;
  return [
    { data: JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, index: 0 }] }) },
    {
      data: JSON.stringify({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
        usageMetadata: {
          promptTokenCount: usage.prompt,
          candidatesTokenCount: usage.completion,
          totalTokenCount: total,
          ...(usage.cached > 0 ? { cachedContentTokenCount: usage.cached } : {}),
        },
        modelVersion: model,
      }),
    },
  ];
}

export function modelsList(protocol: FakeProtocol, ids: string[]): unknown {
  if (protocol === "gemini") {
    return {
      models: ids.map((id) => ({
        name: `models/${id}`,
        displayName: id,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      })),
    };
  }
  if (protocol === "anthropic") {
    return {
      data: ids.map((id) => ({
        type: "model",
        id,
        display_name: id,
        created_at: "2024-01-01T00:00:00Z",
      })),
      has_more: false,
      first_id: ids[0] ?? null,
      last_id: ids[ids.length - 1] ?? null,
    };
  }
  return {
    object: "list",
    data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "fake-upstream" })),
  };
}
