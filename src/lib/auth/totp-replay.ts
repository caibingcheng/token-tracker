import { createHash } from "crypto";
import { getSetting, setSetting } from "./settings";
import { matchTotpCounter } from "./totp";

// TOTP 重放防护：±1 窗口下同一个 6 位码在 90 秒内一直有效，只校验「码正确」
// 意味着抓到一次码就能在窗口内重复用（登录、改 key、换绑 TOTP 全部受影响）。
// 落 settings 表持久化（重启不清零）：同一 secret 只接受时间步计数严格递增的码，
// 成功后写回 → 同一时间步只能用一次。
// 时钟回拨（counter ≤ last_counter）一律拒绝：回拨后新码可能落在已用时间步，
// 无法区分重放与合法新码，安全侧选择拒绝（等时间追上即可恢复）。
// 记录里带 secret 指纹：换绑/新 secret 属于新凭证，计数基准从头开始（否则同一窗口内
// 新 secret 的码会被旧 secret 的计数误判为重放）。

const LAST_COUNTER_KEY = "totp_last_counter";

interface LastCounterState {
  secretHash: string;
  counter: number;
}

// 指纹只用于「是否同一 secret」判定（totp_secret 本身已在 settings 明文存储）
function hashSecret(secret: string): string {
  return createHash("sha256").update(`totp:${secret}`).digest("hex").slice(0, 16);
}

export async function getLastTotpCounter(secret: string): Promise<number | null> {
  const raw = await getSetting(LAST_COUNTER_KEY);
  if (raw === null) return null;
  try {
    const state = JSON.parse(raw) as Partial<LastCounterState>;
    if (state.secretHash !== hashSecret(secret)) return null;
    const counter = Number(state.counter);
    return Number.isFinite(counter) ? counter : null;
  } catch {
    // 坏值（手工改库/旧格式）视为无记录：不影响校验可用性
    return null;
  }
}

// 校验并消费一个 TOTP 码：码错 / 已用过的时间步 / 时钟回拨都返回 false
export async function verifyTotpCodeNoReplay(
  secret: string,
  code: string,
  timestampMs: number = Date.now()
): Promise<boolean> {
  const counter = matchTotpCounter(secret, code, timestampMs);
  if (counter === null) return false;
  const last = await getLastTotpCounter(secret);
  if (last !== null && counter <= last) return false;
  const state: LastCounterState = { secretHash: hashSecret(secret), counter };
  await setSetting(LAST_COUNTER_KEY, JSON.stringify(state));
  return true;
}
