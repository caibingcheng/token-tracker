import { describe, expect, it } from "vitest";
import {
  concatBytes,
  decodeJsonString,
  firstNonWs,
  forEachMember,
  parseJsonSpan,
  scanTopLevelObject,
  scanString,
  skipValue,
  spliceBytes,
} from "./json-scan";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("scanTopLevelObject", () => {
  it("collects watched spans and validates structure", () => {
    const bytes = enc('{"model":"gpt-4o","stream":true,"messages":[{"role":"user"}]}');
    const scan = scanTopLevelObject(bytes, ["model", "stream"]);
    expect(scan.valid).toBe(true);
    expect(scan.isObject).toBe(true);
    expect(scan.memberCount).toBe(3);
    const model = scan.fields.get("model");
    expect(model).toBeDefined();
    expect(dec(bytes.subarray(model!.start, model!.end))).toBe('"gpt-4o"');
    const stream = scan.fields.get("stream");
    expect(dec(bytes.subarray(stream!.start, stream!.end))).toBe("true");
    expect(scan.fields.has("messages")).toBe(false); // 未 watched 不物化
    expect(bytes[scan.rootClose]).toBe(125);
  });

  it("skips nested containers and strings with escapes", () => {
    const bytes = enc(
      '{"a":{"b":[1,"x\\"y",[{"z":"deep"}]]},"model":"m\\u0041","tail":"end"}'
    );
    const scan = scanTopLevelObject(bytes, ["model"]);
    expect(scan.valid).toBe(true);
    const model = scan.fields.get("model");
    expect(decodeJsonString(bytes, model!)).toBe("mA");
    expect(scan.memberCount).toBe(3);
  });

  it("treats base64-like blob as one skippable string", () => {
    const blob = "A".repeat(100_000);
    const bytes = enc(`{"messages":[{"content":"${blob}"}],"model":"gpt"}`);
    const scan = scanTopLevelObject(bytes, ["model", "messages"]);
    expect(scan.valid).toBe(true);
    expect(decodeJsonString(bytes, scan.fields.get("model")!)).toBe("gpt");
    const messages = scan.fields.get("messages")!;
    expect(messages.end - messages.start).toBeGreaterThan(100_000);
  });

  it("rejects truncated / unclosed structure", () => {
    expect(scanTopLevelObject(enc('{"model":"a"'), ["model"]).valid).toBe(false);
    expect(scanTopLevelObject(enc('{"model":"a'), ["model"]).valid).toBe(false);
    expect(scanTopLevelObject(enc('{"model":}'), ["model"]).valid).toBe(false);
    expect(scanTopLevelObject(enc('{"model":"a",}'), ["model"]).valid).toBe(false);
    expect(scanTopLevelObject(enc('{"model":"a"} trailing'), ["model"]).valid).toBe(false);
  });

  it("root non-object: valid array/scalar flags isObject=false", () => {
    const arr = scanTopLevelObject(enc('[1,2,3]'), ["model"]);
    expect(arr.valid).toBe(true);
    expect(arr.isObject).toBe(false);
    expect(arr.rootClose).toBe(-1);
    expect(scanTopLevelObject(enc('{"model"'), ["model"]).valid).toBe(false);
  });

  it("empty object", () => {
    const scan = scanTopLevelObject(enc(" {} "), ["model"]);
    expect(scan.valid).toBe(true);
    expect(scan.memberCount).toBe(0);
    expect(scan.fields.size).toBe(0);
    expect(scan.rootClose).toBe(2);
  });

  it("skips escaped quote runs inside strings (even/odd backslash)", () => {
    // \"  → 引号被转义，不是结尾；\\" → 结尾
    const bytes = enc('{"a":"x\\\\\\"y","model":"m"}');
    const scan = scanTopLevelObject(bytes, ["model"]);
    expect(scan.valid).toBe(true);
    expect(decodeJsonString(bytes, scan.fields.get("model")!)).toBe("m");
  });
});

describe("scanString / skipValue", () => {
  it("returns -1 on unclosed string", () => {
    expect(scanString(enc('"abc'), 0)).toBe(-1);
  });
  it("skips mixed nesting", () => {
    const b = enc('[[{"a":[1,2]}],3]');
    expect(skipValue(b, 0)).toBe(b.length);
  });
  it("rejects empty position", () => {
    expect(skipValue(enc(""), 0)).toBe(-1);
  });
});

describe("forEachMember", () => {
  it("iterates members with spans and allows early abort", () => {
    const b = enc('{"role":"user","content":"hi","name":"n"}');
    const seen: string[] = [];
    const res = forEachMember(b, 0, (key) => {
      seen.push(key);
      return key !== "role"; // role 之后中止
    });
    expect(res).toBeNull();
    expect(seen).toEqual(["role"]);
  });
  it("returns close index and member count", () => {
    const b = enc('{"a":1,"b":2}');
    const res = forEachMember(b, 0, () => true);
    expect(res?.memberCount).toBe(2);
    expect(res?.closeIdx).toBe(b.length - 1);
  });
});

describe("span helpers", () => {
  it("firstNonWs skips leading whitespace", () => {
    const b = enc('  [1]  ');
    const span = { start: 0, end: 5 };
    expect(firstNonWs(b, span)).toBe(2);
    expect(firstNonWs(b, { start: 5, end: 7 })).toBe(-1);
  });
  it("decodeJsonString returns null for non-string values", () => {
    const b = enc('{"n":42}');
    const scan = scanTopLevelObject(b, ["n"]);
    expect(decodeJsonString(b, scan.fields.get("n")!)).toBeNull();
    expect(parseJsonSpan(b, scan.fields.get("n")!)).toBe(42);
  });
  it("parseJsonSpan returns undefined on garbage", () => {
    expect(parseJsonSpan(enc("nope"), { start: 0, end: 4 })).toBeUndefined();
  });
});

describe("concatBytes / spliceBytes", () => {
  it("concatenates parts", () => {
    const out = concatBytes([enc("ab"), enc("cd"), new Uint8Array(0)]);
    expect(dec(out)).toBe("abcd");
  });
  it("splices a range", () => {
    const b = enc('{"model":"old","x":1}');
    const scan = scanTopLevelObject(b, ["model"]);
    const span = scan.fields.get("model")!;
    const out = spliceBytes(b, span.start, span.end, enc('"new"'));
    expect(dec(out)).toBe('{"model":"new","x":1}');
  });
});
