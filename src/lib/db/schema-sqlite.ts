import { sqliteTable, integer, text, index, uniqueIndex, primaryKey, real } from "drizzle-orm/sqlite-core";

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
  ttftMs: integer("ttft_ms"), // 流式首 token 延迟（首 chunk 到达 - 请求开始），非流式为 NULL
  virtualKeyId: integer("virtual_key_id"),
  userAgent: text("user_agent"),
  sessionId: text("session_id"), // 客户端 session header 原值（截断 256，未携带 NULL；仅存储展示用，无索引）
  requestModel: text("request_model"), // 客户端原始请求名（虚拟名路由场景可追溯）
  remoteInstanceUid: text("remote_instance_uid"), // 来源实例稳定身份键（NULL = 本地记录；非 NULL = ingest 推送来源）
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
  index("idx_token_records_remote_instance_uid_created_at").on(table.remoteInstanceUid, table.createdAt),
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
  proxyUrlEncrypted: text("proxy_url_encrypted"), // AES-256-GCM，NULL = 直连
  headerTransforms: text("header_transforms"), // JSON: HeaderTransform[]，出站 header 变换（最后一棒）
  probeConfig: text("probe_config"), // JSON: {path, body}，自定义探活端点；NULL = 默认 chat → responses 双风格
  classifierModels: text("classifier_models"), // JSON: [{model, type, maxInputTokens?, path?}]，声明该 upstream 可作分类器的模型；NULL = 无
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
});

export type Upstream = typeof upstreams.$inferSelect;
export type NewUpstream = typeof upstreams.$inferInsert;

// 命名路由：客户端请求的虚拟名 name + protocol → 目标 upstream 的真实模型（优先级高于自动路由）。
// 自带路由目标池 named_route_targets，可选分类器决定链首：
//   classifier_kind = 'priority'：无 LLM 分类器，链首 = 首个健康目标（按 priority），零 LLM 开销
//   classifier_kind = 'model'：由 classifier_upstream_id + classifier_model 指向的 LLM 分类器选链首
// 命中后目标池构成一条 failover 链（链首由分类器/优先级决定，其余按 priority 接链尾），
// 同名自动路由完全失效。classifier_upstream_id 不加外键级联：删 classifier upstream 不 nuking
// 配置，运行时回退 priority 链首。
export const namedRoutes = sqliteTable(
  "named_routes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(), // 客户端请求的虚拟模型名
    protocol: text("protocol").notNull(), // 'openai' | 'anthropic' | 'gemini'
    instruction: text("instruction").notNull().default(""), // 给 LLM 分类器的决策指令
    classifierUpstreamId: integer("classifier_upstream_id").notNull().default(0), // 分类器所在 upstream（kind=priority 时占位 0）
    classifierModel: text("classifier_model").notNull().default(""), // 分类器模型名（须在 upstream.classifier_models 中声明；kind=priority 时占位 ''）
    classifierKind: text("classifier_kind").notNull().default("priority"), // 'priority' = 规则分类器 | 'model' = LLM 分类器
    enabled: integer("enabled").notNull().default(1),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  },
  (table) => [uniqueIndex("uq_named_routes_name_protocol").on(table.name, table.protocol)]
);

export type NamedRoute = typeof namedRoutes.$inferSelect;
export type NewNamedRoute = typeof namedRoutes.$inferInsert;

// 命名路由的目标池：分类器的选项池，同时是路由内部的 failover 链（链首排前，其余按 priority）
export const namedRouteTargets = sqliteTable(
  "named_route_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    namedRouteId: integer("named_route_id")
      .notNull()
      .references(() => namedRoutes.id, { onDelete: "cascade" }),
    // NULL = 无 provider 目标：upstream_model 按路由解析（命名路由嵌套 > 自动路由候选池）
    upstreamId: integer("upstream_id").references(() => upstreams.id, { onDelete: "cascade" }),
    upstreamModel: text("upstream_model").notNull(), // 真实模型名（显式目标 = 该 upstream 上的模型；auto 目标 = 路由解析名）
    description: text("description"), // 路由特性描述（给分类器看的候选说明）
    priority: integer("priority").notNull().default(0), // 小者先尝试；同 priority 按 id 升序
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("uq_named_route_targets_route_upstream_model").on(
      table.namedRouteId,
      table.upstreamId,
      table.upstreamModel
    ),
    index("idx_named_route_targets_named_route").on(table.namedRouteId),
  ]
);

export type NamedRouteTarget = typeof namedRouteTargets.$inferSelect;

export type NewNamedRouteTarget = typeof namedRouteTargets.$inferInsert;

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
  source: text("source").notNull(), // 'models.dev' | 'github' | 'manual'
  modelsDevId: text("models_dev_id"), // 'provider/model'，models.dev 来源时记录
  updatedAt: text("updated_at").notNull(),
});

export type ModelPrice = typeof modelPrices.$inferSelect;
export type NewModelPrice = typeof modelPrices.$inferInsert;

// 多实例同步：A 侧 ingest token（仿 virtual_keys 模式，AES-256-GCM 加密，写后不可读）
export const ingestTokens = sqliteTable("ingest_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  boundUid: text("bound_uid"), // TOFU 绑定目标（B 实例 uid），NULL = 未绑定
  enabled: integer("enabled").notNull().default(1),
  lastUsedAt: text("last_used_at"),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
});

export type IngestToken = typeof ingestTokens.$inferSelect;
export type NewIngestToken = typeof ingestTokens.$inferInsert;

// 多实例同步：A 侧去重水位表（每实例一行，uid 主键；epoch 变化 → 水位归零）
// instance_name 为展示名（每次推送刷新），改名即时生效；重名无害
export const syncInstances = sqliteTable("sync_instances", {
  uid: text("uid").primaryKey(),
  instanceName: text("instance_name"),
  epoch: text("epoch").notNull(),
  lastRecordId: integer("last_record_id").notNull().default(0),
  updatedAt: text("updated_at"),
});

export type SyncInstance = typeof syncInstances.$inferSelect;
export type NewSyncInstance = typeof syncInstances.$inferInsert;
