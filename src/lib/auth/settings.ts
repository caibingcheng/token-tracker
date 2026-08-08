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

// ---- env 登录 key 解析：ADMIN_API_KEY（优先）→ API_KEYS（deprecated 兼容） ----

export function getEnvAdminKeys(): string[] {
  const primary = process.env.ADMIN_API_KEY;
  if (primary && primary.trim() !== "") {
    return primary.split(",").map((k) => k.trim()).filter(Boolean);
  }
  const legacy = process.env.API_KEYS;
  if (legacy && legacy.trim() !== "") {
    console.warn(
      "[auth] API_KEYS is deprecated, please use ADMIN_API_KEY instead"
    );
    return legacy.split(",").map((k) => k.trim()).filter(Boolean);
  }
  return [];
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

// ---- HIDDEN_PROVIDERS：settings 优先，env 仅 fallback（纯展示配置，免重启热更新） ----

// 返回 settings 中的原始字符串；行不存在返回 null（调用方自行区分「已保存」与「未保存」）
export async function getHiddenProvidersSetting(): Promise<string | null> {
  return getSetting("hidden_providers");
}

export async function setHiddenProvidersSetting(raw: string): Promise<void> {
  await setSetting("hidden_providers", raw);
  // 清空 normalizeModel 的 rawToCanonical 缓存：
  // 面板改分组后立即生效，避免与 10s 查询缓存叠加导致旧匿名名残留
  const { invalidateModelCache } = await import("@/lib/model-registry");
  invalidateModelCache();
}

// ---- 会话 token TTL：settings 优先 → env SESSION_TOKEN_TTL_HOURS → 默认 24h ----

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export async function resolveSessionTtlMs(): Promise<number> {
  const stored = await getSetting("session_token_ttl_hours");
  if (stored !== null) {
    const n = Number(stored);
    if (Number.isFinite(n) && n > 0) {
      return n * 60 * 60 * 1000;
    }
  }
  const hours = Number(process.env.SESSION_TOKEN_TTL_HOURS);
  if (Number.isFinite(hours) && hours > 0) {
    return hours * 60 * 60 * 1000;
  }
  return DEFAULT_TTL_MS;
}

export async function getSessionTtlHoursSetting(): Promise<number | null> {
  const stored = await getSetting("session_token_ttl_hours");
  if (stored === null) return null;
  const n = Number(stored);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function setSessionTtlHoursSetting(hours: number): Promise<void> {
  await setSetting("session_token_ttl_hours", String(hours));
}

// ---- 流式空闲超时（分钟）：settings 表配置（面板优先），默认 30min，无 env ----

const DEFAULT_STREAM_IDLE_TIMEOUT_MINUTES = 30;

export async function resolveStreamIdleTimeoutMs(): Promise<number> {
  const stored = await getSetting("stream_idle_timeout_minutes");
  if (stored !== null) {
    const n = Number(stored);
    if (Number.isFinite(n) && n > 0) {
      return n * 60 * 1000;
    }
  }
  return DEFAULT_STREAM_IDLE_TIMEOUT_MINUTES * 60 * 1000;
}

export async function getStreamIdleTimeoutMinutesSetting(): Promise<number | null> {
  const stored = await getSetting("stream_idle_timeout_minutes");
  if (stored === null) return null;
  const n = Number(stored);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function setStreamIdleTimeoutMinutesSetting(minutes: number): Promise<void> {
  await setSetting("stream_idle_timeout_minutes", String(minutes));
}
