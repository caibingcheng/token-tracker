// 本地免密码 admin 直通（仅本机访问生效）。
// 生效条件（同时满足）：
//   1. env LOCAL_ADMIN_BYPASS=1 —— 只由 docker-compose.local.yml 设置（端口绑定 127.0.0.1），
//      VPS / 生产部署不得设置，**也不得置于反代之后开启**；
//   2. **Host ∧ socket 对端双条件（AND）**：Host 必须 loopback，且取得到对端时对端也必须 loopback。
//      为什么是 AND 而不是二选一：
//      - 只看对端：同机反代（nginx/caddy 回连 127.0.0.1）会把**公网流量**免密放行；
//      - 只看 Host：Host 头可任意伪造；
//      两个都看才能同时挡住「LAN 直连伪造 Host」与「反代转发公网请求」（反代转发时 Host
//      是公网域名）。对端取不到（next dev 单进程 / 单测直调 handler）时只算 Host —— 原行为。
//      docker 桥网络下对端是网关 IP（非 loopback）→ 拒绝（已在部署文档注明）。
// 该文件保持运行时无关（proxy 引用）：只用 process.env + 字符串操作 + 纯函数判定。
import { INTERNAL_REMOTE_ADDR_HEADER, isLoopbackAddress } from "@/lib/net/client-ip";

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
  // Host 必须 loopback：挡住反代转发（Host = 公网域名）与伪造 Host 的远程请求
  if (!isLoopbackHost(request.headers.get("host"))) return false;
  // 对端存在时必须也是 loopback（内核地址，不可伪造）：挡住 Host 伪造 + 反代回连；
  // 对端缺失（next dev 单进程 / 单测直调 handler）退化为纯 Host 判定（原行为）
  const peer = request.headers.get(INTERNAL_REMOTE_ADDR_HEADER);
  if (peer && !isLoopbackAddress(peer)) return false;
  if (!warned) {
    warned = true;
    console.warn(
      "[auth] LOCAL_ADMIN_BYPASS is enabled: admin auth is skipped for loopback requests. Do NOT use outside local deployment."
    );
  }
  return true;
}
