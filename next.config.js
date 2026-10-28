/** @type {import('next').NextConfig} */
// dev 模式 webpack 以 eval() 加载模块（eval-source-map），CSP 需放行 'unsafe-eval'；
// 生产构建不使用 eval，保持收紧不放行
const isDev = process.env.NODE_ENV === 'development';
const scriptSrc = `'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`;

const nextConfig = {
  output: 'standalone',
  // 版本号在构建期内联进客户端 bundle：Docker 构建传 ARG APP_VERSION（CI 用 git tag），
  // 本地 npm run dev / 未传参构建回退 dev
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION || 'dev',
  },
  // 不暴露框架身份（x-powered-by: Next.js 属信息泄露）
  poweredByHeader: false,
  // instrumentation hook：启动时调用 src/instrumentation.ts 的 register()（周期性内存归还）
  experimental: {
    instrumentationHook: true,
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

module.exports = nextConfig;
