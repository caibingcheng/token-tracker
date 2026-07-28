import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";

export const tokenRecords = sqliteTable("token_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  agent: text("agent").notNull().default("unknown"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheRead: integer("cache_read").notNull().default(0),
  cacheWrite: integer("cache_write").notNull().default(0),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("idx_token_records_created_at").on(table.createdAt),
  index("idx_token_records_provider_created_at").on(table.provider, table.createdAt),
  index("idx_token_records_model_created_at").on(table.model, table.createdAt),
  index("idx_token_records_provider_model_created_at").on(table.provider, table.model, table.createdAt),
  index("idx_token_records_agent").on(table.agent),
  index("idx_token_records_agent_created_at").on(table.agent, table.createdAt),
]);

export type TokenRecord = typeof tokenRecords.$inferSelect;
export type NewTokenRecord = typeof tokenRecords.$inferInsert;
