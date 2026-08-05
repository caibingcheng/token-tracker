import { describe, it, expect } from "vitest";
import { joinUrlPath } from "./url-utils";

describe("joinUrlPath", () => {
  it("joins root base with full path", () => {
    expect(joinUrlPath("https://api.deepseek.com", "/v1/chat/completions")).toBe(
      "https://api.deepseek.com/v1/chat/completions"
    );
  });

  it("dedupes /v1 suffix in base with /v1 prefix in path", () => {
    expect(joinUrlPath("https://api.deepseek.com/v1", "/v1/chat/completions")).toBe(
      "https://api.deepseek.com/v1/chat/completions"
    );
    expect(joinUrlPath("https://api.deepseek.com/v1/", "/v1/messages")).toBe(
      "https://api.deepseek.com/v1/messages"
    );
  });

  it("dedupes /v1beta suffix in base with /v1beta prefix in path", () => {
    expect(
      joinUrlPath("https://generativelanguage.googleapis.com/v1beta", "/v1beta/models/gemini-x:generateContent")
    ).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
  });

  it("keeps /v1 prefix when base does not end with it", () => {
    expect(joinUrlPath("https://api.anthropic.com", "/v1/messages")).toBe(
      "https://api.anthropic.com/v1/messages"
    );
  });

  it("does not dedupe partial prefix matches", () => {
    // base 以 /v1 结尾但 path 不是 /v1 开头：正常拼接
    expect(joinUrlPath("https://example.com/v1", "/chat/completions")).toBe(
      "https://example.com/v1/chat/completions"
    );
    // /v1beta 不能被 /v1 规则误伤
    expect(joinUrlPath("https://example.com/v1beta", "/v1beta/models/x")).toBe(
      "https://example.com/v1beta/models/x"
    );
  });

  it("normalizes trailing slash on base", () => {
    expect(joinUrlPath("https://api.deepseek.com/v1/", "/v1/chat/completions")).toBe(
      "https://api.deepseek.com/v1/chat/completions"
    );
    expect(joinUrlPath("https://api.deepseek.com/", "/v1/chat/completions")).toBe(
      "https://api.deepseek.com/v1/chat/completions"
    );
  });

  it("handles path without leading slash", () => {
    expect(joinUrlPath("https://api.deepseek.com", "v1/chat/completions")).toBe(
      "https://api.deepseek.com/v1/chat/completions"
    );
  });
});
