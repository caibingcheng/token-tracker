# Token Tracker

LLM Token Usage Dashboard with opencode plugin.

## Setup

### 1. Local Development (Neon)

开发测试阶段使用 [Neon](https://neon.tech) 免费数据库：

1. 注册 Neon 账号，创建免费项目
2. 复制连接字符串到 `.env.local`
3. 运行数据库迁移：
   ```bash
   npx drizzle-kit push
   ```

### 2. Deploy to Vercel

1. Connect this repo to Vercel
2. Add Vercel Postgres database
3. Set environment variable: `API_KEYS=your-secret-key`

### 3. Database Migration (Production)

```bash
npx drizzle-kit push
```

### 4. Install Plugin

```bash
# In your opencode plugins directory
cd ~/.my-opencode/plugins
git clone https://github.com/your-repo/token-tracker.git token-tracker-plugin
cd token-tracker-plugin/packages/plugin
npm install
npm run build
```

### 5. Configure Plugin

Set environment variables:
```bash
export TOKEN_TRACKER_ENDPOINT="https://your-app.vercel.app/api/ingest"
export TOKEN_TRACKER_API_KEY="your-secret-key"
```

### 6. Access Dashboard

Open `https://your-app.vercel.app` and enter your API Key.

## Local Development & Testing

### Start Development Server

```bash
npm run dev
```

访问 http://localhost:3000

### Test API Endpoints

**1. Test data ingestion:**

```bash
curl -X POST http://localhost:3000/api/ingest \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-local-dev-api-key" \
  -d '{
    "model": "gpt-4o",
    "provider": "openai",
    "inputTokens": 1500,
    "outputTokens": 800,
    "cacheRead": 1200,
    "cacheWrite": 0
  }'
```

**2. Test stats query:**

```bash
curl "http://localhost:3000/api/stats?groupBy=date&range=7d" \
  -H "X-API-Key: your-local-dev-api-key"
```

**3. Test records query:**

```bash
curl "http://localhost:3000/api/records?page=1&limit=10" \
  -H "X-API-Key: your-local-dev-api-key"
```

### Dashboard Testing

1. Open http://localhost:3000
2. Enter your API key (from `.env.local`)
3. View token usage statistics and charts

### Database Operations

```bash
# Open Drizzle Studio (GUI for database)
npx drizzle-kit studio

# Push schema changes to database
npx drizzle-kit push

# Generate migration files
npx drizzle-kit generate
```

## API Endpoints

- `POST /api/ingest` - Report token usage
- `GET /api/stats` - Get aggregated statistics
- `GET /api/records` - Get usage records
