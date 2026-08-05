export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  // 响应中是否包含可用的 usage 信息；false → 记 0 且 status=no_usage
  hasUsage: boolean;
}

export type { Protocol } from "../model-router";
