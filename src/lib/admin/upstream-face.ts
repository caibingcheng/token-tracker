// upstream「接受面 + 认证方式」的写入侧校验（POST / PATCH 共用）。
//
// 两条不变量：
//   1. protocols 非空，且每个都是合法协议；protocol（默认面 / 探活面）= protocols[0]
//   2. 同 baseUrl 下 auth_style 不同的记录之间，enabled_models 不许相交
//      —— 认证是记录级单值，模型名重叠会让请求落到错认证的记录上（401 + 健康状态污染）
import {
  AUTH_STYLES,
  defaultAuthStyleForProtocol,
  isAuthStyle,
  type AuthStyle,
} from "@/lib/gateway/auth-style";
import { isProtocol, VALID_PROTOCOLS, type Protocol } from "@/lib/gateway/model-router";

export interface UpstreamFaceConfig {
  protocol: Protocol; // 默认面（探活端点 / 模型列表端点 / 分类器资格）
  protocols: Protocol[]; // 接受面集合（路由过滤依据）
  authStyle: AuthStyle; // 出站认证头
}

export type FaceConfigResult =
  | { ok: true; value: UpstreamFaceConfig }
  | { ok: false; error: string };

// 解析请求体里的 protocol / protocols / authStyle。
// 优先 protocols（多选）；只给 protocol 时等价于 protocols=[protocol]。
export function parseUpstreamFaceConfig(body: Record<string, unknown>): FaceConfigResult {
  const rawProtocols = body.protocols;
  const rawProtocol = typeof body.protocol === "string" ? body.protocol : "";

  let protocols: Protocol[] = [];
  if (rawProtocols !== undefined && rawProtocols !== null) {
    if (!Array.isArray(rawProtocols)) {
      return { ok: false, error: "protocols must be an array" };
    }
    for (const item of rawProtocols) {
      if (typeof item !== "string" || !isProtocol(item)) {
        return {
          ok: false,
          error: `Invalid protocols, must be one of: ${VALID_PROTOCOLS.join(", ")}`,
        };
      }
      if (!protocols.includes(item)) protocols.push(item);
    }
    if (protocols.length === 0) {
      return { ok: false, error: "protocols must not be empty" };
    }
    // 显式给的默认面必须落在声明集合内（否则探活会打一个不接受的面）
    if (rawProtocol !== "") {
      if (!isProtocol(rawProtocol)) {
        return { ok: false, error: "Invalid protocol" };
      }
      if (!protocols.includes(rawProtocol)) {
        return { ok: false, error: "protocol must be included in protocols" };
      }
    }
  } else if (rawProtocol !== "") {
    if (!isProtocol(rawProtocol)) {
      return { ok: false, error: "Invalid protocol" };
    }
    protocols = [rawProtocol];
  } else {
    return { ok: false, error: "Missing required field: protocol or protocols" };
  }

  const protocol = isProtocol(rawProtocol) ? rawProtocol : protocols[0]!;

  let authStyle: AuthStyle;
  if (body.authStyle === undefined || body.authStyle === null) {
    authStyle = defaultAuthStyleForProtocol(protocol);
  } else if (isAuthStyle(body.authStyle)) {
    authStyle = body.authStyle;
  } else {
    return { ok: false, error: `Invalid authStyle, must be one of: ${AUTH_STYLES.join(", ")}` };
  }

  return { ok: true, value: { protocol, protocols, authStyle } };
}

// 通配/精确模型的相交判定（与运行时 modelMatchesPattern 同口径）：
// "*" 单独出现不匹配任何模型，因此不参与冲突判定。
export function modelPatternsIntersect(a: string, b: string): boolean {
  if (a === "*" || b === "*") return false;
  if (a === b) return true;
  const aPrefix = a.endsWith("*") ? a.slice(0, -1) : null;
  const bPrefix = b.endsWith("*") ? b.slice(0, -1) : null;
  if (aPrefix === null && bPrefix === null) return false;
  if (aPrefix !== null && bPrefix !== null) {
    return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
  }
  return aPrefix !== null ? b.startsWith(aPrefix) : a.startsWith(bPrefix!);
}

// 在「同 baseUrl 且 authStyle 不同」的既有记录里找模型冲突。
// 返回冲突描述（含对方记录名），无冲突返回 null。
export function findAuthModelConflict(
  self: { authStyle: AuthStyle; models: string[] },
  others: { name: string; baseUrl: string; authStyle: AuthStyle; models: string[] }[],
  selfBaseUrl: string
): string | null {
  for (const other of others) {
    if (other.baseUrl !== selfBaseUrl) continue;
    if (other.authStyle === self.authStyle) continue;
    for (const mine of self.models) {
      for (const theirs of other.models) {
        if (modelPatternsIntersect(mine, theirs)) {
          return `model "${mine}" overlaps with "${theirs}" on upstream "${other.name}" (same baseUrl, different authStyle)`;
        }
      }
    }
  }
  return null;
}
