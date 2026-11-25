// JSON 对象字节扫描：为超大请求/响应体（>1MB）替代整包 JSON.parse（proxy.ts 的分治路径）。
// 线性、低分配：只物化被关注键的值区间 [start, end)，其余值按结构跳过——
// 字符串用 Uint8Array.indexOf 原生搜索，base64 大字符串接近 memchr 速度，
// 因此 20MB body 的扫描成本远低于 JSON.parse（后者还会在 V8 堆上物化整棵树）。
//
// 语义边界（与 JSON.parse 的差异，只影响 >1MB 路径，≤1MB 仍走 JSON.parse 保持原契约）：
// 只保证括号/引号配对与键值结构完整，不校验深层 token 合法性（数字格式、未加引号的
// 键等畸形交上游校验，网关透传其 400）。跳过值时括号深度计数不区分 {} 与 [] 匹配，
// 深层结构畸形可能被宽松完成——属同一类交上游的边界。

export interface ValueSpan {
  start: number; // 值首字节下标
  end: number; // 值结束后下标（半开区间）
}

export interface ScanResult {
  valid: boolean; // 结构扫描完成且闭合到字节尾
  isObject: boolean; // 根是对象
  memberCount: number; // 根对象成员数（根非对象为 0）
  rootClose: number; // 根对象闭合 `}` 下标（否则 -1）
  fields: Map<string, ValueSpan>; // 仅被关注键
}

export interface ObjectScan {
  fields: Map<string, ValueSpan>;
  closeIdx: number; // 闭合 `}` 下标
  memberCount: number;
}

export const CH_QUOTE = 34;
export const CH_BACKSLASH = 92;
export const CH_LBRACE = 123;
export const CH_RBRACE = 125;
export const CH_LBRACK = 91;
export const CH_RBRACK = 93;
export const CH_COMMA = 44;
export const CH_COLON = 58;

const DECODER = new TextDecoder("utf-8");

function isWs(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 13;
}

export function skipWs(bytes: Uint8Array, i: number): number {
  let p = i;
  while (p < bytes.length && isWs(bytes[p])) p++;
  return p;
}

// 扫描字符串：i 指向开引号，返回闭引号后下标；-1 非法（未闭合）。
// 关引号判定 = 前导连续反斜杠数为偶数（奇数说明该引号被转义）。
export function scanString(bytes: Uint8Array, i: number): number {
  let from = i + 1;
  while (from < bytes.length) {
    const q = bytes.indexOf(CH_QUOTE, from);
    if (q < 0) return -1;
    let bs = 0;
    let p = q - 1;
    while (p > i && bytes[p] === CH_BACKSLASH) {
      bs++;
      p--;
    }
    if ((bs & 1) === 0) return q + 1;
    from = q + 1;
  }
  return -1;
}

// 跳过一个完整 JSON 值（任意嵌套），返回值后下标；-1 非法。
// 字符串内部用原生 indexOf 跳跃（快路径），逐字节只发生在结构字符上。
export function skipValue(bytes: Uint8Array, i: number): number {
  const len = bytes.length;
  if (i < 0 || i >= len) return -1;
  const c = bytes[i];
  if (c === CH_QUOTE) return scanString(bytes, i);
  if (c === CH_LBRACE || c === CH_LBRACK) {
    let depth = 0;
    let p = i;
    while (p < len) {
      const b = bytes[p];
      if (b === CH_QUOTE) {
        const e = scanString(bytes, p);
        if (e < 0) return -1;
        p = e;
        continue;
      }
      if (b === CH_LBRACE || b === CH_LBRACK) {
        depth++;
      } else if (b === CH_RBRACE || b === CH_RBRACK) {
        depth--;
        if (depth === 0) return p + 1;
      }
      p++;
    }
    return -1;
  }
  // 数字 / true / false / null / （宽松）裸字面量：读到分隔符为止
  let p = i;
  while (
    p < len &&
    !isWs(bytes[p]) &&
    bytes[p] !== CH_COMMA &&
    bytes[p] !== CH_RBRACE &&
    bytes[p] !== CH_RBRACK
  ) {
    p++;
  }
  return p > i ? p : -1;
}

// 遍历单层对象成员（openIdx 指向 `{`）。onMember 返回 false 提前终止。
// 返回 null = 结构非法/被终止；否则给出闭合 `}` 与成员数。
export function forEachMember(
  bytes: Uint8Array,
  openIdx: number,
  onMember: (key: string, span: ValueSpan) => boolean
): ObjectScan | null {
  const len = bytes.length;
  let i = skipWs(bytes, openIdx + 1);
  let count = 0;
  if (i < len && bytes[i] === CH_RBRACE) return { fields: new Map(), closeIdx: i, memberCount: 0 };
  const fields = new Map<string, ValueSpan>();
  while (i < len) {
    if (bytes[i] !== CH_QUOTE) return null;
    const keyEnd = scanString(bytes, i);
    if (keyEnd < 0) return null;
    let key: unknown;
    try {
      key = JSON.parse(DECODER.decode(bytes.subarray(i, keyEnd)));
    } catch {
      return null;
    }
    if (typeof key !== "string") return null;
    i = skipWs(bytes, keyEnd);
    if (i >= len || bytes[i] !== CH_COLON) return null;
    i = skipWs(bytes, i + 1);
    const vStart = i;
    const vEnd = skipValue(bytes, i);
    if (vEnd < 0) return null;
    const span: ValueSpan = { start: vStart, end: vEnd };
    fields.set(key, span);
    count++;
    if (!onMember(key, span)) return null;
    i = skipWs(bytes, vEnd);
    if (i >= len) return null;
    if (bytes[i] === CH_COMMA) {
      i = skipWs(bytes, i + 1);
      continue; // 尾逗号会在下轮要求键（遇到 `}` 返回 null）→ 与 JSON.parse 同样拒绝
    }
    if (bytes[i] === CH_RBRACE) return { fields, closeIdx: i, memberCount: count };
    return null;
  }
  return null;
}

// 顶层对象扫描：整体结构 + watched 顶层键值区间，外加根对象元信息。
export function scanTopLevelObject(
  bytes: Uint8Array,
  watched: readonly string[]
): ScanResult {
  const start = skipWs(bytes, 0);
  if (start >= bytes.length || bytes[start] !== CH_LBRACE) {
    // 根非对象：整体跳过做宽松合法性检查（多模态网关入参根恒为对象，此路供契约对齐）
    const e = skipValue(bytes, start);
    const valid = e >= 0 && skipWs(bytes, e) === bytes.length;
    return { valid, isObject: false, memberCount: 0, rootClose: -1, fields: new Map() };
  }
  const watch = new Set(watched);
  const fields = new Map<string, ValueSpan>();
  const walked = forEachMember(bytes, start, (key, span) => {
    if (watch.has(key)) fields.set(key, span);
    return true;
  });
  if (walked === null) {
    return { valid: false, isObject: true, memberCount: 0, rootClose: -1, fields };
  }
  const after = skipWs(bytes, walked.closeIdx + 1);
  return {
    valid: after === bytes.length,
    isObject: true,
    memberCount: walked.memberCount,
    rootClose: walked.closeIdx,
    fields,
  };
}

// span 内首个非空白字节下标（-1 = 全空白/空）
export function firstNonWs(bytes: Uint8Array, span: ValueSpan): number {
  const i = skipWs(bytes, span.start);
  return i < span.end ? i : -1;
}

// span 是否字符串值（首个非空白字节是引号）
export function isStringSpan(bytes: Uint8Array, span: ValueSpan): boolean {
  const i = firstNonWs(bytes, span);
  return i >= 0 && bytes[i] === CH_QUOTE;
}

// span 是否非空数组（镜像 Array.isArray(x) && x.length > 0）
export function isNonEmptyArraySpan(bytes: Uint8Array, span: ValueSpan): boolean {
  const i = firstNonWs(bytes, span);
  if (i < 0 || bytes[i] !== CH_LBRACK) return false;
  const j = skipWs(bytes, i + 1);
  return j < span.end && bytes[j] !== CH_RBRACK;
}

// span 是 JSON 字符串值（含引号）→ 解码为 JS 字符串；否则 null（非字符串值）
export function decodeJsonString(bytes: Uint8Array, span: ValueSpan): string | null {
  const i = firstNonWs(bytes, span);
  if (i < 0 || bytes[i] !== CH_QUOTE) return null;
  try {
    const v: unknown = JSON.parse(DECODER.decode(bytes.subarray(span.start, span.end)));
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// span 是 JSON 值 → 宽松 parse（仅用于 stream_options 等小值）
export function parseJsonSpan(bytes: Uint8Array, span: ValueSpan): unknown {
  try {
    return JSON.parse(DECODER.decode(bytes.subarray(span.start, span.end)));
  } catch {
    return undefined;
  }
}

// 字节拼接（off-heap，jemalloc 可归还；区别于字符串拼接）
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// 区间替换：bytes[start, end) ← insert
export function spliceBytes(
  bytes: Uint8Array,
  start: number,
  end: number,
  insert: Uint8Array
): Uint8Array {
  const out = new Uint8Array(bytes.length - (end - start) + insert.length);
  out.set(bytes.subarray(0, start), 0);
  out.set(insert, start);
  out.set(bytes.subarray(end), start + insert.length);
  return out;
}
