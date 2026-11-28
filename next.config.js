const { availableParallelism } = require('node:os');
const { PHASE_DEVELOPMENT_SERVER } = require('next/constants');

// 按 phase 分叉的双形态配置（服务端已换 Hono，见 docs/agents/deployment.md）：
//
//   dev（next dev，由 scripts/dev.mjs 与 Hono :3001 并排编排）：
//     - 不能设 output:'export' —— Next 在 export 模式下禁止 headers/rewrites/proxy
//       （node_modules/next/dist/docs/.../static-exports.md «Unsupported Features»）
//     - headers 维持 dev 口径 CSP：webpack 以 eval() 加载模块（eval-source-map），需放行
//       'unsafe-eval'；生产口径的 CSP 由 Hono 下发（src/server/security-headers.ts）
//     - rewrites 把 API 前缀转给 :3001 上的 Hono（数组形态 = 文件系统优先：
//       页面/公开文件仍由 next dev 自己出，未命中的 /api、/v1*、/raw、/ingest 才转发）
//
//   build（next build）：
//     - output:'export' 纯静态导出到 out/，响应头与全部 API 由 Hono 托管
//
// 判定用 phase 而非 NODE_ENV：`next build --debug-prerender` 会把 NODE_ENV 设成 development

const DEV_API_PORT = process.env.DEV_API_PORT || '3001';

function createNextConfig(isDev) {
  /** @type {import('next').NextConfig} */
  const config = {
    // 版本号在构建期内联进客户端 bundle：Docker 构建传 ARG APP_VERSION（CI 用 git tag），
    // 本地 npm run dev / 未传参构建回退 dev
    env: {
      NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION || 'dev',
    },
    // 不暴露框架身份（x-powered-by: Next.js 属信息泄露）
    poweredByHeader: false,
    experimental: {
      // 构建并发上限（容器/CI 上不要打满整机；本机 20 核 → 取一半以内）
      cpus: Math.max(1, Math.floor(availableParallelism() / 2)),
      // 标记本次版本升级来源：安全公告修复（Next.js security upgrade 流程要求写入）
      agentUpgrade: 'security',
    },
  };

  if (isDev) {
    config.headers = async () => [
      {
        source: '/:path*',
        headers: [
          // 点击劫持防护 + MIME 嗅探防护
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // 收紧浏览器能力（camera/mic/geolocation 本应用均不使用）
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // 基础 CSP（dev 口径：eval-source-map 需要 unsafe-eval；生产口径在 Hono 侧）
          { key: 'Content-Security-Policy',
            value: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` },
        ],
      },
    ];
    // Next 16 默认只允许 dev origin（localhost）访问 /_next/* dev 资源，用 127.0.0.1 或
    // 局域网 IP 打开页面会被当成 cross-origin：HMR WebSocket 与字体被拦（控制台报
    // "Blocked cross-origin request to Next.js dev resource /_next/hmr"），页面还停在旧 chunk。
    // 手机/局域网调试再追加 DEV_ALLOWED_ORIGINS（逗号分隔 host，不带端口）。
    config.allowedDevOrigins = [
      'localhost',
      '127.0.0.1',
      ...(process.env.DEV_ALLOWED_ORIGINS || '')
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean),
    ];
    config.rewrites = async () => {
      const api = `http://127.0.0.1:${DEV_API_PORT}`;
      return [
        // 与 scripts/dev.mjs 的 API_PORT 同源（都读 DEV_API_PORT，默认 3001）
        { source: '/api/:path*', destination: `${api}/api/:path*` },
        { source: '/v1/:path*', destination: `${api}/v1/:path*` },
        { source: '/v1beta/:path*', destination: `${api}/v1beta/:path*` },
        { source: '/raw/:path*', destination: `${api}/raw/:path*` },
        { source: '/ingest/records', destination: `${api}/ingest/records` },
      ];
    };
    return config;
  }

  config.output = 'export';
  return config;
}

module.exports = (phase) => {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;
  // 惰性 require：build 阶段不需要密钥逻辑（503 语义不变）
  if (isDev) require('./scripts/dev-secret.cjs').ensureDevGatewaySecret();
  return createNextConfig(isDev);
};
