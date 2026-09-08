FROM node:22-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app

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
# - max-old-space-size=256：收紧 old space 上限，V8 的 major GC 触发阈值随上限缩放，
#   512MB 上限下空闲后堆长期挂在高位；256MB 对 365 天聚合查询 + 32MB 请求体缓冲仍充裕
# - expose-gc：配合 src/instrumentation.ts 每 5 分钟在 RSS 偏高时触发 full GC，空闲后主动归还内存
ENV NODE_OPTIONS="--max-old-space-size=256 --expose-gc"

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates wget; \
  rm -rf /var/lib/apt/lists/*; \
  dpkgArch="$(dpkg --print-architecture | awk -F- '{ print $NF }')"; \
  wget -O /usr/local/bin/gosu "https://github.com/tianon/gosu/releases/download/1.19/gosu-$dpkgArch"; \
  chmod +x /usr/local/bin/gosu; \
  apt-get purge -y --auto-remove wget; \
  rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data && chown node:node /app/data

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 3000

CMD ["node", "server.js"]
