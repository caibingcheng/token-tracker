/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
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
            value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
