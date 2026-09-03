// Agent 维度派生工具：Dashboard 的 Agent 维度还原为客户端工具名（claude-code、
// opencode 等），从 token_records.user_agent 列经映射表（内置自动映射 + settings
// 手动映射 agent_aliases）查询时派生。agent 列保持现状（来源 key 名）不动。

export interface AgentAliasRule {
  name: string;
  aliases: string[];
}

export const UNKNOWN_AGENT = "unknown";

// UA 首段 token（第一个 / 前的内容），lowercase；空 UA → 空串
export function extractUaToken(ua: string): string {
  const trimmed = ua.trim();
  if (!trimmed) return "";
  const token = trimmed.split("/")[0]!;
  return token.trim().toLowerCase();
}

// 内置已知工具映射（UA token → 展示名）；未命中 → token 本身
export const BUILTIN_AGENT_MAP: Record<string, string> = {
  "claude-cli": "claude-code",
  opencode: "opencode",
  codex_cli_rs: "codex",
  codex: "codex",
  geminicli: "gemini-cli",
  aider: "aider",
  "cursor-agent": "cursor",
};

// 解析规则优先级：null/空 → "unknown" → 手动 aliases（UA token 精确匹配，大小写不敏感）
// → 内置 map → UA token 本身
export function resolveAgentName(
  userAgent: string | null,
  aliases: AgentAliasRule[] = []
): string {
  if (!userAgent) return UNKNOWN_AGENT;
  const token = extractUaToken(userAgent);
  if (!token) return UNKNOWN_AGENT;
  const rules = Array.isArray(aliases) ? aliases : [];
  for (const rule of rules) {
    if (
      rule.name &&
      rule.aliases.some((a) => a.trim().toLowerCase() === token)
    ) {
      return rule.name;
    }
  }
  return BUILTIN_AGENT_MAP[token] ?? token;
}

export type AgentUaFilter = { uas: string[] } | { unknown: true } | null;

// 反找：agent 名 → 命中该 agent 的 UA 集合。
// "unknown" → { unknown: true }（调用方生成 isNull(user_agent) 条件）；
// 其他 → { uas: [...] }；无匹配 → null（调用方 400 或按无结果处理）。
export function resolveAgentUserAgents(
  agentName: string,
  allUas: Array<string | null>,
  aliases: AgentAliasRule[] = []
): { uas: string[] } | { unknown: true } | null {
  const rules = Array.isArray(aliases) ? aliases : [];
  if (agentName === UNKNOWN_AGENT) {
    const hasUnknown = allUas.some(
      (ua) => resolveAgentName(ua, rules) === UNKNOWN_AGENT
    );
    return hasUnknown ? { unknown: true } : null;
  }
  const matched: string[] = [];
  for (const ua of allUas) {
    if (!ua) continue;
    if (resolveAgentName(ua, rules) === agentName) {
      matched.push(ua);
    }
  }
  return matched.length > 0 ? { uas: matched } : null;
}