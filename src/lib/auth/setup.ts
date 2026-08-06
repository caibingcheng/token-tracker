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

// 密钥强度：≥16 字符
export function isValidSetupKey(key: string): boolean {
  return typeof key === "string" && key.trim().length >= 16;
}

// 内存滑动窗口限流：setup 独立 bucket（与 login 同款模式）
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 10;
const setupAttempts = new Map<string, number[]>();

export function checkSetupRateLimit(key: string): boolean {
  const now = Date.now();
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
