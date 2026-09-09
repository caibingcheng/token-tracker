import { describe, it, expect } from "vitest";
import {
  isValidHeaderTransforms,
  normalizeHeaderTransforms,
  parseHeaderTransforms,
  applyHeaderTransforms,
  MAX_HEADER_TRANSFORMS,
  MAX_HEADER_TRANSFORM_VALUE_LENGTH,
} from "./header-transforms";
import type { HeaderTransform, HeaderTransformContext } from "./header-transforms";

const BASE_CONTEXT: HeaderTransformContext = {
  sessionId: "sess-abc",
  model: "gpt-4o",
  keyName: "claude-code",
  upstream: "openai-main",
};

function mkTransform(overrides: Partial<HeaderTransform> = {}): HeaderTransform {
  return {
    id: "ht-1234abcd",
    header: "x-opencode-session",
    value: "tt-${var.sessionId}",
    mode: "fill",
    enabled: true,
    ...overrides,
  };
}

describe("isValidHeaderTransforms", () => {
  it("accepts empty array", () => {
    expect(isValidHeaderTransforms([])).toBe(true);
  });

  it("accepts a valid entry", () => {
    expect(isValidHeaderTransforms([mkTransform()])).toBe(true);
  });

  it("accepts mixed-case header names (token charset)", () => {
    expect(isValidHeaderTransforms([mkTransform({ header: "X-Custom-Header" })])).toBe(true);
  });

  it("rejects non-array", () => {
    expect(isValidHeaderTransforms({})).toBe(false);
    expect(isValidHeaderTransforms("x")).toBe(false);
    expect(isValidHeaderTransforms(null)).toBe(false);
  });

  it("rejects invalid header names", () => {
    expect(isValidHeaderTransforms([mkTransform({ header: "bad header" })])).toBe(false);
    expect(isValidHeaderTransforms([mkTransform({ header: "bad:header" })])).toBe(false);
    expect(isValidHeaderTransforms([mkTransform({ header: "héader" })])).toBe(false);
    expect(isValidHeaderTransforms([mkTransform({ header: "" })])).toBe(false);
  });

  it("rejects CRLF in value (header injection)", () => {
    expect(isValidHeaderTransforms([mkTransform({ value: "a\rb" })])).toBe(false);
    expect(isValidHeaderTransforms([mkTransform({ value: "a\nb" })])).toBe(false);
    expect(isValidHeaderTransforms([mkTransform({ value: "a\r\nb" })])).toBe(false);
  });

  it("rejects over-long values", () => {
    expect(
      isValidHeaderTransforms([
        mkTransform({ value: "x".repeat(MAX_HEADER_TRANSFORM_VALUE_LENGTH + 1) }),
      ])
    ).toBe(false);
    expect(
      isValidHeaderTransforms([mkTransform({ value: "x".repeat(MAX_HEADER_TRANSFORM_VALUE_LENGTH) })])
    ).toBe(true);
  });

  it("rejects more than 20 entries", () => {
    const entries = Array.from({ length: MAX_HEADER_TRANSFORMS + 1 }, (_, i) =>
      mkTransform({ id: `ht-${i}` })
    );
    expect(isValidHeaderTransforms(entries)).toBe(false);
    expect(isValidHeaderTransforms(entries.slice(0, MAX_HEADER_TRANSFORMS))).toBe(true);
  });

  it("rejects invalid mode / enabled / id types", () => {
    expect(isValidHeaderTransforms([mkTransform({ mode: "set" as never })])).toBe(false);
    expect(isValidHeaderTransforms([mkTransform({ enabled: 1 as never })])).toBe(false);
    expect(isValidHeaderTransforms([mkTransform({ id: "" })])).toBe(false);
    expect(isValidHeaderTransforms([mkTransform({ id: 42 as never })])).toBe(false);
    expect(isValidHeaderTransforms([mkTransform({ value: 42 as never })])).toBe(false);
    expect(isValidHeaderTransforms(["x"])).toBe(false);
  });

  it("allows semantics-sensitive headers like authorization (no blacklist)", () => {
    expect(
      isValidHeaderTransforms([mkTransform({ header: "authorization", value: "Bearer x" })])
    ).toBe(true);
  });
});

describe("normalizeHeaderTransforms", () => {
  it("lowercases header names", () => {
    const out = normalizeHeaderTransforms([mkTransform({ header: "X-Custom-Header" })]);
    expect(out[0].header).toBe("x-custom-header");
  });
});

describe("parseHeaderTransforms", () => {
  it("parses valid JSON", () => {
    const raw = JSON.stringify([mkTransform()]);
    expect(parseHeaderTransforms(raw)).toHaveLength(1);
  });

  it("falls back to [] on invalid JSON", () => {
    expect(parseHeaderTransforms("{oops")).toEqual([]);
  });

  it("falls back to [] on schema-invalid content", () => {
    expect(parseHeaderTransforms(JSON.stringify([{ header: "bad header" }]))).toEqual([]);
  });

  it("returns [] for null/empty", () => {
    expect(parseHeaderTransforms(null)).toEqual([]);
    expect(parseHeaderTransforms("")).toEqual([]);
    expect(parseHeaderTransforms(undefined)).toEqual([]);
  });
});

describe("applyHeaderTransforms", () => {
  it("fills a missing header (fill mode)", () => {
    const headers = new Headers();
    applyHeaderTransforms(headers, [mkTransform()], BASE_CONTEXT);
    expect(headers.get("x-opencode-session")).toBe("tt-sess-abc");
  });

  it("keeps client value in fill mode", () => {
    const headers = new Headers({ "x-opencode-session": "client-value" });
    applyHeaderTransforms(headers, [mkTransform()], BASE_CONTEXT);
    expect(headers.get("x-opencode-session")).toBe("client-value");
  });

  it("overrides client value in override mode", () => {
    const headers = new Headers({ "x-opencode-session": "client-value" });
    applyHeaderTransforms(headers, [mkTransform({ mode: "override" })], BASE_CONTEXT);
    expect(headers.get("x-opencode-session")).toBe("tt-sess-abc");
  });

  it("header name matching is case-insensitive", () => {
    const headers = new Headers({ "X-Opencode-Session": "client-value" });
    applyHeaderTransforms(headers, [mkTransform()], BASE_CONTEXT);
    expect(headers.get("x-opencode-session")).toBe("client-value");
    applyHeaderTransforms(headers, [mkTransform({ mode: "override" })], BASE_CONTEXT);
    expect(headers.get("x-opencode-session")).toBe("tt-sess-abc");
  });

  it("skips disabled entries", () => {
    const headers = new Headers();
    applyHeaderTransforms(headers, [mkTransform({ enabled: false })], BASE_CONTEXT);
    expect(headers.get("x-opencode-session")).toBeNull();
  });

  it("later same-name entry wins (Headers.set semantics)", () => {
    const headers = new Headers();
    applyHeaderTransforms(
      headers,
      [
        mkTransform({ id: "ht-a", value: "first" }),
        mkTransform({ id: "ht-b", value: "second" }),
      ],
      BASE_CONTEXT
    );
    expect(headers.get("x-opencode-session")).toBe("second");
  });

  it("expands all template variables", () => {
    const headers = new Headers();
    applyHeaderTransforms(
      headers,
      [
        mkTransform({
          header: "x-info",
          value: "${var.model}|${var.keyName}|${var.upstream}|${var.sessionId}",
        }),
      ],
      BASE_CONTEXT
    );
    expect(headers.get("x-info")).toBe("gpt-4o|claude-code|openai-main|sess-abc");
  });

  it("leaves unknown variables as literal text", () => {
    const headers = new Headers();
    applyHeaderTransforms(
      headers,
      [mkTransform({ value: "tt-${var.unknownVar}" })],
      BASE_CONTEXT
    );
    expect(headers.get("x-opencode-session")).toBe("tt-${var.unknownVar}");
  });

  it("computes sessionId lazily (not referenced → not called)", () => {
    let called = 0;
    const context: HeaderTransformContext = {
      ...BASE_CONTEXT,
      sessionId: () => {
        called += 1;
        return "computed";
      },
    };
    const headers = new Headers();
    applyHeaderTransforms(
      headers,
      [mkTransform({ value: "v-${var.model}" })],
      context
    );
    expect(called).toBe(0);
    // 全新 Headers（无同名 header，fill 生效），引用 sessionId → 触发懒计算
    const headers2 = new Headers();
    applyHeaderTransforms(headers2, [mkTransform({ value: "v-${var.sessionId}" })], context);
    expect(called).toBe(1);
    expect(headers2.get("x-opencode-session")).toBe("v-computed");
  });

  it("resolves a string sessionId directly", () => {
    const headers = new Headers();
    applyHeaderTransforms(headers, [mkTransform()], BASE_CONTEXT);
    expect(headers.get("x-opencode-session")).toBe("tt-sess-abc");
  });

  it("is a no-op without transforms", () => {
    const headers = new Headers({ "x-a": "1" });
    applyHeaderTransforms(headers, undefined, BASE_CONTEXT);
    applyHeaderTransforms(headers, [], BASE_CONTEXT);
    expect(headers.get("x-a")).toBe("1");
  });
});
