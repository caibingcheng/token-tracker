import { describe, it, expect } from "vitest";
import { PROVIDER_PRESETS } from "./provider-presets";
import { isProtocol } from "./gateway/model-router";

describe("provider-presets", () => {
  it("preset names are unique", () => {
    const names = PROVIDER_PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every preset has a valid protocol", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(isProtocol(p.protocol), `${p.name} protocol`).toBe(true);
    }
  });

  it("every preset has an https base URL without trailing slash", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.baseUrl, `${p.name} scheme`).toMatch(/^https:\/\//);
      expect(p.baseUrl, `${p.name} trailing slash`).not.toMatch(/\/$/);
    }
  });

  it("base URLs are unique per preset (except known aliases dashscope/bailian)", () => {
    const urls = PROVIDER_PRESETS.map((p) => p.baseUrl);
    const duplicates = urls.filter((u, i) => urls.indexOf(u) !== i);
    for (const dup of duplicates) {
      const names = PROVIDER_PRESETS.filter((p) => p.baseUrl === dup).map((p) => p.name);
      // 阿里云百炼与 dashscope 同平台同 endpoint，允许并存
      expect(names.sort(), `${dup} duplicates`).toEqual(["bailian", "dashscope"]);
    }
  });

  it("includes the expected providers", () => {
    const names = PROVIDER_PRESETS.map((p) => p.name);
    for (const expected of [
      "openai",
      "anthropic",
      "gemini",
      "deepseek",
      "moonshot",
      "openrouter",
      "dashscope",
      "kimi for coding",
      "bigmodel",
      "siliconflow",
      "bailian",
    ]) {
      expect(names, `missing preset ${expected}`).toContain(expected);
    }
  });

  it("kimi for coding uses the Anthropic-compatible endpoint", () => {
    const preset = PROVIDER_PRESETS.find((p) => p.name === "kimi for coding");
    expect(preset?.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(preset?.protocol).toBe("anthropic");
  });
});
