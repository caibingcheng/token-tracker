import { sqliteTable, integer, text, index, primaryKey, real } from "drizzle-orm/sqlite-core";

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
  requestModel: text("request_model"), // 客户端原始请求名（虚拟名路由场景可追溯）
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("idx_token_records_created_at").on(table.createdAt),
  index("idx_token_records_provider_created_at").on(table.provider, table.createdAt),
  index("idx_token_records_model_created_at").on(table.model, table.createdAt),
  index("idx_token_records_provider_model_created_at").on(table.provider, table.model, table.createdAt),
  index("idx_token_records_agent").on(table.agent),
  index("idx_token_records_agent_created_at").on(table.agent, table.createdAt),
  index("idx_token_records_virtual_key_id").on(table.virtualKeyId),
  index("idx_token_records_vk_created_at").on(table.virtualKeyId, table.createdAt),
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
  healthCheckModel: text("health_check_model"),
  healthStatus: text("health_status"), // 'unhealthy' | NULL(healthy)，持久化健康状态
  healthUpdatedAt: text("health_updated_at"),
  balance: text("balance"),
  balanceUpdatedAt: text("balance_updated_at"),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
});

export type Upstream = typeof upstreams.$inferSelect;
export type NewUpstream = typeof upstreams.$inferInsert;

// 手动路由规则：虚拟名 + protocol → 目标 upstream 的某个 model（优先级高于自动路由）
export const routingRules = sqliteTable(
  "routing_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(), // 客户端请求的虚拟模型名
    protocol: text("protocol").notNull(), // 'openai' | 'anthropic' | 'gemini'
    upstreamId: integer("upstream_id")
      .notNull()
      .references(() => upstreams.id, { onDelete: "cascade" }),
    targetModel: text("target_model").notNull(), // 上游真实模型名
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_routing_rules_protocol_name").on(table.protocol, table.name),
  ]
);

export type RoutingRule = typeof routingRules.$inferSelect;
export type NewRoutingRule = typeof routingRules.$inferInsert;

// upstream 级 model 不可用标记（持久化；TTL 过期由 HealthTracker 懒清理）
export const upstreamModelHealth = sqliteTable(
  "upstream_model_health",
  {
    upstreamId: integer("upstream_id")
      .notNull()
      .references(() => upstreams.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    status: text("status").notNull(), // 'unavailable'
    expiresAt: text("expires_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.upstreamId, table.model] })]
);

export type UpstreamModelHealth = typeof upstreamModelHealth.$inferSelect;
export type NewUpstreamModelHealth = typeof upstreamModelHealth.$inferInsert;

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

// 官方价参考表：model 级单价（USD / 1M tokens），查询时计算
export const modelPrices = sqliteTable("model_prices", {
  model: text("model").primaryKey(), // 发往 upstream 的真实 model 名
  inputPrice: real("input_price").notNull(), // USD / 1M tokens
  outputPrice: real("output_price").notNull(),
  cacheReadPrice: real("cache_read_price"), // NULL → 计算时回退 input_price
  cacheWritePrice: real("cache_write_price"), // NULL → 回退 input_price
  source: text("source").notNull(), // 'models.dev' | 'manual'
  modelsDevId: text("models_dev_id"), // 'provider/model'，models.dev 来源时记录
  updatedAt: text("updated_at").notNull(),
});

export type ModelPrice = typeof modelPrices.$inferSelect;
export type NewModelPrice = typeof modelPrices.$inferInsert;
