// Records 表列可见性配置：settings 表 records_columns（明文 JSON 数组，存可见列 id）。
// 只存可见集合，展示顺序恒为 RECORD_COLUMNS 定义顺序（无拖拽排序）。

export const RECORD_COLUMNS = [
  { id: "date", label: "Date" },
  { id: "model", label: "Model" },
  { id: "provider", label: "Provider" },
  { id: "agent", label: "Agent" },
  { id: "key", label: "Key" },
  { id: "session", label: "Session" },
  { id: "tokens", label: "Tokens" },
  { id: "ttft", label: "TTFT" },
  { id: "latency", label: "Latency" },
  { id: "status", label: "Status" },
] as const;

export type RecordColumnId = (typeof RECORD_COLUMNS)[number]["id"];

export const RECORD_COLUMN_IDS: RecordColumnId[] = RECORD_COLUMNS.map((c) => c.id);

export const DEFAULT_RECORD_COLUMNS: RecordColumnId[] = [...RECORD_COLUMN_IDS];

function isRecordColumnId(value: unknown): value is RecordColumnId {
  return typeof value === "string" && (RECORD_COLUMN_IDS as string[]).includes(value);
}

// 历史列 id → 新列 id：input/cacheRead/output 已合并为单列 tokens（存量配置读取时兼容）
const LEGACY_COLUMN_ALIASES: Record<string, RecordColumnId> = {
  input: "tokens",
  cacheRead: "tokens",
  output: "tokens",
  prompt: "tokens",
};

// 写入侧校验：非空数组、每项为已知 id、无重复（空数组等于整表无列，拒绝落库）
export function isValidRecordColumns(value: unknown): value is RecordColumnId[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecordColumnId(item)) return false;
    if (seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

// 读侧归一：非数组/空/全非法 → 默认全显示；合法数组丢弃未知 id（存量配置兼容），按定义顺序返回
export function normalizeRecordColumns(value: unknown): RecordColumnId[] {
  if (!Array.isArray(value)) return [...DEFAULT_RECORD_COLUMNS];
  const visible = new Set<RecordColumnId>();
  for (const item of value) {
    const id = isRecordColumnId(item)
      ? item
      : typeof item === "string"
        ? LEGACY_COLUMN_ALIASES[item]
        : undefined;
    if (id) visible.add(id);
  }
  if (visible.size === 0) return [...DEFAULT_RECORD_COLUMNS];
  return RECORD_COLUMN_IDS.filter((id) => visible.has(id));
}

// 读取侧解析：settings 原始字符串 → 可见列 id 数组
export function parseRecordColumns(raw: string | null): RecordColumnId[] {
  if (!raw) return [...DEFAULT_RECORD_COLUMNS];
  try {
    return normalizeRecordColumns(JSON.parse(raw));
  } catch {
    return [...DEFAULT_RECORD_COLUMNS];
  }
}
