FROM node:22-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app

# 版本号由 CI 传 tag（v1.3.0）；手动构建不传则为 dev。build 阶段内联进 bundle
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

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
# - expose-gc：配合 src/instrumentation.ts 每 30s 在 RSS 偏高时触发 full GC，空闲后主动归还内存
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

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 3000

# --optimize-for-size 不能放进 NODE_OPTIONS（Node 不允许），只能作为命令行参数：
# 实测混压测峰值 RSS 220MB → 182MB，代价是吞吐降 ~9%（个人场景无感，内存优先）。
# 若基座 Node 版本不再接受该 V8 flag，删掉此参数即可（内存峰值回升到 ~220MB）。
CMD ["node", "--optimize-for-size", "server.js"]
