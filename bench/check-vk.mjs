/**
 * 诊断：用与运行环境一致的密钥解密 virtual_keys / upstream_keys，确认 bench 数据可用。
 * node bench/check-vk.mjs <dbPath>
 */
import Database from "better-sqlite3";
import { createDecipheriv, createHash } from "node:crypto";

const dbPath = process.argv[2] || "bench/data/bench.db";
const SECRET = process.env.GATEWAY_SECRET || "a".repeat(64);

const KEY = /^[0-9a-fA-F]{64}$/.test(SECRET)
  ? Buffer.from(SECRET, "hex")
  : (() => {
      const b = Buffer.from(SECRET, "base64");
      return b.length === 32 ? b : createHash("sha256").update(SECRET).digest();
    })();

function decrypt(payload) {
  const [ivB64, tagB64, ctB64] = payload.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const d = createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

const db = new Database(dbPath, { readonly: true });
const vks = db.prepare("SELECT id, name, enabled, enabled_models, api_key_encrypted FROM virtual_keys").all();
console.log(`secretLen=${SECRET.length} hex64=${/^[0-9a-fA-F]{64}$/.test(SECRET)} vkRows=${vks.length}`);
for (const vk of vks) {
  let plain = "<decrypt failed>";
  try {
    plain = decrypt(vk.api_key_encrypted);
  } catch (e) {
    plain = `<${e.message}>`;
  }
  console.log(`  id=${vk.id} name=${vk.name} enabled=${vk.enabled} models=${vk.enabled_models} key=${plain}`);
}
const uks = db.prepare("SELECT id, upstream_id, enabled, api_key_encrypted FROM upstream_keys").all();
console.log(`upstreamKeys=${uks.length}`);
for (const k of uks) {
  let plain = "<decrypt failed>";
  try {
    plain = decrypt(k.api_key_encrypted);
  } catch (e) {
    plain = `<${e.message}>`;
  }
  console.log(`  id=${k.id} upstream=${k.upstream_id} enabled=${k.enabled} key=${plain}`);
}
db.close();
