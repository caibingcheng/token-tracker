import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import {
  readJsonBodyLimited,
  readBodyLimited,
  BodyTooLargeError,
  InvalidJsonBodyError,
  MAX_AUTH_BODY_BYTES,
} from "./request-body";

function post(body: BodyInit | null, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers,
    body,
    // ReadableStream body 需要 half duplex
    ...(body && typeof body === "object" && "getReader" in body
      ? ({ duplex: "half" } as RequestInit)
      : {}),
  } as RequestInit);
}

function chunkedBody(
  totalBytes: number,
  chunkSize = 8 * 1024,
  filler = 0x20
): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(filler));
    },
  });
}

function encodeJsonStream(payload: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(payload);
  let offset = 0;
  const chunkSize = 64;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

describe("readJsonBodyLimited", () => {
  it("parses a normal JSON body", async () => {
    const parsed = await readJsonBodyLimited(post(JSON.stringify({ apiKey: "k" })));
    expect(parsed).toEqual({ apiKey: "k" });
  });

  it("rejects a declared content-length above the 64KB cap without reading", async () => {
    const req = post(JSON.stringify({ apiKey: "k" }), {
      "content-length": String(MAX_AUTH_BODY_BYTES + 1),
    });
    await expect(readJsonBodyLimited(req)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("rejects a chunked body that grows past the cap (no content-length)", async () => {
    const req = post(chunkedBody(MAX_AUTH_BODY_BYTES + 1));
    expect(req.headers.get("content-length")).toBeNull();
    await expect(readJsonBodyLimited(req)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("accepts a chunked body just under the cap", async () => {
    const payload = JSON.stringify({ apiKey: "x".repeat(1000) });
    const req = post(encodeJsonStream(payload));
    const parsed = await readJsonBodyLimited(req);
    expect(typeof parsed.apiKey).toBe("string");
  });

  it("rejects malformed JSON and empty bodies", async () => {
    await expect(readJsonBodyLimited(post("{not json"))).rejects.toBeInstanceOf(
      InvalidJsonBodyError
    );
    await expect(readJsonBodyLimited(post(null))).rejects.toBeInstanceOf(
      InvalidJsonBodyError
    );
  });

  it("normalises non-object JSON to an empty object", async () => {
    expect(await readJsonBodyLimited(post('"scalar"'))).toEqual({});
    expect(await readJsonBodyLimited(post("[1,2]"))).toEqual({});
    expect(await readJsonBodyLimited(post("null"))).toEqual({});
  });

  it("respects a custom limit", async () => {
    const req = post(JSON.stringify({ a: "0123456789" }));
    await expect(readJsonBodyLimited(req, 5)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("readBodyLimited（非 JSON 端点复用）", () => {
  it("reads a normal body as text", async () => {
    expect(await readBodyLimited(post("hello"), 1024)).toBe("hello");
    expect(await readBodyLimited(post(null), 1024)).toBe("");
  });

  it("rejects a declared content-length above the limit without reading the body", async () => {
    const req = post(chunkedBody(4096), { "content-length": "4096" });
    await expect(readBodyLimited(req, 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    // 声明已超限：body 未被消费（request.bodyUsed 仍为 false）
    expect(req.bodyUsed).toBe(false);
  });

  it("aborts a chunked body that grows past the limit", async () => {
    const req = post(chunkedBody(8 * 1024));
    expect(req.headers.get("content-length")).toBeNull();
    await expect(readBodyLimited(req, 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
