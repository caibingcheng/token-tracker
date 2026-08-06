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
  status: text("status"),
  latencyMs: integer("latency_ms"),
  virtualKeyId: integer("virtual_key_id"),
  userAgent: text("user_agent"),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("idx_token_records_created_at").on(table.createdAt),
  index("idx_token_records_provider_created_at").on(table.provider, table.createdAt),
  index("idx_token_records_model_created_at").on(table.model, table.createdAt),
  index("idx_token_records_provider_model_created_at").on(table.provider, table.model, table.createdAt),
  index("idx_token_records_agent").on(table.agent),
  index("idx_token_records_agent_created_at").on(table.agent, table.createdAt),
  index("idx_token_records_virtual_key_id").on(table.virtualKeyId),
]);

export type TokenRecord = typeof tokenRecords.$inferSelect;
export type NewTokenRecord = typeof tokenRecords.$inferInsert;

export const upstreams = sqliteTable("upstreams", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  protocol: text("protocol").notNull(), // 'openai' | 'anthropic' | 'gemini'
  baseUrl: text("base_url").notNull(),
  enabledModels: text("enabled_models").notNull().default("[]"), // JSON array, supports 'gpt-*' prefix wildcard
  priority: integer("priority").notNull().default(0),
  enabled: integer("enabled").notNull().default(1),
  balance: text("balance"),
  balanceUpdatedAt: text("balance_updated_at"),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
});

export type Upstream = typeof upstreams.$inferSelect;
export type NewUpstream = typeof upstreams.$inferInsert;

export const upstreamKeys = sqliteTable("upstream_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  upstreamId: integer("upstream_id")
    .notNull()
    .references(() => upstreams.id, { onDelete: "cascade" }),
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  enabled: integer("enabled").notNull().default(1),
  lastStatus: text("last_status"),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
});

export type UpstreamKey = typeof upstreamKeys.$inferSelect;
export type NewUpstreamKey = typeof upstreamKeys.$inferInsert;

export const virtualKeys = sqliteTable("virtual_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  enabled: integer("enabled").notNull().default(1),
  comment: text("comment"),
  enabledModels: text("enabled_models").notNull().default('["*"]'), // JSON array, supports 'gpt-*' prefix wildcard
  lastUsedAt: text("last_used_at"),
  maxRpm: integer("max_rpm"),
  maxTpm: integer("max_tpm"),
  maxDailyTokens: integer("max_daily_tokens"),
  maxMonthlyTokens: integer("max_monthly_tokens"),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
});

export type VirtualKey = typeof virtualKeys.$inferSelect;
export type NewVirtualKey = typeof virtualKeys.$inferInsert;

export const adminAuditLogs = sqliteTable("admin_audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  action: text("action").notNull(),
  actor: text("actor"),
  targetType: text("target_type"), // upstream | virtual_key | upstream_key | system
  targetId: integer("target_id"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  details: text("details"),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
});

export type AdminAuditLog = typeof adminAuditLogs.$inferSelect;
export type NewAdminAuditLog = typeof adminAuditLogs.$inferInsert;

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
