# Token Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Token 用量统计 Web 应用，包含 Next.js Dashboard + API，以及 opencode 普通插件，部署在 Vercel，使用 Vercel Postgres 数据库。

**Architecture:** 采用 monorepo 结构，根目录为 Next.js 14 App Router 应用，包含 Web Dashboard 页面和 REST API。插件作为独立 package 放在 `packages/plugin/` 目录，通过 npm + git 安装。数据通过 `POST /api/ingest` 实时上报，存储在 Vercel Postgres，Dashboard 通过 `GET /api/stats` 和 `GET /api/records` 查询展示。

**Tech Stack:** Next.js 14, TypeScript, Tailwind CSS, Recharts, Drizzle ORM, Vercel Postgres (Neon), SolidJS (opencode plugin peer dep)

---

## File Structure

```
token-tracker/
├── src/
│   ├── app/
│   │   ├── page.tsx                    # Dashboard 首页
│   │   ├── layout.tsx                  # 根布局
│   │   └── globals.css                 # 全局样式
│   ├── app/api/
│   │   ├── ingest/route.ts            # POST /api/ingest
│   │   ├── stats/route.ts             # GET /api/stats
│   │   └── records/route.ts           # GET /api/records
│   ├── components/
│   │   ├── Dashboard.tsx              # Dashboard 主组件
│   │   ├── StatsCards.tsx             # 概览卡片
│   │   ├── TrendChart.tsx             # 趋势图
│   │   ├── ModelDistributionChart.tsx # 模型分布
│   │   ├── ProviderDistributionChart.tsx # 供应商分布
│   │   └── RecordsTable.tsx           # 记录表格
│   ├── lib/
│   │   └── db/
│   │       ├── schema.ts              # Drizzle schema
│   │       └── index.ts               # DB client + queries
│   └── middleware.ts                  # API Key 认证中间件
├── packages/
│   └── plugin/
│       ├── package.json               # 插件包配置
│       ├── tsconfig.json              # 插件 TS 配置
│       └── src/
│           └── index.ts               # 插件入口
├── drizzle.config.ts                  # Drizzle CLI 配置
├── .env.example                       # 环境变量模板
├── .env.local                         # 本地环境变量 (gitignored)
├── next.config.js                     # Next.js 配置
├── tailwind.config.ts                 # Tailwind 配置
├── tsconfig.json                      # 根 TS 配置
└── package.json                       # 根 package.json
```

---

## Task 1: 项目初始化

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.js`
- Create: `tailwind.config.ts`
- Create: `.env.example`
- Create: `src/app/layout.tsx`
- Create: `src/app/globals.css`
- Create: `src/app/page.tsx`

- [ ] **Step 1.1: 初始化 package.json**

```json
{
  "name": "token-tracker",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "next": "14.2.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "drizzle-orm": "^0.31.0",
    "postgres": "^3.4.4",
    "recharts": "^2.12.7",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.3.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "autoprefixer": "^10.4.19",
    "drizzle-kit": "^0.22.0",
    "postcss": "^8.4.38",
    "tailwindcss": "^3.4.4",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 1.2: 安装依赖**

```bash
npm install
```

Expected: `node_modules/` 创建，无报错

- [ ] **Step 1.3: 创建 TypeScript 配置**

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 1.4: 创建 Next.js 配置**

Create `next.config.js`:
```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
};

module.exports = nextConfig;
```

- [ ] **Step 1.5: 创建 Tailwind 配置**

Create `tailwind.config.ts`:
```typescript
import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
```

- [ ] **Step 1.6: 创建 PostCSS 配置**

Create `postcss.config.js`:
```javascript
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 1.7: 创建根布局**

Create `src/app/layout.tsx`:
```typescript
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Token Tracker",
  description: "LLM Token Usage Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900">
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 1.8: 创建全局样式**

Create `src/app/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
```

- [ ] **Step 1.9: 创建首页占位**

Create `src/app/page.tsx`:
```typescript
export default function Home() {
  return (
    <main className="min-h-screen p-8">
      <h1 className="text-3xl font-bold mb-8">Token Tracker Dashboard</h1>
      <p>Loading...</p>
    </main>
  );
}
```

- [ ] **Step 1.10: 创建环境变量模板**

Create `.env.example`:
```bash
# Database
DATABASE_URL="postgresql://user:password@host:port/database"

# API Keys (comma separated)
API_KEYS="your-api-key-here"
```

- [ ] **Step 1.11: 创建本地环境变量文件 (Neon)**

开发测试阶段使用 Neon 免费数据库：

1. 注册 [Neon](https://neon.tech) 账号，创建免费项目
2. 获取数据库连接字符串
3. Create `.env.local`:
```bash
DATABASE_URL="postgresql://user:password@host.neon.tech/database?sslmode=require"
API_KEYS="your-local-dev-api-key"
```

注意：`.env.local` 已添加到 `.gitignore`，不会提交到 git。

- [ ] **Step 1.12: Commit**

```bash
git add .
git commit -m "chore: initialize Next.js project with TypeScript and Tailwind"
```

---

## Task 2: 数据库层

**Files:**
- Create: `src/lib/db/schema.ts`
- Create: `src/lib/db/index.ts`
- Create: `drizzle.config.ts`

- [ ] **Step 2.1: 创建 Drizzle Schema**

Create `src/lib/db/schema.ts`:
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

export type TokenRecord = typeof tokenRecords.$inferSelect;
export type NewTokenRecord = typeof tokenRecords.$inferInsert;
```

- [ ] **Step 2.2: 创建数据库客户端**

Create `src/lib/db/index.ts`:
```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;

// 禁用预编译语句以避免 prepared statement 冲突
const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client, { schema });
```

- [ ] **Step 2.3: 创建 Drizzle 配置**

Create `drizzle.config.ts`:
```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 2.4: Commit**

```bash
git add src/lib/db/ drizzle.config.ts
git commit -m "feat: add database schema and Drizzle ORM setup"
```

---

## Task 3: API 认证中间件

**Files:**
- Create: `src/middleware.ts`

- [ ] **Step 3.1: 创建 API Key 认证中间件**

Create `src/middleware.ts`:
```typescript
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  // 只对 /api/* 路由进行认证
  if (!request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const apiKey = request.headers.get("X-API-Key");
  const validKeys = process.env.API_KEYS?.split(",").map((k) => k.trim()) || [];

  if (!apiKey || !validKeys.includes(apiKey)) {
    return NextResponse.json(
      { success: false, error: "Invalid or missing API Key" },
      { status: 401 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
```

- [ ] **Step 3.2: Commit**

```bash
git add src/middleware.ts
git commit -m "feat: add API key authentication middleware"
```

---

## Task 4: API Routes

**Files:**
- Create: `src/app/api/ingest/route.ts`
- Create: `src/app/api/stats/route.ts`
- Create: `src/app/api/records/route.ts`

- [ ] **Step 4.1: 创建数据上报接口**

Create `src/app/api/ingest/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const apiKey = request.headers.get("X-API-Key")!;

    // 验证必填字段
    if (!body.model || !body.provider) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: model, provider" },
        { status: 400 }
      );
    }

    // 插入记录
    const result = await db
      .insert(tokenRecords)
      .values({
        apiKey,
        model: String(body.model),
        provider: String(body.provider),
        inputTokens: Math.max(0, Number(body.inputTokens) || 0),
        outputTokens: Math.max(0, Number(body.outputTokens) || 0),
        cacheRead: Math.max(0, Number(body.cacheRead) || 0),
        cacheWrite: Math.max(0, Number(body.cacheWrite) || 0),
      })
      .returning();

    return NextResponse.json({ success: true, id: result[0].id });
  } catch (error) {
    console.error("Ingest error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 4.2: 创建聚合统计接口**

Create `src/app/api/stats/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.headers.get("X-API-Key")!;
    const { searchParams } = new URL(request.url);
    const groupBy = searchParams.get("groupBy") || "date";
    const range = searchParams.get("range") || "30d";

    // 计算时间范围
    let dateFilter: Date | null = null;
    if (range !== "all") {
      const days = parseInt(range);
      dateFilter = new Date();
      dateFilter.setDate(dateFilter.getDate() - days);
    }

    let query;

    if (groupBy === "date") {
      const granularity = searchParams.get("granularity") || "day";
      let dateFormat: string;

      if (granularity === "week") {
        dateFormat = "YYYY-WW";
      } else if (granularity === "month") {
        dateFormat = "YYYY-MM";
      } else {
        dateFormat = "YYYY-MM-DD";
      }

      query = db
        .select({
          group: sql<string>`TO_CHAR(${tokenRecords.createdAt}, ${dateFormat})`,
          totalInput: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheRead: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .where(sql`${tokenRecords.apiKey} = ${apiKey}`)
        .groupBy(sql`TO_CHAR(${tokenRecords.createdAt}, ${dateFormat})`)
        .orderBy(sql`TO_CHAR(${tokenRecords.createdAt}, ${dateFormat})`);

      if (dateFilter) {
        query = query.where(
          sql`${tokenRecords.apiKey} = ${apiKey} AND ${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
        );
      }
    } else if (groupBy === "model") {
      query = db
        .select({
          group: tokenRecords.model,
          totalInput: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheRead: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .where(sql`${tokenRecords.apiKey} = ${apiKey}`)
        .groupBy(tokenRecords.model)
        .orderBy(sql`SUM(${tokenRecords.inputTokens}) DESC`);
    } else {
      // provider
      query = db
        .select({
          group: tokenRecords.provider,
          totalInput: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheRead: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .where(sql`${tokenRecords.apiKey} = ${apiKey}`)
        .groupBy(tokenRecords.provider)
        .orderBy(sql`SUM(${tokenRecords.inputTokens}) DESC`);
    }

    const data = await query;

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Stats error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 4.3: 创建记录查询接口**

Create `src/app/api/records/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { sql, desc, eq, and, gte, lte } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.headers.get("X-API-Key")!;
    const { searchParams } = new URL(request.url);

    // 分页参数
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50")));
    const offset = (page - 1) * limit;

    // 筛选条件
    const conditions = [eq(tokenRecords.apiKey, apiKey)];

    const model = searchParams.get("model");
    if (model) conditions.push(eq(tokenRecords.model, model));

    const provider = searchParams.get("provider");
    if (provider) conditions.push(eq(tokenRecords.provider, provider));

    const startDate = searchParams.get("startDate");
    if (startDate) conditions.push(gte(tokenRecords.createdAt, new Date(startDate)));

    const endDate = searchParams.get("endDate");
    if (endDate) {
      const end = new Date(endDate);
      end.setDate(end.getDate() + 1);
      conditions.push(lte(tokenRecords.createdAt, end));
    }

    const whereClause = and(...conditions);

    // 查询数据
    const data = await db
      .select()
      .from(tokenRecords)
      .where(whereClause)
      .orderBy(desc(tokenRecords.createdAt))
      .limit(limit)
      .offset(offset);

    // 查询总数
    const countResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(tokenRecords)
      .where(whereClause);

    const total = countResult[0].count;

    return NextResponse.json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Records error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 4.4: Commit**

```bash
git add src/app/api/
git commit -m "feat: add API routes for ingest, stats, and records"
```

---

## Task 5: Dashboard UI 组件

**Files:**
- Create: `src/components/StatsCards.tsx`
- Create: `src/components/TrendChart.tsx`
- Create: `src/components/ModelDistributionChart.tsx`
- Create: `src/components/ProviderDistributionChart.tsx`
- Create: `src/components/RecordsTable.tsx`
- Create: `src/components/Dashboard.tsx`

- [ ] **Step 5.1: 创建概览卡片组件**

Create `src/components/StatsCards.tsx`:
```typescript
"use client";

import { useEffect, useState } from "react";

interface Stats {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  count: number;
}

export default function StatsCards() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const apiKey = localStorage.getItem("token-tracker-api-key") || "";
    if (!apiKey) return;

    fetch("/api/stats?groupBy=date&range=all", {
      headers: { "X-API-Key": apiKey },
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          const totals = data.data.reduce(
            (acc: Stats, item: any) => ({
              totalInput: acc.totalInput + Number(item.totalInput || 0),
              totalOutput: acc.totalOutput + Number(item.totalOutput || 0),
              totalCacheRead: acc.totalCacheRead + Number(item.totalCacheRead || 0),
              totalCacheWrite: acc.totalCacheWrite + Number(item.totalCacheWrite || 0),
              count: acc.count + Number(item.count || 0),
            }),
            { totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, count: 0 }
          );
          setStats(totals);
        }
      });
  }, []);

  const formatNumber = (num: number) => new Intl.NumberFormat("en-US").format(num);

  const cards = [
    { label: "Total Input", value: stats?.totalInput || 0, color: "blue" },
    { label: "Total Output", value: stats?.totalOutput || 0, color: "green" },
    { label: "Total Cache", value: (stats?.totalCacheRead || 0) + (stats?.totalCacheWrite || 0), color: "purple" },
    { label: "Total Requests", value: stats?.count || 0, color: "orange" },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {cards.map((card) => (
        <div key={card.label} className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm font-medium text-gray-500">{card.label}</h3>
          <p className="text-2xl font-bold mt-2">{formatNumber(card.value)}</p>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5.2: 创建趋势图表组件**

Create `src/components/TrendChart.tsx`:
```typescript
"use client";

import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface TrendData {
  group: string;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
}

export default function TrendChart({ range = "30d" }: { range?: string }) {
  const [data, setData] = useState<TrendData[]>([]);

  useEffect(() => {
    const apiKey = localStorage.getItem("token-tracker-api-key") || "";
    if (!apiKey) return;

    fetch(`/api/stats?groupBy=date&range=${range}`, {
      headers: { "X-API-Key": apiKey },
    })
      .then((res) => res.json())
      .then((result) => {
        if (result.success) {
          setData(result.data);
        }
      });
  }, [range]);

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-8">
      <h3 className="text-lg font-semibold mb-4">Token Usage Trend</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="group" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="totalInput" stroke="#3B82F6" name="Input" />
          <Line type="monotone" dataKey="totalOutput" stroke="#10B981" name="Output" />
          <Line type="monotone" dataKey="totalCacheRead" stroke="#8B5CF6" name="Cache Read" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 5.3: 创建模型分布图表**

Create `src/components/ModelDistributionChart.tsx`:
```typescript
"use client";

import { useEffect, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";

const COLORS = ["#3B82F6", "#10B981", "#8B5CF6", "#F59E0B", "#EF4444", "#EC4899"];

interface ModelData {
  group: string;
  totalInput: number;
}

export default function ModelDistributionChart() {
  const [data, setData] = useState<ModelData[]>([]);

  useEffect(() => {
    const apiKey = localStorage.getItem("token-tracker-api-key") || "";
    if (!apiKey) return;

    fetch("/api/stats?groupBy=model", {
      headers: { "X-API-Key": apiKey },
    })
      .then((res) => res.json())
      .then((result) => {
        if (result.success) {
          setData(result.data);
        }
      });
  }, []);

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold mb-4">By Model</h3>
      <ResponsiveContainer width="100%" height={250}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            labelLine={false}
            label={(entry) => `${entry.group}: ${entry.totalInput}`}
            outerRadius={80}
            fill="#8884d8"
            dataKey="totalInput"
          >
            {data.map((_, index) => (
              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 5.4: 创建供应商分布图表**

Create `src/components/ProviderDistributionChart.tsx`:
```typescript
"use client";

import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

interface ProviderData {
  group: string;
  totalInput: number;
}

export default function ProviderDistributionChart() {
  const [data, setData] = useState<ProviderData[]>([]);

  useEffect(() => {
    const apiKey = localStorage.getItem("token-tracker-api-key") || "";
    if (!apiKey) return;

    fetch("/api/stats?groupBy=provider", {
      headers: { "X-API-Key": apiKey },
    })
      .then((res) => res.json())
      .then((result) => {
        if (result.success) {
          setData(result.data);
        }
      });
  }, []);

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold mb-4">By Provider</h3>
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="group" />
          <YAxis />
          <Tooltip />
          <Bar dataKey="totalInput" fill="#3B82F6" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 5.5: 创建记录表格组件**

Create `src/components/RecordsTable.tsx`:
```typescript
"use client";

import { useEffect, useState } from "react";

interface Record {
  id: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  createdAt: string;
}

export default function RecordsTable() {
  const [records, setRecords] = useState<Record[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    const apiKey = localStorage.getItem("token-tracker-api-key") || "";
    if (!apiKey) return;

    fetch(`/api/records?page=${page}&limit=20`, {
      headers: { "X-API-Key": apiKey },
    })
      .then((res) => res.json())
      .then((result) => {
        if (result.success) {
          setRecords(result.data);
          setTotalPages(result.pagination.totalPages);
        }
      });
  }, [page]);

  const formatNumber = (num: number) => new Intl.NumberFormat("en-US").format(num);
  const formatDate = (date: string) => new Date(date).toLocaleString();

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <h3 className="text-lg font-semibold p-6 pb-0">Recent Records</h3>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Output</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cache</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {records.map((record) => (
              <tr key={record.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {formatDate(record.createdAt)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{record.model}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{record.provider}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.inputTokens)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.outputTokens)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                  {formatNumber(record.cacheRead + record.cacheWrite)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-6 py-4 flex justify-between items-center border-t">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
          className="px-4 py-2 bg-gray-100 rounded disabled:opacity-50"
        >
          Previous
        </button>
        <span className="text-sm text-gray-600">
          Page {page} of {totalPages}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
          className="px-4 py-2 bg-gray-100 rounded disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5.6: 创建 Dashboard 主组件**

Create `src/components/Dashboard.tsx`:
```typescript
"use client";

import { useState } from "react";
import StatsCards from "./StatsCards";
import TrendChart from "./TrendChart";
import ModelDistributionChart from "./ModelDistributionChart";
import ProviderDistributionChart from "./ProviderDistributionChart";
import RecordsTable from "./RecordsTable";

export default function Dashboard() {
  const [apiKey, setApiKey] = useState("");
  const [isConfigured, setIsConfigured] = useState(false);
  const [range, setRange] = useState("30d");

  const handleConfigure = () => {
    if (apiKey.trim()) {
      localStorage.setItem("token-tracker-api-key", apiKey.trim());
      setIsConfigured(true);
    }
  };

  if (!isConfigured) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-white rounded-lg shadow p-8 max-w-md w-full">
          <h2 className="text-2xl font-bold mb-4">Token Tracker</h2>
          <p className="text-gray-600 mb-4">
            Enter your API Key to view your token usage dashboard.
          </p>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Enter API Key"
            className="w-full px-4 py-2 border rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleConfigure}
            className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition"
          >
            Connect
          </button>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Token Tracker Dashboard</h1>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="px-4 py-2 border rounded-lg"
          >
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
            <option value="90d">Last 90 Days</option>
            <option value="all">All Time</option>
          </select>
        </div>

        <StatsCards />
        <TrendChart range={range} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
          <ModelDistributionChart />
          <ProviderDistributionChart />
        </div>

        <RecordsTable />
      </div>
    </main>
  );
}
```

- [ ] **Step 5.7: 更新首页**

Modify `src/app/page.tsx`:
```typescript
import Dashboard from "@/components/Dashboard";

export default function Home() {
  return <Dashboard />;
}
```

- [ ] **Step 5.8: Commit**

```bash
git add src/components/ src/app/page.tsx
git commit -m "feat: add dashboard UI components with charts and data table"
```

---

## Task 6: opencode 插件

**Files:**
- Create: `packages/plugin/package.json`
- Create: `packages/plugin/tsconfig.json`
- Create: `packages/plugin/src/index.ts`

- [ ] **Step 6.1: 创建插件 package.json**

Create `packages/plugin/package.json`:
```json
{
  "name": "@token-tracker/plugin",
  "version": "0.1.0",
  "description": "opencode plugin for token usage tracking",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": "*"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "latest",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 6.2: 创建插件 TS 配置**

Create `packages/plugin/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 6.3: 创建插件入口**

Create `packages/plugin/src/index.ts`:
```typescript
import type { Plugin } from "@opencode-ai/plugin";

const API_ENDPOINT = process.env.TOKEN_TRACKER_ENDPOINT || "";
const API_KEY = process.env.TOKEN_TRACKER_API_KEY || "";

const plugin: Plugin = async ({ client }) => {
  if (!API_ENDPOINT || !API_KEY) {
    client.app.log({
      body: {
        service: "token-tracker",
        level: "warn",
        message: "Token Tracker plugin disabled: TOKEN_TRACKER_ENDPOINT or TOKEN_TRACKER_API_KEY not set",
      },
    });
    return {};
  }

  return {
    "message.updated": async ({ event }) => {
      const message = event.properties.info;

      // 只处理 assistant 消息
      if (!message || message.role !== "assistant") {
        return;
      }

      // 只处理已完成且有 token 信息的消息
      if (!message.time?.completed || !message.tokens) {
        return;
      }

      const payload = {
        model: message.model || "unknown",
        provider: message.provider || "unknown",
        inputTokens: message.tokens.input || 0,
        outputTokens: message.tokens.output || 0,
        cacheRead: message.tokens.cache?.read || 0,
        cacheWrite: message.tokens.cache?.write || 0,
      };

      try {
        const response = await fetch(API_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const error = await response.text();
          client.app.log({
            body: {
              service: "token-tracker",
              level: "error",
              message: `Failed to report token usage: ${error}`,
            },
          });
        }
      } catch (error) {
        client.app.log({
          body: {
            service: "token-tracker",
            level: "error",
            message: `Token Tracker network error: ${(error as Error).message}`,
          },
        });
      }
    },
  };
};

export default plugin;
```

- [ ] **Step 6.4: Commit**

```bash
git add packages/
git commit -m "feat: add opencode plugin for token usage reporting"
```

---

## Task 7: 部署配置

**Files:**
- Modify: `package.json`
- Create: `vercel.json`
- Create: `README.md`

- [ ] **Step 7.1: 更新 package.json scripts**

Modify `package.json`:
```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}
```

- [ ] **Step 7.2: 创建 Vercel 配置**

Create `vercel.json`:
```json
{
  "buildCommand": "next build",
  "outputDirectory": ".next",
  "framework": "nextjs"
}
```

- [ ] **Step 7.3: 创建 README**

Create `README.md`:
```markdown
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
```

- [ ] **Step 7.4: Commit**

```bash
git add package.json vercel.json README.md
git commit -m "docs: add deployment config and README"
```

---

## Self-Review

### Spec Coverage Check

| Spec Requirement | Implementing Task |
|-----------------|------------------|
| Next.js Web App | Task 1, 5 |
| Vercel Postgres DB | Task 2 |
| API Key Auth | Task 3 |
| POST /api/ingest | Task 4.1 |
| GET /api/stats | Task 4.2 |
| GET /api/records | Task 4.3 |
| Dashboard with charts | Task 5 |
| opencode plugin (普通) | Task 6 |
| Vercel deployment | Task 7 |

**Coverage:** 100% - 所有 spec 需求都有对应任务

### Placeholder Scan

- [x] 无 "TBD"/"TODO"
- [x] 无 "implement later"
- [x] 每个代码步骤都有完整代码
- [x] 所有类型和函数名一致

### Type Consistency

- `TokenRecord` / `NewTokenRecord` 在 Task 2 定义，后续使用一致
- API 响应格式 `{ success: boolean, ... }` 在所有 endpoint 中一致
- `message.tokens` 结构在所有地方一致

---

*Plan complete.*
