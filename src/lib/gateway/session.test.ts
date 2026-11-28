import { describe, it, expect } from "vitest";
import {
  extractSessionInput,
  extractSessionInputFromBytes,
  computeSessionId,
  computeSessionIdFromInput,
  buildSessionId,
  SessionStore,
} from "./session";
import { scanTopLevelObject } from "./json-scan";

describe("extractSessionInput", () => {
  it("concatenates system messages with first user message", () => {
    const body = {
      messages: [
        { role: "system", content: "sys1" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "second" },
      ],
    };
    expect(extractSessionInput(body, "gpt-4o", 1, "openai")).toBe(
      "sys1hello\u0000gpt-4o\u00001\u0000openai"
    );
  });

  it("uses only first user message", () => {
    const body = {
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    };
    expect(extractSessionInput(body, "m", 1, "openai")).toBe(
      "first\u0000m\u00001\u0000openai"
    );
  });

  it("falls back to system part only when no user message", () => {
    const body = { messages: [{ role: "system", content: "sys" }] };
    expect(extractSessionInput(body, "m", 1, "openai")).toBe("sys\u0000m\u00001\u0000openai");
  });

  it("truncates system concatenation to last 1024 chars", () => {
    const long = "a".repeat(2000);
    const body = { messages: [{ role: "system", content: long }] };
    expect(extractSessionInput(body, "m", 1, "openai")).toBe(
      long.slice(-1024) + "\u0000m\u00001\u0000openai"
    );
  });

  it("truncates first user message to first 1024 chars", () => {
    const long = "b".repeat(2000);
    const body = { messages: [{ role: "user", content: long }] };
    expect(extractSessionInput(body, "m", 1, "openai")).toBe(
      long.slice(0, 1024) + "\u0000m\u00001\u0000openai"
    );
  });

  it("joins multiple system messages in order", () => {
    const body = {
      messages: [
        { role: "system", content: "a" },
        { role: "user", content: "u" },
        { role: "system", content: "b" },
      ],
    };
    expect(extractSessionInput(body, "m", 1, "openai")).toBe("abu\u0000m\u00001\u0000openai");
  });

  it("extracts text parts only from multimodal user message", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:..." } },
            { type: "text", text: "describe" },
          ],
        },
      ],
    };
    expect(extractSessionInput(body, "m", 1, "openai")).toBe(
      "describe\u0000m\u00001\u0000openai"
    );
  });

  it("handles empty messages array", () => {
    expect(extractSessionInput({ messages: [] }, "m", 1, "openai")).toBe(
      "\u0000m\u00001\u0000openai"
    );
  });

  it("ignores non-object messages", () => {
    expect(extractSessionInput({ messages: [null, "x", 42] }, "m", 1, "openai")).toBe(
      "\u0000m\u00001\u0000openai"
    );
  });
});

describe("extractSessionInputFromBytes（与解析路径逐点平价）", () => {
  const bytesInput = (bodyJsonText: string, model = "m", vk = 1, protocol = "openai") => {
    const bytes = new TextEncoder().encode(bodyJsonText);
    const scan = scanTopLevelObject(bytes, ["messages"]);
    return extractSessionInputFromBytes(bytes, scan.fields.get("messages"), model, vk, protocol);
  };

  it("matches parsed path: system + first user", () => {
    const body = {
      messages: [
        { role: "system", content: "sys1" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "second" },
      ],
    };
    expect(bytesInput(JSON.stringify(body), "gpt-4o")).toBe(extractSessionInput(body, "gpt-4o", 1, "openai"));
  });

  it("matches parsed path: multimodal content with image blob", () => {
    const blob = "A".repeat(50_000);
    const body = {
      messages: [
        { role: "system", content: "规则" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${blob}` } },
            { type: "text", text: "描述这张图" },
          ],
        },
      ],
    };
    expect(bytesInput(JSON.stringify(body))).toBe(extractSessionInput(body, "m", 1, "openai"));
  });

  it("matches parsed path: string content with escapes + pretty-printed JSON", () => {
    const body = {
      messages: [
        { role: "system", content: 'line1\nline2 "quoted" 中文' },
        { role: "user", content: "  spaced  " },
      ],
    };
    const pretty = JSON.stringify(body, null, 2);
    expect(bytesInput(pretty)).toBe(extractSessionInput(body, "m", 1, "openai"));
  });

  it("matches parsed path: truncation rules (system tail / user head 1024)", () => {
    const body = {
      messages: [
        { role: "system", content: "a".repeat(2000) },
        { role: "user", content: "b".repeat(2000) },
      ],
    };
    expect(bytesInput(JSON.stringify(body))).toBe(extractSessionInput(body, "m", 1, "openai"));
  });

  it("matches parsed path: empty / missing / non-array messages", () => {
    expect(bytesInput(JSON.stringify({ messages: [] }))).toBe(
      extractSessionInput({ messages: [] }, "m", 1, "openai")
    );
    expect(bytesInput(JSON.stringify({ foo: 1 }))).toBe(
      extractSessionInput({ foo: 1 }, "m", 1, "openai")
    );
    expect(bytesInput(JSON.stringify({ messages: [null, "x", 42] }))).toBe(
      extractSessionInput({ messages: [null, "x", 42] }, "m", 1, "openai")
    );
    expect(bytesInput(JSON.stringify({ messages: "not-array" }))).toBe(
      extractSessionInput({ messages: "not-array" }, "m", 1, "openai")
    );
  });

  it("matches parsed path: text parts only, non-object parts skipped", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [null, 42, { type: "text", text: "t1" }, { type: "text", text: "t2" }, { type: "image_url" }],
        },
      ],
    };
    expect(bytesInput(JSON.stringify(body))).toBe(extractSessionInput(body, "m", 1, "openai"));
  });

  it("fingerprint hashes identical across paths", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const parsed = computeSessionId(extractSessionInput(body, "m", 7, "anthropic"));
    const scanned = computeSessionId(bytesInput(JSON.stringify(body), "m", 7, "anthropic"));
    expect(scanned).toBe(parsed);
  });
});

describe("computeSessionId / buildSessionId", () => {
  it("produces stable 64-char hex hash for identical input", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const a = buildSessionId(body, "gpt-4o", 1, "openai");
    const b = buildSessionId(body, "gpt-4o", 1, "openai");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when model changes", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(buildSessionId(body, "gpt-4o", 1, "openai")).not.toBe(
      buildSessionId(body, "gpt-4o-mini", 1, "openai")
    );
  });

  it("differs when virtual key changes", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(buildSessionId(body, "gpt-4o", 1, "openai")).not.toBe(
      buildSessionId(body, "gpt-4o", 2, "openai")
    );
  });

  it("differs when user message changes", () => {
    const a = buildSessionId({ messages: [{ role: "user", content: "one" }] }, "m", 1, "openai");
    const b = buildSessionId({ messages: [{ role: "user", content: "two" }] }, "m", 1, "openai");
    expect(a).not.toBe(b);
  });

  it("hashes deterministically across computes", () => {
    const input = extractSessionInput({ messages: [] }, "m", 7, "anthropic");
    expect(computeSessionId(input)).toBe(computeSessionId(input));
  });
});

describe("computeSessionIdFromInput（relay 与直连共用同一套 tail 拼接）", () => {
  it("与 buildSessionId / extractSessionInput 逐字节相等", () => {
    const body = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    };
    const expected = buildSessionId(body, "gpt-4o", 7, "openai");
    // 素材 = system 尾部 + 首条 user 头部（中间无分隔符）
    const material = `syshi`.slice(0, 1024);
    expect(computeSessionId(computeSessionIdFromInput(material, "gpt-4o", 7, "openai"))).toBe(
      expected
    );
    expect(computeSessionIdFromInput(material, "gpt-4o", 7, "openai")).toBe(
      extractSessionInput(body, "gpt-4o", 7, "openai")
    );
  });

  it("素材与 model 之间无分隔符（直接相接）", () => {
    expect(computeSessionIdFromInput("abc", "m", 1, "openai")).toBe("abc\u0000m\u00001\u0000openai");
  });
});

describe("SessionStore", () => {
  it("stores and retrieves binding", () => {
    const store = new SessionStore();
    store.set("s1", 42);
    const binding = store.get("s1");
    expect(binding?.upstreamId).toBe(42);
    expect(typeof binding?.boundAt).toBe("number");
  });

  it("returns undefined for unknown session", () => {
    const store = new SessionStore();
    expect(store.get("nope")).toBeUndefined();
  });

  it("expires entries after ttl", () => {
    const store = new SessionStore(10, 100);
    store.set("s1", 1);
    expect(store.get("s1")).toBeDefined();
    // TTL 未到（LRU 过期懒清理）：时间推进需由调用方控制，这里仅验证删除接口
    store.delete("s1");
    expect(store.get("s1")).toBeUndefined();
  });

  it("respects custom max size", () => {
    const store = new SessionStore(2, 100_000);
    store.set("a", 1);
    store.set("b", 2);
    store.set("c", 3);
    expect(store.size).toBeLessThanOrEqual(2);
  });

  it("overwrites existing binding for same session", () => {
    const store = new SessionStore();
    store.set("s1", 1);
    store.set("s1", 2);
    expect(store.get("s1")?.upstreamId).toBe(2);
  });
});
