# 部署、前端安全与移动端适配

> 上级文档：`AGENTS.md`。改 env / Dockerfile / compose / 发布流程 / UI 前必读。

## Web 前端安全与 PWA

- **安全响应头**（`next.config.js` 全局 header，`:path*`）：`X-Frame-Options: DENY`（点击劫持）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy`（禁 camera/mic/geolocation）、CSP：`default-src 'self'` + `script-src 'self' 'unsafe-inline'`（**dev 模式额外放行 `unsafe-eval`**，生产不放松；`unsafe-inline` 因 Next bootstrap/styled-jsx 需要）+ `frame-ancestors 'none'` + `object-src 'none'`；`poweredByHeader: false`（不暴露 x-powered-by 框架身份）
- **PWA 可安装性**：`src/app/manifest.ts`（manifest + 图标），无 Service Worker（离线能力未启用）；移动端底栏 `MobileTabBar.tsx`（`md:hidden`，只有 Dashboard / Records / Admin 三项导航，无登出）
- **依赖与工具链**：Next 16（App Router，Turbopack 构建）+ React 19 + undici 8 + **better-sqlite3 13（N-API）**（均要求 **Node >= 22.19**，`node:22-slim` 浮动 tag 当前 22.23.x 即可，本地开发建议同版本；better-sqlite3 13 起为 N-API 预编译，无需 node-gyp 编译，并修复了 Node 24 退出期 `RemoveEnvironmentCleanupHook` native abort）。`next lint` 在 Next 16 已移除 → `npm run lint` = `eslint .`，规则集为 `eslint.config.mjs`（flat config，eslint-config-next 16 的 core-web-vitals + typescript 预设；`no-explicit-any` 与 React Compiler 系列规则按升级前基线显式关闭）。`tsconfig.json` 排除 `**/*.test.ts`（Next 16 的构建期类型检查会覆盖测试文件，测试类型由 vitest/esbuild 负责，与 Next 14 行为对齐）
- **Docker 构建**：Dockerfile `output: 'standalone'` + base `node:22-slim` + `ENV NODE_OPTIONS=--max-old-space-size=256 --expose-gc --max-semi-space-size=8`（生产内存控制：收紧 old space 上限 + young gen 双 semi-space 从 32MB 降到 16MB + `src/instrumentation.ts` instrumentationHook 每 5 分钟 RSS>64MB 时 full GC 归还内存）+ jemalloc（`LD_PRELOAD` 替换 glibc malloc，native 分配回收更彻底，防长跑 RSS 碎片爬升；构建期软链到架构无关路径）；docker-compose.example.yml 含 `TRUSTED_PROXY` 与可选 `deploy.memory` 注释
- **TOTP 绑定二维码**：`qrcode.react`（^4.2.0）渲染 otpauth:// URI
- **`scripts/test_gateway.py`**：手动端到端网关测试脚本（虚拟 key → 代理请求 → 校验透传/写库），不入 vitest，仅供本地联调

## 移动端适配约定

- 任何 UI 改动必须同时考虑移动端（<768px）：新表格必须做「桌面 table + `md:hidden` 卡片」双轨；
  新弹窗移动端全屏（`w-full h-full md:...`）；新导航/按钮触摸区 ≥40px；input 移动端字号 ≥16px
- 移动端专属 UI 一律 `md:hidden` 门控，桌面端 DOM 只新增不修改
- **弹层滚动隔离**：全屏弹窗 / 底部抽屉的内部滚动容器一律 `overflow-y-auto overscroll-contain`（否则滑到底后会链式滚动背后页面），并在弹窗打开时用 `useBodyScrollLock(open)`（`src/hooks/useBodyScrollLock.ts`，引用计数 + body 固定+负 top 保留滚动位置）锁 body；新弹窗两个都要加
- **弹层必须走 portal**：`src/components/ModalPortal.tsx`（`createPortal` 到 `document.body`）。页面里任意 `transform / filter / contain / will-change` 祖先都会让 `position: fixed` 退化成相对该祖先定位——表现为遮罩和卡片整体下移、顶部露出未压暗的页面（Records 筛选抽屉、Upstreams 选型、PricePicker、Sync/VirtualKeys 删除确认、Recovery codes、Price Simulation 均已接入）。
- **z-index 分层（移动端）**：页面内容 / sticky 筛选栏 ≤ `z-20` → 底栏 `MobileTabBar` `z-40` → 弹层（全屏弹窗 / 底部抽屉）`z-50`。底栏**不能**用 `z-50`：它与弹窗同级但 DOM 在后，会盖住全屏弹窗底部的 Cancel/Save（如 Upstreams 的 Fetch Models 选型弹窗）
- **移动端 Records 页**（`RecordsPage` / `RecordsTable`）：顶栏只留一行「`Filters`（带激活数徽标）/ 刷新 / Auto 15s」，三个多维筛选（`MultiSelect`，与桌面同一组件）+ Rows + Columns 收进底部抽屉（`fixed inset-0 z-50 md:hidden`，max-h 85dvh，Esc 与遮罩关闭，触摸区 ≥40px（Rows / Reset / Done 为 44px））；列表卡片为白卡 `rounded-xl bg-white shadow-sm ring-1 ring-gray-100`，默认四行（模型+状态 / 时间·provider·agent / In·Out·Cache% / 延迟），点击展开完整明细（Manual / Requested / Key / User-Agent / Prompt 分解 / 精确延迟 / Session / ISO 时间）——**移动端没有 hover，明细不能只靠 `title`**；移动端分页只留 prev / 页码输入 / next
- 移动端白卡必须与页面底色拉开层次：`main` 为 `bg-gray-50`，桌面表格外壳的 `bg-white/shadow/overflow-hidden` 一律降级为 `md:` 前缀，否则移动端卡片会被包在白色容器里看不出边界
- **移动端 Admin 二级导航**：`/admin` 是分区列表页（分区元数据单一来源 `src/app/admin/sections.tsx`：id / label / description / Icon），子页顶部只留「← Admin + 当前分区名」（`md:hidden`，不吸顶——否则与面板自身的 `sticky top-0` 筛选栏叠在同一位置）；**不再用横向滚动 pill**（7 个分区有 3 个永远在屏外且无滚动提示）。桌面端导航仍在 `AppSidebar`
- **登出入口**（全站只有两处，无浮动按钮、无 Tab，**两处都是二次确认**）：移动端 = `/admin` 列表页底部红色 `Logout` 行；桌面端 = `AppSidebar` 的 Admin 子菜单末尾项（inline 与收起态 flyout 都有）。确认窗口由 `useConfirmLogout()`（`src/components/LogoutContext.tsx`）统一提供：点一次进入确认态（3s 超时复位），再次点击才 `await apiLogout()` + 复位登录态（防 cookie 竞态）；侧栏 flyout 首次点击不关闭，否则第二次点击无处可点
- **桌面侧栏可收起**：`AppSidebar`（`w-56`）/ 内容区（`md:pl-56`）由 `ApiKeyGate` 的 `sidebarCollapsed` 同步切换为 `w-16` / `md:pl-16`；偏好存 `localStorage` key `tt:sidebar-collapsed`（设备级 UI 状态，不进 settings 表）；收起时只留图标（`title` 提示）、隐藏版本号 / Dashboard 锤点 / Admin 子项 / 侧栏底部操作组（含 NumberFormatToggle）；`<md` 侧栏本就 `hidden`，移动端不受影响
- **Admin 面板表格统一使用共享组件 `src/components/admin/table.tsx`**（`AdminTableCard` / `AdminTable` / `AdminTableHead` / `AdminTableBody` / `AdminTd` / `AdminTableEmptyRow` / `AdminMobileCards` / `AdminMobileCard` / `AdminMobileEmpty`），新增/修改 Admin 表格禁止手写 `<table>`——样式以 **Records 页表格为基准**（两边视觉一致）：桌面外壳 `hidden md:block overflow-x-auto`、表头 `thead.bg-gray-50` + `tr.text-left.text-xs.font-medium.text-gray-500.uppercase` + `px-6 py-3`、单元格 `px-6 py-4`、tbody `divide-y divide-gray-200`、数字列 `text-right font-mono text-xs`（`AdminTd align="right" mono`）、操作列 `text-right whitespace-nowrap`、移动端卡片 `rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100`（双 checkbox 行保留 `h-5 w-5`）。`AdminTableCard` 默认带 `p-4`（含标题/操作区的面板）；`flush` 用于表格满卡（无内边距 + `overflow-hidden` + header `px-6 py-3 border-b`），`/admin/audit` 即用 `flush`。徽标语义各异不抽公共组件，各面板局部实现
- 复用现有范式：RecordsTable 双轨、ActionMenu、FiltersModal、PriceSimulatorModal、`ColumnPicker`（列可见性下拉，`columns` 由调用方传入，Records / Audit 共用）
- 提交前自检：375px 视口无横向溢出，桌面端视觉无回归
- **触摸区 40px 的统一写法**：移动端可点元素加 `min-h-[40px]`（文字型链接按钮用 `inline-flex items-center` 才能生效）+ 桌面端用 `md:min-h-0` 还原紧凑行高；原先的 `py-1` / `py-1.5` / `text-xs` 小按钮在手机上只有 26–32px。仅桌面端渲染的元素（`AdminTd` 单元格内的文字型 Save/Edit、`AppSidebar` 内部按钮）无需加，它们不受 `<md` 影响

## 环境变量

```bash
# SQLite（可选，默认 ./data/token-tracker.db）
SQLITE_DATABASE_PATH="./data/token-tracker.db"

# AI Gateway 主密钥（生产必需；npm run dev 缺失时自动生成到 <db 目录>/.gateway-secret）
GATEWAY_SECRET=""                   # AES-256-GCM 32 字节（hex/base64）；openssl rand -hex 32

# 可选：bootstrap（未配置且 DB 无 key 时 Web 端出现首次设置向导）
# ADMIN_API_KEY="..."               # 可设置多个，逗号分隔；旧名 API_KEYS 兼容（deprecated）
#                                   # 强度仅提示；个人/家庭部署允许弱 key，生产建议 >=16 字符且 >=2 类字符
#                                   # 且不会重新打开首次设置向导（fail-closed）

# 可选：也可在 admin panel Security/Display tab 配置（面板优先，env 仅 fallback）
SESSION_TOKEN_TTL_HOURS=24          # 会话 token 有效期（小时），默认 24，滑动续期；只影响新签发 token

# 安全：默认 false（fail-closed）。仅当前置反代已设置 X-Real-IP 并覆盖客户端 XFF 时设为 true。
# false 时登录/设置限流用全局桶（防 XFF 伪造绕过限流），审计 IP 记为 unknown；
# true 时恢复精确 IP 限流（取 x-real-ip，回退 XFF 末位）。反代需配：
#   proxy_set_header X-Real-IP $remote_addr;
#   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
TRUSTED_PROXY=false

# 可选：进阶（代码保留 env 支持，不在 .env.example 中）
API_CACHE_TTL_MS=10000              # SELECT 缓存 TTL（毫秒），默认 10000，0 关闭
API_CACHE_MAX_SIZE=1000             # 缓存最大条目数，默认 1000
GATEWAY_MAX_BODY_MB=32              # 代理请求体上限（MB），默认 32；超限 413
ALLOW_PRIVATE_UPSTREAMS=false       # 设为 true 允许上游指向内网/环回/元数据地址（内网自建 LLM 逃生开关）
# API_CACHE_DEBUG=true              # 设为 true 在日志中输出缓存命中/未命中
```

- 本地开发复制 `.env.example` → `.env.local`，并 `chmod 600 .env .env.local`（`.env*` 除模板外已在 `.gitignore` 中）；**不建也能起**：`SQLITE_DATABASE_PATH` 默认 `./data/token-tracker.db`（`src/lib/db/index.ts`、`drizzle.config.ts` 同值），`GATEWAY_SECRET` 缺失时由 `next.config.js` 在 dev 生成并落盘 `<db 目录>/.gateway-secret`（`flag:"wx"` 原子创建 + 0600，后续复用；已在 `.gitignore` 白名单外单独 ignore `**/.gateway-secret`，自定义 db 目录也不会入库）。只认 `phase === PHASE_DEVELOPMENT_SERVER`（不看 `NODE_ENV`：`next build --debug-prerender` 会把它设成 development），build/start 不生成，生产缺 secret 仍是 503；**同一目录下 db 已存在但密钥文件缺失时拒绝启动**（生成新密钥会让已加密的 upstream key / 虚拟 key / 同步 token 永久不可解，与 `scripts/local-entrypoint.sh` 同口径），ENOENT 之外的读错（权限/IO）也不当作首次运行。secret 必须在启动进程内就位，middleware（edge）在编译期读 `process.env.GATEWAY_SECRET`，运行期写文件无效
- **compose 无默认凭证**：`docker-compose.example.yml` 的 `ADMIN_API_KEY` / `GATEWAY_SECRET` 用 `${VAR:?...}` 必填语法，缺失时 compose 直接报错退出（不再有 `your-api-key-here` 之类公开默认值）
- **公网建议 HTTPS**：会话 token / 虚拟 key / 同步 token 都走 header 明文，公网裸 HTTP 会暴露凭据。反代（Caddy/Nginx）终止 TLS 后转发到 `127.0.0.1:3001`，并配置 `X-Real-IP` + `TRUSTED_PROXY=true`。upstream、proxy、sync 均允许 HTTP/HTTPS 以兼容本机和内网部署；私网地址仍受 SSRF 策略保护（内网目标用 `ALLOW_PRIVATE_UPSTREAMS=true`，sync loopback 例外）

## Docker 部署（VPS 自托管）

```bash
# 1. 拉取镜像
docker pull ghcr.io/caibingcheng/token-tracker:latest

# 2. 准备 data 目录
mkdir -p /opt/token-tracker/data

# 3. 启动（必须设置 GATEWAY_SECRET）
docker run -d \
  --name token-tracker \
  -p 3000:3000 \
  -e SQLITE_DATABASE_PATH=/app/data/token-tracker.db \
  -e ADMIN_API_KEY=your-key-here \
  -e GATEWAY_SECRET=your-32-byte-hex \
  -v /opt/token-tracker/data:/app/data \
  ghcr.io/caibingcheng/token-tracker:latest

# 或用 docker-compose.example.yml（推荐）
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

- SQLite 数据库文件在首次 API 请求时由 `initDatabase()` 自动创建（含新表与存量补列），无需手动迁移

### GitHub Container Registry

`latest` = **最近一次正式 tag 构建出的镜像**；dev tag、PR、分支 push、`workflow_dispatch` 都不更新它。

| 触发条件 | 镜像标签 | 用途 |
|---------|---------|------|
| tag `vX.Y.Z`（如 `v1.3.0`） | `ghcr.io/caibingcheng/token-tracker:vX.Y.Z` + `:<short-sha>` + `:latest` | 生产发布 |
| tag `vX.Y.Z-devN`（如 `v1.3.0-dev.1`） | 同上（不含 `:latest`）+ `:dev` | 开发版发布 |
| `workflow_dispatch` | 仅 `:<short-sha>` | 手动重建，不动任何版本/浮动标签 |

`.github/workflows/docker.yml` 的顺序是 **校验 → 构建 → smoke test → 推送**，浮动标签（`:latest` / `:dev`）最后推送：

1. `Verify tag ancestry`：只接受 `^vX.Y.Z$`（commit 必须落在 `origin/main` 历史内）与 `^vX.Y.Z-dev...$`（必须落在 `origin/dev` 历史内）；其它命名（如 `-rc.1`）直接失败，因此不会进 `latest`。
2. `Build image`：`load: true` + `push: false`，镜像只进 runner 本地。
3. `Smoke test image`：用固定测试密钥起容器，轮询 `http://127.0.0.1:3000/api/cli`（会真实建库并跑一次聚合查询），失败则 job 红且不推送任何标签。
4. `Push image`：先推不可变标签（版本号、short-sha），最后推浮动标签。

构建时 CI 传 `--build-arg APP_VERSION=${{ github.ref_name }}`（tag 构建即 `v1.3.0`），Dockerfile builder 阶段
转为 `NEXT_PUBLIC_APP_VERSION`，`next.config.js` 的 `env` 将其内联进客户端 bundle，侧栏底部展示。
不传参（本地 `npm run build`、`docker compose --build`）回退 `dev`；`workflow_dispatch` 在分支上触发时显示分支名。

### 发布流程

`.github/workflows/ci.yml` 在 PR → main 时跑 `npm ci` / `npm run lint` / `npm test` / `npm run build`（job id：`lint-and-test`、`build`）。dev 的 push 由 `pr-dev-to-main.yml` 汇总成一个长期复用的 PR，因此不在 dev push 上重复跑 CI。

1. dev 上开发并 push → 自动创建/复用 `dev → main` PR → CI 绿 → 人工 review 后 **Merge**。
2. 在 main 上打 tag（约定 annotated，可追溯谁在何时打的；不改写已有的 lightweight tag）：
   ```bash
   git checkout main && git pull
   git tag -a v1.6.0 -m "v1.6.0"
   git push origin v1.6.0
   ```
3. tag push 触发 `docker.yml`：ancestry 校验 → 构建 → smoke test → 推送。
4. 校验或 smoke test 失败时镜像不发布。修完后要重打同一版本需先删远端 tag，否则直接发下一个 patch 版本；不要删已有 GHCR 镜像版本。

GitHub 侧一次性配置（无法进仓库，需在 Settings 里手工做）：

- **main branch protection**：Require a pull request before merging；Require status checks 勾选 `lint-and-test` 与 `build`（等第一次 CI 成功、检查项出现后再勾；job id 之后不要改）。
- **tag ruleset**（`v*`）：限制创建/更新/删除权限给发布账号本身。ruleset 只控权限，不替代 workflow 里的 ancestry 校验。
