# 开发、API 与环境变量

> 面向使用者的接口与本地开发说明。改代码前必读的开发约定在 [`agents/`](./agents/) 与仓库根 `AGENTS.md`。

## 本地开发与测试

需要 **Node >= 22.19**（Next 16 + better-sqlite3 13 的 N-API 预编译，无需 node-gyp）。

```bash
npm install
cp .env.example .env.local      # 可选：不建也能起，默认 ./data/token-tracker.db；dev 自动生成 GATEWAY_SECRET
npm run dev                     # 双进程 dev：页面 :3000（next dev HMR）+ API :3001（Hono，同源 rewrite）；3000 被占用时 DEV_WEB_PORT=3xxx
npm test                        # vitest 单测（覆盖代理链路/解析器/路由/加密/认证等核心模块，并发上限 = CPU 一半）
npm run lint                    # ESLint 9 flat config（Next 16 起 `next lint` 已移除）
npm run build                   # 生产构建：gen-routes + next build（静态导出 out/）+ esbuild 打包 build/server.js
npm start                       # 跑 build/server.js（宿主机验证用；自动加载 .env.production.local → .env.local → .env.production → .env，真实 env 优先）
npm run seed:demo -- --reset    # 灌 90 天演示数据（只写 token_records + model_prices，调试 UI 用）
npx drizzle-kit studio          # Drizzle Studio 查看 SQLite
```

- SQLite 数据库在首次请求时自动建表 + 增量迁移，无需手动操作
- `scripts/test_gateway.py` 是手动端到端网关脚本（虚拟 key → 代理请求 → 校验透传/写库），不入 vitest
- Docker 本地构建：`docker build -t token-tracker:test .`

## API 概览

| 路由 | 认证 | 说明 |
|---|---|---|
| `/v1/*`、`/v1beta/*` | 虚拟 key | 代理入口（纯透传） |
| `/raw/*` | 虚拟 key | 裸透传入口：剥掉 `/raw` 前缀后按内层路径透传到上游（用于 `/v1`、`/v1beta` 之外的端点） |
| `/ingest/records` | ingest token（`Bearer it-xxx`） | 多实例同步接收端点（A 侧），独立于会话认证 |
| `/api/auth/login` | 原始 API key（+ 可选 TOTP） | 登录换取会话 token（浏览器同时下发 httpOnly cookie） |
| `/api/cli` | **无（公开只读）** | 公开用量快照：全时段 `summary` + 当日 `today`（`?tzOffset=` 对齐时区，仅 token/cache/请求数聚合，无模型名与成本） |
| `/api/dashboard` 等统计 API | 会话 token（浏览器走 cookie，脚本用 `X-API-Key` header） | 仪表盘数据 |
| `/api/admin/*` | 会话 token | 管理操作 |
| `/`、`/records`、`/admin` | 页面 + 会话 token | 仪表盘 / 用量明细 / 管理面板 |

> 除 `login` / `setup` / `logout` 与已登记的公开只读例外 `/api/cli` 外，所有 `/api/*` 路由只接受会话 token，原始 API key 不能直接调。脚本示例：

```bash
TOKEN=$(curl -s -X POST http://host:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"your-api-key"}' | jq -r .token)
curl -s http://host:3000/api/dashboard -H "X-API-Key: $TOKEN"
```

完整接口清单（含各 admin 子资源的字段与校验规则）见 [`agents/api-routes.md`](./agents/api-routes.md)。

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `SQLITE_DATABASE_PATH` | 否 | SQLite 数据库文件路径，默认 `./data/token-tracker.db`（Docker 由 compose 显式指定） |
| `ADMIN_API_KEY` | 建议 | 管理面用 API key，逗号分隔多个；个人/家庭部署允许弱 key，前端提供强度提示，生产建议 ≥16 字符且 ≥2 类字符；已配置弱 key 也不会重新打开首次设置向导；未设置且 DB 无 key 时出现首次设置向导（旧名 `API_KEYS` 已废弃） |
| `GATEWAY_SECRET` | 生产是 | 网关主密钥（AES-256-GCM），`openssl rand -hex 32` 生成；缺失时代理与管理 API 返回 503。`npm run dev` 缺失时自动生成并复用 `<db 目录>/.gateway-secret`（仅 dev，`npm run build` / `npm start` 不生成） |
| `SESSION_TOKEN_TTL_HOURS` | 否 | 会话 token 有效期（小时，默认 24，滑动续期） |
| `TRUSTED_PROXY` | 否 | 前置反代已设置 `X-Real-IP` 时设为 true，恢复精确 IP 限流 |
| `API_CACHE_TTL_MS` | 否 | SELECT 缓存 TTL（毫秒，默认 10000，0 关闭） |
| `API_CACHE_MAX_SIZE` | 否 | SELECT 缓存最大条目数，默认 1000 |
| `GATEWAY_MAX_BODY_MB` | 否 | 代理请求体上限（MB，默认 32） |
| `ALLOW_PRIVATE_UPSTREAMS` | 否 | 允许 upstream 指向内网/环回地址（内网自建 LLM 逃生开关） |

`SESSION_TOKEN_TTL_HOURS` 也可在管理面板 Security 页配置（面板优先，env 仅 fallback）。
