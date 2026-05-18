# Token Tracker 项目设计文档

**日期**: 2026-05-18
**版本**: 1.0
**状态**: 已确认

---

## 1. 项目概述

### 1.1 目标
构建一个 Token 用量统计 Web 应用，包含：
- Web Dashboard：展示 Token 用量数据，支持多维度聚合和可视化
- opencode 插件：监听 opencode 会话中的 token 用量，上报到服务端

### 1.2 核心功能
- **数据上报**: opencode 插件拦截消息事件，提取 token 信息，通过 API 上报
- **数据存储**: 持久化到 Vercel Postgres 数据库
- **数据展示**: Web Dashboard 展示趋势、分布、明细
- **认证**: API Key 机制保护数据上报接口

### 1.3 使用场景
个人使用，可能在不同设备上使用 opencode，数据集中到服务端统计。

---

## 2. 架构设计

### 2.1 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    Token Tracker System                  │
│                                                          │
│  ┌──────────────┐     ┌──────────────┐                  │
│  │   opencode   │────▶│   Plugin     │                  │
│  │   (CLI)      │     │   (上报数据)  │                  │
│  └──────────────┘     └──────┬───────┘                  │
│                              │ HTTP POST                 │
│                              ▼                          │
│  ┌──────────────────────────────────────────────┐      │
│  │           Vercel (Next.js App)                │      │
│  │  ┌────────────┐  ┌────────────┐  ┌────────┐  │      │
│  │  │  Dashboard │  │   API      │  │  Auth  │  │      │
│  │  │   Pages    │  │  Routes    │  │(APIKey)│  │      │
│  │  └────────────┘  └─────┬──────┘  └────────┘  │      │
│  │                        │                      │      │
│  │  ┌─────────────────────────────────────────┐ │      │
│  │  │        Vercel Postgres (Neon)           │ │      │
│  │  │        token_records 表                  │ │      │
│  │  └─────────────────────────────────────────┘ │      │
│  └──────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
```

### 2.2 项目结构 (Monorepo)

```
token-tracker/
├── src/                          # Next.js Web Application
│   ├── app/                     # App Router 页面
│   │   ├── page.tsx             # Dashboard 首页
│   │   └── api/                 # API Routes
│   │       ├── ingest/route.ts  # 数据上报接口
│   │       ├── stats/route.ts   # 聚合统计接口
│   │       └── records/route.ts # 记录查询接口
│   ├── components/              # React UI 组件
│   │   ├── Dashboard.tsx        # 仪表盘主组件
│   │   ├── StatsCards.tsx       # 概览卡片
│   │   ├── TrendChart.tsx       # 趋势图表
│   │   ├── DistributionChart.tsx # 分布图表
│   │   └── RecordsTable.tsx     # 记录表格
│   ├── lib/                     # 共享库
│   │   ├── db/                  # 数据库相关
│   │   │   ├── schema.ts        # Drizzle ORM Schema
│   │   │   └── index.ts         # 数据库连接和查询
│   │   └── utils.ts             # 工具函数
│   └── server/                  # 服务端逻辑
│       └── auth.ts              # API Key 验证
├── plugin/                      # opencode 插件
│   ├── package.json             # 插件包配置
│   └── src/
│       └── index.ts             # 插件入口 (TUI Plugin)
├── drizzle.config.ts            # Drizzle ORM 配置
├── .env.example                 # 环境变量模板
├── next.config.js               # Next.js 配置
├── tailwind.config.ts           # Tailwind 配置
├── tsconfig.json
└── package.json
```

---

## 3. 技术栈

### 3.1 Web 应用
- **框架**: Next.js 14 (App Router)
- **语言**: TypeScript
- **样式**: Tailwind CSS
- **图表**: Recharts
- **ORM**: Drizzle ORM
- **数据库**: Vercel Postgres (Neon)
- **部署**: Vercel

### 3.2 插件
- **类型**: opencode TUI Plugin
- **框架**: SolidJS (opencode TUI 使用 SolidJS)
- **运行时**: 依赖 `@opencode-ai/plugin`

---

## 4. 数据库设计

### 4.1 表结构

```sql
CREATE TABLE token_records (
  id            SERIAL PRIMARY KEY,
  api_key       VARCHAR(255) NOT NULL,
  model         VARCHAR(255) NOT NULL,
  provider      VARCHAR(255) NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.2 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL | 自增主键 |
| api_key | VARCHAR(255) | 上报来源的 API Key，用于认证和数据隔离 |
| model | VARCHAR(255) | LLM 模型名称，如 "gpt-4o", "claude-3.5-sonnet" |
| provider | VARCHAR(255) | 供应商名称，如 "openai", "anthropic" |
| input_tokens | INTEGER | Input Token 数量 |
| output_tokens | INTEGER | Output Token 数量 |
| cache_read | INTEGER | Cache Read Token 数量 |
| cache_write | INTEGER | Cache Write Token 数量 |
| created_at | TIMESTAMPTZ | 记录创建时间 |

### 4.3 索引

```sql
CREATE INDEX idx_records_api_key   ON token_records(api_key);
CREATE INDEX idx_records_created   ON token_records(created_at);
CREATE INDEX idx_records_model     ON token_records(model);
CREATE INDEX idx_records_provider  ON token_records(provider);
```

### 4.4 ORM Schema (Drizzle)

```typescript
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
```

---

## 5. API 设计

### 5.1 认证机制

所有 API 端点（除 Dashboard 页面外）使用 **API Key** 认证：
- Header: `X-API-Key: <your-api-key>`
- API Key 存储在环境变量 `API_KEYS` 中（逗号分隔多个 Key）
- 上报接口和查询接口共用同一套 API Key

### 5.2 端点列表

#### POST /api/ingest

**功能**: 插件上报 token 用量数据

**Headers**:
```
Content-Type: application/json
X-API-Key: <api-key>
```

**请求体**:
```json
{
  "model": "gpt-4o",
  "provider": "openai",
  "inputTokens": 1500,
  "outputTokens": 800,
  "cacheRead": 1200,
  "cacheWrite": 0
}
```

**响应**:
```json
{
  "success": true,
  "id": 123
}
```

**错误响应**:
```json
{
  "success": false,
  "error": "Invalid API Key"
}
```

#### GET /api/stats

**功能**: 获取聚合统计数据

**Headers**:
```
X-API-Key: <api-key>
```

**查询参数**:
- `groupBy`: `date` | `model` | `provider`
- `range`: `7d` | `30d` | `90d` | `all`
- `granularity`: `day` | `week` | `month` (仅 groupBy=date 时有效)

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "group": "2026-05-18",
      "totalInput": 5000,
      "totalOutput": 2000,
      "totalCacheRead": 3000,
      "totalCacheWrite": 100,
      "count": 5
    }
  ]
}
```

#### GET /api/records

**功能**: 获取原始记录列表（支持分页和筛选）

**Headers**:
```
X-API-Key: <api-key>
```

**查询参数**:
- `page`: 页码，默认 1
- `limit`: 每页数量，默认 50，最大 200
- `model`: 按模型筛选（可选）
- `provider`: 按供应商筛选（可选）
- `startDate`: 开始日期，格式 YYYY-MM-DD（可选）
- `endDate`: 结束日期，格式 YYYY-MM-DD（可选）

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "id": 123,
      "model": "gpt-4o",
      "provider": "openai",
      "inputTokens": 1500,
      "outputTokens": 800,
      "cacheRead": 1200,
      "cacheWrite": 0,
      "createdAt": "2026-05-18T10:30:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1234,
    "totalPages": 25
  }
}
```

---

## 6. 插件设计

### 6.1 插件架构

基于 opencode TUI Plugin 架构，参考 `cache-stats-sidebar` 插件的实现。

### 6.2 插件入口 (`plugin/src/index.ts`)

```typescript
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";

const API_ENDPOINT = process.env.TOKEN_TRACKER_ENDPOINT || "https://your-app.vercel.app/api/ingest";
const API_KEY = process.env.TOKEN_TRACKER_API_KEY;

const id = "token-tracker-plugin";

const tui: TuiPlugin = async (api) => {
  if (!API_KEY) {
    console.warn("[TokenTracker] TOKEN_TRACKER_API_KEY not set, plugin disabled");
    return;
  }

  api.event.on("message.updated", ({ properties }) => {
    const info = properties.info;
    
    // 只处理 assistant 消息
    if (!info || info.role !== "assistant") {
      return;
    }

    // 只处理已完成且有 token 信息的消息
    if (!info.time?.completed || !info.tokens) {
      return;
    }

    // 构建上报数据
    const payload = {
      model: info.model || "unknown",
      provider: info.provider || "unknown",
      inputTokens: info.tokens.input || 0,
      outputTokens: info.tokens.output || 0,
      cacheRead: info.tokens.cache?.read || 0,
      cacheWrite: info.tokens.cache?.write || 0,
    };

    // 异步上报（不阻塞 UI）
    fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
      },
      body: JSON.stringify(payload),
    }).catch((err) => {
      console.error("[TokenTracker] Failed to report:", err.message);
    });
  });
};

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
};

export default plugin;
```

### 6.3 插件配置

插件通过环境变量配置：

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `TOKEN_TRACKER_ENDPOINT` | 服务端 API 地址 | `https://your-app.vercel.app/api/ingest` |
| `TOKEN_TRACKER_API_KEY` | API Key | - (必填) |

### 6.4 插件安装

1. 克隆插件目录到 `~/.my-opencode/plugins/token-tracker/`
2. 在 `~/.my-opencode/` 目录的合适配置文件中注册插件
3. 设置环境变量

---

## 7. Dashboard 设计

### 7.1 页面布局

```
┌──────────────────────────────────────────────────────────────┐
│  Token Tracker Dashboard                           [刷新]    │
├──────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ Total    │ │ Total    │ │ Total    │ │ Total    │        │
│  │ Input    │ │ Output   │ │ Cache    │ │ Requests │        │
│  │ 1.2M     │ │ 800K     │ │ 500K     │ │ 1,234    │        │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘        │
├──────────────────────────────────────────────────────────────┤
│  [时间范围: 7天 ▼]  [分组: 按日期 ▼]                        │
├──────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    Token 趋势图                          │ │
│  │                                                         │ │
│  │  Input ──────────────────────────────                   │ │
│  │  Output ───────────────────────                         │ │
│  │  Cache ───────────────                                  │ │
│  └─────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│  ┌────────────────────────┐  ┌──────────────────────────┐   │
│  │   按模型分布            │  │   按供应商分布            │   │
│  │   [饼图]                │  │   [饼图]                  │   │
│  │   gpt-4o: 50%          │  │   openai: 70%            │   │
│  │   claude-3.5: 30%      │  │   anthropic: 30%         │   │
│  │   ...                   │  │   ...                     │   │
│  └────────────────────────┘  └──────────────────────────┘   │
├──────────────────────────────────────────────────────────────┤
│  最近记录                                                     │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 日期       │ 模型       │ 供应商    │ Input │ Output    │ │
│  │ 2026-05-18 │ gpt-4o     │ openai    │ 1500  │ 800       │ │
│  │ 2026-05-18 │ claude-3.5 │ anthropic │ 2000  │ 1200      │ │
│  │ ...                                                     │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 7.2 组件列表

| 组件 | 说明 |
|------|------|
| `StatsCards` | 4 张概览卡片：总 Input、总 Output、总 Cache、总请求数 |
| `TrendChart` | 折线图/柱状图，展示 token 用量随时间变化的趋势 |
| `ModelDistributionChart` | 饼图/环形图，展示按模型的 token 分布 |
| `ProviderDistributionChart` | 饼图/环形图，展示按供应商的 token 分布 |
| `RecordsTable` | 数据表格，展示最近记录，支持分页 |
| `FilterBar` | 筛选栏：时间范围选择、分组方式选择 |

### 7.3 交互设计

- **时间范围**: 快捷选择（7天/30天/90天/全部）
- **数据刷新**: 自动刷新（每 30 秒）+ 手动刷新按钮
- **表格排序**: 点击表头按列排序
- **表格分页**: 底部页码导航

---

## 8. 部署方案

### 8.1 环境变量

| 变量名 | 说明 | 来源 |
|--------|------|------|
| `DATABASE_URL` | Postgres 连接字符串 | 本地: Neon 免费数据库 / 生产: Vercel Postgres |
| `API_KEYS` | 逗号分隔的 API Key 列表 | 手动配置 |
| `NEXT_PUBLIC_APP_NAME` | 应用名称 | 可选 |

### 8.2 本地开发数据库配置 (Neon)

开发阶段不部署到 Vercel，使用 [Neon](https://neon.tech) 免费数据库：

1. 注册 Neon 账号，创建免费项目
2. 获取数据库连接字符串
3. 创建本地环境变量文件 `.env.local`：
   ```bash
   DATABASE_URL="postgresql://user:password@host.neon.tech/database?sslmode=require"
   API_KEYS="your-local-dev-api-key"
   ```
4. 运行数据库迁移：
   ```bash
   npx drizzle-kit push
   ```

**优势**: Neon 是 Vercel Postgres 的底层提供商，SQL 语法 100% 兼容，无需修改代码即可从开发环境切换到生产环境。

### 8.3 生产部署步骤

1. **创建 Vercel 项目**
   - 连接 GitHub 仓库
   - 选择 Next.js 框架预设

2. **创建 Vercel Postgres 数据库**
   - Vercel Dashboard → Storage → Create Database
   - 选择 Postgres (Neon)

3. **配置环境变量**
   - `API_KEYS`: 生成一个随机字符串作为 API Key

4. **运行数据库迁移**
   ```bash
   npx drizzle-kit push
   ```

5. **部署**
   - Vercel 自动部署 main 分支

### 8.3 插件配置

在本地环境变量或 opencode 配置中设置：
```bash
export TOKEN_TRACKER_ENDPOINT="https://your-app.vercel.app/api/ingest"
export TOKEN_TRACKER_API_KEY="your-api-key"
```

---

## 9. 安全考虑

### 9.1 API Key 安全
- API Key 不存储在数据库中，仅作为环境变量存在于服务端
- 支持配置多个 API Key（逗号分隔），便于轮换
- 插件端 API Key 通过环境变量传入，不硬编码

### 9.2 数据隔离
- 每条记录关联上报时的 API Key
- 查询时只返回相同 API Key 的数据
- 不同 API Key 之间的数据完全隔离

### 9.3 输入验证
- 所有上报字段进行类型和范围验证
- 负数 token 数量会被拒绝或归零
- 缺失字段使用默认值

---

## 10. 扩展考虑

### 10.1 未来可能的扩展
- **多用户支持**: 引入用户系统，每个用户有独立的 API Key 和数据空间
- **费用估算**: 根据模型价格估算费用
- **告警**: 设置用量阈值，超过时通知
- **导出**: 支持导出 CSV/Excel

### 10.2 性能优化
- 对于高并发场景，可引入批量写入或消息队列
- 大数据量时，为 Dashboard 添加缓存层
- 预聚合统计数据到单独的汇总表

---

## 11. 开发计划

### Phase 1: 基础骨架
1. 初始化 Next.js 项目
2. 配置 Tailwind CSS
3. 配置 Drizzle ORM + Vercel Postgres
4. 创建数据库表和迁移

### Phase 2: API 层
1. 实现 `/api/ingest` 上报接口
2. 实现 `/api/stats` 聚合接口
3. 实现 `/api/records` 查询接口
4. 实现 API Key 认证中间件

### Phase 3: Dashboard UI
1. 创建概览卡片组件
2. 创建趋势图表组件
3. 创建分布图表组件
4. 创建记录表格组件
5. 组装 Dashboard 页面

### Phase 4: 插件开发
1. 创建插件包结构
2. 实现事件监听和上报逻辑
3. 测试插件集成

### Phase 5: 部署和文档
1. Vercel 部署配置
2. 数据库迁移
3. 插件安装文档
4. README 编写

---

*文档结束*
