import { sql } from "drizzle-orm";
import { wrapDatabaseClient } from "./cache";
import { offsetMinutesToSqlModifiers } from "@/lib/timezone-utils";

let db: any;
let tokenRecords: any;
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

export { db, tokenRecords };
export type { TokenRecord, NewTokenRecord } from "./schema-sqlite";
