// 存量表不会通过 CREATE TABLE IF NOT EXISTS 补列，
// 通过 PRAGMA table_info 检测缺失列并 ALTER TABLE 添加。
import { defaultAuthStyleForProtocol, isAuthStyle } from "@/lib/gateway/auth-style";
import { normalizeUpstreamProtocols } from "@/lib/gateway/model-router";
import { pruneOrphanLegacyRows, LEGACY_NAMED_ROUTES_BACKUP_TABLE } from "./migrate-preflight";
export interface MigrateColumn {
  name: string;
  definition: string;
}

export interface MigrateTable {
  table: string;
  columns: MigrateColumn[];
}

export function migrateColumns(
  client: any,
  tables: MigrateTable[]
): void {
  for (const { table, columns } of tables) {
    const existing: string[] = client
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c: any) => c.name);
    for (const { name, definition } of columns) {
      if (!existing.includes(name)) {
        client.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
    }
  }
}

// token_records 专用一次性迁移：model 列语义改为「发往 upstream 的真实名」，
// 原请求名挪到 request_model，废弃 target_model 列。幂等（PRAGMA 检测驱动）。
export function migrateTokenRecordsModelColumns(client: any): void {
  const existing: string[] = client
    .prepare(`PRAGMA table_info(token_records)`)
    .all()
    .map((c: any) => c.name);

  if (!existing.includes("request_model")) {
    client.exec(`ALTER TABLE token_records ADD COLUMN request_model TEXT`);
    client.exec(`UPDATE token_records SET request_model = model`);
  }

  // 旧 schema 下 target_model 存在：把已路由的真实名回填到 model
  if (existing.includes("target_model")) {
    client.exec(
      `UPDATE token_records SET model = target_model WHERE target_model IS NOT NULL`
    );
    client.exec(`ALTER TABLE token_records DROP COLUMN target_model`);
  }
}

// sync_instances 专用迁移：旧 instance 主键结构（instance TEXT PRIMARY KEY）
// → uid 主键 + instance_name 展示名结构。协议已破坏（旧行 name 无对应 uid），
// 旧行直接丢弃（必然重绑重推）。幂等检测：缺少 uid 列 → 触发重建。
export function migrateSyncInstancesTable(client: any): void {
  const existing: string[] = client
    .prepare(`PRAGMA table_info(sync_instances)`)
    .all()
    .map((c: any) => c.name);
  if (existing.includes("uid")) return;

  client.exec(`DROP TABLE IF EXISTS sync_instances_old`);
  client.exec(`
    ALTER TABLE sync_instances RENAME TO sync_instances_old;
    CREATE TABLE sync_instances (
      uid TEXT PRIMARY KEY,
      instance_name TEXT,
      epoch TEXT NOT NULL,
      last_record_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
    DROP TABLE sync_instances_old;
  `);
}

// ingest_tokens 专用迁移：旧 bound_instance 列 → bound_uid 列。
// token 行全量回迁（ingest token 是用户资产，不可丢弃），仅 bound_uid 置 NULL
// 等待重新 TOFU 绑定。幂等检测：存在 bound_instance 列 → 触发重建。
export function migrateIngestTokensTable(client: any): void {
  const existing: string[] = client
    .prepare(`PRAGMA table_info(ingest_tokens)`)
    .all()
    .map((c: any) => c.name);
  if (!existing.includes("bound_instance")) return;

  client.exec(`DROP TABLE IF EXISTS ingest_tokens_old`);
  client.exec(`
    ALTER TABLE ingest_tokens RENAME TO ingest_tokens_old;
    CREATE TABLE ingest_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      bound_uid TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO ingest_tokens (id, name, api_key_encrypted, bound_uid, enabled, last_used_at, created_at)
      SELECT id, name, api_key_encrypted, NULL, enabled, last_used_at, created_at FROM ingest_tokens_old;
    DROP TABLE ingest_tokens_old;
  `);
}

// 命名路由迁移（幂等）：把旧 routing_rules / virtual_models + virtual_model_routes 折叠进
// named_routes + named_route_targets，然后删旧表。
// - manual 规则行 → named_routes(classifier_kind='priority') + 各目标一条 target
// - virtual model 行 → 同名同协议 upsert（同名 manual 行的分类器配置被 vm 覆盖）+ 其路由候选进 target
// 旧表不存在（全新库 / 已迁移）直接跳过；旧表缺后加列（priority / description / classifier_kind 等）按默认值回填。
// 整段 fold 包在事务里：fold 中途失败（如 target 指向已删 upstream 的 FK 违反）时
// 不能留下“部分行已写、旧表还在一半”的半迁移状态。
export function migrateNamedRoutesTables(client: any): void {
  const tableNames: string[] = client
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: any) => r.name);
  const hasRoutingRules = tableNames.includes("routing_rules");
  const hasVirtualModels = tableNames.includes("virtual_models");
  if (!hasRoutingRules && !hasVirtualModels) return;

  client.transaction(() => {
    // 先清孤儿外键行（否则下面的 INSERT 会被 FK 直接 abort，升级卡死在启动）
    const pruned = pruneOrphanLegacyRows(client);
    if (pruned.routingRules > 0 || pruned.virtualModelRoutes > 0) {
      console.warn(
        `[migrate] pruned orphan legacy rows before folding: routing_rules=${pruned.routingRules}, virtual_model_routes=${pruned.virtualModelRoutes}`
      );
      recordPrunedOrphansAudit(client, pruned);
    }
    foldLegacyNamedRoutes(client, tableNames, hasRoutingRules, hasVirtualModels);
  })();
}

function recordPrunedOrphansAudit(
  client: any,
  pruned: { routingRules: number; virtualModelRoutes: number }
): void {
  try {
    const hasTable = client
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='admin_audit_logs'`)
      .get();
    if (!hasTable) return;
    client
      .prepare(
        `INSERT INTO admin_audit_logs
           (action, actor, target_type, target_id, ip, user_agent, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "migration_conflict",
        null,
        "system",
        null,
        null,
        null,
        JSON.stringify({
          scope: "legacy_named_routes",
          kind: "orphan_rows_pruned",
          pruned,
          note: "legacy rows whose upstream/target no longer existed; removed to let the fold migration run",
        }),
        new Date().toISOString()
      );
  } catch (err) {
    console.error("[migrate] failed to record orphan-prune audit:", err);
  }
}

function foldLegacyNamedRoutes(
  client: any,
  tableNames: string[],
  hasRoutingRules: boolean,
  hasVirtualModels: boolean
): void {
  const columnsOf = (table: string): string[] =>
    client
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c: any) => c.name);

  // 极老的 v1 库（只有 routing_rules / virtual_models，从来没建过 named_routes）：
  // 本次启动的 CREATE TABLE IF NOT EXISTS 已按**新** schema 建表（无 protocol 列），
  // 下面 fold 语句仍按旧 schema 引用 name+protocol。先临时补回 protocol 列 +
  // (name, protocol) 唯一索引让 fold 能跑，随后的 migrateNamedRoutesDropProtocol
  // 再重建表并把列去掉（同名不同协议行在合并阶段处理）。
  const routeColumns = columnsOf("named_routes");
  if (routeColumns.length > 0 && !routeColumns.includes("protocol")) {
    client.exec(`ALTER TABLE named_routes ADD COLUMN protocol TEXT NOT NULL DEFAULT ''`);
    client.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_named_routes_name_protocol ON named_routes(name, protocol)`
    );
  }

  // 1. manual 规则（routing_rules）→ priority 规则分类器的命名路由
  if (hasRoutingRules) {
    const ruleColumns = columnsOf("routing_rules");
    const priorityExpr = ruleColumns.includes("priority") ? "priority" : "0";
    client.exec(`
      INSERT OR IGNORE INTO named_routes
        (name, protocol, instruction, classifier_upstream_id, classifier_model, classifier_kind, enabled, created_at)
        SELECT name, protocol, '', 0, '', 'priority', 1, created_at FROM routing_rules;
      INSERT OR IGNORE INTO named_route_targets
        (named_route_id, upstream_id, upstream_model, description, priority, created_at)
        SELECT nr.id, rr.upstream_id, rr.target_model, NULL, ${priorityExpr}, rr.created_at
        FROM routing_rules rr
        JOIN named_routes nr ON nr.name = rr.name AND nr.protocol = rr.protocol;
    `);
  }

  // 2. virtual model 行：同名同协议合并到一个命名路由，分类器配置以 vm 为准
  if (hasVirtualModels) {
    const vmColumns = columnsOf("virtual_models");
    const instructionExpr = vmColumns.includes("instruction") ? "instruction" : "''";
    const kindExpr = vmColumns.includes("classifier_kind") ? "classifier_kind" : "'model'";
    const enabledExpr = vmColumns.includes("enabled") ? "enabled" : "1";
    const classifierUpstreamExpr = vmColumns.includes("classifier_upstream_id")
      ? "classifier_upstream_id"
      : "0";
    const classifierModelExpr = vmColumns.includes("classifier_model") ? "classifier_model" : "''";
    client.exec(`
      INSERT INTO named_routes
        (name, protocol, instruction, classifier_upstream_id, classifier_model, classifier_kind, enabled, created_at)
        SELECT name, protocol, ${instructionExpr}, ${classifierUpstreamExpr}, ${classifierModelExpr}, ${kindExpr}, ${enabledExpr}, created_at
        FROM virtual_models
        WHERE 1
        ON CONFLICT(name, protocol) DO UPDATE SET
          instruction = CASE WHEN excluded.instruction <> '' THEN excluded.instruction ELSE instruction END,
          classifier_upstream_id = excluded.classifier_upstream_id,
          classifier_model = excluded.classifier_model,
          classifier_kind = excluded.classifier_kind,
          enabled = excluded.enabled;
    `);
    if (tableNames.includes("virtual_model_routes")) {
      const routeColumns = columnsOf("virtual_model_routes");
      const descriptionExpr = routeColumns.includes("description") ? "vr.description" : "NULL";
      const routePriorityExpr = routeColumns.includes("priority") ? "vr.priority" : "0";
      client.exec(`
        INSERT OR IGNORE INTO named_route_targets
          (named_route_id, upstream_id, upstream_model, description, priority, created_at)
          SELECT nr.id, vr.upstream_id, vr.upstream_model, ${descriptionExpr}, ${routePriorityExpr}, vr.created_at
          FROM virtual_model_routes vr
          JOIN virtual_models vm ON vm.id = vr.virtual_model_id
          JOIN named_routes nr ON nr.name = vm.name AND nr.protocol = vm.protocol;
      `);
    }
  }

  client.exec(`
    DROP TABLE IF EXISTS virtual_model_routes;
    DROP TABLE IF EXISTS virtual_models;
    DROP TABLE IF EXISTS routing_rules;
  `);
}

// named_route_targets.upstream_id 放宽为可空（NULL = 无 provider 目标，按路由解析）。
// SQLite 无法修改列约束，表重建（rename → 新表 → 回迁 → drop）。
// 幂等检测：PRAGMA table_info 的 notnull 标志（全新库建表即可空，直接跳过）。
export function migrateNamedRouteTargetsNullableUpstream(client: any): void {
  const cols: { name: string; notnull: number }[] = client
    .prepare(`PRAGMA table_info(named_route_targets)`)
    .all();
  if (cols.length === 0) return; // 表不存在（不应发生，CREATE TABLE IF NOT EXISTS 已建）
  if (cols.find((c) => c.name === "upstream_id")?.notnull !== 1) return;

  client.exec(`DROP TABLE IF EXISTS named_route_targets_old`);
  client.exec(`
    ALTER TABLE named_route_targets RENAME TO named_route_targets_old;
    CREATE TABLE named_route_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      named_route_id INTEGER NOT NULL REFERENCES named_routes(id) ON DELETE CASCADE,
      upstream_id INTEGER REFERENCES upstreams(id) ON DELETE CASCADE,
      upstream_model TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO named_route_targets (id, named_route_id, upstream_id, upstream_model, description, priority, created_at)
      SELECT id, named_route_id, upstream_id, upstream_model, description, priority, created_at FROM named_route_targets_old;
    DROP TABLE named_route_targets_old;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_named_route_targets_route_upstream_model
      ON named_route_targets(named_route_id, upstream_id, upstream_model);
    CREATE INDEX IF NOT EXISTS idx_named_route_targets_named_route ON named_route_targets(named_route_id);
  `);
}

// upstream 认证方式 + 接受协议集合（幂等）：
// - protocols：JSON Protocol[]，缺列/空/非法一律回落 [protocol]（历史「一条记录只服务一个面」）
// - auth_style：出站认证头，缺列/非法回落按 protocol 映射（历史「认证头按协议推导」）
// 两项都带存量回填，升级后行为与旧版一致。
export function migrateUpstreamAuthStyleAndProtocols(client: any): void {
  const existing: string[] = client
    .prepare(`PRAGMA table_info(upstreams)`)
    .all()
    .map((c: any) => c.name);
  if (existing.length === 0) return;

  if (!existing.includes("protocols")) {
    client.exec(`ALTER TABLE upstreams ADD COLUMN protocols TEXT`);
  }
  if (!existing.includes("auth_style")) {
    client.exec(`ALTER TABLE upstreams ADD COLUMN auth_style TEXT`);
  }

  const rows: { id: number; protocol: string; protocols: string | null; auth_style: string | null }[] =
    client.prepare(`SELECT id, protocol, protocols, auth_style FROM upstreams`).all();
  const update = client.prepare(`UPDATE upstreams SET protocols = ?, auth_style = ? WHERE id = ?`);
  for (const row of rows) {
    const protocols = normalizeUpstreamProtocols(row.protocols, row.protocol);
    const authStyle = isAuthStyle(row.auth_style)
      ? row.auth_style
      : defaultAuthStyleForProtocol(protocols[0]!);
    const nextProtocols = JSON.stringify(protocols);
    if (row.protocols === nextProtocols && row.auth_style === authStyle) continue;
    update.run(nextProtocols, authStyle, row.id);
  }
}

export interface NamedRouteMergeSnapshot {
  id: number;
  protocol: string;
  instruction: string;
  classifierKind: string;
  classifierUpstreamId: number;
  classifierModel: string;
  enabled: number;
  targets: { upstreamId: number | null; upstreamModel: string; description: string | null; priority: number }[];
}

export interface NamedRouteMergeReport {
  name: string;
  keeperId: number;
  mergedRouteIds: number[];
  disabled: boolean;
  reasons: string[];
  // 合并前的原始行快照（含 loser 行字段与各自目标池），落到 admin_audit_logs 供人工复核
  routes: NamedRouteMergeSnapshot[];
}

// 命名路由去协议（UNIQUE(name, protocol) → UNIQUE(name)）。
// 同名多协议行必须收敛成一行，但以下字段可能出现无法自动判定的冲突：
//   instruction / classifier_upstream_id / classifier_model / classifier_kind / enabled
//   + 两个池里出现相同 (upstream_id, upstream_model) 目标
// 策略：保留 id 最小行作为主行，目标池全部并入；发生任何冲突时整条路由 enabled=0
// （不静默丢配置，也不让半冲突的池参与路由），由人工复核后重新启用。
// 迁移返回报告（含原始行快照）：db/index.ts 打日志，本函数写一条 admin_audit_logs 审计。
export function migrateNamedRoutesDropProtocol(client: any): NamedRouteMergeReport[] {
  const cols: string[] = client
    .prepare(`PRAGMA table_info(named_routes)`)
    .all()
    .map((c: any) => c.name);
  if (!cols.includes("protocol")) return [];

  interface LegacyRow {
    id: number;
    name: string;
    protocol: string;
    instruction: string;
    classifier_upstream_id: number;
    classifier_model: string;
    classifier_kind: string;
    enabled: number;
    created_at: string;
  }
  interface TargetRow {
    id: number;
    upstream_id: number | null;
    upstream_model: string;
    description: string | null;
    priority: number;
  }

  const rows: LegacyRow[] = client
    .prepare(
      `SELECT id, name, protocol, instruction, classifier_upstream_id, classifier_model,
              classifier_kind, enabled, created_at
       FROM named_routes ORDER BY id`
    )
    .all();

  const targetStmt = client.prepare(
    `SELECT id, upstream_id, upstream_model, description, priority
     FROM named_route_targets WHERE named_route_id = ? ORDER BY id`
  );
  const targetsOf = new Map<number, TargetRow[]>();
  for (const row of rows) targetsOf.set(row.id, targetStmt.all(row.id));

  const groups = new Map<string, LegacyRow[]>();
  for (const row of rows) {
    if (!groups.has(row.name)) groups.set(row.name, []);
    groups.get(row.name)!.push(row);
  }

  const targetKey = (t: TargetRow): string => `${t.upstream_id ?? "null"}\u0000${t.upstream_model}`;

  const reports: NamedRouteMergeReport[] = [];
  const keepers: LegacyRow[] = [];
  for (const [name, group] of groups) {
    const keeper = group[0]!;
    const reasons: string[] = [];
    const seen = new Map<string, number>();
    for (const t of targetsOf.get(keeper.id) ?? []) seen.set(targetKey(t), keeper.id);

    for (const loser of group.slice(1)) {
      if (loser.instruction !== keeper.instruction) {
        reasons.push(`instruction differs (route ${loser.id} "${loser.protocol}")`);
      }
      if (loser.classifier_upstream_id !== keeper.classifier_upstream_id) {
        reasons.push(`classifier_upstream_id differs (route ${loser.id} "${loser.protocol}")`);
      }
      if (loser.classifier_model !== keeper.classifier_model) {
        reasons.push(`classifier_model differs (route ${loser.id} "${loser.protocol}")`);
      }
      if (loser.classifier_kind !== keeper.classifier_kind) {
        reasons.push(`classifier_kind differs (route ${loser.id} "${loser.protocol}")`);
      }
      if (loser.enabled !== keeper.enabled) {
        reasons.push(`enabled differs (route ${loser.id} "${loser.protocol}")`);
      }
      for (const t of targetsOf.get(loser.id) ?? []) {
        const key = targetKey(t);
        if (seen.has(key)) {
          reasons.push(
            `duplicate target ${t.upstream_model} (route ${loser.id} "${loser.protocol}")`
          );
        } else {
          seen.set(key, loser.id);
        }
      }
    }

    const disabled = reasons.length > 0;
    keepers.push({ ...keeper, enabled: disabled ? 0 : keeper.enabled });
    if (group.length > 1) {
      reports.push({
        name,
        keeperId: keeper.id,
        mergedRouteIds: group.map((r) => r.id),
        disabled,
        reasons,
        routes: group.map((r) => ({
          id: r.id,
          protocol: r.protocol,
          instruction: r.instruction,
          classifierKind: r.classifier_kind,
          classifierUpstreamId: r.classifier_upstream_id,
          classifierModel: r.classifier_model,
          enabled: r.enabled,
          targets: (targetsOf.get(r.id) ?? []).map((t) => ({
            upstreamId: t.upstream_id,
            upstreamModel: t.upstream_model,
            description: t.description,
            priority: t.priority,
          })),
        })),
      });
    }
  }

  const repoint = client.prepare(`UPDATE named_route_targets SET named_route_id = ? WHERE id = ?`);
  const dropTarget = client.prepare(`DELETE FROM named_route_targets WHERE id = ?`);
  const existsWithUpstream = client.prepare(
    `SELECT id FROM named_route_targets
     WHERE named_route_id = ? AND upstream_id = ? AND upstream_model = ?`
  );
  const existsAuto = client.prepare(
    `SELECT id FROM named_route_targets
     WHERE named_route_id = ? AND upstream_id IS NULL AND upstream_model = ?`
  );

  // 外键必须关：DROP TABLE named_routes 会级联删掉 named_route_targets 的行，
  // 而这些行正是要保留并重指的数据。
  // 整个重建包在一个事务里：进程在 DROP 与 RENAME 之间挂掉会丢掉全部命名路由配置。
  client.pragma("foreign_keys = OFF");
  try {
    client.transaction(() => {
    // 保留一份重建前的原始表（含 protocol 列与全部同名行），合并丢掉的行随时可回查。
    // 用 CREATE TABLE AS SELECT 而不是 RENAME：RENAME 会重写 named_route_targets 的
    // 外键文本指向备份表，导致新表的 targets 失联。
    client.exec(`DROP TABLE IF EXISTS ${LEGACY_NAMED_ROUTES_BACKUP_TABLE}`);
    client.exec(
      `CREATE TABLE ${LEGACY_NAMED_ROUTES_BACKUP_TABLE} AS SELECT * FROM named_routes`
    );
    client.exec(`DROP TABLE IF EXISTS named_routes_new`);
    client.exec(`
      CREATE TABLE named_routes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        classifier_upstream_id INTEGER NOT NULL DEFAULT 0,
        classifier_model TEXT NOT NULL DEFAULT '',
        classifier_kind TEXT NOT NULL DEFAULT 'priority',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    const insertKeeper = client.prepare(
      `INSERT INTO named_routes_new
         (id, name, instruction, classifier_upstream_id, classifier_model, classifier_kind, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const k of keepers) {
      insertKeeper.run(
        k.id,
        k.name,
        k.instruction,
        k.classifier_upstream_id,
        k.classifier_model,
        k.classifier_kind,
        k.enabled,
        k.created_at
      );
    }

    // 目标池并入主行：撞唯一索引的重复目标删除（该路由已因冲突被禁用，人工复核）
    for (const group of groups.values()) {
      const keeper = group[0]!;
      for (const loser of group.slice(1)) {
        for (const t of targetsOf.get(loser.id) ?? []) {
          const dup =
            t.upstream_id === null
              ? existsAuto.get(keeper.id, t.upstream_model)
              : existsWithUpstream.get(keeper.id, t.upstream_id, t.upstream_model);
          if (dup) dropTarget.run(t.id);
          else repoint.run(keeper.id, t.id);
        }
      }
    }

    client.exec(`
      DROP TABLE named_routes;
      ALTER TABLE named_routes_new RENAME TO named_routes;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_named_routes_name ON named_routes(name);
    `);
    })();
  } finally {
    client.pragma("foreign_keys = ON");
  }

  // 审计：合并本身是一次配置变更，loser 行的字段已从库中消失，只有这里能留下原值。
  // 写在重建事务之外 + 吞异常：审计失败不得把已完成的迁移回滚。
  recordMergeAudit(client, reports);
  return reports;
}

// 迁移冲突审计（通用 action `migration_conflict`）：任何迁移在无法无损自动处理、
// 需要人工复核时写一条。具体是哪个迁移、什么冲突由 details.scope / details.kind /
// details.reasons 区分——不为每个新迁移新增 action，否则审计页会被一次性 tag 漂没。
function recordMergeAudit(client: any, reports: NamedRouteMergeReport[]): void {
  if (reports.length === 0) return;
  try {
    const hasTable = client
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='admin_audit_logs'`)
      .get();
    if (!hasTable) return;
    const insert = client.prepare(
      `INSERT INTO admin_audit_logs
         (action, actor, target_type, target_id, ip, user_agent, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = new Date().toISOString();
    for (const report of reports) {
      // 无冲突的合并不需要人工介入：只打启动日志，不写审计
      if (!report.disabled) continue;
      insert.run(
        "migration_conflict",
        null, // 系统操作，无 actor
        "named_route",
        report.keeperId,
        null,
        null,
        JSON.stringify({
          scope: "named_routes",
          kind: "same_name_merge",
          name: report.name,
          source: "sqlite migration: named_routes UNIQUE(name, protocol) -> UNIQUE(name)",
          mergedRouteIds: report.mergedRouteIds,
          keptRouteId: report.keeperId,
          disabled: report.disabled,
          reasons: report.reasons,
          // 合并前每个同名路由的完整配置（loser 行已从 named_routes 删除）
          routes: report.routes,
        }),
        now
      );
    }
  } catch (err) {
    console.error("[migrate] failed to record named-route merge audit:", err);
  }
}
