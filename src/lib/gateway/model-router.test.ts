import { describe, it, expect } from "vitest";
import {
  routeModel,
  modelMatchesPattern,
  extractGeminiModel,
  extractRequestModel,
  detectRequestProtocol,
  parseEnabledModels,
} from "./model-router";
import type { UpstreamRoute } from "./model-router";

function mkUpstream(overrides: Partial<UpstreamRoute>): UpstreamRoute {
  return {
    id: 1,
    name: "u1",
    protocol: "openai",
    baseUrl: "https://example.com",
    priority: 0,
    enabled: true,
    enabledModels: [],
    ...overrides,
  };
}

describe("modelMatchesPattern", () => {
  it("exact match", () => {
    expect(modelMatchesPattern("gpt-4o", "gpt-4o")).toBe(true);
    expect(modelMatchesPattern("gpt-4o", "gpt-4o-mini")).toBe(false);
  });

  it("prefix wildcard match", () => {
    expect(modelMatchesPattern("gpt-*", "gpt-4o")).toBe(true);
    expect(modelMatchesPattern("gpt-*", "gpt-4o-mini")).toBe(true);
    expect(modelMatchesPattern("claude-3-*-sonnet", "claude-3-x-sonnet")).toBe(false); // 仅前缀通配
  });

  it("bare prefix without content does not match", () => {
    expect(modelMatchesPattern("*", "anything")).toBe(false);
  });
});

describe("routeModel", () => {
  const upstreams: UpstreamRoute[] = [
    mkUpstream({ id: 1, name: "openai", priority: 0, enabledModels: ["gpt-4o", "gpt-*"] }),
    mkUpstream({ id: 2, name: "deepseek", priority: 1, enabledModels: ["deepseek-chat"] }),
    mkUpstream({ id: 3, name: "fallback", priority: 5, enabledModels: ["gpt-*", "claude-*"] }),
  ];

  it("exact match beats wildcard", () => {
    const result = routeModel("gpt-4o", upstreams);
    expect(result?.upstream.id).toBe(1);
    expect(result?.matchedPattern).toBe("gpt-4o");
  });

  it("wildcard match falls to lowest priority when no exact match", () => {
    const result = routeModel("gpt-4o-mini", upstreams);
    expect(result?.upstream.id).toBe(1); // priority 0 < 5
    expect(result?.matchedPattern).toBe("gpt-*");
  });

  it("priority tie broken by first in list", () => {
    const result = routeModel("claude-sonnet-4", [
      mkUpstream({ id: 1, priority: 2, enabledModels: ["claude-*"] }),
      mkUpstream({ id: 2, priority: 2, enabledModels: ["claude-*"] }),
    ]);
    expect(result?.upstream.id).toBe(1);
  });

  it("disabled upstreams are skipped", () => {
    const result = routeModel("deepseek-chat", [
      mkUpstream({ id: 1, enabled: false, enabledModels: ["deepseek-chat"] }),
      mkUpstream({ id: 2, enabled: true, enabledModels: ["deepseek-chat"] }),
    ]);
    expect(result?.upstream.id).toBe(2);
  });

  it("returns null when no match", () => {
    expect(routeModel("unknown-model", upstreams)).toBeNull();
  });

  it("parses JSON string enabledModels", () => {
    const upstream = mkUpstream({ enabledModels: '["gpt-4o","gpt-*"]' as any });
    expect(parseEnabledModels(upstream.enabledModels)).toEqual(["gpt-4o", "gpt-*"]);
    expect(parseEnabledModels(null)).toEqual([]);
    expect(parseEnabledModels("invalid json")).toEqual([]);
  });
});

describe("extractGeminiModel", () => {
  it("extracts model from /v1beta/models/{model}:generateContent", () => {
    expect(extractGeminiModel("/v1beta/models/gemini-2.0-flash:generateContent")).toBe("gemini-2.0-flash");
  });

  it("extracts from /v1/models path (non-beta)", () => {
    expect(extractGeminiModel("/v1/models/gemini-pro:streamGenerateContent")).toBe("gemini-pro");
  });

  it("returns null for non-gemini paths", () => {
    expect(extractGeminiModel("/v1/chat/completions")).toBeNull();
    expect(extractGeminiModel("/v1/messages")).toBeNull();
  });
});

describe("extractRequestModel", () => {
  it("extracts from body for openai/anthropic", () => {
    expect(extractRequestModel("/v1/chat/completions", { model: "gpt-4o" })).toBe("gpt-4o");
    expect(extractRequestModel("/v1/messages", { model: "claude-3-5-sonnet" })).toBe("claude-3-5-sonnet");
  });

  it("extracts from path for gemini", () => {
    expect(extractRequestModel("/v1beta/models/gemini-2.0-flash:generateContent", {})).toBe("gemini-2.0-flash");
  });

  it("returns null when no model present", () => {
    expect(extractRequestModel("/v1/chat/completions", {})).toBeNull();
    expect(extractRequestModel("/v1beta/models", {})).toBeNull();
  });
});

describe("detectRequestProtocol", () => {
  it("detects gemini from /v1beta prefix", () => {
    expect(detectRequestProtocol("/v1beta/models/x:generateContent")).toBe("gemini");
  });

  it("detects anthropic from /v1/messages", () => {
    expect(detectRequestProtocol("/v1/messages")).toBe("anthropic");
  });

  it("defaults to openai", () => {
    expect(detectRequestProtocol("/v1/chat/completions")).toBe("openai");
    expect(detectRequestProtocol("/v1/models")).toBe("openai");
  });
});

import { findCandidatesByProtocol, routeModelByProtocol } from "./model-router";

describe("findCandidatesByProtocol", () => {
  it("only returns candidates with matching protocol", () => {
    const candidates = findCandidatesByProtocol(
      "gpt-4o",
      "openai",
      [
        mkUpstream({ id: 1, name: "openai", protocol: "openai", priority: 0, enabledModels: ["gpt-4o"] }),
        mkUpstream({ id: 2, name: "anthropic", protocol: "anthropic", priority: 0, enabledModels: ["gpt-4o"] }),
      ]
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].upstream.id).toBe(1);
  });

  it("includes both exact and wildcard matches", () => {
    const candidates = findCandidatesByProtocol(
      "gpt-4o",
      "openai",
      [
        mkUpstream({ id: 1, name: "openai", protocol: "openai", priority: 0, enabledModels: ["gpt-4o", "gpt-*"] }),
        mkUpstream({ id: 2, name: "fallback", protocol: "openai", priority: 5, enabledModels: ["gpt-*"] }),
      ]
    );
    expect(candidates).toHaveLength(3);
    expect(candidates.filter((c) => c.matchType === "exact")).toHaveLength(1);
    expect(candidates.filter((c) => c.matchType === "wildcard")).toHaveLength(2);
  });

  it("skips disabled upstreams", () => {
    const candidates = findCandidatesByProtocol(
      "gpt-4o",
      "openai",
      [
        mkUpstream({ id: 1, name: "disabled", protocol: "openai", enabled: false, enabledModels: ["gpt-4o"] }),
        mkUpstream({ id: 2, name: "enabled", protocol: "openai", enabled: true, enabledModels: ["gpt-4o"] }),
      ]
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].upstream.id).toBe(2);
  });
});

describe("routeModelByProtocol", () => {
  it("exact match wins over wildcard", () => {
    const { winner, candidates } = routeModelByProtocol(
      "gpt-4o",
      "openai",
      [
        mkUpstream({ id: 1, name: "openai", protocol: "openai", priority: 0, enabledModels: ["gpt-4o", "gpt-*"] }),
        mkUpstream({ id: 2, name: "fallback", protocol: "openai", priority: 0, enabledModels: ["gpt-*"] }),
      ]
    );
    expect(winner?.upstream.id).toBe(1);
    expect(winner?.matchType).toBe("exact");
    expect(candidates[0].matchType).toBe("exact");
  });

  it("lowest priority wins among wildcards", () => {
    const { winner } = routeModelByProtocol(
      "gpt-4o-mini",
      "openai",
      [
        mkUpstream({ id: 1, name: "a", protocol: "openai", priority: 1, enabledModels: ["gpt-*"] }),
        mkUpstream({ id: 2, name: "b", protocol: "openai", priority: 0, enabledModels: ["gpt-*"] }),
      ]
    );
    expect(winner?.upstream.id).toBe(2);
  });

  it("different protocols do not interfere", () => {
    const openai = routeModelByProtocol(
      "gpt-4o",
      "openai",
      [
        mkUpstream({ id: 1, name: "openai", protocol: "openai", priority: 0, enabledModels: ["gpt-4o"] }),
        mkUpstream({ id: 2, name: "other", protocol: "anthropic", priority: 0, enabledModels: ["gpt-4o"] }),
      ]
    );
    const anthropic = routeModelByProtocol(
      "gpt-4o",
      "anthropic",
      [
        mkUpstream({ id: 1, name: "openai", protocol: "openai", priority: 0, enabledModels: ["gpt-4o"] }),
        mkUpstream({ id: 2, name: "other", protocol: "anthropic", priority: 0, enabledModels: ["gpt-4o"] }),
      ]
    );
    expect(openai.winner?.upstream.id).toBe(1);
    expect(anthropic.winner?.upstream.id).toBe(2);
  });

  it("orders candidates by exact-first then priority", () => {
    const { candidates } = routeModelByProtocol(
      "gpt-4o",
      "openai",
      [
        mkUpstream({ id: 1, name: "fallback", protocol: "openai", priority: 5, enabledModels: ["gpt-*"] }),
        mkUpstream({ id: 2, name: "openai", protocol: "openai", priority: 0, enabledModels: ["gpt-4o"] }),
        mkUpstream({ id: 3, name: "cheap", protocol: "openai", priority: 1, enabledModels: ["gpt-*"] }),
      ]
    );
    expect(candidates.map((c) => c.upstream.id)).toEqual([2, 3, 1]);
  });

  it("returns null winner when no match", () => {
    const { winner, candidates } = routeModelByProtocol(
      "unknown-model",
      "openai",
      [mkUpstream({ id: 1, name: "openai", protocol: "openai", enabledModels: ["gpt-4o"] })]
    );
    expect(winner).toBeNull();
    expect(candidates).toHaveLength(0);
  });
});
