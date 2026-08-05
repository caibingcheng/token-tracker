import { eq } from "drizzle-orm";
import { db, initDatabase, settingsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret, decryptSecret } from "@/lib/gateway/crypto";

// settings 读取必须走 withSkipCache：查询缓存 TTL 10s，
// 否则改 key / epoch+1 / 解绑 TOTP 后旧凭证最长残留 10s

export async function getSetting(key: string): Promise<string | null> {
  return withSkipCache(async () => {
    await initDatabase();
    const row = (
      await db.select().from(settingsTable).where(eq(settingsTable.key, key))
    )[0];
    return row?.value ?? null;
  });
}

export async function setSetting(key: string, value: string): Promise<void> {
  return withSkipCache(async () => {
    await initDatabase();
    await db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
  });
}

export async function deleteSetting(key: string): Promise<void> {
  return withSkipCache(async () => {
    await initDatabase();
    await db.delete(settingsTable).where(eq(settingsTable.key, key));
  });
}

// ---- admin 登录 key（DB 优先，env API_KEYS 仅 bootstrap 兜底） ----

export async function getAdminApiKey(): Promise<string | null> {
  const encrypted = await getSetting("admin_api_key");
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted);
  } catch {
    return null;
  }
}

export async function setAdminApiKey(plain: string): Promise<void> {
  await setSetting("admin_api_key", encryptSecret(plain));
}

export async function deleteAdminApiKey(): Promise<void> {
  await deleteSetting("admin_api_key");
}

// ---- token_epoch：修改登录 key 时 +1，吊销所有已签发会话 ----

export async function getTokenEpoch(): Promise<number> {
  const raw = await getSetting("token_epoch");
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function bumpTokenEpoch(): Promise<number> {
  const next = (await getTokenEpoch()) + 1;
  await setSetting("token_epoch", String(next));
  return next;
}

// ---- TOTP ----

export async function isTotpEnabled(): Promise<boolean> {
  return (await getSetting("totp_enabled")) === "1";
}

export async function getTotpSecret(): Promise<string | null> {
  const encrypted = await getSetting("totp_secret");
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted);
  } catch {
    return null;
  }
}

export async function setTotpSecret(secret: string): Promise<void> {
  await setSetting("totp_secret", encryptSecret(secret));
}

export async function setTotpEnabled(enabled: boolean): Promise<void> {
  await setSetting("totp_enabled", enabled ? "1" : "0");
}

export async function clearTotp(): Promise<void> {
  await deleteSetting("totp_secret");
  await deleteSetting("totp_enabled");
}
