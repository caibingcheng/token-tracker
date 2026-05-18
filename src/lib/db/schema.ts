import { pgTable, serial, varchar, integer, timestamp } from "drizzle-orm/pg-core";

export const tokenRecords = pgTable("token_records", {
  id: serial("id").primaryKey(),
  apiKey: varchar("api_key", { length: 255 }).notNull(),
  model: varchar("model", { length: 255 }).notNull(),
  provider: varchar("provider", { length: 255 }).notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheRead: integer("cache_read").notNull().default(0),
  cacheWrite: integer("cache_write").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type TokenRecord = typeof tokenRecords.$inferSelect;
export type NewTokenRecord = typeof tokenRecords.$inferInsert;
