import { createHash, randomBytes } from "crypto";
import { getSetting, setSetting, deleteSetting } from "./settings";
import { safeCompare } from "@/lib/gateway/crypto";

// Recovery codes：一次性登录备用凭证，只在生成时明文返回一次，存储仅保留 SHA-256 哈希。
// 格式 XXXX-XXXX-XXXX-XXXX，字符集排除 0/O/I/1（避免视觉混淆）。
// 所有 settings 读写通过基础函数完成（内部已包 withSkipCache，无缓存残留）。

const RECOVERY_CODES_KEY = "recovery_codes";
const REMINDER_KEY = "recovery_code_login_reminder";
// A-Z 排除 I/O，数字 2-9 排除 0/1，共 32 字符
const CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GROUP_LENGTH = 4;
const GROUP_COUNT = 4;
// 归一化（大写、无连字符）后的 16 位字符集校验
const NORMALIZED_PATTERN = /^[A-HJ-NP-Z2-9]{16}$/;

interface StoredRecoveryCodes {
  hashes: string[];
  used: boolean[];
}

export function generateOneRecoveryCode(): string {
  // randomBytes 逐字节 mod 32：256 % 32 === 0，无模偏向
  const bytes = randomBytes(GROUP_COUNT * GROUP_LENGTH);
  let chars = "";
  for (let i = 0; i < bytes.length; i++) {
    chars += CODE_CHARSET[bytes[i]! % CODE_CHARSET.length]!;
  }
  const groups: string[] = [];
  for (let i = 0; i < GROUP_COUNT; i++) {
    groups.push(chars.slice(i * GROUP_LENGTH, (i + 1) * GROUP_LENGTH));
  }
  return groups.join("-");
}

export function generateRecoveryCodes(count = 4): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];
  let guard = 0;
  while (codes.length < count && guard < count * 10) {
    const code = generateOneRecoveryCode();
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
    guard++;
  }
  return codes;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// 归一化输入：去连字符/空白、大写；长度 16 且字符集合法 → 返回归一化明文，否则 null
export function parseRecoveryCodeInput(raw: string): string | null {
  const normalized = raw.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!NORMALIZED_PATTERN.test(normalized)) return null;
  return normalized;
}

// login 分流纯函数：6 位纯数字 → "totp"；归一化后 16 位合法 → "recovery"；否则 "invalid"
export function classifySecondFactorInput(raw: string): "totp" | "recovery" | "invalid" {
  const trimmed = raw.trim();
  if (/^\d{6}$/.test(trimmed)) return "totp";
  if (parseRecoveryCodeInput(trimmed) !== null) return "recovery";
  return "invalid";
}

async function readStored(): Promise<StoredRecoveryCodes | null> {
  const raw = await getSetting(RECOVERY_CODES_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRecoveryCodes>;
    if (
      !Array.isArray(parsed.hashes) ||
      !Array.isArray(parsed.used) ||
      parsed.hashes.length !== parsed.used.length
    ) {
      return null;
    }
    return { hashes: parsed.hashes, used: parsed.used };
  } catch {
    return null;
  }
}

async function writeStored(stored: StoredRecoveryCodes): Promise<void> {
  await setSetting(RECOVERY_CODES_KEY, JSON.stringify(stored));
}

// 验证并标记已用：哈希比对（safeCompare 防时序侧信道），命中未使用条目即标记并写回
export async function verifyRecoveryCode(code: string): Promise<boolean> {
  const normalized = parseRecoveryCodeInput(code);
  if (!normalized) return false;
  const stored = await readStored();
  if (!stored) return false;
  const hash = hashRecoveryCode(normalized);
  for (let i = 0; i < stored.hashes.length; i++) {
    if (!stored.used[i] && safeCompare(hash, stored.hashes[i]!)) {
      stored.used[i] = true;
      await writeStored(stored);
      return true;
    }
  }
  return false;
}

// 剩余可用数量；从未生成返回 0
export async function getRemainingRecoveryCodes(): Promise<number> {
  const stored = await readStored();
  if (!stored) return 0;
  return stored.hashes.filter((_, i) => !stored.used[i]).length;
}

// 是否生成过 recovery codes（区分「从未生成」与「全部用完」）
export async function hasRecoveryCodes(): Promise<boolean> {
  return (await readStored()) !== null;
}

// 哈希后写入 settings 表（明文只存在于本次调用参数中）。
// 统一按归一化明文（大写、无连字符）哈希，与 verifyRecoveryCode 的哈希口径一致
export async function setRecoveryCodes(codes: string[]): Promise<void> {
  const stored: StoredRecoveryCodes = {
    hashes: codes.map((c) => hashRecoveryCode(parseRecoveryCodeInput(c) ?? c)),
    used: codes.map(() => false),
  };
  await writeStored(stored);
}

export async function clearRecoveryCodes(): Promise<void> {
  await deleteSetting(RECOVERY_CODES_KEY);
}

// ---- 登录提醒标记：recovery code 登录成功后置位，Security 面板显示横幅 ----

export async function getRecoveryCodeReminder(): Promise<boolean> {
  return (await getSetting(REMINDER_KEY)) === "1";
}

export async function setRecoveryCodeReminder(): Promise<void> {
  await setSetting(REMINDER_KEY, "1");
}

export async function clearRecoveryCodeReminder(): Promise<void> {
  await deleteSetting(REMINDER_KEY);
}
