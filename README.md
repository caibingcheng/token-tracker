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

## API Endpoints

- `POST /api/ingest` - Report token usage
- `GET /api/stats` - Get aggregated statistics
- `GET /api/records` - Get usage records
