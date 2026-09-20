# AGENTS.md

> 帮助未来 OpenCode 会话快速上手、避免常见错误。仅包含从代码库推断出的高信号事实。
> 本文件只放**常驻概要 + 开发者命令 + 必读表 + 硬约束 + Commit 约定**；领域细节在 `docs/agents/`，按「必读表」触发读取。

## 项目概览

- **Token Tracker**：基于 Next.js 14 App Router + Drizzle ORM + SQLite 的**个人 AI Gateway**（LLM Token 用量仪表盘 + 多协议上游代理）
- **网关定位**：`/v1/*` + `/v1beta/*` catch-all 纯透传（OpenAI/Anthropic/Gemini 三协议），透传中自动解析 token 用量写库；agent 客户端零插件，只改 base_url + key
- **部署目标**：Docker VPS（SQLite）
- **使用规模**：个人使用，日均约 1000 条记录

## 开发者命令

```bash
npm run dev                 # 启动开发服务器，访问 http://localhost:3000
npm run build               # 生产构建
npm run lint                # ESLint
npm test                    # vitest 单元测试（src/**/*.test.ts）
npx drizzle-kit studio      # Drizzle Studio（SQLite）

# Docker
docker build -t token-tracker:test .                # 本地构建
cp docker-compose.example.yml docker-compose.yml     # 首次使用：复制示例文件
docker compose up -d                                 # 本地运行
```

## 必读表（动手前先读对应文档）

| 要改什么 | 先读 |
|---|---|
| schema / 加表加列 / 写迁移 | `docs/agents/database.md` |
| 新增或修改 `/api/*` 路由、认证、TOTP、recovery codes、公开 Status 面板 | `docs/agents/api-routes.md` |
| `/v1/*` `/v1beta/*` `/raw/*` 代理链路、model 路由、failover、探活、usage 解析、header transforms、出站代理 | `docs/agents/gateway.md` |
| 多实例同步（push / ingest / 水位 / uid） | `docs/agents/sync.md` |
| 统计口径、Dashboard/Records 聚合、延迟统计、Dashboard 组件清单、定价、models.dev、model 归一化、Provider 匿名化、Hidden Sources、Agent 派生、时区、查询缓存 | `docs/agents/data-conventions.md` |
| UI / 组件 / 新增表格弹窗 / 移动端适配 | `docs/agents/deployment.md` |
| env、Dockerfile、docker-compose、GHCR 发布流程、安全响应头 | `docs/agents/deployment.md` |
| 加测试 / 改动被测模块 | `docs/agents/testing.md` |

## 硬约束（红线，任何改动都适用）

- **认证**：新增 `/api/*` 路由必须用 `withAuth` 包裹（`src/lib/auth/guard.ts`，login/setup 除外），否则 `src/lib/auth/guard-scan.test.ts` 静态扫描测试失败。所有 `/api/*`（login、setup 除外）只接受**会话 token**，原始 API key 不能直接调；脚本/curl 必须先 `POST /api/auth/login` 换 token，再带 `X-API-Key: <token>`
- **缓存失效**：新增写入接口必须在写入成功后调用 `invalidateQueryCache()`，或将 handler 包进 `withSkipCache()`（`src/lib/db/cache.ts`）；settings 读写**必须**包 `withSkipCache()`（`src/lib/auth/settings.ts`），否则改 key/epoch+1/解绑 TOTP 后旧凭证最长残留 10s
- **模型命名与 token 口径**：`token_records.model` 一律写**发往 upstream 的真实 model 名**，客户端原始请求名写 `request_model`；`input_tokens` 不含 cache_read，`cache_read` 单独列，展示层 Total Input 含 cache
- **上游出站**：所有带真实 key 的出站 fetch（主链、responses 辅助链、probe、fetchUpstreamModels、fetchBalance）一律 `redirect: "manual"`，3xx 视为失败（防 key 跨源泄露）；upstream baseUrl / proxyUrl 一律走 SSRF 校验，不用裸 `^https?://` 正则
- **密钥与日志**：日志永不打印请求 body 与任何 key；`GATEWAY_SECRET` 缺失时代理路由与 admin API 返回 503，不静默降级；502/协议不匹配错误不回显 upstream 名、内网地址等内部细节
- **迁移**：`CREATE TABLE IF NOT EXISTS` 不会补列，存量列变更必须 `PRAGMA table_info` 检测 + `ALTER TABLE` 补列；所有迁移必须幂等
- **UI**：任何 UI 改动必须同时考虑移动端（<768px）——新表格做「桌面 table + `md:hidden` 卡片」双轨，新弹窗移动端全屏，触摸区 ≥40px；Admin 表格统一用共享组件 `src/components/admin/table.tsx`，禁止手写 `<table>`

## Git Commit

- DO NOT and MUST NOT commit plan/spec files to the repository.
- Commit message must in English.
