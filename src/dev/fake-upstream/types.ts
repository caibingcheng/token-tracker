// 三协议模拟上游（openai / anthropic / gemini / responses）的配置与测试用接口类型。
// 用途：本地/CI 验证网关与 relay 的上游链路（key 轮换、failover、健康标记、usage 解析），
// 不依赖任何真实厂商。零依赖（只用 node:http），因此既能被 vitest 直接 import，
// 也能 `npm run fake-upstream` 起独立进程给 relay 用。

export type FakeProtocol = "openai" | "anthropic" | "gemini" | "responses";

export interface FakeModel {
  /** 响应里回报的 model 名（默认 = 请求里的 model） */
  reportAs?: string;
  /** 声明协议；与请求路径推断出的协议不一致时按 model_not_found 处理（防配错） */
  protocol?: FakeProtocol;
  /** usage 数字（默认 12 / 8） */
  promptTokens?: number;
  completionTokens?: number;
  /** 命中缓存的 input tokens（默认 0，0 时 anthropic/gemini 不写该字段，贴近真实响应） */
  cachedTokens?: number;
  /** 生成文本（默认 "fake upstream ok"） */
  text?: string;
}

export interface FakeKeyFail {
  status: number;
  /** 协议各自的错误 type/status 字符串；省略时按状态码给默认值 */
  type?: string;
  message?: string;
}

export interface FakeKey {
  /** 明文 key（openai/responses 走 Authorization: Bearer，anthropic 走 x-api-key，gemini 走 x-goog-api-key） */
  key: string;
  /** 限定可用协议；省略 = 全部允许 */
  protocols?: FakeProtocol[];
  /** 限定可用 model；省略或 "*" = 全部允许（用于测 model 白名单/路由绑定） */
  models?: string[] | "*";
  /** 每次都失败（用于 failover / 健康标记 / 401 换 key 测试） */
  fail?: FakeKeyFail;
  /** 前 N 次失败、之后成功（按 key 计数，reset() 清零） */
  failFirst?: FakeKeyFail;
  /** 该 key 的额外延迟（毫秒），用于测超时与 idle 检测 */
  latencyMs?: number;
}

export interface FakeUpstreamConfig {
  host?: string;
  /** 0（默认）= 随机端口，测试用；独立进程时用 --port */
  port?: number;
  /** 全局延迟（毫秒） */
  latencyMs?: number;
  /** 流式响应每帧之间的延迟（毫秒），用于测 relay/中心的 idle 超时 */
  streamChunkDelayMs?: number;
  keys: FakeKey[];
  models: Record<string, FakeModel>;
}

export interface FakeRequestLog {
  at: string;
  method: string;
  path: string;
  protocol: FakeProtocol | null;
  key: string | null;
  model: string | null;
  stream: boolean;
  headers: Record<string, string>;
  body: unknown;
  /** 实际返回的状态码（便于断言 200/403/429 之类） */
  status: number;
}

export interface FakeUpstream {
  /** 形如 http://127.0.0.1:34567（无结尾斜杠），可直接作为 upstream baseUrl */
  url: string;
  port: number;
  requests: FakeRequestLog[];
  /** 清空请求日志与 failFirst 计数（每个测试用例之间调用） */
  reset(): void;
  close(): Promise<void>;
}
