import { describe, it, expect } from "vitest";
import {
  AUDIT_COLUMNS,
  AUDIT_COLUMN_IDS,
  DEFAULT_AUDIT_COLUMNS,
  isValidAuditColumns,
  normalizeAuditColumns,
  parseAuditColumns,
} from "./audit-columns";

describe("audit-columns", () => {
  it("默认全列可见且覆盖全部定义列", () => {
    expect(DEFAULT_AUDIT_COLUMNS).toEqual(AUDIT_COLUMN_IDS);
    expect(DEFAULT_AUDIT_COLUMNS).toEqual(
      AUDIT_COLUMNS.map((column) => column.id)
    );
    expect(DEFAULT_AUDIT_COLUMNS).toContain("time");
    expect(DEFAULT_AUDIT_COLUMNS).toContain("details");
  });

  it("isValidAuditColumns：非空、已知 id、无重复", () => {
    expect(isValidAuditColumns(["time", "action"])).toBe(true);
    expect(isValidAuditColumns([])).toBe(false);
    expect(isValidAuditColumns(["time", "time"])).toBe(false);
    expect(isValidAuditColumns(["time", "nope"])).toBe(false);
    expect(isValidAuditColumns("time")).toBe(false);
    expect(isValidAuditColumns(null)).toBe(false);
    expect(isValidAuditColumns([1, 2])).toBe(false);
  });

  it("normalizeAuditColumns：丢弃未知 id 并按定义顺序返回", () => {
    expect(normalizeAuditColumns(["details", "action", "bogus"])).toEqual([
      "action",
      "details",
    ]);
    expect(normalizeAuditColumns(["ip", "time"])).toEqual(["time", "ip"]);
    // 重复 id 去重
    expect(normalizeAuditColumns(["time", "time"])).toEqual(["time"]);
    // 非数组 / 全非法 → 默认全显示
    expect(normalizeAuditColumns(null)).toEqual(DEFAULT_AUDIT_COLUMNS);
    expect(normalizeAuditColumns(["bogus"])).toEqual(DEFAULT_AUDIT_COLUMNS);
  });

  it("parseAuditColumns：坏 JSON / 空值回退默认，合法 JSON 归一", () => {
    expect(parseAuditColumns(null)).toEqual(DEFAULT_AUDIT_COLUMNS);
    expect(parseAuditColumns("")).toEqual(DEFAULT_AUDIT_COLUMNS);
    expect(parseAuditColumns("not json")).toEqual(DEFAULT_AUDIT_COLUMNS);
    expect(parseAuditColumns(JSON.stringify(["time", "actor"]))).toEqual([
      "time",
      "actor",
    ]);
    expect(parseAuditColumns(JSON.stringify(["time", "nope"]))).toEqual(["time"]);
  });
});
