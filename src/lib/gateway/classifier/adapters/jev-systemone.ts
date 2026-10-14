// jev systemone 分类器 adapter（TypeSafe AI System One 决策模型）。
// POST /v1/systemone，body = {model, state, questions: {route: {type:"choice", instructions, criteria}}}
// criteria 是 map<选项键, 选项说明>；响应 answers.route.choice 返回选中选项键。
// OpenRouter 等网关变体（/alpha/decisions）通过 entry.path 覆盖端点路径。
import type {
  ClassifierAdapter,
  ClassifierDecision,
  ClassifierDecisionInput,
  ClassifierModelEntry,
  ClassifierRouteOption,
} from "../types";

const DEFAULT_INSTRUCTION =
  "Pick the model route that best fits this request's complexity and requirements.";

export const jevSystemoneAdapter: ClassifierAdapter = {
  type: "jev-systemone",
  defaultPath: "/v1/systemone",

  buildRequest(
    model: string,
    input: ClassifierDecisionInput,
    entry: ClassifierModelEntry
  ): { path: string; body: Record<string, unknown> } {
    const criteria: Record<string, string> = {};
    for (const option of input.options) {
      criteria[option.key] = option.label;
    }
    return {
      path: entry.path ?? this.defaultPath,
      body: {
        model,
        state: input.state,
        questions: {
          route: {
            type: "choice",
            instructions: input.instruction.trim() || DEFAULT_INSTRUCTION,
            criteria,
          },
        },
      },
    };
  },

  parseResponse(json: unknown, options: ClassifierRouteOption[]): ClassifierDecision {
    const usage = parseUsage(json);
    if (typeof json !== "object" || json === null) return { routeId: null, usage };
    const answers = (json as Record<string, unknown>).answers;
    if (typeof answers !== "object" || answers === null) return { routeId: null, usage };
    const route = (answers as Record<string, unknown>).route;
    if (typeof route !== "object" || route === null) return { routeId: null, usage };
    const r = route as Record<string, unknown>;
    if (r.type !== "choice" || typeof r.choice !== "string") return { routeId: null, usage };
    const hit = options.find((o) => o.key === r.choice);
    return { routeId: hit ? hit.routeId : null, usage };
  },
};

// usage 为 responses 风格（{input_tokens, output_tokens}），与 openai parser 归一化口径一致
function parseUsage(json: unknown): { inputTokens: number; outputTokens: number } | null {
  if (typeof json !== "object" || json === null) return null;
  const usage = (json as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  if (input === 0 && output === 0) return null;
  return { inputTokens: input, outputTokens: output };
}
