FROM node:22-slim AS deps
WORKDIR /app

# better-sqlite3 13 通过 lib/<platform>.js 直接 require prebuilds/linux-x64.node 加载（不查 build/），
# 但包内存在 binding.gyp 会让 npm 自动跑一次 node-gyp rebuild。--ignore-scripts 跳过这段编译，
# 因此 deps / builder 都不再需要 python3/make/g++（原先每个 stage 各装一次 apt）。
# 注意：它也会跳过所有第三方 postinstall —— 将来新增依赖若靠 postinstall 下载二进制，需在此显式放开。
# esbuild（build-server.mjs 用）的平台二进制来自 optionalDependencies @esbuild/<platform>，
# 不依赖 postinstall，--ignore-scripts 下同样可用。
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
# optionalDependencies（@next/swc-<platform>-gnu）下载失败时 npm 静默跳过且仍 exit 0，
# 要等到 `next build` 才炸出一句 "Turbopack is not supported on this platform"——看着像平台问题。
# 这里提前失败并给出可操作提示。用 *-gnu 通配保留未来 arm64 构建，musl-only 不通过属正常。
RUN ls node_modules/@next/swc-linux-*-gnu/*.node > /dev/null 2>&1 \
  || (echo "ERROR: @next/swc native binding missing (optionalDependencies download failed) — rerun with: docker build --no-cache ." >&2; exit 1)

FROM node:22-slim AS builder
WORKDIR /app

# 版本号在构建期内联进 bundle（CI 用 git tag）；手动构建不传则为 dev
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# npm run build = gen-routes（src/server/routes.generated.ts）+ next build（output:'export' → out/）
# + build-server.mjs（esbuild bundle → build/server.js，external 仅 better-sqlite3）
RUN npm run build

# better-sqlite3 prebuilds 共 8 个平台变体（npm 装出来是全量，不像旧 standalone trace 只带 4 个），
# 只留当前架构的 linux 变体；runner 只拷这一个包，删错架构在本步断言直接失败而不是运行时才炸。
# 按 process.arch（x64/arm64）而非 uname -m（x86_64）命名匹配 prebuilds 文件名。
RUN cd node_modules/better-sqlite3/prebuilds \
  && arch="$(node -p process.arch)" \
  && find . -maxdepth 1 -name '*.node' ! -name "linux-$arch.node" -delete \
  && ls "linux-$arch.node" > /dev/null \
  && ls

FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# 内存调优（实测：flags 对稳态基线影响很小，100MB 级占用来自长期运行后 V8 堆不归还 OS）：
# - max-old-space-size=128：收紧 old space 上限。V8 的 major GC 触发阈值随上限缩放：
#   256MB 下同一混合负载（43 rps + 30 万行库）heapTotal 会涨到 200MB 且空闲后不回落；
#   128MB 下封顶 ~90MB。365 天聚合查询 + 32MB 请求体缓冲的实际堆峰值 <80MB，余量充足
# - expose-gc：配合 src/instrumentation.node.ts 的 30s 周期归还（server entry 启动时调 registerNode），
#   RSS 偏高时触发 full GC，空闲后主动归还内存
# - max-semi-space-size=4：默认 16MB 双 semi-space 常驻 32MB，低 QPS 场景 4MB 足够，省 ~24MB
ENV NODE_OPTIONS="--max-old-space-size=128 --expose-gc --max-semi-space-size=4"
# jemalloc 替换 glibc malloc：V8 之外的 native 分配（better-sqlite3/OpenSSL/undici buffer）
# 在 glibc 多 arena 下释放后难归还 OS，是长期运行 RSS 挂高位的主因；jemalloc 回收更彻底。
# 构建期建固定路径软链，LD_PRELOAD 与架构无关（ghcr 当前仅 amd64，未来加 arm64 无需改）
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so

RUN set -eux; \
  apt-get update; \
  # gosu 直接用 Debian 官方包（不再 wget 未校验的 GitHub release 二进制）
  apt-get install -y --no-install-recommends ca-certificates gosu libjemalloc2; \
  rm -rf /var/lib/apt/lists/*; \
  ln -s "/usr/lib/$(uname -m)-linux-gnu/libjemalloc.so.2" /usr/local/lib/libjemalloc.so

RUN mkdir -p /app/data && chown node:node /app/data

# 运行面 = bundle + 静态导出 + native 包三件套（无 node_modules 全量、无 .next）：
# - build/server.js：esbuild 单文件，除 better-sqlite3 外全部内联
# - out/：next build（output:'export'）的静态产物（页面 HTML + _next/static + public）
# - better-sqlite3：native prebuild（builder 已裁到当前架构），运行时 require 零外部依赖
COPY --from=builder --chown=node:node /app/build ./build
COPY --from=builder --chown=node:node /app/out ./out
COPY --from=builder --chown=node:node /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3

# 不是入口，是报错翻译器：v1.6.0 起入口改为 build/server.js，而换镜像时若容器按旧配置重建
# （面板/编排的「升级镜像」、写死 command 的 compose / docker run / systemd / K8s），CMD 不会跟
# 新镜像更新，仍是 `node server.js`。没这个文件时用户只看到 Node 的 MODULE_NOT_FOUND 栈，看不出
# 是启动命令过时。文件内容只打印中文修法后 exit 1，行为与之前一致（失败 → 编排层回滚）。
# 它必须永远不会被 CMD 执行（下方 CMD 指向 build/server.js，legacy-server.test 钉住这对关系）：
# 若将来入口真改回 /app/server.js，删掉这条 COPY 和那个测试，不要让它变成入口。
COPY --chown=node:node legacy-server.js /app/server.js

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 3000

# --optimize-for-size 不能放进 NODE_OPTIONS（Node 不允许），只能作为命令行参数：
# 实测混压测峰值 RSS 220MB → 182MB，代价是吞吐降 ~9%（个人场景无感，内存优先）。
# 若基座 Node 版本不再接受该 V8 flag，删掉此参数即可（内存峰值回升到 ~220MB）。
CMD ["node", "--optimize-for-size", "build/server.js"]
