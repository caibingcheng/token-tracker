import { describe, it, expect } from "vitest";
import {
  extractUaToken,
  BUILTIN_AGENT_MAP,
  resolveAgentName,
  resolveAgentUserAgents,
  UNKNOWN_AGENT,
} from "@/lib/agent-utils";

describe("extractUaToken", () => {
  it("取第一个 / 前的 token 并 lowercase", () => {
    expect(extractUaToken("claude-cli/2.1.5 (external, cli)")).toBe("claude-cli");
    expect(extractUaToken("opencode/1.18.14")).toBe("opencode");
    expect(extractUaToken("Codex_CLI_RS/0.1.0")).toBe("codex_cli_rs");
    expect(extractUaToken("python-requests/2.31.0")).toBe("python-requests");
  });

  it("无斜杠的 UA 返回整个 token", () => {
    expect(extractUaToken("opencode")).toBe("opencode");
  });

  it("空串 / 纯空白 → 空串", () => {
    expect(extractUaToken("")).toBe("");
    expect(extractUaToken("   ")).toBe("");
  });
});

describe("BUILTIN_AGENT_MAP", () => {
  it("覆盖全部已知工具", () => {
    expect(BUILTIN_AGENT_MAP["claude-cli"]).toBe("claude-code");
    expect(BUILTIN_AGENT_MAP["opencode"]).toBe("opencode");
    expect(BUILTIN_AGENT_MAP["codex_cli_rs"]).toBe("codex");
    expect(BUILTIN_AGENT_MAP["codex"]).toBe("codex");
    expect(BUILTIN_AGENT_MAP["geminicli"]).toBe("gemini-cli");
    expect(BUILTIN_AGENT_MAP["aider"]).toBe("aider");
    expect(BUILTIN_AGENT_MAP["cursor-agent"]).toBe("cursor");
  });
});

describe("resolveAgentName", () => {
  it("null / 空 UA → unknown", () => {
    expect(resolveAgentName(null)).toBe(UNKNOWN_AGENT);
    expect(resolveAgentName("")).toBe(UNKNOWN_AGENT);
    expect(resolveAgentName("   ")).toBe(UNKNOWN_AGENT);
  });

  it("内置映射命中 → 工具名", () => {
    expect(resolveAgentName("claude-cli/2.1.5 (external, cli)")).toBe("claude-code");
    expect(resolveAgentName("opencode/1.18.14")).toBe("opencode");
    expect(resolveAgentName("codex_cli_rs/0.1.0")).toBe("codex");
    expect(resolveAgentName("geminicli/1.0.0")).toBe("gemini-cli");
    expect(resolveAgentName("cursor-agent/1.0.0")).toBe("cursor");
  });

  it("未命中 → UA token 本身", () => {
    expect(resolveAgentName("python-requests/2.31.0")).toBe("python-requests");
    expect(resolveAgentName("my-tool/1.0")).toBe("my-tool");
  });

  it("手动 aliases 优先于内置映射，大小写不敏感", () => {
    const aliases = [{ name: "Codex CLI", aliases: ["codex", "codex_cli_rs"] }];
    expect(resolveAgentName("codex/0.1", aliases)).toBe("Codex CLI");
    expect(resolveAgentName("CODEX_CLI_RS/0.1", aliases)).toBe("Codex CLI");
    // 内置映射被覆盖
    expect(resolveAgentName("codex/0.1", aliases)).toBe("Codex CLI");
  });

  it("手动映射命中其他 UA → 工具名；未命中保持原始/内置", () => {
    const aliases = [{ name: "My Agent", aliases: ["my-tool"] }];
    expect(resolveAgentName("my-tool/1.0", aliases)).toBe("My Agent");
    expect(resolveAgentName("other/1.0", aliases)).toBe("other");
  });

  it("aliases 前后空白忽略", () => {
    const aliases = [{ name: "A", aliases: ["  claude-cli  "] }];
    expect(resolveAgentName("claude-cli/1.0", aliases)).toBe("A");
  });
});

describe("resolveAgentUserAgents（反找）", () => {
  const UAS: Array<string | null> = [
    "claude-cli/2.1.5 (external, cli)",
    "opencode/1.18.14",
    "codex/0.1",
    null,
  ];

  it("工具名 → 命中 UA 集合", () => {
    expect(resolveAgentUserAgents("claude-code", UAS)).toEqual({
      uas: ["claude-cli/2.1.5 (external, cli)"],
    });
    // 单 UA 匹配
    expect(resolveAgentUserAgents("opencode", UAS)).toEqual({
      uas: ["opencode/1.18.14"],
    });
  });

  it("多 UA → 一 agent（手动映射合并）", () => {
    const aliases = [{ name: "Codex", aliases: ["codex", "codex_cli_rs"] }];
    const uas = ["codex/0.1", "codex_cli_rs/0.9", "claude-cli/0.9"];
    expect(resolveAgentUserAgents("Codex", uas, aliases)).toEqual({
      uas: ["codex/0.1", "codex_cli_rs/0.9"],
    });
  });

  it("unknown → { unknown: true }（存在 NULL UA 时）", () => {
    expect(resolveAgentUserAgents(UNKNOWN_AGENT, UAS)).toEqual({
      unknown: true,
    });
    expect(resolveAgentUserAgents(UNKNOWN_AGENT, ["", "x/1"])).toEqual({
      unknown: true,
    });
  });

  it("unknown 但无 NULL/派生 unknown → null", () => {
    expect(
      resolveAgentUserAgents(UNKNOWN_AGENT, ["opencode/1.0", "codex/0.1"])
    ).toBeNull();
  });

  it("无匹配 → null", () => {
    expect(resolveAgentUserAgents("nonexistent", UAS)).toBeNull();
  });
});