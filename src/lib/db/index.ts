import { sql } from "drizzle-orm";
import { wrapDatabaseClient } from "./cache";
import { offsetMinutesToSqlModifiers } from "@/lib/timezone-utils";
import { migrateColumns, migrateTokenRecordsModelColumns, migrateRoutingRulesTable } from "./migrate";

let db: any;
let tokenRecords: any;
let upstreamsTable: any;
let upstreamKeysTable: any;
let virtualKeysTable: any;
let settingsTable: any;
let adminAuditLogsTable: any;
let upstreamModelHealthTable: any;
let routingRulesTable: any;
let modelPricesTable: any;
let ingestTokensTable: any;
let syncInstancesTable: any;
let initialized = false;

export async function initDatabase() {
  if (initialized) return;
  await ensureClient();
  initialized = true;
}

async function ensureClient() {
  if (db) return;

  const { default: Database } = await import("better-sqlite3");
  const { mkdirSync } = await import("fs");
  const { dirname } = await import("path");
  const sqliteModule = await import("./schema-sqlite");

  const dbPath = process.env.SQLITE_DATABASE_PATH;
  if (!dbPath) {
    throw new Error("SQLITE_DATABASE_PATH environment variable is required");
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const client = new Database(dbPath);
  wrapDatabaseClient(client);

  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  db = drizzle(client, { schema: sqliteModule });
  tokenRecords = sqliteModule.tokenRecords;
  upstreamsTable = sqliteModule.upstreams;
  upstreamKeysTable = sqliteModule.upstreamKeys;
  virtualKeysTable = sqliteModule.virtualKeys;
  settingsTable = sqliteModule.settings;
  adminAuditLogsTable = sqliteModule.adminAuditLogs;
  upstreamModelHealthTable = sqliteModule.upstreamModelHealth;
  routingRulesTable = sqliteModule.routingRules;
  modelPricesTable = sqliteModule.modelPrices;
  ingestTokensTable = sqliteModule.ingestTokens;
  syncInstancesTable = sqliteModule.syncInstances;

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
    CREATE TABLE IF NOT EXISTS routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL,
      upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
      target_model TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(name, protocol, upstream_id)
    );
    CREATE INDEX IF NOT EXISTS idx_routing_rules_protocol_name ON routing_rules(protocol, name);
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
      bound_instance TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS sync_instances (
      instance TEXT PRIMARY KEY,
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
        { name: "proxy_url_encrypted", definition: "proxy_url_encrypted TEXT" },
      ],
    },
  ]);

  // token_records 专用迁移：model 列改为真实名 + request_model 回填 + target_model 删除
  migrateTokenRecordsModelColumns(client);

  // routing_rules 专用迁移：旧 UNIQUE(name, protocol) 结构 → 多目标结构（priority 列 + 新唯一约束）
  migrateRoutingRulesTable(client);

  client.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_records_virtual_key_id ON token_records(virtual_key_id);
    CREATE INDEX IF NOT EXISTS idx_token_records_vk_created_at ON token_records(virtual_key_id, created_at);
  `);

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

export { db, tokenRecords, upstreamsTable, upstreamKeysTable, virtualKeysTable, settingsTable, adminAuditLogsTable, upstreamModelHealthTable, routingRulesTable, modelPricesTable, ingestTokensTable, syncInstancesTable };
export type { TokenRecord, NewTokenRecord } from "./schema-sqlite";
