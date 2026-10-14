// 本地免密码 admin 直通（仅本机访问生效）。
// 生效条件（同时满足）：
//   1. env LOCAL_ADMIN_BYPASS=1 —— 只由 docker-compose.local.yml 设置（端口绑定 127.0.0.1），
//      VPS / 生产部署不得设置；
//   2. 请求 Host 为 loopback（localhost / 127.x / ::1）—— 纵深防御：即使有人把端口改绑到
//      0.0.0.0，非本机 Host 的请求也不会被放行。注意 Host 头可被伪造，真正的边界是
//      compose 文件只绑定 127.0.0.1。
// 该文件必须保持 Edge runtime 兼容（middleware 引用）：只用 process.env + 字符串操作。

export function isLocalAdminBypassEnabled(): boolean {
  const v = process.env.LOCAL_ADMIN_BYPASS;
  return v === "1" || v === "true";
}

export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  // 去端口：IPv6 带括号形如 [::1]:3000；裸 IPv6（含多个冒号）整体作为地址；其余形如 127.0.0.1:39001
  let name: string;
  if (h.startsWith("[")) {
    name = h.slice(1, h.indexOf("]"));
  } else if (h.indexOf(":") !== h.lastIndexOf(":")) {
    name = h;
  } else {
    name = h.split(":")[0];
  }
  return name === "localhost" || name === "::1" || name.startsWith("127.");
}

let warned = false;

export function canBypassAuth(request: { headers: Headers }): boolean {
  if (!isLocalAdminBypassEnabled()) return false;
  if (!isLoopbackHost(request.headers.get("host"))) return false;
  if (!warned) {
    warned = true;
    console.warn(
      "[auth] LOCAL_ADMIN_BYPASS is enabled: admin auth is skipped for loopback requests. Do NOT use outside local deployment."
    );
  }
  return true;
}
