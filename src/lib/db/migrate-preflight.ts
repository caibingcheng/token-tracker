// 迁移前预检 / 自动修复 / 迁移后问题记录。
//
// 目标：升级不该把服务搞挂。
//   - 结构性迁移（加列）失败 → 仍然致命（缺列后所有查询都会挂，没有可用降级）
//   - 数据整理类迁移失败 → 降级启动（跳过 + 记录 + 下次启动自动重试，因为迁移都幂等）
//   - 已知的必然失败原因（legacy 折叠时的孤儿外键行）→ 迁移前主动清理并审计
//   - 有待跑迁移时先做一份一致性快照，人工可一键回退
import { copyFileSync, existsSync, unlinkSync } from "fs";

export const MIGRATION_SNAPSHOT_SUFFIX = ".pre-migrate";
export const LEGACY_NAMED_ROUTES_BACKUP_TABLE = "named_routes_pre_protocol_merge";
// settings 表里的 key：降级启动时遗留的迁移问题（供 Admin banner 读，恢复正常后删掉）
export const MIGRATION_ISSUES_KEY = "migration_issues";
// settings 里是否还留着上次降级启动的迁移问题（= 上次迁移没跑完）
export function hasPendingIssues(client: any): boolean {
  try {
    if (!hasTable(client, "settings")) return false;
    return Boolean(
      client.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(MIGRATION_ISSUES_KEY)
    );
  } catch {
    return false;
  }
}

function tableColumns(client: any, table: string): string[] {
  return client
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c: any) => c.name);
}

function hasTable(client: any, table: string): boolean {
  return Boolean(
    client
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table)
  );
}

// 待跑迁移清单（名字即人可读标识）。空数组 = 结构已是当前版本，无需快照。
export function pendingMigrations(client: any): string[] {
  const pending: string[] = [];

  if (hasTable(client, "upstreams")) {
    const cols = tableColumns(client, "upstreams");
    if (!cols.includes("protocols")) pending.push("upstreams.protocols");
    if (!cols.includes("auth_style")) pending.push("upstreams.auth_style");
  }

  if (hasTable(client, "token_records")) {
    const cols = tableColumns(client, "token_records");
    if (!cols.includes("request_model")) pending.push("token_records.request_model");
    if (cols.includes("target_model")) pending.push("token_records.drop_target_model");
  }

  if (hasTable(client, "routing_rules") || hasTable(client, "virtual_models")) {
    pending.push("named_routes.legacy_fold");
  }

  if (hasTable(client, "named_routes") && tableColumns(client, "named_routes").includes("protocol")) {
    pending.push("named_routes.drop_protocol");
  }

  if (hasTable(client, "named_route_targets")) {
    const cols = client.prepare(`PRAGMA table_info(named_route_targets)`).all() as {
      name: string;
      notnull: number;
    }[];
    if (cols.find((c) => c.name === "upstream_id")?.notnull === 1) {
      pending.push("named_route_targets.nullable_upstream");
    }
  }

  if (hasTable(client, "sync_instances") && !tableColumns(client, "sync_instances").includes("uid")) {
    pending.push("sync_instances.uid");
  }
  if (hasTable(client, "ingest_tokens") && tableColumns(client, "ingest_tokens").includes("bound_instance")) {
    pending.push("ingest_tokens.bound_uid");
  }

  return pending;
}

// 迁移前一致性快照：VACUUM INTO 生成独立副本（不受 WAL/半写影响），
// 失败退回「checkpoint + 文件复制」。整体失败只警告——快照是保险，不是启动前提。
//
// keepExisting：上一次启动留下了未完成的迁移（settings.migration_issues 仍在）时传 true，
// 此时**不覆盖**已有快照——否则会把「升级前」的回退点换成「部分迁移已生效」的状态。
// 全部迁移跑通后该 key 会被清掉，下一次升级就正常刷新快照。
export function snapshotBeforeMigrate(
  client: any,
  dbPath: string,
  opts: { keepExisting?: boolean } = {}
): string | null {
  const target = `${dbPath}${MIGRATION_SNAPSHOT_SUFFIX}`;
  try {
    if (existsSync(target)) {
      if (opts.keepExisting) {
        console.log(
          `[migrate] keeping the existing pre-migration snapshot (previous migrations still incomplete): ${target}`
        );
        return target;
      }
      unlinkSync(target);
    }
    try {
      client.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } catch (vacuumErr) {
      console.warn("[migrate] VACUUM INTO failed, falling back to file copy:", vacuumErr);
      client.pragma("wal_checkpoint(TRUNCATE)");
      copyFileSync(dbPath, target);
    }
    console.log(`[migrate] pre-migration snapshot: ${target}`);
    return target;
  } catch (err) {
    console.warn("[migrate] could not create a pre-migration snapshot:", err);
    return null;
  }
}

// legacy 折叠的已知必然失败原因：脏数据里的孤儿外键行会让 INSERT 直接 abort
// （FK 违反不走 ON CONFLICT/OR IGNORE）。迁移前先删掉并审计，避免升级卡死在启动。
export function pruneOrphanLegacyRows(client: any): {
  routingRules: number;
  virtualModelRoutes: number;
} {
  const result = { routingRules: 0, virtualModelRoutes: 0 };
  if (hasTable(client, "routing_rules")) {
    const stmt = client.prepare(
      `DELETE FROM routing_rules WHERE upstream_id NOT IN (SELECT id FROM upstreams)`
    );
    result.routingRules = stmt.run().changes ?? 0;
  }
  if (hasTable(client, "virtual_model_routes")) {
    const stmt = client.prepare(
      `DELETE FROM virtual_model_routes
       WHERE upstream_id NOT IN (SELECT id FROM upstreams)
          OR virtual_model_id NOT IN (SELECT id FROM virtual_models)`
    );
    result.virtualModelRoutes = stmt.run().changes ?? 0;
  }
  return result;
}
