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
npm run lint                # ESLint 9 flat config（Next 16 起 next lint 已移除）
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
| 新增或修改 `/api/*` 路由、认证、TOTP、recovery codes | `docs/agents/api-routes.md` |
| `/v1/*` `/v1beta/*` `/raw/*` 代理链路、model 路由、failover、探活、usage 解析、header transforms、出站代理 | `docs/agents/gateway.md` |
| 多实例同步（push / ingest / 水位 / uid） | `docs/agents/sync.md` |
| 统计口径、Dashboard/Records 聚合、延迟统计、Dashboard 组件清单、定价、models.dev、model 归一化、Provider 匿名化、Agent 派生、时区、查询缓存 | `docs/agents/data-conventions.md` |
| UI / 组件 / 新增表格弹窗 / 移动端适配 | `docs/agents/deployment.md` |
| env、Dockerfile、docker-compose、GHCR 发布流程、安全响应头 | `docs/agents/deployment.md` |
| 加测试 / 改动被测模块 | `docs/agents/testing.md` |

## 硬约束（红线，任何改动都适用）

- **认证**：新增 `/api/*` 路由**默认**必须用 `withAuth` 包裹（`src/lib/auth/guard.ts`），否则 `src/lib/auth/guard-scan.test.ts` 静态扫描测试失败。公开例外必须先 review 泄露面，并**三处同步登记**：`guard-scan.test.ts` 的 `exempt`、`src/middleware.ts` matcher 排除项、`docs/agents/api-routes.md` 接口表（写明公开理由与返回字段）—— 只改 `exempt` 会被 middleware 拦成 401。当前登记的唯一公开只读例外是 `/api/cli`（只返回全时段聚合 summary + today，无 provider/model/agent 维度，进程内快照限流）。除 login/setup/logout 与已登记例外，`/api/*` 只接受**会话 token**，原始 API key 不能直接调；脚本/curl 必须先 `POST /api/auth/login` 换 token，再带 `X-API-Key: <token>`
- **虚拟 key 认证**：只接受 header（`Authorization: Bearer` / `x-api-key` / `x-goog-api-key`），**不得恢复 `?key=` query 认证**（query 会进访问日志/反代日志/Referer）
- **缓存失效**：新增写入接口必须在写入成功后调用 `invalidateQueryCache()`，或将 handler 包进 `withSkipCache()`（`src/lib/db/cache.ts`）；settings 读写**必须**包 `withSkipCache()`（`src/lib/auth/settings.ts`），否则改 key/epoch+1/解绑 TOTP 后旧凭证最长残留 10s
- **模型命名与 token 口径**：`token_records.model` 一律写**发往 upstream 的真实 model 名**，客户端原始请求名写 `request_model`；`input_tokens` 不含 cache_read，`cache_read` 单独列，展示层 Total Input 含 cache
- **登录 key 强度**：个人/家庭部署允许弱 key，`getLoginKeyStrength()` 仅用于前端提示，不在 setup、改 key 或登录时强制拒绝；env 是否配置统一用 `getEnvAdminKeysConfigured()` 判定，弱 key 也不能被当成「未配置」而重新打开 setup
- **认证端点请求体**：`/api/auth/login`、`/api/auth/setup` 必须「先限流、再读 body」，body 走 `readJsonBodyLimited()`（64KB，content-length + chunked 双覆盖），不得用裸 `request.json()`
- **上游出站**：所有带真实 key 的出站 fetch（主链、responses 辅助链、probe、classifier、fetchUpstreamModels、fetchBalance、sync pusher）一律 `redirect: "manual"`，3xx 视为失败（防 key 跨源泄露）；一律注入 `getOutboundDispatcher(proxyUrl)`（无 proxy 时也必须是受连接时地址校验保护的直连 Agent，禁止裸 fetch）；`outboundFetch` 每次请求前还要跑 `assertOutboundUrlAllowed(url, scope)` —— 写入校验挡不住存量行，字面私网 IP 与非法 scheme 必须在运行时也 fail-closed；upstream baseUrl / proxyUrl 一律走 SSRF 校验（含连接时 DNS lookup 校验防 rebinding），不用裸 `^https?://` 正则；HTTP/HTTPS 均允许，内网地址由 `ALLOW_PRIVATE_UPSTREAMS` 与 sync loopback 例外控制
- **密钥与日志**：日志永不打印请求 body 与任何 key；`GATEWAY_SECRET` 缺失时代理路由与 admin API 返回 503，不静默降级；502/协议不匹配错误不回显 upstream 名、内网地址等内部细节
- **迁移**：`CREATE TABLE IF NOT EXISTS` 不会补列，存量列变更必须 `PRAGMA table_info` 检测 + `ALTER TABLE` 补列；所有迁移必须幂等
- **UI**：任何 UI 改动必须同时考虑移动端（<768px）——新表格做「桌面 table + `md:hidden` 卡片」双轨，新弹窗移动端全屏，触摸区 ≥40px；Admin 表格统一用共享组件 `src/components/admin/table.tsx`，禁止手写 `<table>`

## Git Commit

- DO NOT and MUST NOT commit plan/spec files to the repository.
- Commit message must in English.
- Format: Conventional Commits — `<type>(<scope>): <subject>` (e.g. `fix(gateway): skip client_aborted status when response complete`);
  type ∈ feat / fix / refactor / chore / docs / test / style; subject-only, no body.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
