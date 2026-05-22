# Token Tracker

LLM Token Usage Dashboard.

## Deploy to Vercel

### 方法一：Vercel Postgres（推荐）

1. **Push code to GitHub** and import project in [Vercel Dashboard](https://vercel.com)

2. **Add Vercel Postgres**
   - 进入项目 Dashboard → "Storage" → "Connect Store" → "Create New" → "Vercel Postgres"
   - Vercel 会自动添加 `POSTGRES_URL` 环境变量

3. **Configure environment variables**

   | 变量名 | 值 | 说明 |
   |--------|-----|------|
   | `DATABASE_URL` | `${POSTGRES_URL}` | 使用 Vercel Postgres 的连接字符串 |
   | `API_KEYS` | `your-secret-key` | 数据上报的 API 密钥，可设置多个（逗号分隔）|

4. **Deploy**
   - Vercel 自动构建和部署
   - 首次部署后运行数据库迁移：`DATABASE_URL="your-production-url" npx drizzle-kit push`

### 方法二：External Database（Neon / Supabase / Self-hosted）

使用任意 PostgreSQL 数据库：

1. **配置环境变量**

   | 变量名 | 值 |
   |--------|-----|
   | `DATABASE_URL` | `postgresql://user:password@host:port/database` |
   | `API_KEYS` | `your-secret-key` |

2. **运行迁移** — `npx drizzle-kit push`
3. **部署** — 推送代码到 GitHub，Vercel 自动部署

## License

MIT
