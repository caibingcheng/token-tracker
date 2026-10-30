// 审计日志表列可见性配置：settings 表 audit_columns（明文 JSON 数组，存可见列 id）。
// 只存可见集合，展示顺序恒为 AUDIT_COLUMNS 定义顺序（无拖拽排序）。
// 通用校验/归一在 ./columns（与 records_columns 共用）。

import { columnIds, isValidColumns, normalizeColumns, parseColumns } from "./columns";

export const AUDIT_COLUMNS = [
  { id: "time", label: "Time" },
  { id: "action", label: "Action" },
  { id: "actor", label: "Actor" },
  { id: "target", label: "Target" },
  { id: "ip", label: "IP" },
  { id: "userAgent", label: "User-Agent" },
  { id: "details", label: "Details" },
] as const;

export type AuditColumnId = (typeof AUDIT_COLUMNS)[number]["id"];

export const AUDIT_COLUMN_IDS: AuditColumnId[] = columnIds(AUDIT_COLUMNS);

export const DEFAULT_AUDIT_COLUMNS: AuditColumnId[] = [...AUDIT_COLUMN_IDS];

// 写入侧校验：非空数组、每项为已知 id、无重复（空数组等于整表无列，拒绝落库）
export function isValidAuditColumns(value: unknown): value is AuditColumnId[] {
  return isValidColumns(value, AUDIT_COLUMN_IDS);
}

// 读侧归一：非数组/空/全非法 → 默认全显示；合法数组丢弃未知 id，按定义顺序返回
export function normalizeAuditColumns(value: unknown): AuditColumnId[] {
  return normalizeColumns(value, AUDIT_COLUMN_IDS);
}

// 读取侧解析：settings 原始字符串 → 可见列 id 数组
export function parseAuditColumns(raw: string | null): AuditColumnId[] {
  return parseColumns(raw, AUDIT_COLUMN_IDS);
}
