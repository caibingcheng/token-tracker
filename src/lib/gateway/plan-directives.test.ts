// resolveBodyDirectives：relay 侧 body 改写的唯一决策点（中心下发，relay 只应用）。
import { describe, expect, it } from "vitest";
import { resolveBodyDirectives } from "./plan";

describe("resolveBodyDirectives", () => {
  it("只有 openai chat completions 流式才注入 include_usage", () => {
    expect(resolveBodyDirectives("/v1/chat/completions", true)).toEqual({
      injectIncludeUsage: true,
    });
    // 带 query 不影响判定（path 含已剥 key 的 query）
    expect(resolveBodyDirectives("/v1/chat/completions?alt=sse", true)).toEqual({
      injectIncludeUsage: true,
    });
  });

  it("非流式 / 其他端点 / 未知 stream 一律不注入", () => {
    expect(resolveBodyDirectives("/v1/chat/completions", false).injectIncludeUsage).toBe(false);
    expect(resolveBodyDirectives("/v1/chat/completions", undefined).injectIncludeUsage).toBe(false);
    expect(resolveBodyDirectives("/v1/messages", true).injectIncludeUsage).toBe(false);
    expect(resolveBodyDirectives("/v1/responses", true).injectIncludeUsage).toBe(false);
    expect(resolveBodyDirectives("/raw/api/chat", true).injectIncludeUsage).toBe(false);
  });
});
