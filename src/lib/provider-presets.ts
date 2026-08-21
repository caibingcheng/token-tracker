export interface ProviderPreset {
  name: string;
  protocol: string;
  baseUrl: string;
}

// 内置 provider 预设：新建 upstream 时可选，选中自动填充 protocol + baseUrl
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { name: "openai", protocol: "openai", baseUrl: "https://api.openai.com/v1" },
  { name: "anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { name: "gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  { name: "deepseek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { name: "moonshot", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1" },
  { name: "openrouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "dashscope", protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { name: "kimi for coding", protocol: "openai", baseUrl: "https://api.kimi.com/coding/v1" },
  { name: "bigmodel", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { name: "siliconflow", protocol: "openai", baseUrl: "https://api.siliconflow.cn/v1" },
  { name: "bailian", protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { name: "opencode", protocol: "openai", baseUrl: "https://opencode.ai/zen/v1" },
  { name: "opencode go", protocol: "openai", baseUrl: "https://opencode.ai/zen/go/v1" },
];
