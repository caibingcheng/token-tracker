import { describe, expect, it } from "vitest";
import { estimateInputTokens, estimateOutputTokens, estimateTokens } from "./estimate";

describe("estimateTokens", () => {
  it("empty string is 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("ascii chars / 4 rounded up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("hello world")).toBe(3); // 11 chars → ceil(11/4)
  });

  it("non-ascii chars count 1 each", () => {
    expect(estimateTokens("你好世界")).toBe(4);
  });

  it("mixed text sums both parts", () => {
    expect(estimateTokens("ab你好")).toBe(1 + 2); // ceil(2/4)=1 + 2
  });
});

describe("estimateInputTokens", () => {
  it("openai messages are estimated from JSON", () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hello world" }] };
    expect(estimateInputTokens(body, "openai")).toBeGreaterThan(0);
  });

  it("gemini contents are used for gemini protocol", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hello world" }] }] };
    expect(estimateInputTokens(body, "gemini")).toBeGreaterThan(0);
  });

  it("returns 0 without messages/contents", () => {
    expect(estimateInputTokens({ model: "x" }, "openai")).toBe(0);
    expect(estimateInputTokens(null, "openai")).toBe(0);
    expect(estimateInputTokens("not-object", "openai")).toBe(0);
  });
});

describe("estimateOutputTokens", () => {
  it("openai choices message content (string and parts)", () => {
    const r1 = JSON.stringify({ choices: [{ message: { content: "hello world" } }] });
    expect(estimateOutputTokens(r1, "openai")).toBe(3);
    const r2 = JSON.stringify({
      choices: [{ message: { content: [{ type: "text", text: "你好" }] } }],
    });
    expect(estimateOutputTokens(r2, "openai")).toBe(2);
  });

  it("openai legacy text field", () => {
    const r = JSON.stringify({ choices: [{ text: "abcd" }] });
    expect(estimateOutputTokens(r, "openai")).toBe(1);
  });

  it("anthropic content blocks", () => {
    const r = JSON.stringify({ content: [{ type: "text", text: "hi there" }] });
    expect(estimateOutputTokens(r, "anthropic")).toBe(2);
  });

  it("gemini candidates parts", () => {
    const r = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "hello" }, { text: "世界" }] } }],
    });
    expect(estimateOutputTokens(r, "gemini")).toBe(2 + 2); // ceil(5/4)=2 + 2
  });

  it("invalid JSON or no content is 0", () => {
    expect(estimateOutputTokens("not json", "openai")).toBe(0);
    expect(estimateOutputTokens("{}", "openai")).toBe(0);
  });

  it("non-object root returns 0 without throwing", () => {
    expect(estimateOutputTokens("null", "openai")).toBe(0);
    expect(estimateOutputTokens("null", "anthropic")).toBe(0);
    expect(estimateOutputTokens("null", "gemini")).toBe(0);
    expect(estimateOutputTokens("42", "openai")).toBe(0);
    expect(estimateOutputTokens('"text"', "openai")).toBe(0);
    expect(estimateOutputTokens("[]", "openai")).toBe(0);
  });

  it("responses API output items are estimated", () => {
    const r = JSON.stringify({
      object: "response",
      output: [
        { type: "message", content: [{ type: "output_text", text: "hello" }] },
        { type: "message", content: [{ type: "output_text", text: "世界" }] },
      ],
    });
    expect(estimateOutputTokens(r, "openai")).toBe(2 + 2);
  });
});

describe("estimateInputTokens - responses API input", () => {
  it("uses body.input for responses-style requests", () => {
    const body = { model: "gpt-5", input: "hello world" };
    expect(estimateInputTokens(body, "openai")).toBe(3);
  });

  it("sums messages and input when both present", () => {
    const body = { messages: [{ role: "user", content: "abcd" }], input: "efgh" };
    expect(estimateInputTokens(body, "openai")).toBeGreaterThan(0);
  });

  it("array root body returns 0", () => {
    expect(estimateInputTokens([{ role: "user" }], "openai")).toBe(0);
  });
});
