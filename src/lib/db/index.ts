import { sql } from "drizzle-orm";
import { wrapDatabaseClient } from "./cache";
import { offsetMinutesToSqlModifiers } from "@/lib/timezone-utils";
import { migrateColumns, migrateTokenRecordsModelColumns, migrateNamedRoutesTables, migrateNamedRouteTargetsNullableUpstream, migrateSyncInstancesTable, migrateIngestTokensTable } from "./migrate";

let db: any;
let rawClient: any;
let tokenRecords: any;
let upstreamsTable: any;
let upstreamKeysTable: any;
let virtualKeysTable: any;
let settingsTable: any;
let adminAuditLogsTable: any;
let upstreamModelHealthTable: any;
let namedRoutesTable: any;
let namedRouteTargetsTable: any;
let modelPricesTable: any;
let ingestTokensTable: any;
let syncInstancesTable: any;
let initialized = false;
// in-flight 初始化：并发调用 initDatabase()（多路由同时冷启动）只开一个连接、只跑一遍
// DDL/迁移。失败置空，允许下次重试；成功则靠 initialized 短路。
let initPromise: Promise<void> | undefined;
// closeDb 递增（仅测试路径）：正在飞的 ensureClient 在提交状态前校验它，
// 避免 closeDb 之后又被一次迟到的初始化「复活」成 initialized=true + db 已关闭。
let epoch = 0;

// 未配置时的默认库路径（与 .env.example / docs / scripts/migrate-pg-to-sqlite.ts 一致）：
// 本地开发零配置能起，Docker 由 compose / entrypoint 显式传入
const DEFAULT_DB_PATH = "./data/token-tracker.db";

// 已打开的 SQLite 客户端登记表（挂在 globalThis，跨模块实例共享）。
// 测试里 vi.resetModules() 会重建模块实例，每个实例都有自己的连接；
// closeDb 必须能关掉历史连接，否则 Windows 上临时库文件删不掉。
const CLIENT_REGISTRY = Symbol.for("token-tracker.sqlite-clients");

export async function initDatabase() {
  if (initialized) return;
  if (!initPromise) {
    const p = ensureClient()
      .then(() => {
        // closeDb 已复位并可能已起了新一轮 init：旧 promise 不得改状态
        if (initPromise !== p) return;
        initialized = true;
      })
      .catch((err) => {
        if (initPromise === p) initPromise = undefined;
        throw err;
      });
    initPromise = p;
  }
  await initPromise;
}

// 关闭所有已打开的 SQLite 句柄并重置本实例状态。仅供测试 afterAll 使用：
// Windows 上句柄未关时临时库文件删不掉（unlink EPERM），Linux 上不报错。
// 生产代码不走这里；重复调用安全。
export function closeDb() {
  const registry: any[] = (globalThis as any)[CLIENT_REGISTRY] ?? [];
  for (const client of registry) {
    try {
      client.close();
    } catch {
      // 已关闭或连接失效，忽略
    }
  }
  registry.length = 0;
  db = undefined;
  rawClient = undefined;
  initPromise = undefined;
  epoch += 1;
  initialized = false;
}

// 底层 better-sqlite3 句柄：大结果集需要 stmt.iterate() 游标逐行消费，
// 而 drizzle 的 select 只能一次性返回完整数组（30 万行 → 上百 MB 常驻堆）。
// 仅供「必须遍历全部行」的聚合查询使用，业务读写仍走 drizzle。
export function getRawClient(): any {
  if (!rawClient) {
    throw new Error("SQLite client not initialized; call initDatabase() first");
  }
  return rawClient;
}

async function ensureClient() {
  if (db) return;

  // 上次初始化中途失败会留下「已登记、未提交状态」的句柄：摘牌并关掉，避免重试时
  // 死条目在 globalThis registry 里无上界累积（生产不走 closeDb，没有其他回收路径）。
  if (rawClient) {
    const registry: any[] = (globalThis as any)[CLIENT_REGISTRY] ?? [];
    const idx = registry.lastIndexOf(rawClient);
    if (idx >= 0) registry.splice(idx, 1);
    try {
      rawClient.close();
    } catch {
      // 已关闭或连接失效，忽略
    }
    rawClient = undefined;
  }

  // closeDb 递增 epoch：若初始化期间被打断，结尾不提交状态（见下方提交处）
  const myEpoch = epoch;

  const { default: Database } = await import("better-sqlite3");
  const { mkdirSync } = await import("fs");
  const { dirname } = await import("path");
  const sqliteModule = await import("./schema-sqlite");

  const dbPath = process.env.SQLITE_DATABASE_PATH || DEFAULT_DB_PATH;

  mkdirSync(dirname(dbPath), { recursive: true });
  const client = new Database(dbPath);
  // 先登记再配置：pragma 若抛错，句柄已在 CLIENT_REGISTRY 里，closeDb() 才能关掉；
  // 否则 fd 悬挂到进程退出，下次 ensureClient 会再开一个。
  rawClient = client;
  ((globalThis as any)[CLIENT_REGISTRY] ??= []).push(client);
  // 页缓存上限：better-sqlite3 编译期默认 SQLITE_DEFAULT_CACHE_SIZE=-16000（≈15.6MB），
  // 这块是 SQLite 自己 malloc 的 native 内存（anon，V8 的 GC 定时器收不回来）。
  // 实测（32MB / 30 万行库，dashboard 全表聚合 + 总量 + distinct 扫描）：cache_size
  // -16000 → cgroup anon +29.8MB，-2000 → +9.1MB；耗时 216ms → 214ms（顺序全表扫描
  // 本就不吃缓存复用，热页由 OS page cache 兜底，不在进程占用里）。
  // 代价：库页超出 2MB 时会更多走 read()，宿主内存紧张时那批页被回收后需重新读盘。
  client.pragma("cache_size = -2000");

  const { drizzle } = await import("drizzle-orm/better-sqlite3");

  client.exec(`
    CREATE TABLE IF NOT EXISTS token_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      agent TEXT NOT NULL DEFAULT 'unknown',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_token_records_created_at ON token_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_token_records_provider_created_at ON token_records(provider, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_records_model_created_at ON token_records(model, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_records_provider_model_created_at ON token_records(provider, model, created_at);
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS upstreams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      protocol TEXT NOT NULL,
      base_url TEXT NOT NULL,
      enabled_models TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      health_check_model TEXT,
      health_status TEXT,
      health_updated_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS upstream_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
      api_key_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_status TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_upstream_keys_upstream_id ON upstream_keys(upstream_id);
    CREATE TABLE IF NOT EXISTS virtual_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      api_key_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      comment TEXT,
      enabled_models TEXT NOT NULL DEFAULT '["*"]',
      last_used_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor TEXT,
      target_type TEXT,
      target_id INTEGER,
      ip TEXT,
      user_agent TEXT,
      details TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_action_created_at ON admin_audit_logs(action, created_at);
    CREATE TABLE IF NOT EXISTS upstream_model_health (
      upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (upstream_id, model)
    );
    CREATE TABLE IF NOT EXISTS named_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL,
      instruction TEXT NOT NULL DEFAULT '',
      classifier_upstream_id INTEGER NOT NULL DEFAULT 0,
      classifier_model TEXT NOT NULL DEFAULT '',
      classifier_kind TEXT NOT NULL DEFAULT 'priority',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_named_routes_name_protocol ON named_routes(name, protocol);
    CREATE INDEX IF NOT EXISTS idx_named_routes_protocol_name ON named_routes(protocol, name);
    CREATE TABLE IF NOT EXISTS named_route_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      named_route_id INTEGER NOT NULL REFERENCES named_routes(id) ON DELETE CASCADE,
      upstream_id INTEGER REFERENCES upstreams(id) ON DELETE CASCADE, -- NULL = 无 provider 目标（按路由解析）
      upstream_model TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_named_route_targets_route_upstream_model
      ON named_route_targets(named_route_id, upstream_id, upstream_model);
    CREATE INDEX IF NOT EXISTS idx_named_route_targets_named_route ON named_route_targets(named_route_id);
    CREATE TABLE IF NOT EXISTS model_prices (
      model TEXT PRIMARY KEY,
      input_price REAL NOT NULL,
      output_price REAL NOT NULL,
      cache_read_price REAL,
      cache_write_price REAL,
      source TEXT NOT NULL,
      models_dev_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ingest_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      bound_uid TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS sync_instances (
      uid TEXT PRIMARY KEY,
      instance_name TEXT,
      epoch TEXT NOT NULL,
      last_record_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
  `);

  // 存量补列必须在所有 CREATE TABLE 之后执行：全新库先建表再补列，旧库表已存在、幂等补列
  migrateColumns(client, [
    {
      table: "token_records",
      columns: [
        { name: "status", definition: "status TEXT" },
        { name: "latency_ms", definition: "latency_ms INTEGER" },
        { name: "ttft_ms", definition: "ttft_ms INTEGER" },
        { name: "virtual_key_id", definition: "virtual_key_id INTEGER" },
        { name: "user_agent", definition: "user_agent TEXT" },
        { name: "session_id", definition: "session_id TEXT" },
        { name: "remote_instance_uid", definition: "remote_instance_uid TEXT" },
      ],
    },
    {
      table: "virtual_keys",
      columns: [
        { name: "comment", definition: "comment TEXT" },
        { name: "enabled_models", definition: "enabled_models TEXT NOT NULL DEFAULT '[\"*\"]'" },
        { name: "max_rpm", definition: "max_rpm INTEGER" },
        { name: "max_tpm", definition: "max_tpm INTEGER" },
        { name: "max_daily_tokens", definition: "max_daily_tokens INTEGER" },
        { name: "max_monthly_tokens", definition: "max_monthly_tokens INTEGER" },
      ],
    },
    {
      table: "upstreams",
      columns: [
        { name: "health_check_model", definition: "health_check_model TEXT" },
        { name: "health_status", definition: "health_status TEXT" },
        { name: "health_updated_at", definition: "health_updated_at TEXT" },
        { name: "balance", definition: "balance TEXT" },
        { name: "balance_updated_at", definition: "balance_updated_at TEXT" },
        { name: "balance_fetch_mode", definition: "balance_fetch_mode TEXT NOT NULL DEFAULT 'auto'" },
        { name: "proxy_url_encrypted", definition: "proxy_url_encrypted TEXT" },
        { name: "header_transforms", definition: "header_transforms TEXT" },
        { name: "probe_config", definition: "probe_config TEXT" },
        { name: "model_probe_configs", definition: "model_probe_configs TEXT" },
        { name: "classifier_models", definition: "classifier_models TEXT" },
      ],
    },
  ]);

  // token_records 专用迁移：model 列改为真实名 + request_model 回填 + target_model 删除
  migrateTokenRecordsModelColumns(client);

  // 命名路由迁移：把存量 routing_rules / virtual_models + virtual_model_routes
  // 折叠进 named_routes + named_route_targets，然后删旧表（幂等，全新库无旧表自动跳过）
  migrateNamedRoutesTables(client);

  // named_route_targets.upstream_id 放宽可空（无 provider 目标）：NOT NULL 存量表重建（幂等）
  migrateNamedRouteTargetsNullableUpstream(client);

  // 多实例同步表专用迁移（幂等，全新库无旧结构自动跳过）：
  // - sync_instances：instance 主键 → uid 主键 + instance_name（旧行丢弃）
  // - ingest_tokens：bound_instance → bound_uid（行回迁 + bound_uid 置 NULL）
  migrateSyncInstancesTable(client);
  migrateIngestTokensTable(client);

  client.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_records_virtual_key_id ON token_records(virtual_key_id);
    CREATE INDEX IF NOT EXISTS idx_token_records_vk_created_at ON token_records(virtual_key_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_records_remote_instance_uid_created_at ON token_records(remote_instance_uid, created_at);
  `);

  // 模块状态最后一次性提交：DDL/迁移任一步抛错时 db 保持 undefined，下次 initDatabase
  // 才能重试；否则 `if (db) return` 会短路，带着残缺 schema 报初始化成功。
  //
  // 查询缓存也在这一步才启用：migrate* 用 `PRAGMA table_info` / `sqlite_master` 探测存量
  // 结构，若这些读被缓存，迁移中途失败后 10s 内重试会读到「迁移前」快照并重复
  // ALTER TABLE（duplicate column name），重试路径在最需要它时反而必定失败。
  if (epoch !== myEpoch) {
    // closeDb 在初始化期间被调用：不提交状态（句柄已由 closeDb 关闭）
    throw new Error("database closed during initialization");
  }
  wrapDatabaseClient(client);
  db = drizzle(client, { schema: sqliteModule });
  tokenRecords = sqliteModule.tokenRecords;
  upstreamsTable = sqliteModule.upstreams;
  upstreamKeysTable = sqliteModule.upstreamKeys;
  virtualKeysTable = sqliteModule.virtualKeys;
  settingsTable = sqliteModule.settings;
  adminAuditLogsTable = sqliteModule.adminAuditLogs;
  upstreamModelHealthTable = sqliteModule.upstreamModelHealth;
  namedRoutesTable = sqliteModule.namedRoutes;
  namedRouteTargetsTable = sqliteModule.namedRouteTargets;
  modelPricesTable = sqliteModule.modelPrices;
  ingestTokensTable = sqliteModule.ingestTokens;
  syncInstancesTable = sqliteModule.syncInstances;
  console.log("[DB] SQLite initialized at:", dbPath);
}

export function getDateGroupExpr(
  granularity: string,
  timezoneOffsetMinutes?: number
) {
  if (!tokenRecords) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }

  const modifiers =
    timezoneOffsetMinutes !== undefined
      ? offsetMinutesToSqlModifiers(timezoneOffsetMinutes)
      : [];

  if (granularity === "week") {
    if (modifiers.length === 0) {
      return sql<string>`strftime('%Y-%W', ${tokenRecords.createdAt})`;
    }
    if (modifiers.length === 1) {
      return sql<string>`strftime('%Y-%W', ${tokenRecords.createdAt}, ${modifiers[0]})`;
    }
    return sql<string>`strftime('%Y-%W', ${tokenRecords.createdAt}, ${modifiers[0]}, ${modifiers[1]})`;
  }

  if (granularity === "month") {
    if (modifiers.length === 0) {
      return sql<string>`strftime('%Y-%m', ${tokenRecords.createdAt})`;
    }
    if (modifiers.length === 1) {
      return sql<string>`strftime('%Y-%m', ${tokenRecords.createdAt}, ${modifiers[0]})`;
    }
    return sql<string>`strftime('%Y-%m', ${tokenRecords.createdAt}, ${modifiers[0]}, ${modifiers[1]})`;
  }

  if (granularity === "hour") {
    if (modifiers.length === 0) {
      return sql<string>`strftime('%H', ${tokenRecords.createdAt})`;
    }
    if (modifiers.length === 1) {
      return sql<string>`strftime('%H', ${tokenRecords.createdAt}, ${modifiers[0]})`;
    }
    return sql<string>`strftime('%H', ${tokenRecords.createdAt}, ${modifiers[0]}, ${modifiers[1]})`;
  }

  if (modifiers.length === 0) {
    return sql<string>`strftime('%Y-%m-%d', ${tokenRecords.createdAt})`;
  }
  if (modifiers.length === 1) {
    return sql<string>`strftime('%Y-%m-%d', ${tokenRecords.createdAt}, ${modifiers[0]})`;
  }
  return sql<string>`strftime('%Y-%m-%d', ${tokenRecords.createdAt}, ${modifiers[0]}, ${modifiers[1]})`;
}

export { db, tokenRecords, upstreamsTable, upstreamKeysTable, virtualKeysTable, settingsTable, adminAuditLogsTable, upstreamModelHealthTable, namedRoutesTable, namedRouteTargetsTable, modelPricesTable, ingestTokensTable, syncInstancesTable };
export type { TokenRecord, NewTokenRecord, NamedRoute, NewNamedRoute, NamedRouteTarget, NewNamedRouteTarget } from "./schema-sqlite";
