// 本地开发零配置主密钥（从 next.config.js 原样抽出，双进程共用）：
// SQLITE_DATABASE_PATH 有默认值（见 src/lib/db/index.ts），GATEWAY_SECRET 缺失时生成一次并
// 持久化到 <db 目录>/.gateway-secret（同 scripts/local-entrypoint.sh 的思路）。
// 注入 process.env 而不是只写文件：proxy 与路由在处理请求时从 process.env 读密钥，
// 子进程必须在 spawn 前拿到（dev.mjs 先 ensure 再启动 next / Hono 两个子进程）。
// 仅开发用；build / start 缺 secret 仍按原逻辑 503。
// 并发安全：wx 独占创建 + 有界重读，两个 dev 进程同时首启不会写出两把密钥。
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

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
    process.env.GATEWAY_SECRET = readSecretWithRetry(secretFile);
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

module.exports = { ensureDevGatewaySecret };
