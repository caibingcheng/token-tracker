# Token Tracker

LLM Token Usage Dashboard with opencode plugin.

## Quick Start

### Local Development

1. **Clone and install**
   ```bash
   git clone https://github.com/caibingcheng/token-tracker.git
   cd token-tracker
   npm install
   ```

2. **Setup database** (使用 [Neon](https://neon.tech) 免费 PostgreSQL)
   ```bash
   # 复制环境变量模板
   cp .env.example .env.local
   
   # 编辑 .env.local，填入你的数据库连接字符串
   # DATABASE_URL="postgresql://user:password@host:port/database"
   ```

3. **Run migrations**
   ```bash
   npx drizzle-kit push
   ```

4. **Start dev server**
   ```bash
   npm run dev
   ```

   访问 http://localhost:3000

## Deploy to Vercel

### 方法一：Vercel Postgres（推荐）

1. **Push code to GitHub**
   ```bash
   git push origin main
   ```

2. **Import project in Vercel**
   - 登录 [Vercel Dashboard](https://vercel.com)
   - 点击 "Add New Project"
   - 导入 `token-tracker` GitHub 仓库

3. **Add Vercel Postgres**
   - 进入项目 Dashboard → "Storage" → "Connect Store"
   - 选择 "Create New" → "Vercel Postgres"
   - 创建后，Vercel 会自动添加 `POSTGRES_URL` 环境变量

4. **Configure environment variables**
   
   进入项目 Dashboard → "Settings" → "Environment Variables"：

   | 变量名 | 值 | 说明 |
   |--------|-----|------|
   | `DATABASE_URL` | `${POSTGRES_URL}` | 使用 Vercel Postgres 的连接字符串 |
   | `API_KEYS` | `your-secret-key` | 数据上报的 API 密钥，可设置多个（逗号分隔）|

   > **注意**：Dashboard 现在是只读的，不需要 API Key 即可查看。只有 `POST /api/ingest` 需要 `X-API-Key` header。

5. **Deploy**
   - Vercel 会自动构建和部署
   - 首次部署后需要运行数据库迁移（见下方）

6. **Run database migration**

   在本地执行（使用生产环境数据库）：
   ```bash
   # 临时使用生产数据库 URL
   DATABASE_URL="your-production-postgres-url" npx drizzle-kit push
   ```

   或者在 Vercel CLI 中执行：
   ```bash
   vercel env pull .env.production.local
   npx drizzle-kit push
   ```

### 方法二：External Database（Neon / Supabase / Self-hosted）

如果不想用 Vercel Postgres，可以使用任何 PostgreSQL 数据库：

1. **准备数据库**
   - [Neon](https://neon.tech) - 免费额度足够个人使用
   - [Supabase](https://supabase.com)
   - 自托管 PostgreSQL

2. **配置环境变量**
   
   在 Vercel Dashboard → Settings → Environment Variables：

   | 变量名 | 值 |
   |--------|-----|
   | `DATABASE_URL` | `postgresql://user:password@host:port/database` |
   | `API_KEYS` | `your-secret-key` |

3. **运行迁移**
   ```bash
   npx drizzle-kit push
   ```

4. **部署**
   - 推送代码到 GitHub，Vercel 自动部署

## Configure Plugin

插件仓库：[token-tracker-opencode](https://github.com/caibingcheng/token-tracker-opencode)

在 `~/.my-opencode/opencode.jsonc` 中配置（opencode 会自动从 GitHub 安装）：

```jsonc
{
  "plugin": [
    ["github:caibingcheng/token-tracker-opencode", {
      "endpoint": "https://your-app.vercel.app/api/ingest",
      "apiKey": "your-secret-key"
    }]
  ]
}
```

也支持环境变量配置（优先级低于 options）：
```bash
export TOKEN_TRACKER_ENDPOINT="https://your-app.vercel.app/api/ingest"
export TOKEN_TRACKER_API_KEY="your-secret-key"
```

## API Endpoints

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| `POST` | `/api/ingest` | `X-API-Key` required | 上报 token 用量 |
| `GET` | `/api/stats` | 不需要 | 聚合统计（按日期/模型/供应商分组）|
| `GET` | `/api/records` | 不需要 | 查询原始记录（支持分页）|

### 上报数据示例

```bash
curl -X POST https://your-app.vercel.app/api/ingest \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-secret-key" \
  -d '{
    "model": "gpt-4o",
    "provider": "openai",
    "inputTokens": 1500,
    "outputTokens": 800,
    "cacheRead": 1200,
    "cacheWrite": 0
  }'
```

### 查询统计示例

```bash
# 总体统计
curl "https://your-app.vercel.app/api/stats?groupBy=none&range=all"

# 按模型分组
curl "https://your-app.vercel.app/api/stats?groupBy=model"

# 最近 30 天按日期分组
curl "https://your-app.vercel.app/api/stats?groupBy=date&range=30d"

# 查询记录（第 1 页，每页 20 条）
curl "https://your-app.vercel.app/api/records?page=1&limit=20"
```

## Development

```bash
# Start dev server
npm run dev

# Database operations
npx drizzle-kit studio    # GUI 管理数据库
npx drizzle-kit push      # 推送 schema 变更
npx drizzle-kit generate  # 生成迁移文件
```

## Architecture

```
┌─────────────┐     POST /api/ingest      ┌──────────────┐
│   opencode  │ ────────────────────────> │   Vercel     │
│   plugin    │     X-API-Key header      │   (Next.js)  │
└─────────────┘                           └──────┬───────┘
                                                 │
                                                 │ Drizzle ORM
                                                 ▼
                                          ┌──────────────┐
                                          │  PostgreSQL  │
                                          │  (Vercel/    │
                                          │   Neon/ etc) │
                                          └──────────────┘
                                                 ▲
                                                 │ SELECT
┌─────────────┐     GET /api/stats            │
│  Dashboard  │ ──────────────────────────────┘
│  (Browser)  │     GET /api/records
└─────────────┘
```

## License

MIT
