// 表格列可见性配置的通用校验/归一（records_columns / audit_columns 共用）。
// 只存可见集合，展示顺序恒为 columns 定义顺序（无拖拽排序）。

export interface ColumnDef<T extends string> {
  id: T;
  label: string;
}

export function columnIds<T extends string>(columns: readonly ColumnDef<T>[]): T[] {
  return columns.map((column) => column.id);
}

// 写入侧校验：非空数组、每项为已知 id、无重复（空数组等于整表无列，拒绝落库）
export function isValidColumns<T extends string>(value: unknown, ids: readonly T[]): value is T[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !ids.includes(item as T)) return false;
    if (seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

// 读侧归一：非数组/空/全非法 → 默认全显示；合法数组丢弃未知 id，按定义顺序返回
export function normalizeColumns<T extends string>(
  value: unknown,
  ids: readonly T[],
  aliases: Record<string, T> = {}
): T[] {
  if (!Array.isArray(value)) return [...ids];
  const visible = new Set<T>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = ids.includes(item as T) ? (item as T) : aliases[item];
    if (id) visible.add(id);
  }
  if (visible.size === 0) return [...ids];
  return ids.filter((id) => visible.has(id));
}

// 读取侧解析：settings 原始字符串 → 可见列 id 数组
export function parseColumns<T extends string>(
  raw: string | null,
  ids: readonly T[],
  aliases: Record<string, T> = {}
): T[] {
  if (!raw) return [...ids];
  try {
    return normalizeColumns(JSON.parse(raw), ids, aliases);
  } catch {
    return [...ids];
  }
}

export function isColumnId<T extends string>(value: unknown, ids: readonly T[]): value is T {
  return typeof value === "string" && ids.includes(value as T);
}
