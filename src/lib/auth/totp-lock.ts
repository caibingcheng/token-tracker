import { getSetting, setSetting, deleteSetting } from "./settings";

// TOTP 暴力防护：连续失败计数持久化到 settings 表（防重启清零），
// 每 TOTP_FAIL_THRESHOLD 次失败触发一次锁定，锁定时长随累计失败次数翻倍，封顶 24h。
// 注意：只有已通过 key 校验的请求才会走到 TOTP 校验 —— 攻击者必须先知道有效
// key 才能触发锁定，锁定不会成为 key 有效性 oracle。

const FAIL_COUNT_KEY = "totp_fail_count";
const LOCKED_UNTIL_KEY = "totp_locked_until";

export const TOTP_FAIL_THRESHOLD = 5;
export const TOTP_BASE_LOCK_MS = 15 * 60 * 1000;
export const TOTP_MAX_LOCK_MS = 24 * 60 * 60 * 1000;

export async function getTotpFailCount(): Promise<number> {
  const raw = await getSetting(FAIL_COUNT_KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function setTotpFailCount(count: number): Promise<void> {
  await setSetting(FAIL_COUNT_KEY, String(count));
}

// 锁定截止时间（毫秒时间戳）；从未锁定返回 null
export async function getTotpLockedUntil(): Promise<number | null> {
  const raw = await getSetting(LOCKED_UNTIL_KEY);
  if (!raw) return null;
  const ts = Number(raw);
  return Number.isFinite(ts) ? ts : null;
}

// 当前是否处于锁定期；锁定已过期返回 null（保留计数用于下次翻倍）
export async function isTotpLocked(): Promise<number | null> {
  const until = await getTotpLockedUntil();
  if (until === null) return null;
  return Date.now() < until ? until : null;
}

// 记录一次 TOTP 校验失败；达到阈值时触发锁定并返回锁定截止时间
export async function recordTotpFailure(): Promise<{ lockedUntil: number | null }> {
  const count = (await getTotpFailCount()) + 1;
  await setTotpFailCount(count);
  if (count < TOTP_FAIL_THRESHOLD) return { lockedUntil: null };
  const rounds = Math.floor(count / TOTP_FAIL_THRESHOLD);
  const duration = Math.min(
    TOTP_BASE_LOCK_MS * 2 ** (rounds - 1),
    TOTP_MAX_LOCK_MS
  );
  const lockedUntil = Date.now() + duration;
  await setSetting(LOCKED_UNTIL_KEY, String(lockedUntil));
  return { lockedUntil };
}

// TOTP 校验通过 / 登录成功后清零
export async function clearTotpFailures(): Promise<void> {
  await deleteSetting(FAIL_COUNT_KEY);
  await deleteSetting(LOCKED_UNTIL_KEY);
}
