import { describe, it, expect } from "vitest";
import {
  DEFAULT_RECORD_COLUMNS,
  RECORD_COLUMN_IDS,
  isValidRecordColumns,
  normalizeRecordColumns,
  parseRecordColumns,
} from "./records-columns";

describe("records-columns", () => {
  it("默认全列可见且覆盖全部定义列", () => {
    expect(DEFAULT_RECORD_COLUMNS).toEqual(RECORD_COLUMN_IDS);
    expect(DEFAULT_RECORD_COLUMNS).toContain("session");
    expect(DEFAULT_RECORD_COLUMNS).toContain("date");
  });

  it("isValidRecordColumns：非空、已知 id、无重复", () => {
    expect(isValidRecordColumns(["date", "session"])).toBe(true);
    expect(isValidRecordColumns([])).toBe(false);
    expect(isValidRecordColumns(["date", "date"])).toBe(false);
    expect(isValidRecordColumns(["date", "nope"])).toBe(false);
    expect(isValidRecordColumns("date")).toBe(false);
    expect(isValidRecordColumns(null)).toBe(false);
    expect(isValidRecordColumns([1, 2])).toBe(false);
  });

  it("normalizeRecordColumns：丢弃未知 id 并按定义顺序返回", () => {
    expect(normalizeRecordColumns(["session", "latency", "bogus"])).toEqual([
      "session",
      "latency",
    ]);
    // 顺序与输入无关
    expect(normalizeRecordColumns(["latency", "date"])).toEqual(["date", "latency"]);
    // 重复 id 去重
    expect(normalizeRecordColumns(["date", "date"])).toEqual(["date"]);
  });

  it("normalizeRecordColumns：存量 input/cacheRead/output 归一到 tokens", () => {
    expect(normalizeRecordColumns(["date", "input", "cacheRead", "output"])).toEqual([
      "date",
      "tokens",
    ]);
    expect(normalizeRecordColumns(["cacheRead"])).toEqual(["tokens"]);
    // 列表已无这些 id
    expect(RECORD_COLUMN_IDS).not.toContain("input");
    expect(RECORD_COLUMN_IDS).toContain("tokens");
  });

  it("normalizeRecordColumns：非数组 / 空 / 全非法 → 默认全列", () => {
    expect(normalizeRecordColumns(null)).toEqual(DEFAULT_RECORD_COLUMNS);
    expect(normalizeRecordColumns([])).toEqual(DEFAULT_RECORD_COLUMNS);
    expect(normalizeRecordColumns(["bogus"])).toEqual(DEFAULT_RECORD_COLUMNS);
  });

  it("parseRecordColumns：缺失或坏 JSON → 默认全列，合法 JSON 正常解析", () => {
    expect(parseRecordColumns(null)).toEqual(DEFAULT_RECORD_COLUMNS);
    expect(parseRecordColumns("not json")).toEqual(DEFAULT_RECORD_COLUMNS);
    expect(parseRecordColumns("{}")).toEqual(DEFAULT_RECORD_COLUMNS);
    expect(parseRecordColumns('["key","status"]')).toEqual(["key", "status"]);
  });
});
