import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;

// 禁用预编译语句以避免 prepared statement 冲突
const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client, { schema });

// 自动初始化数据库表
let initialized = false;

export async function initDatabase() {
  if (initialized) return;

  try {
    // 检查表是否存在
    const result = await client`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'token_records'
      )
    `;

    if (!result[0].exists) {
      console.log('[DB] Creating token_records table...');
      await client`
        CREATE TABLE token_records (
          id SERIAL PRIMARY KEY,
          model VARCHAR(255) NOT NULL,
          provider VARCHAR(255) NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read INTEGER NOT NULL DEFAULT 0,
          cache_write INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      console.log('[DB] Table created successfully');
    }

    initialized = true;
  } catch (error) {
    console.error('[DB] Initialization failed:', error);
    throw error;
  }
}
