// 余额/用量 provider 探测与 mode 类型定义。
// 独立成模块（无服务端依赖）：balance.ts（服务端拉取）与 Admin UI（表单跟随）共用同一套规则。

export type BalanceProvider =
  | "deepseek"
  | "openrouter"
  | "kimi"
  | "kimi-coding"
  | "glm"
  | "opencode-go";

// auto = 按 baseUrl/name 探测（无识别规则 = off）；none = 不自动获取
export type BalanceFetchMode = BalanceProvider | "auto" | "none";

export const BALANCE_FETCH_MODES: BalanceFetchMode[] = [
  "auto",
  "none",
  "deepseek",
  "openrouter",
  "kimi",
  "kimi-coding",
  "glm",
  "opencode-go",
];

export function isBalanceFetchMode(v: unknown): v is BalanceFetchMode {
  return typeof v === "string" && (BALANCE_FETCH_MODES as string[]).includes(v);
}

// 归一化存量/外部输入的 mode 值：非法值回退 auto（按 URL/name 探测，未识别即 off）
export function normalizeBalanceFetchMode(v: unknown): BalanceFetchMode {
  return isBalanceFetchMode(v) ? v : "auto";
}

// 根据 baseUrl 识别内置 provider；URL 无法识别时回退到 name 关键字
export function detectBalanceProvider(baseUrl: string, name?: string): BalanceProvider | null {
  const url = baseUrl.toLowerCase();
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("deepseek.com") || url.includes("deepseek")) return "deepseek";
  if (url.includes("api.kimi.com")) return "kimi-coding";
  if (url.includes("moonshot")) return "kimi";
  if (url.includes("z.ai") || url.includes("bigmodel.cn")) return "glm";
  if (url.includes("opencode.ai")) return "opencode-go";
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes("opencode")) return "opencode-go";
  if (n.includes("kimi")) return /cod/.test(n) ? "kimi-coding" : "kimi";
  if (n.includes("glm") || n.includes("zhipu") || n.includes("z.ai") || n.includes("bigmodel"))
    return "glm";
  if (n.includes("deepseek")) return "deepseek";
  if (n.includes("openrouter")) return "openrouter";
  return null;
}
