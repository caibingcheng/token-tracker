// relay 本地状态（data/relay.state.json，权限 0600）：唯一落盘的东西。
// 内容：fingerprint / X25519 私钥 / device token / pairedAt / center 指纹。
// CENTER_URL、port、ALLOW_PRIVATE_UPSTREAMS、GATEWAY_MAX_BODY_MB 一律只从 env 读，不写这里
//（容器改配不需要改卷；卷丢了重新配对即可）。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { dirname } from "path";
import { generateDeviceKeypair } from "@/lib/gateway/lease";

export interface RelayState {
  fingerprint: string;
  publicKey: string;
  privateKeyPem: string;
  deviceToken: string | null;
  pairedAt: string | null;
  /** CENTER_URL 的 sha256 前 16 位：用于发现「换了中心但没重新配对」 */
  centerUrlHash: string | null;
}

export function relayStatePath(): string {
  return process.env.RELAY_STATE_PATH || "./data/relay.state.json";
}

export function centerUrlHash(centerUrl: string): string {
  return createHash("sha256").update(centerUrl).digest("hex").slice(0, 16);
}

function writePrivate(path: string, state: RelayState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    // Windows 上 mode 不生效；POSIX 下显式再设一次（已有文件时 mode 参数不生效）
    chmodSync(path, 0o600);
  } catch {
    // ignore（Windows / 只读文件系统）
  }
}

export function loadState(centerUrl: string): RelayState {
  const path = relayStatePath();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RelayState>;
      if (
        typeof parsed.fingerprint === "string" &&
        typeof parsed.publicKey === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        return {
          fingerprint: parsed.fingerprint,
          publicKey: parsed.publicKey,
          privateKeyPem: parsed.privateKeyPem,
          deviceToken: typeof parsed.deviceToken === "string" ? parsed.deviceToken : null,
          pairedAt: typeof parsed.pairedAt === "string" ? parsed.pairedAt : null,
          centerUrlHash: typeof parsed.centerUrlHash === "string" ? parsed.centerUrlHash : null,
        };
      }
    } catch {
      // 文件损坏：按首次启动处理（重新配对即可，历史记录不断链：指纹不变时复用 device 行）
    }
  }
  const keypair = generateDeviceKeypair();
  const state: RelayState = {
    fingerprint: `u-${randomBytes(16).toString("hex")}`,
    publicKey: keypair.publicKey,
    privateKeyPem: keypair.privateKeyPem,
    deviceToken: null,
    pairedAt: null,
    centerUrlHash: centerUrlHash(centerUrl),
  };
  writePrivate(path, state);
  return state;
}

export function saveState(state: RelayState): void {
  writePrivate(relayStatePath(), state);
}

// 中心的权威设备名（plan 响应下发，或配对 poll 返回）：只存内存，不落盘。
// 为什么不写 relay.state.json：改名在中心发生，relay 只是展示方；把它持久化反而会出现
// 「中心改名了、卷里还留着旧名」的第二份真相。进程重启后先用 RELAY_DEVICE_NAME，
// 下一个 plan 请求就会拿到中心的新名。
let centerDeviceName: string | null = null;

export function setCenterDeviceName(name: string | null | undefined): void {
  const next = typeof name === "string" ? name.trim() : "";
  centerDeviceName = next || null;
}

export function getCenterDeviceName(): string | null {
  return centerDeviceName;
}

/** 展示用设备名：中心（权威）> RELAY_DEVICE_NAME（首次配对时上报的默认值）> "relay" */
export function displayDeviceName(): string {
  return centerDeviceName ?? ((process.env.RELAY_DEVICE_NAME ?? "").trim() || "relay");
}
