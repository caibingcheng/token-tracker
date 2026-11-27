// Records 表列可见性配置：settings 表 records_columns（明文 JSON 数组，存可见列 id）。
// 只存可见集合，展示顺序恒为 RECORD_COLUMNS 定义顺序（无拖拽排序）。
// 通用校验/归一在 ./columns（与 audit_columns 共用）。

import { columnIds, isValidColumns, normalizeColumns, parseColumns } from "./columns";

export const RECORD_COLUMNS = [
  { id: "date", label: "Date" },
  { id: "model", label: "Model" },
  { id: "provider", label: "Provider" },
  { id: "agent", label: "Agent" },
  { id: "key", label: "Key" },
  { id: "session", label: "Session" },
  { id: "device", label: "Device" },
  { id: "tokens", label: "Tokens" },
  { id: "ttft", label: "TTFT" },
  { id: "latency", label: "Latency" },
  { id: "status", label: "Status" },
] as const;

export type RecordColumnId = (typeof RECORD_COLUMNS)[number]["id"];

export const RECORD_COLUMN_IDS: RecordColumnId[] = columnIds(RECORD_COLUMNS);

export const DEFAULT_RECORD_COLUMNS: RecordColumnId[] = [...RECORD_COLUMN_IDS];

// 历史列 id → 新列 id：input/cacheRead/output 已合并为单列 tokens（存量配置读取时兼容）
const LEGACY_COLUMN_ALIASES: Record<string, RecordColumnId> = {
  input: "tokens",
  cacheRead: "tokens",
  output: "tokens",
  prompt: "tokens",
};

// 写入侧校验：非空数组、每项为已知 id、无重复（空数组等于整表无列，拒绝落库）
export function isValidRecordColumns(value: unknown): value is RecordColumnId[] {
  return isValidColumns(value, RECORD_COLUMN_IDS);
}

// 读侧归一：非数组/空/全非法 → 默认全显示；合法数组丢弃未知 id（存量配置兼容），按定义顺序返回
export function normalizeRecordColumns(value: unknown): RecordColumnId[] {
  return normalizeColumns(value, RECORD_COLUMN_IDS, LEGACY_COLUMN_ALIASES);
}

// 读取侧解析：settings 原始字符串 → 可见列 id 数组
export function parseRecordColumns(raw: string | null): RecordColumnId[] {
  return parseColumns(raw, RECORD_COLUMN_IDS, LEGACY_COLUMN_ALIASES);
}
