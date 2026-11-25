// 上游 API key 的脱敏提示位（展示层的掩码规则）：从明文现算，**不落库**——
// 调用方是 keys 路由的读取路径（解密 → computeKeyHint），因此掩码依赖 GATEWAY_SECRET
// 可用；密钥缺失时由路由返回 503，密文损坏则单行回落 key #<id>。
//
// 两条约束同时成立：
// 1. 每个 key 至少留 `KEY_UNKNOWN_MIN_LENGTH` 个字符不露（短 key 优先保证未知位数，
//    宁可不显示格式标记）；
// 2. 前缀只在能真正帮忙辨认时给：长 key 给前 6 位；中段长度只给公开格式标记。
// 旧实现 maskKey 传的是密文，对 11 字符的 key 会露出 10 位，等于直接给了一半以上。

export const KEY_PREFIX_MIN_LENGTH = 24;
export const KEY_LAST4_MIN_LENGTH = 12;
// 未显示字符数下限：决定「能不能再额外露前缀」，避免短 key 被露出大半
// （例：12 位 sk- key 若带上标记只剩 5 位未知）。
export const KEY_UNKNOWN_MIN_LENGTH = 8;

// 公开的 provider 格式标记：sk- 覆盖 OpenAI / Anthropic / DeepSeek / Moonshot / Kimi /
// OpenRouter 等，gsk_ = Groq、xai- = xAI、AIza = Google Gemini。只认白名单，不取任意前缀；
// 且仅当露出后仍满足未知位数下限才展示（见 computeKeyHint）。
const PUBLIC_KEY_MARKERS = ["sk-", "gsk_", "xai-", "AIza"] as const;

function matchedMarker(plain: string): string | null {
  return PUBLIC_KEY_MARKERS.find((m) => plain.startsWith(m)) ?? null;
}

export interface KeyHint {
  /** 展示用前缀：长 key（len≥24）取前 6 位；中段长度（12≤len<24）仅当命中公开 provider 标记；null = 不展示 */
  keyPrefix: string | null;
  /** 末 4 位。空字符串 = key 太短不展示；null = 无法得到掩码（调用方回落 key #<id>） */
  keyLast4: string | null;
}

export function computeKeyHint(plain: string): KeyHint {
  const len = plain.length;
  if (len >= KEY_PREFIX_MIN_LENGTH) {
    // 长 key：前 6 + 末 4，未知位数恒 ≥ KEY_UNKNOWN_MIN_LENGTH
    return { keyPrefix: plain.slice(0, 6), keyLast4: plain.slice(-4) };
  }
  if (len >= KEY_LAST4_MIN_LENGTH) {
    // 中段长度：末 4 位恒定给出（未知位数 ≥ 8），格式标记看剩余未知位数是否仍足够
    const marker = matchedMarker(plain);
    const shown = (marker?.length ?? 0) + 4;
    return {
      keyPrefix: marker && len - shown >= KEY_UNKNOWN_MIN_LENGTH ? marker : null,
      keyLast4: plain.slice(-4),
    };
  }
  // 太短：连末四位都接近整条 key，一点都不露，靠 id 区分
  return { keyPrefix: null, keyLast4: "" };
}

// 列表展示：有前缀 → sk-pro***xyz9；只有末四位 → ***xyz9；都没有 → key #7
export function formatMaskedKey(hint: KeyHint | null | undefined, id: number): string {
  if (!hint?.keyLast4) return `key #${id}`;
  return hint.keyPrefix ? `${hint.keyPrefix}***${hint.keyLast4}` : `***${hint.keyLast4}`;
}
