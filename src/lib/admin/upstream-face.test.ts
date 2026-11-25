import { describe, it, expect } from "vitest";
import {
  findAuthModelConflict,
  modelPatternsIntersect,
  parseUpstreamFaceConfig,
} from "./upstream-face";

describe("parseUpstreamFaceConfig", () => {
  it("treats a single protocol as a one-face record with the protocol-derived auth style", () => {
    expect(parseUpstreamFaceConfig({ protocol: "anthropic" })).toEqual({
      ok: true,
      value: { protocol: "anthropic", protocols: ["anthropic"], authStyle: "x-api-key" },
    });
    expect(parseUpstreamFaceConfig({ protocol: "gemini" })).toEqual({
      ok: true,
      value: { protocol: "gemini", protocols: ["gemini"], authStyle: "x-goog-api-key" },
    });
  });

  it("takes protocols[0] as the default face and defaults auth to the first face", () => {
    expect(parseUpstreamFaceConfig({ protocols: ["openai", "anthropic"] })).toEqual({
      ok: true,
      value: { protocol: "openai", protocols: ["openai", "anthropic"], authStyle: "bearer" },
    });
  });

  it("honours an explicit authStyle (decoupled from protocol)", () => {
    // Kimi / OpenRouter：anthropic 面也用 Bearer
    expect(parseUpstreamFaceConfig({ protocol: "anthropic", authStyle: "bearer" })).toEqual({
      ok: true,
      value: { protocol: "anthropic", protocols: ["anthropic"], authStyle: "bearer" },
    });
  });

  it("dedupes repeated faces", () => {
    const parsed = parseUpstreamFaceConfig({ protocols: ["openai", "openai"] });
    expect(parsed.ok && parsed.value.protocols).toEqual(["openai"]);
  });

  it("rejects empty / invalid / unknown input", () => {
    expect(parseUpstreamFaceConfig({})).toMatchObject({ ok: false });
    expect(parseUpstreamFaceConfig({ protocols: [] })).toMatchObject({ ok: false });
    expect(parseUpstreamFaceConfig({ protocols: ["grpc"] })).toMatchObject({ ok: false });
    expect(parseUpstreamFaceConfig({ protocols: "openai" })).toMatchObject({ ok: false });
    expect(parseUpstreamFaceConfig({ protocol: "grpc" })).toMatchObject({ ok: false });
    expect(parseUpstreamFaceConfig({ protocol: "openai", authStyle: "basic" })).toMatchObject({
      ok: false,
    });
  });

  it("rejects a default face that is not in the declared set", () => {
    expect(
      parseUpstreamFaceConfig({ protocol: "gemini", protocols: ["openai", "anthropic"] })
    ).toMatchObject({ ok: false });
  });
});

describe("modelPatternsIntersect", () => {
  it("matches exact names and prefix wildcards", () => {
    expect(modelPatternsIntersect("gpt-4o", "gpt-4o")).toBe(true);
    expect(modelPatternsIntersect("gpt-4o", "gpt-5")).toBe(false);
    expect(modelPatternsIntersect("gpt-*", "gpt-4o")).toBe(true);
    expect(modelPatternsIntersect("gpt-4o", "gpt-*")).toBe(true);
    expect(modelPatternsIntersect("gpt-*", "gpt-5*")).toBe(true); // 前缀互为前缀
    expect(modelPatternsIntersect("claude-*", "gpt-4o")).toBe(false);
  });

  it("treats a bare * as matching nothing (same as runtime)", () => {
    expect(modelPatternsIntersect("*", "gpt-4o")).toBe(false);
    expect(modelPatternsIntersect("*", "*")).toBe(false);
  });
});

describe("findAuthModelConflict", () => {
  const others = [
    {
      name: "zen-openai",
      baseUrl: "https://zen.example",
      authStyle: "bearer" as const,
      models: ["gpt-*"],
    },
    {
      name: "other-base",
      baseUrl: "https://other.example",
      authStyle: "bearer" as const,
      models: ["claude-*"],
    },
    {
      name: "same-auth",
      baseUrl: "https://zen.example",
      authStyle: "x-api-key" as const,
      models: ["claude-*"],
    },
  ];

  it("flags overlapping models on the same baseUrl with a different auth style", () => {
    const conflict = findAuthModelConflict(
      { authStyle: "x-api-key", models: ["gpt-4o"] },
      others,
      "https://zen.example"
    );
    expect(conflict).toContain('"gpt-4o"');
    expect(conflict).toContain("zen-openai");
  });

  it("ignores other baseUrls and non-overlapping models under another auth style", () => {
    // 同 baseUrl 但 authStyle 不同且模型不相交 → 不报冲突
    expect(
      findAuthModelConflict(
        { authStyle: "x-api-key", models: ["claude-sonnet"] },
        others,
        "https://zen.example"
      )
    ).toBeNull();
    // 不同 baseUrl 不参与对比（other-base 的 claude-* 不算冲突）
    expect(
      findAuthModelConflict({ authStyle: "bearer", models: ["claude-x"] }, others, "https://third.example")
    ).toBeNull();
  });
});

describe("findAuthModelConflict - enabled 行", () => {
  it("ignores disabled records so they cannot block edits", () => {
    const conflict = findAuthModelConflict(
      { authStyle: "x-api-key", models: ["claude-sonnet"] },
      [
        {
          name: "zen-openai",
          baseUrl: "https://zen.example",
          authStyle: "bearer",
          models: ["claude-sonnet"],
          enabled: false,
        },
      ],
      "https://zen.example"
    );
    expect(conflict).toBeNull();
  });

  it("still reports enabled records", () => {
    const conflict = findAuthModelConflict(
      { authStyle: "x-api-key", models: ["claude-sonnet"] },
      [
        {
          name: "zen-openai",
          baseUrl: "https://zen.example",
          authStyle: "bearer",
          models: ["claude-sonnet"],
          enabled: true,
        },
      ],
      "https://zen.example"
    );
    expect(conflict).toContain("zen-openai");
  });
});
