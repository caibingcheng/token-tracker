import { describe, expect, it } from "vitest";
import { filterModelsByQuery } from "./model-search";

const MODELS = [
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "anthropic/claude-3.7-sonnet",
  "deepseek-chat",
  "google/gemini-2.0-flash",
];

describe("filterModelsByQuery", () => {
  it("空白查询返回全量列表", () => {
    expect(filterModelsByQuery(MODELS, "")).toEqual(MODELS);
    expect(filterModelsByQuery(MODELS, "   ")).toEqual(MODELS);
  });

  it("大小写不敏感子串匹配", () => {
    expect(filterModelsByQuery(MODELS, "GPT")).toEqual([
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
    ]);
    expect(filterModelsByQuery(MODELS, "DeepSeek")).toEqual(["deepseek-chat"]);
  });

  it("分隔符无关：查询词与模型名均去除 - _ . / :", () => {
    expect(filterModelsByQuery(MODELS, "claude37")).toEqual(["anthropic/claude-3.7-sonnet"]);
    expect(filterModelsByQuery(MODELS, "gpt4o")).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
    expect(filterModelsByQuery(MODELS, "openai/gpt-4o")).toEqual([
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
    ]);
  });

  it("多关键词空白分隔为 AND 语义", () => {
    expect(filterModelsByQuery(MODELS, "openai mini")).toEqual(["openai/gpt-4o-mini"]);
    expect(filterModelsByQuery(MODELS, "gpt openai")).toEqual([
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
    ]);
    // 单个词都无法命中的组合为空
    expect(filterModelsByQuery(MODELS, "gpt gemini")).toEqual([]);
  });

  it("无命中返回空数组", () => {
    expect(filterModelsByQuery(MODELS, "llama")).toEqual([]);
  });

  it("模糊匹配：子序列按序命中，无需连续", () => {
    // g-p-t-...-o 按序出现
    expect(filterModelsByQuery(MODELS, "gpto")).toEqual([
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
    ]);
    // c-...-s-... 按序出现（claude-3.7-sonnet）
    expect(filterModelsByQuery(MODELS, "cs")).toEqual(["anthropic/claude-3.7-sonnet"]);
    // 逆序不命中：gpt4o 中 o 之后无 g、4
    expect(filterModelsByQuery(["gpt-4o"], "og4")).toEqual([]);
  });

  it("排序：连续子串命中优先于纯子序列命中，同级保持原顺序", () => {
    // cld 对 claude-3 是纯子序列（c...l...d），对 c-l-d-x 是连续子串
    expect(filterModelsByQuery(["claude-3", "c-l-d-x"], "cld")).toEqual([
      "c-l-d-x",
      "claude-3",
    ]);
    // 同为连续子串时保持原始顺序
    expect(filterModelsByQuery(["openai/gpt-4o", "openai/gpt-4o-mini"], "gpt4o")).toEqual([
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
    ]);
  });

  it("混合得分：单关键词子串优先；多关键词累加得分", () => {
    // gt 对 gt-4o 是连续子串（2 分），对 gpt-4o 是纯子序列（1 分）
    expect(filterModelsByQuery(["gpt-4o", "gt-4o"], "gt")).toEqual(["gt-4o", "gpt-4o"]);
    // 多关键词：gt-4o 两项皆子串（4 分），gpt-4o 的子序列项只得 1 分
    expect(filterModelsByQuery(["gpt-4o", "gt-4o"], "gt 4o")).toEqual(["gt-4o", "gpt-4o"]);
  });

  it("边界：纯分隔符查询视为空查询，空数组返回空数组", () => {
    expect(filterModelsByQuery(MODELS, "---")).toEqual(MODELS);
    expect(filterModelsByQuery([], "gpt")).toEqual([]);
  });
});
