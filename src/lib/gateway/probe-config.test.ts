import { describe, it, expect } from "vitest";
import {
  PROBE_PRESETS,
  applyModelToProbePath,
  buildProbeRequestFromConfig,
  isProbePathInsideBase,
  isProbeUrlInsideBase,
  isValidModelProbeConfigs,
  isValidProbeConfig,
  parseModelProbeConfigs,
  parseProbeConfig,
  serializeModelProbeConfigs,
  serializeProbeConfig,
  type ModelProbeConfig,
  type ProbeConfig,
} from "./probe-config";

const valid: ProbeConfig = {
  path: "/v1/systemone",
  body: { model: "{{model}}", state: "hi", questions: {} },
};

describe("isValidProbeConfig", () => {
  it("accepts a plain path + object body", () => {
    expect(isValidProbeConfig(valid)).toBe(true);
  });

  it("rejects non-objects and arrays", () => {
    expect(isValidProbeConfig(null)).toBe(false);
    expect(isValidProbeConfig("x")).toBe(false);
    expect(isValidProbeConfig([])).toBe(false);
    expect(isValidProbeConfig({})).toBe(false);
  });

  it("rejects paths that are not relative single-slash paths", () => {
    for (const path of ["", "v1/models", "https://evil.example/x", "//evil.example/x", "/a://b"]) {
      expect(isValidProbeConfig({ path, body: {} })).toBe(false);
    }
  });

  it("rejects paths escaping the base prefix", () => {
    expect(isValidProbeConfig({ path: "/../internal", body: {} })).toBe(false);
    // 中段 `..` 也拒绝：URL 归一化后会逃出 /v1 前缀
    expect(isValidProbeConfig({ path: "/v1/../admin", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/a/../../b", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/..", body: {} })).toBe(false);
  });

  it("rejects equivalent encodings that URL normalization would treat as separators", () => {
    // 百分号编码点段 / 编码斜杠 / 反斜杠 / 控制字符：归一化后均可逃出前缀
    expect(isValidProbeConfig({ path: "/v1/%2e%2e/x", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/%2E%2E/x", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/.%2e/x", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/%2fadmin", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/%5cadmin", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1\\..\\admin", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/\t../admin", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/a b", body: {} })).toBe(false);
  });

  it("rejects query/fragment suffixes that hide a dot segment from the segment check", () => {
    // `?`/`#` 之后的内容不再是路径段，`..?x=1` 不等于 `..`，会绕开按 / 切段的检查
    expect(isValidProbeConfig({ path: "/v1/..?x=1", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/..#f", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/..?/admin", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/systemone?x=1", body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/systemone#f", body: {} })).toBe(false);
  });

  it("allows dot segments that stay inside", () => {
    expect(isValidProbeConfig({ path: "/v1/./systemone", body: {} })).toBe(true);
  });

  it("rejects array or non-object bodies", () => {
    expect(isValidProbeConfig({ path: "/v1/x", body: [] })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/x", body: "y" })).toBe(false);
  });

  it("rejects oversized path or body", () => {
    expect(isValidProbeConfig({ path: `/${"a".repeat(2000)}`, body: {} })).toBe(false);
    expect(isValidProbeConfig({ path: "/v1/x", body: { a: "b".repeat(9000) } })).toBe(false);
  });
});

describe("parseProbeConfig / serializeProbeConfig", () => {
  it("round-trips a valid config", () => {
    expect(parseProbeConfig(serializeProbeConfig(valid))).toEqual(valid);
  });

  it("falls back to null (= auto) for empty or invalid input", () => {
    expect(parseProbeConfig(null)).toBeNull();
    expect(parseProbeConfig("")).toBeNull();
    expect(parseProbeConfig("not json")).toBeNull();
    expect(parseProbeConfig(JSON.stringify({ path: "//evil" }))).toBeNull();
    expect(parseProbeConfig(JSON.stringify(["x"]))).toBeNull();
  });

  it("serializes invalid config to null", () => {
    expect(serializeProbeConfig(null)).toBeNull();
    expect(serializeProbeConfig({ path: "no-slash", body: {} })).toBeNull();
  });
});

describe("buildProbeRequestFromConfig", () => {
  it("joins baseUrl + path and substitutes {{model}}", () => {
    const { url, body } = buildProbeRequestFromConfig("https://api.typesafe.ai", "jev-latest", valid);
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(body).toEqual({
      model: "jev-latest",
      state: "hi",
      questions: {},
    });
  });

  it("dedupes the /v1 prefix when baseUrl already ends with it", () => {
    const { url } = buildProbeRequestFromConfig("https://api.typesafe.ai/v1", "jev-latest", valid);
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  });

  it("substitutes inside nested values and substrings", () => {
    const { body } = buildProbeRequestFromConfig("https://api.example", "m1", {
      path: "/v1/x",
      body: { model: "{{model}}", list: ["a/{{model}}", { deep: "{{model}}" }], n: 1 },
    });
    expect(body).toEqual({
      model: "m1",
      list: ["a/m1", { deep: "m1" }],
      n: 1,
    });
  });

  it("keeps a __proto__ key as an own property instead of dropping it", () => {
    const body = JSON.parse('{"model":"{{model}}","__proto__":{"x":1}}') as Record<string, unknown>;
    const out = buildProbeRequestFromConfig("https://api.example", "m1", {
      path: "/v1/x",
      body,
    }).body;
    expect(Object.keys(out)).toContain("__proto__");
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("does not mutate the stored config", () => {
    const config: ProbeConfig = { path: "/v1/x", body: { model: "{{model}}" } };
    buildProbeRequestFromConfig("https://api.example", "m2", config);
    expect(config.body.model).toBe("{{model}}");
  });
});

describe("applyModelToProbePath / path substitution", () => {
  it("replaces {{model}} inside the path (gemini style)", () => {
    expect(applyModelToProbePath("/v1beta/models/{{model}}:generateContent", "gemini-1.5-flash")).toBe(
      "/v1beta/models/gemini-1.5-flash:generateContent"
    );
  });

  it("buildProbeRequestFromConfig substitutes the model into url and body", () => {
    const config: ProbeConfig = {
      path: "/v1beta/models/{{model}}:generateContent",
      body: { contents: [{ parts: [{ text: "hi" }] }] },
    };
    const { url, body } = buildProbeRequestFromConfig("https://relay.example", "gemini-1.5-flash", config);
    expect(url).toBe("https://relay.example/v1beta/models/gemini-1.5-flash:generateContent");
    expect(body).toEqual({ contents: [{ parts: [{ text: "hi" }] }] });
    // 不改动存储的配置
    expect(config.path).toBe("/v1beta/models/{{model}}:generateContent");
  });
});

describe("isProbeUrlInsideBase", () => {
  it("accepts resolved URLs under the base path prefix", () => {
    expect(isProbeUrlInsideBase("https://api.example.com/v1", "https://api.example.com/v1/chat/completions")).toBe(true);
    expect(isProbeUrlInsideBase("https://api.example.com", "https://api.example.com/v1beta/models/m:x")).toBe(true);
  });

  it("rejects cross-origin or escaping resolved URLs", () => {
    expect(isProbeUrlInsideBase("https://api.example.com", "https://evil.example.com/v1/x")).toBe(false);
    expect(isProbeUrlInsideBase("https://api.example.com/v1", "https://api.example.com/admin")).toBe(false);
    expect(isProbeUrlInsideBase("not-a-url", "https://api.example.com/v1/x")).toBe(false);
  });
});

describe("isProbePathInsideBase", () => {
  it("accepts paths under the base path prefix", () => {
    expect(isProbePathInsideBase("https://api.example.com/v1", "/v1/systemone")).toBe(true);
    expect(isProbePathInsideBase("https://api.example.com/v1", "/v1/x/")).toBe(true);
    expect(isProbePathInsideBase("https://api.example.com/v1", "/v1")).toBe(true);
  });

  it("accepts any same-origin path when the base has no path", () => {
    expect(isProbePathInsideBase("https://api.example.com", "/v1/systemone")).toBe(true);
    expect(isProbePathInsideBase("https://api.example.com/", "/whatever")).toBe(true);
  });

  it("rejects paths that normalize outside the base prefix", () => {
    // 这些写法绕过了 isValidProbeConfig 的黑名单（手工构造 / 未来的校验缺口）；
    // 注意 joinUrlPath 是字符串拼接，不能改 host，只有归一化（.. 类）才能逃出路径前缀
    expect(isProbePathInsideBase("https://api.example.com/v1", "/v1/..?x=1")).toBe(false);
    expect(isProbePathInsideBase("https://api.example.com/v1", "/v1/../admin")).toBe(false);
    expect(isProbePathInsideBase("https://api.example.com/v1", "/v1/%2e%2e/x")).toBe(false);
    expect(isProbePathInsideBase("https://api.example.com/v1", "/v1/x/../../y")).toBe(false);
  });

  it("rejects an unparsable base URL", () => {
    expect(isProbePathInsideBase("not-a-url", "/v1/x")).toBe(false);
  });
});

describe("isValidModelProbeConfigs", () => {
  const emb: ModelProbeConfig = {
    model: "text-embedding-3-large",
    path: "/v1/embeddings",
    body: { model: "{{model}}", input: "hi" },
  };

  it("accepts a list of per-model configs", () => {
    expect(isValidModelProbeConfigs([emb])).toBe(true);
    expect(isValidModelProbeConfigs([])).toBe(true);
    expect(isValidModelProbeConfigs(null)).toBe(false);
    expect(isValidModelProbeConfigs({})).toBe(false);
  });

  it("rejects empty/oversized/duplicate model names", () => {
    expect(isValidModelProbeConfigs([{ ...emb, model: "" }])).toBe(false);
    expect(isValidModelProbeConfigs([{ ...emb, model: "   " }])).toBe(false);
    expect(isValidModelProbeConfigs([{ ...emb, model: "m".repeat(257) }])).toBe(false);
    expect(isValidModelProbeConfigs([emb, { ...emb }])).toBe(false);
  });

  it("rejects entries whose path/body fail single-config validation", () => {
    expect(isValidModelProbeConfigs([{ ...emb, path: "no-slash" }])).toBe(false);
    expect(isValidModelProbeConfigs([{ ...emb, path: "/v1/../admin" }])).toBe(false);
    expect(isValidModelProbeConfigs([{ ...emb, body: [] }])).toBe(false);
  });

  it("rejects non-object entries and oversized lists", () => {
    expect(isValidModelProbeConfigs(["x"])).toBe(false);
    expect(isValidModelProbeConfigs([null])).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({
      model: `m${i}`,
      path: "/v1/embeddings",
      body: {},
    }));
    expect(isValidModelProbeConfigs(many)).toBe(false);
  });
});

describe("parseModelProbeConfigs / serializeModelProbeConfigs", () => {
  const list: ModelProbeConfig[] = [
    { model: "text-embedding-3-large", path: "/v1/embeddings", body: { model: "{{model}}" } },
  ];

  it("round-trips a valid list", () => {
    expect(parseModelProbeConfigs(serializeModelProbeConfigs(list))).toEqual(list);
  });

  it("serializes an empty list to null and rejects invalid input", () => {
    expect(serializeModelProbeConfigs([])).toBeNull();
    expect(serializeModelProbeConfigs([{ model: "", path: "/v1/x", body: {} }])).toBeNull();
  });

  it("falls back to [] for empty or invalid stored JSON", () => {
    expect(parseModelProbeConfigs(null)).toEqual([]);
    expect(parseModelProbeConfigs("")).toEqual([]);
    expect(parseModelProbeConfigs("not json")).toEqual([]);
    // 含非法条目时整体回落（与 parseProbeConfig 口径一致）
    expect(parseModelProbeConfigs(JSON.stringify([{ model: "", path: "/v1/x", body: {} }]))).toEqual([]);
    expect(parseModelProbeConfigs(JSON.stringify({ path: "/v1/x" }))).toEqual([]);
  });
});

describe("PROBE_PRESETS", () => {
  it("every preset is a valid probe config with a model placeholder in path or body", () => {
    for (const preset of PROBE_PRESETS) {
      expect(isValidProbeConfig({ path: preset.path, body: preset.body })).toBe(true);
      // {{model}} 在 body（chat/anthropic 风格）或 path（gemini 风格）均可
      expect(preset.path + JSON.stringify(preset.body)).toContain("{{model}}");
    }
  });

  it("covers the known non-chat endpoints", () => {
    const ids = PROBE_PRESETS.map((p) => p.id);
    expect(ids).toContain("embeddings");
    expect(ids).toContain("rerank");
    expect(ids).toContain("systemone");
  });

  it("covers the cross-protocol relay endpoints", () => {
    const ids = PROBE_PRESETS.map((p) => p.id);
    expect(ids).toContain("anthropic-messages");
    expect(ids).toContain("gemini-generateContent");
  });
});
