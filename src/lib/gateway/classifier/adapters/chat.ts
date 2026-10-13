// 通用 chat completion 分类器 adapter（v1 仅支持 openai 协议 upstream）。
// 让任意 chat 模型充当分类器：system 给指令 + 选项清单，要求只回复选项键。
import type {
  ClassifierAdapter,
  ClassifierDecision,
  ClassifierDecisionInput,
  ClassifierModelEntry,
  ClassifierRouteOption,
} from "../types";

const DEFAULT_INSTRUCTION =
  "Pick the model route that best fits this request's complexity and requirements.";

export const chatAdapter: ClassifierAdapter = {
  type: "chat",
  defaultPath: "/v1/chat/completions",

  buildRequest(
    model: string,
    input: ClassifierDecisionInput,
    entry: ClassifierModelEntry
  ): { path: string; body: Record<string, unknown> } {
    const optionLines = input.options.map((o) => `${o.key}: ${o.label}`).join("\n");
    const system = [
      input.instruction.trim() || DEFAULT_INSTRUCTION,
      "",
      "Options:",
      optionLines,
      "",
      "Reply with only the option key, nothing else.",
    ].join("\n");
    return {
      path: entry.path ?? this.defaultPath,
      body: {
        model,
        stream: false,
        max_tokens: 32,
        messages: [
          { role: "system", content: system },
          { role: "user", content: input.state },
        ],
      },
    };
  },

  parseResponse(json: unknown, options: ClassifierRouteOption[]): ClassifierDecision {
    const usage = parseUsage(json);
    if (typeof json !== "object" || json === null) return { routeId: null, usage };
    const choices = (json as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length === 0) return { routeId: null, usage };
    const message = (choices[0] as Record<string, unknown>)?.message;
    const content =
      typeof message === "object" && message !== null
        ? (message as Record<string, unknown>).content
        : null;
    if (typeof content !== "string") return { routeId: null, usage };
    const text = content.trim();
    // 精确命中选项键优先；否则取文本中包含的最长选项键
    //（模型可能带标点/引号；r1 是 r12 的前缀，按数组顺序取首个命中会错选短键）
    const exact = options.find((o) => o.key === text);
    if (exact) return { routeId: exact.routeId, usage };
    let best: ClassifierRouteOption | null = null;
    for (const o of options) {
      if (!text.includes(o.key)) continue;
      if (!best || o.key.length > best.key.length) best = o;
    }
    return { routeId: best ? best.routeId : null, usage };
  },
};

function parseUsage(json: unknown): { inputTokens: number; outputTokens: number } | null {
  if (typeof json !== "object" || json === null) return null;
  const usage = (json as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const output = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
  if (input === 0 && output === 0) return null;
  return { inputTokens: input, outputTokens: output };
}
