/**
 * 把模拟上游（src/dev/fake-upstream）注册成中心里的 upstream + key + 一个虚拟 key，
 * 让「网关 → 真实 HTTP 上游」这条链路开箱可测（UI 里能直接看到、能切路由）。
 *
 * 用法：
 *   npm run fake-upstream                                        # 另开一个终端，起 :4010
 *   npm run seed:fake-upstream                                   # 默认 http://127.0.0.1:4010
 *   npm run seed:fake-upstream -- --base-url http://host.docker.internal:4010
 *   npm run seed:fake-upstream -- --with-broken                  # 追加 401 key / 失败上游，验轮换与 failover
 *   npm run seed:fake-upstream -- --force                        # 覆盖已存在的同名 upstream（先删后建）
 *
 * 前置条件：
 *   - `.env` 里有 `GATEWAY_SECRET`（upstream key / vk 都是 AES-256-GCM 加密存储）
 *   - `ALLOW_PRIVATE_UPSTREAMS=true`（baseUrl 是环回地址；中心的 SSRF 校验会拦）
 *
 * 幂等：同名 upstream 已存在就跳过（除非 --force）；vk 已存在则保留（明文不可反推）。
 * 只写 upstreams / upstream_keys / virtual_keys，不碰 token_records 与 settings。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { closeDb, db, initDatabase, upstreamKeysTable, upstreamsTable, virtualKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret } from "@/lib/gateway/crypto";
import { virtualKeyFingerprint } from "@/lib/gateway/vk-fingerprint";

// tsx 不像 `npm start` / `npm run dev` 那样自动加载 .env：按 dev 的优先级补上
//（process.loadEnvFile 不覆盖已设值 ⇒ 最先加载的优先级最高，与 dotenv 默认行为一致）。
for (const file of [".env.development.local", ".env.local", ".env.development", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

// 与 dev.mjs 共用同一个主密钥解析：GATEWAY_SECRET 缺失时读（dev 首启时生成）<db 目录>/.gateway-secret。
// 库已存在但密钥文件缺失时它直接报错——本脚本也不该用一把新密钥去加密新行（旧行解不开）。
const requireFromScripts = createRequire(join(process.cwd(), "scripts", "seed-fake-upstreams.ts"));
const { ensureDevGatewaySecret } = requireFromScripts("./dev-secret.cjs") as {
  ensureDevGatewaySecret: () => void;
};
try {
  ensureDevGatewaySecret();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

interface SeedUpstream {
  name: string;
  protocol: "openai" | "anthropic" | "gemini";
  models: string[];
  keys: string[];
  priority: number;
  /** 仅用于说明「这条是故意坏的」 */
  broken?: string;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

const BASE_URL = (flag("base-url") || "http://127.0.0.1:4010").replace(/\/+$/, "");
const WITH_BROKEN = process.argv.includes("--with-broken");
const FORCE = process.argv.includes("--force");
const VK_NAME = "fake-host-demo";
const VK_PLAINTEXT = process.env.SEED_FAKE_VK || "sk-fake-host-demo-vk";

const SEEDS: SeedUpstream[] = [
  { name: "fake-openai", protocol: "openai", models: ["gpt-4o-mini", "gpt-4o"], keys: ["sk-fake-openai"], priority: 10 },
  {
    name: "fake-anthropic",
    protocol: "anthropic",
    models: ["claude-sonnet-4", "claude-3-5-haiku"],
    keys: ["sk-fake-anthropic"],
    priority: 10,
  },
  {
    name: "fake-gemini",
    protocol: "gemini",
    models: ["gemini-2.0-flash", "gemini-2.5-pro"],
    keys: ["sk-fake-gemini"],
    priority: 10,
  },
  // responses 协议在 fake 端是 /v1/responses；中心的 protocol 仍按 openai 构造鉴权头
  { name: "fake-responses", protocol: "openai", models: ["gpt-5-codex"], keys: ["sk-fake-openai"], priority: 10 },
];

if (WITH_BROKEN) {
  // 401 的先手 key：验证「key 轮换」（同 upstream 换 key）
  SEEDS[0]!.keys.unshift("sk-fake-revoked");
  // 独立上游但只有坏 key：验证「跨 upstream failover」（priority 更小 = 先试）
  SEEDS.push({
    name: "fake-broken-401",
    protocol: "openai",
    models: ["gpt-4o-mini"],
    keys: ["sk-fake-revoked"],
    priority: 5,
    broken: "always 401",
  });
  // 首次 503：验证 5xx 重试/换 key
  SEEDS.push({
    name: "fake-flaky-503",
    protocol: "openai",
    models: ["gpt-4o-mini"],
    keys: ["sk-fake-flaky"],
    priority: 6,
    broken: "first request 503",
  });
}

if (!process.env.ALLOW_PRIVATE_UPSTREAMS || !["true", "1"].includes(process.env.ALLOW_PRIVATE_UPSTREAMS)) {
  console.warn(
    "[seed] warn: ALLOW_PRIVATE_UPSTREAMS 不是 true —— 中心会拒绝环回 baseUrl（保存/请求时都拦），" +
      "请以 ALLOW_PRIVATE_UPSTREAMS=true 重启服务后再用这些上游"
  );
}

async function main(): Promise<void> {
  if (!process.env.GATEWAY_SECRET) {
    console.error(
      "[seed] 缺少 GATEWAY_SECRET：upstream key / vk 都是加密存储，需要一个和中心进程完全相同的值。" +
        "dev 下通常已自动落盘到 <db 目录>/.gateway-secret；也可显式 GATEWAY_SECRET=... npm run seed:fake-upstream"
    );
    process.exit(1);
  }
  await initDatabase();

  const created: string[] = [];
  const skipped: string[] = [];
  const keyless: string[] = [];

  for (const seed of SEEDS) {
    const existing = await withSkipCache(() =>
      db.select({ id: upstreamsTable.id }).from(upstreamsTable).where(eq(upstreamsTable.name, seed.name))
    );
    if (existing.length > 0 && !FORCE) {
      // 中途失败（如缺 GATEWAY_SECRET）会留下「upstream 建了、key 没写」的半成品：
      // 这种行会被路由直接跳过，但 UI 上看起来已配置，必须单独报出来
      const keys = await withSkipCache(() =>
        db
          .select({ id: upstreamKeysTable.id })
          .from(upstreamKeysTable)
          .where(eq(upstreamKeysTable.upstreamId, existing[0]!.id))
      );
      if (keys.length === 0) keyless.push(seed.name);
      else skipped.push(seed.name);
      continue;
    }
    let newId: number | null = null;
    try {
      await withSkipCache(async () => {
        // 先删后建：upstream_keys 有 onDelete cascade
        if (existing.length > 0) {
          await db.delete(upstreamsTable).where(eq(upstreamsTable.id, existing[0]!.id));
        }
        const inserted = await db
          .insert(upstreamsTable)
          .values({
            name: seed.name,
            protocol: seed.protocol,
            baseUrl: BASE_URL,
            enabledModels: JSON.stringify(seed.models),
            priority: seed.priority,
            enabled: 1,
            balanceFetchMode: "none",
          })
          .returning({ id: upstreamsTable.id });
        const upstreamId = Number(inserted[0]!.id);
        newId = upstreamId;
        for (const key of seed.keys) {
          await db
            .insert(upstreamKeysTable)
            .values({ upstreamId, apiKeyEncrypted: encryptSecret(key) });
        }
      });
    } catch (err) {
      // 不留半成品：建了 upstream 却没 key 的行比没建更坑
      const id = newId;
      if (id !== null) {
        await withSkipCache(() => db.delete(upstreamsTable).where(eq(upstreamsTable.id, id)));
      }
      throw err;
    }
    created.push(`${seed.name}${seed.broken ? ` (${seed.broken})` : ""}`);
  }

  // vk：已存在就保留（密文不可反推明文，重建会让旧会话的 key 失效）
  const vkExisting = await withSkipCache(() =>
    db.select({ id: virtualKeysTable.id }).from(virtualKeysTable).where(eq(virtualKeysTable.name, VK_NAME))
  );
  let vkCreated = false;
  if (vkExisting.length === 0) {
    await withSkipCache(() =>
      db.insert(virtualKeysTable).values({
        name: VK_NAME,
        apiKeyEncrypted: encryptSecret(VK_PLAINTEXT),
        keyFingerprint: virtualKeyFingerprint(VK_PLAINTEXT),
        enabledModels: '["*"]',
        comment: "created by npm run seed:fake-upstream",
      })
    );
    vkCreated = true;
  }

  console.log(`[seed] baseUrl = ${BASE_URL}`);
  console.log(`[seed] created : ${created.length ? created.join(", ") : "(none)"}`);
  if (skipped.length) console.log(`[seed] skipped : ${skipped.join(", ")}  (已存在；--force 可覆盖)`);
  if (keyless.length) {
    console.warn(
      `[seed] 无 key  : ${keyless.join(", ")}  (上次中途失败留下的空上游，会被路由跳过；用 --force 重建)`
    );
  }
  console.log(
    `[seed] vk      : ${VK_NAME} ${vkCreated ? `= ${VK_PLAINTEXT}` : "(已存在，明文未知，保留不动)"}`
  );
  if (vkCreated) {
    console.log("");
    console.log("试一下（先确保 npm run fake-upstream 在跑）：");
    console.log(
      `  curl -s http://localhost:3001/v1/chat/completions -H 'authorization: Bearer ${VK_PLAINTEXT}' -H 'content-type: application/json' \\\n    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'`
    );
    console.log(
      `  curl -s http://localhost:3001/v1/messages -H 'authorization: Bearer ${VK_PLAINTEXT}' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \\\n    -d '{"model":"claude-sonnet-4","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}'`
    );
    console.log(
      `  curl -s 'http://localhost:3001/v1beta/models/gemini-2.0-flash:generateContent' -H 'authorization: Bearer ${VK_PLAINTEXT}' -H 'content-type: application/json' \\\n    -d '{"contents":[{"parts":[{"text":"hi"}]}]}'`
    );
  }
  console.log("");
  console.log("fake 上游收到的请求：GET http://127.0.0.1:4010/__fake/requests");
}

main()
  .then(async () => {
    await closeDb();
  })
  .catch(async (err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    await closeDb();
    process.exit(1);
  });
