import { eq } from "drizzle-orm";
import { db, initDatabase, settingsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret } from "@/lib/gateway/crypto";
import { getEnvAdminKeys, getSetting, resolveSessionTtlMs } from "./settings";
import { signSessionToken, keyFingerprint } from "./session";

// 首次设置向导：仅当 DB 无 admin_api_key 且 env 无任何登录 key 时可执行。
// 这是全项目唯一 fail-open 入口，判定必须严格：多源否定判断（DB 无 key AND env 无 key）。

export class SetupNotAllowedError extends Error {
  constructor() {
    super("Setup is not allowed: admin key already configured");
    this.name = "SetupNotAllowedError";
  }
}

// 登录 key 强度：≥16 字符且至少 2 种字符类别（大写 / 小写 / 数字 / 符号）
const UPPER = /[A-Z]/;
const LOWER = /[a-z]/;
const DIGIT = /\d/;
const SYMBOL = /[^A-Za-z0-9]/;

export function isStrongLoginKey(key: string): boolean {
  const k = typeof key === "string" ? key.trim() : "";
  if (k.length < 16) return false;
  let classes = 0;
  if (UPPER.test(k)) classes++;
  if (LOWER.test(k)) classes++;
  if (DIGIT.test(k)) classes++;
  if (SYMBOL.test(k)) classes++;
  return classes >= 2;
}

export function isValidSetupKey(key: string): boolean {
  return isStrongLoginKey(key);
}

// 内存滑动窗口限流：setup 独立 bucket（与 login 同款模式）
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 10;
const setupAttempts = new Map<string, number[]>();
let sweepCounter = 0;

export function checkSetupRateLimit(key: string): boolean {
  const now = Date.now();
  // 惰性清扫：每 64 次调用清理一次过期条目，防伪造 key 无界增长
  sweepCounter++;
  if (sweepCounter % 64 === 0) {
    setupAttempts.forEach((ts, k) => {
      if (ts.length === 0 || now - ts[ts.length - 1]! >= RATE_WINDOW_MS) {
        setupAttempts.delete(k);
      }
    });
  }
  const timestamps = (setupAttempts.get(key) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS
  );
  if (timestamps.length >= RATE_MAX_ATTEMPTS) {
    setupAttempts.set(key, timestamps);
    return true;
  }
  timestamps.push(now);
  setupAttempts.set(key, timestamps);
  return false;
}

// 闸门：DB 无 key AND env 无有效 key → true
export async function canRunSetup(): Promise<boolean> {
  await initDatabase();
  if (await getSetting("admin_api_key")) return false;
  return getEnvAdminKeys().length === 0;
}

// 事务内 re-check 闸门 → 写入 admin_api_key → token_epoch + 1 → 签发会话 token。
// 事务保证并发双 POST 只有一个成功（better-sqlite3 串行化写事务）。
// 外层 withSkipCache：事务内 select 不走查询缓存，避免读到 10s 缓存旧值。
// 注意：better-sqlite3 事务回调为同步执行，内部禁止 await。
export async function runSetup(plainKey: string): Promise<string> {
  await initDatabase();
  if (getEnvAdminKeys().length > 0) {
    throw new SetupNotAllowedError();
  }
  const ttlMs = await resolveSessionTtlMs();
  return withSkipCache(() =>
    db.transaction((tx: any) => {
      const existing = tx
        .select()
        .from(settingsTable)
        .where(eq(settingsTable.key, "admin_api_key"))
        .get();
      if (existing?.value) {
        throw new SetupNotAllowedError();
      }

      tx.insert(settingsTable)
        .values({ key: "admin_api_key", value: encryptSecret(plainKey) })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: encryptSecret(plainKey) },
        })
        .run();

      const epochRow = tx
        .select()
        .from(settingsTable)
        .where(eq(settingsTable.key, "token_epoch"))
        .get();
      const prevEpoch = Number(epochRow?.value ?? 0);
      const epoch = (Number.isFinite(prevEpoch) ? prevEpoch : 0) + 1;
      tx.insert(settingsTable)
        .values({ key: "token_epoch", value: String(epoch) })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: String(epoch) },
        })
        .run();

      return signSessionToken(epoch, keyFingerprint(plainKey), ttlMs);
    })
  );
}
