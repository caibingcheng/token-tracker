import { joinUrlPath } from "./url-utils";

export type BalanceProvider = "deepseek" | "openrouter";

export interface BalanceResult {
  balance: string;
  currency: string;
}

// 根据 baseUrl 识别内置余额 provider（deepseek / openrouter）
export function detectBalanceProvider(baseUrl: string): BalanceProvider | null {
  const url = baseUrl.toLowerCase();
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("deepseek.com") || url.includes("deepseek")) return "deepseek";
  return null;
}

// 拉取余额；不支持的 provider 抛错由调用方处理
export async function fetchBalance(
  baseUrl: string,
  apiKey: string
): Promise<BalanceResult> {
  const provider = detectBalanceProvider(baseUrl);
  if (!provider) {
    throw new Error("Balance auto-fetch not supported for this upstream");
  }

  if (provider === "deepseek") {
    const res = await fetch(joinUrlPath(baseUrl, "/user/balance"), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`DeepSeek balance API returned ${res.status}`);
    }
    const json = (await res.json()) as { balance_infos?: Array<{ total_balance?: string | number; currency?: string }> };
    const infos = json.balance_infos;
    if (!Array.isArray(infos) || infos.length === 0) {
      throw new Error("Unexpected DeepSeek balance response");
    }
    const total = infos.reduce((acc, b) => acc + (Number(b.total_balance) || 0), 0);
    return { balance: String(total), currency: infos[0]?.currency || "CNY" };
  }

  // openrouter
  const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter auth/key API returned ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: { usage?: string | number; limit?: string | number | null };
  };
  const data = json.data;
  if (!data) {
    throw new Error("Unexpected OpenRouter auth/key response");
  }
  const usage = Number(data.usage) || 0;
  const limit = data.limit;
  const remaining =
    typeof limit === "number" && !Number.isNaN(limit)
      ? Math.max(0, limit - usage)
      : "unknown";
  return { balance: String(remaining), currency: "USD" };
}
