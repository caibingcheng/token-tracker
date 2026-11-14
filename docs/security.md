# 安全与部署注意事项

> 面向使用者的部署安全提示。实现层面的防护细节见 [`agents/deployment.md`](./agents/deployment.md) 与 [`agents/api-routes.md`](./agents/api-routes.md)。

## 首次设置向导（fail-open）

如果 `ADMIN_API_KEY` 未设置且 DB 无 key，任何能访问 Web UI 的人都可以抢先设置管理 key。

**生产环境务必设置 `ADMIN_API_KEY`**，或用防火墙 / 内网保护首次配置窗口。向导的限流只能防爆破，不能防抢先注册。

## 公网部署请走 HTTPS

虚拟 key 走明文 header，会话 token 走明文 header 或 `tt_session` cookie（纯 http + LAN IP 部署下不设 `Secure`）。反代（Caddy / Nginx）终止 TLS 后转发到 `127.0.0.1:3001`，并设置 `X-Real-IP` + `TRUSTED_PROXY=true`。

upstream、proxy 与多实例同步均兼容 HTTP/HTTPS，便于本机和内网部署；私网地址仍受 SSRF 策略保护，内网目标使用 `ALLOW_PRIVATE_UPSTREAMS=true`，sync 的 loopback 可直接使用。

## 密钥卫生

`.env*`（除 `.env.example`）、`*.pem`、`*.p12`、`*.pfx`、`id_rsa*`、`credentials*`、`secrets*`、`**/.gateway-secret` 已加入 `.gitignore`；本机 `.env` 建议 `chmod 600`。

## `GATEWAY_SECRET` 丢失不可逆

dev 自动生成的密钥在 `<db 目录>/.gateway-secret`。数据库里已加密的 upstream key / 虚拟 key / 同步 token 只能用它解密；**已有数据库时该文件丢失，`npm run dev` 会直接拒绝启动**（不会静默重建）。备份数据库时请一并备份这个文件。

## 忘记登录 key

删除 SQLite `settings` 表中的 `admin_api_key` 行，即回退到 `ADMIN_API_KEY` 环境变量。

```bash
sqlite3 ./data/token-tracker.db "DELETE FROM settings WHERE key = 'admin_api_key';"
```
