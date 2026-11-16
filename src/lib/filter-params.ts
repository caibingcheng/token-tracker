// 多值筛选参数解析：/api/dashboard 与 /api/records 共用。
// 前端多选以重复 query 参数传递（?agent=a&agent=b）；单值链接（?agent=a）行为不变。
// 空串与 "all" 表示「不筛选」，等价于不传。

export const MAX_FILTER_VALUE_LENGTH = 128;
export const MAX_FILTER_VALUES = 100;

export class FilterParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterParamError";
  }
}

export function parseFilterValues(
  searchParams: URLSearchParams,
  key: string
): string[] {
  const raw = searchParams.getAll(key);
  if (raw.length > MAX_FILTER_VALUES) {
    throw new FilterParamError(
      `Too many values for parameter "${key}" (max ${MAX_FILTER_VALUES})`
    );
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (value.length > MAX_FILTER_VALUE_LENGTH) {
      throw new FilterParamError(`Parameter "${key}" is too long`);
    }
    if (value === "" || value === "all" || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}
