// B 侧同步配置读写（settings 表，withSkipCache 保证即时生效）。
// 未配置（无 target_url/token）时 worker 完全不启动，单机使用零开销。

import { randomBytes } from "crypto";
import { hostname } from "os";
import { getSetting, setSetting, deleteSetting } from "@/lib/auth/settings";
import { encryptSecret, decryptSecret, GatewaySecretMissingError } from "@/lib/gateway/crypto";
import { isValidInstanceName, isValidInstanceUid } from "@/lib/ingest/validate";

const KEY_TARGET_URL = "sync_target_url";
const KEY_TOKEN = "sync_token_encrypted";
const KEY_INSTANCE = "sync_instance";
const KEY_UID = "sync_instance_uid";
const KEY_EPOCH = "sync_epoch";
const KEY_CURSOR = "sync_cursor";
const KEY_DROPPED = "sync_dropped_count";
const KEY_BOUND = "sync_bound_uid";
const KEY_LAST_SUCCESS = "sync_last_success_at";
const KEY_LAST_ERROR = "sync_last_error";
const KEY_LAST_ATTEMPT = "sync_last_attempt_at";
const KEY_LAST_SKIPPED_INVALID = "sync_last_skipped_invalid";

export interface SyncLastError {
  type: "auth" | "batch_rejected" | "network" | "server" | "internal";
  message: string;
  firstFailedAt: string;
}

export interface SyncConfig {
  targetUrl: string | null;
  hasToken: boolean;
  instance: string;
  uid: string; // 稳定身份键（TOFU/水位/级联删除），B 端首先生成、持久不变、reset 不重置
  epoch: string;
  cursor: number;
  droppedCount: number;
  boundUid: string | null;
  lastSuccessAt: string | null;
  lastError: SyncLastError | null;
  lastAttemptAt: string | null;
  lastSkippedInvalid: number[] | null; // 最近一次 ack 的 skippedInvalid（部分接受可观测）
}

export function isValidTargetUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// 归一化目标 URL：路径为空或 "/" 时自动补 A 端固定接收端点 /ingest/records；
// 已有路径仅去尾部斜杠（保留反代子路径场景）；query/hash 无意义一并丢弃。
export function normalizeTargetUrl(url: string): string {
  const u = new URL(url.trim());
  if (u.pathname === "" || u.pathname === "/") {
    u.pathname = "/ingest/records";
  } else {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  u.search = "";
  u.hash = "";
  return u.toString();
}

function parseNumber(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// 默认实例名：主机名清洗（小写、非法字符转 -、去首尾 -、截断 32），不可得回退 b- + 8 随机 hex
export function defaultInstanceName(): string {
  try {
    const cleaned = hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    if (cleaned) return cleaned;
  } catch {
    // fall through
  }
  return `b-${randomBytes(4).toString("hex")}`;
}

// 唯一 async 入口：读取全部配置；uid / instance / epoch 缺失时生成并持久化（幂等）。
// uid = 稳定身份键：首次生成后持久不变、不可编辑、reset 不重置；
// instance = 展示名：随时可改（重名无害，身份与名字解耦）。
export async function loadSyncConfig(): Promise<SyncConfig> {
  let uid = await getSetting(KEY_UID);
  if (!uid || !isValidInstanceUid(uid)) {
    uid = `u-${randomBytes(16).toString("hex")}`;
    await setSetting(KEY_UID, uid);
  }
  let instance = await getSetting(KEY_INSTANCE);
  if (!instance || !isValidInstanceName(instance)) {
    instance = defaultInstanceName();
    await setSetting(KEY_INSTANCE, instance);
  }
  let epoch = await getSetting(KEY_EPOCH);
  if (!epoch || epoch.length === 0 || epoch.length > 64) {
    epoch = randomBytes(16).toString("hex");
    await setSetting(KEY_EPOCH, epoch);
  }

  const targetUrl = await getSetting(KEY_TARGET_URL);
  const tokenEncrypted = await getSetting(KEY_TOKEN);
  const boundUid = await getSetting(KEY_BOUND);
  const cursor = parseNumber(await getSetting(KEY_CURSOR));
  const droppedCount = parseNumber(await getSetting(KEY_DROPPED));

  let lastError: SyncLastError | null = null;
  const lastErrorRaw = await getSetting(KEY_LAST_ERROR);
  if (lastErrorRaw) {
    try {
      const parsed = JSON.parse(lastErrorRaw) as SyncLastError;
      if (
        parsed &&
        typeof parsed.type === "string" &&
        typeof parsed.message === "string" &&
        typeof parsed.firstFailedAt === "string"
      ) {
        lastError = {
          type: parsed.type,
          message: parsed.message.slice(0, 500),
          firstFailedAt: parsed.firstFailedAt,
        };
      }
    } catch {
      lastError = null;
    }
  }

  return {
    targetUrl: targetUrl && targetUrl.trim() !== "" ? targetUrl : null,
    hasToken: !!tokenEncrypted,
    instance,
    uid,
    epoch,
    cursor,
    droppedCount,
    boundUid,
    lastSuccessAt: await getSetting(KEY_LAST_SUCCESS),
    lastError,
    lastAttemptAt: await getSetting(KEY_LAST_ATTEMPT),
    lastSkippedInvalid: parseSkippedInvalid(await getSetting(KEY_LAST_SKIPPED_INVALID)),
  };
}

function parseSkippedInvalid(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.filter((n): n is number => Number.isInteger(n) && n > 0);
    return ids.slice(0, 200); // 有界，防响应体积失控
  } catch {
    return null;
  }
}

export async function setSyncLastSkippedInvalid(ids: number[]): Promise<void> {
  if (ids.length === 0) {
    await deleteSetting(KEY_LAST_SKIPPED_INVALID);
    return;
  }
  await setSetting(KEY_LAST_SKIPPED_INVALID, JSON.stringify(ids.slice(0, 200)));
}

// 保存配置：undefined 字段不改变；token=null 清除
export async function saveSyncConfig(input: {
  targetUrl?: string;
  token?: string | null;
  instance?: string;
}): Promise<void> {
  if (input.targetUrl !== undefined) {
    if (!isValidTargetUrl(input.targetUrl)) {
      throw new Error("targetUrl must be an http(s) URL");
    }
    await setSetting(KEY_TARGET_URL, normalizeTargetUrl(input.targetUrl));
  }
  if (input.instance !== undefined) {
    if (!isValidInstanceName(input.instance)) {
      throw new Error("instance must match [a-z0-9-]{1,32}");
    }
    await setSetting(KEY_INSTANCE, input.instance);
  }
  if (input.token !== undefined) {
    if (input.token === null) {
      // 显式清除：null 或调用方删键
      await deleteSetting(KEY_TOKEN);
    } else {
      // ingest token 固定 it- 前缀（generateIngestToken 产出），非空 + 前缀校验
      const trimmed = input.token.trim();
      if (trimmed === "" || !trimmed.startsWith("it-")) {
        throw new Error("token must be non-empty and start with it-");
      }
      const encrypted = encryptSecret(trimmed);
      await setSetting(KEY_TOKEN, encrypted);
    }
  }
  const { invalidateQueryCache } = await import("@/lib/db/cache");
  invalidateQueryCache();
}

export async function getSyncToken(): Promise<string | null> {
  const encrypted = await getSetting(KEY_TOKEN);
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted);
  } catch (err) {
    if (err instanceof GatewaySecretMissingError) throw err;
    return null;
  }
}

// ---- 游标 / 计数 / 状态读写 ----

export async function setSyncCursor(cursor: number): Promise<void> {
  await setSetting(KEY_CURSOR, String(cursor));
}

export async function incrementDroppedCount(n: number): Promise<void> {
  if (n <= 0) return;
  const config = await loadSyncConfig();
  await setSetting(KEY_DROPPED, String(config.droppedCount + n));
}

export async function setSyncBoundUid(uid: string | null): Promise<void> {
  if (uid === null) {
    await deleteSetting(KEY_BOUND);
  } else {
    await setSetting(KEY_BOUND, uid);
  }
}

export async function setSyncLastSuccessAt(iso: string): Promise<void> {
  await setSetting(KEY_LAST_SUCCESS, iso);
}

export async function setSyncLastError(error: SyncLastError | null): Promise<void> {
  if (error === null) {
    await deleteSetting(KEY_LAST_ERROR);
  } else {
    await setSetting(KEY_LAST_ERROR, JSON.stringify(error));
  }
}

export async function setSyncLastAttemptAt(iso: string): Promise<void> {
  await setSetting(KEY_LAST_ATTEMPT, iso);
}

// 重置同步状态（A 重建场景）：游标归零 + 重新生成 epoch + 解除本地锁定。
// uid 是稳定身份键：reset 不重置（A 端按 uid 恢复水位/TOFU，无需重推身份）。
export async function resetSyncState(): Promise<void> {
  await setSetting(KEY_CURSOR, "0");
  await setSetting(KEY_EPOCH, randomBytes(16).toString("hex"));
  await setSyncBoundUid(null);
  await setSyncLastError(null);
  await deleteSetting(KEY_LAST_SUCCESS);
  await deleteSetting(KEY_LAST_ATTEMPT);
  await deleteSetting(KEY_LAST_SKIPPED_INVALID);
}