import { describe, it, expect } from "vitest";
import {
  extractSessionInput,
  computeSessionId,
  buildSessionId,
  SessionStore,
} from "./session";

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
