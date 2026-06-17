# AGENTS.md

> 帮助未来 OpenCode 会话快速上手、避免常见错误。仅包含从代码库推断出的高信号事实。

## 项目概览

- **Token Tracker**：基于 Next.js 14 App Router + Drizzle ORM + PostgreSQL（Neon）的 LLM Token 用量仪表盘
- **部署目标**：Vercel（`output: 'standalone'`）
- **使用规模**：个人使用，日均约 1000 条记录
- **数据库访问策略**：极低——依赖 Next.js 缓存 + 手动失效，读取接口几乎不直接查库

## 开发者命令

```bash
# 开发
npm run dev                 # 启动开发服务器，访问 http://localhost:3000

# 数据库操作
npx drizzle-kit push        # 推送 schema 变更到数据库（使用 .env.local）
npx drizzle-kit studio      # 启动 Drizzle Studio GUI

# 构建与检查
npm run build               # 生产构建（Vercel 自动执行）
npm run lint                # ESLint（仅 extends next/core-web-vitals）
```

## 数据库架构（Drizzle ORM）

- **Schema 文件**：`src/lib/db/schema.ts`
- **连接配置**：`src/lib/db/index.ts`
- **关键配置**：postgres client 使用 `prepare: false`，避免 prepared statement 冲突（Neon serverless 必需）
- **自动初始化**：`initDatabase()` 在首次 API 调用时自动检查并创建 `token_records` 表，无需手动迁移
- **表结构**：`token_records`（id, model, provider, input_tokens, output_tokens, cache_read, cache_write, created_at）

## 缓存策略（核心设计）

- **机制**：Next.js `unstable_cache`，**手动标签失效**（非时间过期）
- **缓存标签**：
  - `api-dashboard` — Dashboard 聚合数据（/api/dashboard）：包含 total、today、yesterday、daily、models
  - `api-providers` — Provider 列表（/api/providers）
  - `api-models` — Model 列表（/api/models）
- **失效触发**：仅在 `POST /api/ingest` 成功写入后调用 `revalidateTag()`
  - 新 provider 首次出现时额外使 providers 缓存失效
- **设计目标**：个人使用 + 低频次写入 → 缓存长期有效，读取零数据库访问

## API 路由与认证

| 路由 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/ingest` | POST | `X-API-Key` header | 上报 token 用量，触发缓存失效 |
| `/api/dashboard` | GET | 无 | 聚合统计（total + today + yesterday + daily + models），缓存 |
| `/api/providers` | GET | 无 | Provider 列表，缓存 |
| `/api/models` | GET | 无 | Model 列表，缓存 |
| `/api/records` | GET | `X-API-Key` header | 原始记录分页查询（每页 max 200），不走缓存 |

- **认证中间件**：`src/middleware.ts`，拦截 `/api/ingest` 与 `/api/records`
- **API Keys**：`API_KEYS` 环境变量，逗号分隔多个 key

## 数据处理约定

### Provider 匿名化
- **环境变量**：`HIDDEN_PROVIDERS`（逗号分隔）
- **行为**：被隐藏的 provider 在 UI 中显示为 "Provider A", "Provider B"...
- **相关文件**：`src/lib/provider-utils.ts`

### Model 归一化
- **文件**：`src/lib/model-registry.ts`（`src/lib/model-utils.ts` 仅做薄封装）
- **数据源**：`public/data/models-dev/models.json`（canonical ID 与显示名）、`public/data/models-dev/api.json`（官方定价）
- **规则**：按优先级依次匹配
  1. 精确匹配 canonical ID
  2. 精确匹配 provider-local alias
  3. 最长公共子序列（LCS）模糊匹配，相似度 ≥ 0.6 时采用最佳候选
  4. 未命中时保持原始名称
- **用途**：Dashboard Top 5 按归一化后的 model 名称聚合（如 `gpt-4o-2024-08-06` → `gpt-4o`）

## 环境变量

```bash
# 必需
DATABASE_URL="postgresql://user:password@host:port/database"
API_KEYS="your-secret-key"          # 可设置多个，逗号分隔

# 可选
HIDDEN_PROVIDERS="openai,google"    # 需要匿名的 provider 列表
```

- 本地开发复制 `.env.example` → `.env.local`
- Drizzle Kit 自动读取 `.env.local`（通过 `drizzle.config.ts` 中的 `dotenv.config()`）

## 部署注意事项

- **Vercel 构建**：`vercel.json` 指定 `buildCommand: "next build"`
- **数据库迁移**：首次部署后需运行 `npx drizzle-kit push`（使用生产环境 DATABASE_URL）
- **Neon 适配**：`prepare: false` 已配置，无需额外调整

## 一致性保证

- **写入后读取一致性**：POST /api/ingest 成功后立即 `revalidateTag()`，确保后续读取看到最新数据
- **缓存与数据库一致性**：无后台定时任务，一致性完全由写入触发失效保证
- **多实例一致性**：Vercel 多实例部署时，缓存标签失效通过 Next.js 自动传播

## Git Commit

- DO NOT and MUST NOT commit plan/spec files to the repository.
- Commit message must in English.
