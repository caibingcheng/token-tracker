// 余额/用量 provider 探测与 mode 类型定义。
// 独立成模块（无服务端依赖）：balance.ts（服务端拉取）与 Admin UI（表单跟随）共用同一套规则。

export type BalanceProvider =
  | "deepseek"
  | "openrouter"
  | "kimi"
  | "kimi-coding"
  | "glm"
  | "opencode-go"
  | "ollama-cloud";

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
  "ollama-cloud",
];

export function isBalanceFetchMode(v: unknown): v is BalanceFetchMode {
  return typeof v === "string" && (BALANCE_FETCH_MODES as string[]).includes(v);
}

// 归一化存量/外部输入的 mode 值：非法值回退 auto（按 URL/name 探测，未识别即 off）
export function normalizeBalanceFetchMode(v: unknown): BalanceFetchMode {
  return isBalanceFetchMode(v) ? v : "auto";
}

// baseUrl → 小写 hostname（去掉 DNS 尾点 `ollama.com.`）；不可解析返回 ""（回退到 name 关键字）
function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

// 精确域名或其子域：evil-ollama.com / ollama.com.evil.example 均不命中（子串包含会命中，
// 误判后自动刷新会把该 upstream 的真实 key 发给真正的官方端点）
function isHostOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

// 根据 baseUrl 的 hostname 识别内置 provider；URL 无法识别时回退到 name 关键字
//（name 是用户自定义标签，只能靠关键字；hostname 是可控标识，必须精确匹配）
export function detectBalanceProvider(baseUrl: string, name?: string): BalanceProvider | null {
  const host = hostnameOf(baseUrl);
  if (host) {
    if (isHostOrSubdomain(host, "openrouter.ai")) return "openrouter";
    if (isHostOrSubdomain(host, "deepseek.com")) return "deepseek";
    if (isHostOrSubdomain(host, "api.kimi.com")) return "kimi-coding";
    if (isHostOrSubdomain(host, "moonshot.cn") || isHostOrSubdomain(host, "moonshot.ai"))
      return "kimi";
    if (isHostOrSubdomain(host, "z.ai") || isHostOrSubdomain(host, "bigmodel.cn")) return "glm";
    if (isHostOrSubdomain(host, "opencode.ai")) return "opencode-go";
    if (isHostOrSubdomain(host, "ollama.com") || isHostOrSubdomain(host, "ollama.ai"))
      return "ollama-cloud";
  }
  if (!name) return null;
  const n = name.toLowerCase();
  // 只允许 endpoint 随 baseUrl 走的 provider 用 name 回退：deepseek / kimi / glm 的
  // 余额接口拼在 baseUrl 上，key 发往用户自己配的 host。endpoint 固定为第三方域名的
  // （ollama-cloud / openrouter / kimi-coding / opencode-go）必须靠 hostname 或手动 mode，
  // 否则本地 `http://localhost:11434` + name "Ollama" 会把本地 key 发到 ollama.com
  if (n.includes("kimi")) return "kimi";
  if (n.includes("glm") || n.includes("zhipu") || n.includes("z.ai") || n.includes("bigmodel"))
    return "glm";
  if (n.includes("deepseek")) return "deepseek";
  return null;
}
