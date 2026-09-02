// A 侧 ingest token 管理：生成 / 加密比对 / CRUD。
// 仿 virtual_keys 模式：AES-256-GCM 加密落库；认证时全表解密比对（随机 IV 无法索引，
// safeCompare 防时序侧信道）；admin 列表可回显明文供复制（与 virtual_keys 惯例一致），
// 创建时额外展示一次明文提示立即配置到 B 端。

import { eq, desc, sql } from "drizzle-orm";
import { db, initDatabase, ingestTokensTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { randomBytes } from "crypto";
import {
  encryptSecret,
  decryptSecret,
  safeCompare,
  GatewaySecretMissingError,
} from "@/lib/gateway/crypto";

export interface IngestTokenInfo {
  id: number;
  name: string;
  apiKey: string | null; // admin 列表回显明文（与 virtual_keys 同模式）；解密失败为 null
  enabled: boolean;
  boundUid: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export function generateIngestToken(): string {
  return `it-${randomBytes(24).toString("base64url")}`;
}

// 全表解密比对认证（ingest 端点专用，与虚拟 key 同口径；GATEWAY_SECRET 缺失向上传播）
// ⚠️ 必须同步执行：withSkipCache 基于 AsyncLocalStorage，await 后的 SQL 执行在微任务中
// 会丢失 skipCache 上下文落到缓存读（读不到刚创建的 token / 读到旧绑定）。
// better-sqlite3 驱动为同步 API，.all() 在 ALS 上下文内完成，跳过缓存直读真实库。
export async function resolveIngestToken(
  token: string
): Promise<IngestTokenInfo | null> {
  await initDatabase();
  return withSkipCache(() => {
    const rows = db.select().from(ingestTokensTable).all();
    for (const row of rows) {
      try {
        const plain = decryptSecret(row.apiKeyEncrypted);
        if (safeCompare(plain, token)) {
          return {
            id: row.id,
            name: row.name,
            apiKey: null, // 认证路径不回显明文
            enabled: row.enabled === 1,
            boundUid: row.boundUid ?? null,
            lastUsedAt: row.lastUsedAt ?? null,
            createdAt: row.createdAt,
          };
        }
      } catch (err) {
        if (err instanceof GatewaySecretMissingError) throw err;
        continue;
      }
    }
    return null;
  });
}

export async function listIngestTokens(): Promise<IngestTokenInfo[]> {
  await initDatabase();
  // 与 resolveIngestToken 同因：同步执行保证 skipCache 上下文生效
  return withSkipCache(() => {
    const rows = db.select().from(ingestTokensTable).orderBy(desc(ingestTokensTable.id)).all();
    return rows.map((row: any) => {
      let apiKey: string | null = null;
      try {
        apiKey = decryptSecret(row.apiKeyEncrypted);
      } catch (err) {
        // GATEWAY_SECRET 缺失向上传播（fail-closed），其余解密失败行明文置 null
        if (err instanceof GatewaySecretMissingError) throw err;
      }
      return {
        id: row.id,
        name: row.name,
        apiKey,
        enabled: row.enabled === 1,
        boundUid: row.boundUid ?? null,
        lastUsedAt: row.lastUsedAt ?? null,
        createdAt: row.createdAt,
      };
    });
  });
}

export async function createIngestToken(name: string): Promise<{
  token: IngestTokenInfo;
  plainKey: string;
}> {
  await initDatabase();
  const plainKey = generateIngestToken();
  const encrypted = encryptSecret(plainKey);
  const result = await withSkipCache(async () =>
    db.insert(ingestTokensTable).values({
      name,
      apiKeyEncrypted: encrypted,
      enabled: 1,
    }).returning()
  );
  return {
    token: {
      id: result[0].id,
      name: result[0].name,
      apiKey: plainKey,
      enabled: true,
      boundUid: null,
      lastUsedAt: null,
      createdAt: result[0].createdAt,
    },
    plainKey,
  };
}

export async function updateIngestToken(
  id: number,
  patch: { name?: string; enabled?: boolean } | null
): Promise<boolean> {
  await initDatabase();
  let changed = false;
  await withSkipCache(async () => {
    const flow =
      patch === null
        ? db.delete(ingestTokensTable).where(eq(ingestTokensTable.id, id))
        : db
            .update(ingestTokensTable)
            .set({
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
            })
            .where(eq(ingestTokensTable.id, id));
    const result = await flow;
    changed = Number(result?.changes ?? 0) > 0;
  });
  return changed;
}

export async function unbindIngestToken(id: number): Promise<boolean> {
  await initDatabase();
  let changed = false;
  await withSkipCache(async () => {
    const result = await db
      .update(ingestTokensTable)
      .set({ boundUid: null })
      .where(eq(ingestTokensTable.id, id));
    changed = Number(result?.changes ?? 0) > 0;
  });
  return changed;
}

// 存在性检查（同步水位删除路由复用）
export async function ingestTokenExists(id: number): Promise<boolean> {
  await initDatabase();
  return withSkipCache(async () => {
    const row = await db
      .select({ id: ingestTokensTable.id })
      .from(ingestTokensTable)
      .where(eq(ingestTokensTable.id, id))
      .get();
    return !!row;
  });
}