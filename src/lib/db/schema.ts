import { pgTable, serial, varchar, integer, timestamp, index } from "drizzle-orm/pg-core";

export const tokenRecords = pgTable("token_records", {
  id: serial("id").primaryKey(),
  model: varchar("model", { length: 255 }).notNull(),
  provider: varchar("provider", { length: 255 }).notNull(),
  agent: varchar("agent", { length: 255 }).notNull().default("unknown"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheRead: integer("cache_read").notNull().default(0),
  cacheWrite: integer("cache_write").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_token_records_created_at").on(table.createdAt.desc()),
  index("idx_token_records_provider_created_at").on(table.provider, table.createdAt),
  index("idx_token_records_model_created_at").on(table.model, table.createdAt),
  index("idx_token_records_provider_model_created_at").on(table.provider, table.model, table.createdAt),
]);

export type TokenRecord = typeof tokenRecords.$inferSelect;
export type NewTokenRecord = typeof tokenRecords.$inferInsert;
