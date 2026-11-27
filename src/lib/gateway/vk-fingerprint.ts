// vk 认证索引键（纯逻辑，中心与 relay 共用）。
//
// 口径：sha256("vkfp:v1:" + vk 明文) 的 **hex**（不带前缀）。
// 只用于认证索引，不参与 session 指纹（session 指纹用 virtual_keys.id 主键，
// 换成指纹会让同一会话在直连与 relay 两条入口算出不同 session_id）。
import { createHash } from "crypto";

export function virtualKeyFingerprint(vk: string): string {
  return createHash("sha256").update(`vkfp:v1:${vk}`).digest("hex");
}
