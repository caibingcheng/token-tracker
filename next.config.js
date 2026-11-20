const { availableParallelism } = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { PHASE_DEVELOPMENT_SERVER } = require('next/constants');

// dev 模式 webpack 以 eval() 加载模块（eval-source-map），CSP 需放行 'unsafe-eval'；
// 生产构建不使用 eval，保持收紧不放行。判定用 phase 而非 NODE_ENV：
// `next build --debug-prerender` 会把 NODE_ENV 设成 development

// 本地开发零配置：SQLITE_DATABASE_PATH 有默认值（见 src/lib/db/index.ts），
// GATEWAY_SECRET 缺失时生成一次并持久化到 <db 目录>/.gateway-secret（同 scripts/local-entrypoint.sh
// 的思路）。必须在这里注入 process.env：config 先于 server 启动执行，proxy 与路由在
// 处理请求时从 process.env 读密钥，只有这里先就位才能用上；进程起来后再写文件已经太晚。
// 仅 PHASE_DEVELOPMENT_SERVER 生效；build / start 缺 secret 仍按原逻辑 503。
function ensureDevGatewaySecret() {
  if (process.env.GATEWAY_SECRET) return;
  const dbPath = process.env.SQLITE_DATABASE_PATH || './data/token-tracker.db';
  const secretFile = path.join(path.dirname(dbPath), '.gateway-secret');
  let secret = '';
  try {
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  } catch (err) {
    // 只有 ENOENT 才是首次运行；权限/IO 错误不能当作「没配过」去生成新密钥
    if (err.code !== 'ENOENT') throw err;
  }
  if (secret) {
    process.env.GATEWAY_SECRET = secret;
    return;
  }
  // 已有数据库却没有密钥：新密钥会让库里已加密的 upstream key / 虚拟 key / 同步 token
  // 永久解不开，拒绝启动而不是静默重建（与 scripts/local-entrypoint.sh 同口径）
  if (fs.existsSync(dbPath)) {
    throw new Error(
      `[dev] 数据库 ${dbPath} 已存在，但缺少主密钥文件 ${secretFile}。\n` +
        '生成新密钥会使库中已加密的 upstream key / 虚拟 key / 同步 token 永久无法解密。\n' +
        '恢复办法：找回原来的 GATEWAY_SECRET 文件或环境变量；\n' +
        '确需重置：停掉 dev、备份并删除该 db 后重新启动（会重新生成密钥并需重新配置）。'
    );
  }
  secret = randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  try {
    // wx：独占创建，并发启动的两个 dev 进程不会互相覆盖成两把不同的密钥
    fs.writeFileSync(secretFile, `${secret}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // 另一进程抢先写入：wx 只保证独占创建，不保证它已写完 → 有界重试到内容完整
    secret = readSecretWithRetry(secretFile);
    process.env.GATEWAY_SECRET = secret;
    return;
  }
  console.warn(`[dev] GATEWAY_SECRET 未配置，已生成并保存到 ${secretFile}`);
  process.env.GATEWAY_SECRET = secret;
}

// 并发写入竞争：等对手进程写完 64 位 hex，最多 ~1s；不完整就拒绝启动，不用错密钥
function readSecretWithRetry(secretFile) {
  for (let i = 0; i < 20; i++) {
    let content = '';
    try {
      content = fs.readFileSync(secretFile, 'utf8').trim();
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (/^[0-9a-f]{64}$/.test(content)) return content;
    // 同步睡 50ms（只在配置加载期的竞争分支）
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error(`[dev] 主密钥文件 ${secretFile} 内容不完整（期望 64 位 hex）`);
}

function createNextConfig(isDev) {
  const scriptSrc = `'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`;
  /** @type {import('next').NextConfig} */
  return {
    output: 'standalone',
    // 版本号在构建期内联进客户端 bundle：Docker 构建传 ARG APP_VERSION（CI 用 git tag），
    // 本地 npm run dev / 未传参构建回退 dev
    env: {
      NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION || 'dev',
    },
    // 不暴露框架身份（x-powered-by: Next.js 属信息泄露）
    poweredByHeader: false,
    // instrumentation：15+ 已稳定，src/instrumentation.ts 自动识别（不再需要 experimental.instrumentationHook）
    experimental: {
      // 构建并发上限（容器/CI 上不要打满整机；本机 20 核 → 取一半以内）
      cpus: Math.max(1, Math.floor(availableParallelism() / 2)),
      // 标记本次版本升级来源：安全公告修复（Next.js security upgrade 流程要求写入）
      agentUpgrade: 'security',
    },
    async headers() {
      return [
        {
          source: '/:path*',
          headers: [
            // 点击劫持防护 + MIME 嗅探防护
            { key: 'X-Frame-Options', value: 'DENY' },
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'no-referrer' },
            // 收紧浏览器能力（camera/mic/geolocation 本应用均不使用）
            { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
            // 基础 CSP：同源资源 + 内联样式（styled-jsx）/脚本（Next bootstrap）
            { key: 'Content-Security-Policy',
              value: `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` },
          ],
        },
      ];
    },
  };
}

module.exports = (phase) => {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;
  if (isDev) ensureDevGatewaySecret();
  return createNextConfig(isDev);
};
