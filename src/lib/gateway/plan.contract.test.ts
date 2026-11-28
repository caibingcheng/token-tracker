// buildPlan() 与 proxy.ts 链组装的契约测试（specs/relay-subnode.md §9 / §11）。
//
// 做法：**用现有 proxy.ts 当 oracle**。同一份 fixture + 同一份 deps 假实现，
// 先跑 handleProxyRequest（记录真实的 outbound 尝试序列），再跑 buildPlan()，
// 逐条比对 hop 序列 / 最终 URL / realModel / 错误码 / 会话指纹。
//
// 为什么不让 proxy.ts 与 buildPlan() 共用链组装代码：hopLoop 与响应处理、写库深度耦合，
// 抽取的回归风险大于收益（§9）。这里用「两份实现 + 一份 fixture」把漂移挡在 CI 里。
import { afterEach, describe, expect, it } from "vitest";
import { handleProxyRequest, MAX_RETRY, PROXY_RESPONSE_HEADERS } from "./proxy";
import type {
  NamedRouteInfo,
  NamedRouteTargetInfo,
  ProxyDeps,
  RecordUsageMeta,
  VirtualKeyInfo,
} from "./proxy";
import { buildPlan, resolvePlanMode } from "./plan";
import type { BuildPlanInput, BuildPlanResult, PlanDeps, PlanKey } from "./plan";
import { setOutboundFetchImpl } from "./outbound-fetch";
import {
  detectRequestProtocol,
  extractRequestModel,
  type Protocol,
  type UpstreamRoute,
} from "./model-router";
import {
  computeSessionId,
  computeSessionIdFromInput,
  extractSessionInput,
  type SessionBinding,
} from "./session";
import type { HeaderTransform } from "./header-transforms";
import type { QuotaUsage } from "./quota";

const VK_TOKEN = "vk-plain-token";
const VK_ID = 7;
const USER_AGENT = "contract-test/1.0";

// ---- fixture ----

interface FixtureOpts {
  upstreams: UpstreamRoute[];
  keys?: Record<number, PlanKey[]>;
  routes?: NamedRouteInfo[];
  targets?: Record<number, NamedRouteTargetInfo[]>;
  unhealthy?: number[];
  modelUnhealthy?: string[]; // `${upstreamId}\u0000${model}`
  givenUp?: number[];
  classifier?: { routeId: number | null };
  responseOwners?: Record<string, number>;
  quotaUsage?: QuotaUsage;
  response?: (ctx: { upstreamId: number; keyId: number; attempt: number; url: string }) => Response;
  seed?: (fx: Fixture) => void;
}

interface Fixture {
  upstreams: UpstreamRoute[];
  keys: Record<number, PlanKey[]>;
  routes: NamedRouteInfo[];
  targets: Record<number, NamedRouteTargetInfo[]>;
  unhealthy: Set<number>;
  modelUnhealthy: Set<string>;
  givenUp: Set<number>;
  classifier: { routeId: number | null } | null;
  classifierCalls: number;
  marks: string[];
  bindings: Map<string, SessionBinding>;
  responseOwners: Record<string, number>;
  quotaUsage: QuotaUsage;
  response: (ctx: { upstreamId: number; keyId: number; attempt: number; url: string }) => Response;
  keyIndex: Map<string, { upstreamId: number; keyId: number }>;
}

const up = (
  id: number,
  enabledModels: string[],
  extra: Partial<UpstreamRoute> = {}
): UpstreamRoute => ({
  id,
  name: `u${id}`,
  protocol: "openai",
  baseUrl: `https://u${id}.example.com/v1`,
  priority: id,
  enabled: true,
  enabledModels,
  proxyUrl: null,
  headerTransforms: [],
  ...extra,
});

const nr = (
  id: number,
  name: string,
  extra: Partial<NamedRouteInfo> = {}
): NamedRouteInfo => ({
  id,
  name,
  protocol: "openai",
  instruction: "pick one",
  classifierUpstreamId: 0,
  classifierModel: "",
  classifierKind: "priority",
  enabled: true,
  ...extra,
});

const nt = (
  id: number,
  upstreamId: number | null,
  targetModel: string,
  priority: number
): NamedRouteTargetInfo => ({ id, upstreamId, targetModel, description: null, priority });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...PROXY_RESPONSE_HEADERS },
  });
}

function defaultKeys(upstreams: UpstreamRoute[]): Record<number, PlanKey[]> {
  const keys: Record<number, PlanKey[]> = {};
  for (const u of upstreams) keys[u.id] = [{ id: u.id * 100 + 1, apiKey: `sk-${u.id}-k1` }];
  return keys;
}

function mkFixture(opts: FixtureOpts): Fixture {
  const keys = opts.keys ?? defaultKeys(opts.upstreams);
  const keyIndex = new Map<string, { upstreamId: number; keyId: number }>();
  for (const [rawId, list] of Object.entries(keys)) {
    const upstreamId = Number(rawId);
    for (const k of list) keyIndex.set(k.apiKey, { upstreamId, keyId: k.id });
  }
  const fx: Fixture = {
    upstreams: opts.upstreams,
    keys,
    routes: opts.routes ?? [],
    targets: opts.targets ?? {},
    unhealthy: new Set(opts.unhealthy ?? []),
    modelUnhealthy: new Set(opts.modelUnhealthy ?? []),
    givenUp: new Set(opts.givenUp ?? []),
    classifier: opts.classifier ?? null,
    classifierCalls: 0,
    marks: [],
    bindings: new Map(),
    responseOwners: opts.responseOwners ?? {},
    quotaUsage: opts.quotaUsage ?? { rpm: 0, tpm: 0, dailyTokens: 0, monthlyTokens: 0 },
    response:
      opts.response ??
      (() => jsonResponse(500, { error: { message: "upstream boom", type: "upstream_error" } })),
    keyIndex,
  };
  opts.seed?.(fx);
  return fx;
}

// ---- 共享 deps 假实现（proxy 与 buildPlan 用同一份 fixture 语义） ----

function healthOf(fx: Fixture): ProxyDeps["health"] {
  return {
    isHealthy: async (id: number) => !fx.unhealthy.has(id),
    markUnhealthy: (id: number) => {
      fx.marks.push(`unhealthy:${id}`);
    },
    markHealthy: (id: number) => {
      fx.marks.push(`healthy:${id}`);
    },
    isModelHealthy: async (id: number, model: string) =>
      !fx.modelUnhealthy.has(`${id}\u0000${model}`),
    markModelUnhealthy: (id: number, model: string) => {
      fx.marks.push(`model-unhealthy:${id}:${model}`);
    },
    markModelHealthy: (id: number, model: string) => {
      fx.marks.push(`model-healthy:${id}:${model}`);
    },
    isGivenUp: (id: number) => fx.givenUp.has(id),
  };
}

function sessionOf(fx: Fixture): NonNullable<ProxyDeps["session"]> {
  return {
    getBinding: (sessionId: string) => fx.bindings.get(sessionId),
    setBinding: (sessionId: string, upstreamId: number, targetModel?: string) => {
      fx.bindings.set(sessionId, { upstreamId, targetModel, boundAt: Date.now() });
    },
  };
}

function vkOf(sc: Scenario): VirtualKeyInfo {
  return {
    id: VK_ID,
    name: "vk-main",
    enabled: true,
    enabledModels: ["*"],
    ...sc.vk,
  };
}

// ---- 场景 ----

interface Scenario {
  method?: string;
  path: string; // 含 query
  body?: unknown;
  vk?: Partial<VirtualKeyInfo>;
  nativeSessionId?: string | null;
  sessionInput?: string;
  estimatedInputTokens?: number;
  headers?: Record<string, string>;
}

interface Attempt {
  upstreamId: number;
  keyId: number;
  model: string | null;
  url: string;
}

interface OracleResult {
  attempts: Attempt[];
  usages: RecordUsageMeta[];
  classifierUsages: RecordUsageMeta[];
  sessionHeaders: (string | null)[];
  marks: string[];
  bindings: Map<string, SessionBinding>;
  status: number;
  errorType: string | null;
  body: unknown;
}

interface PlanRun {
  result: BuildPlanResult;
  classifierCalls: number;
  classifierUsages: RecordUsageMeta[];
}

function bodyModel(body: unknown): string | null {
  if (!(body instanceof Uint8Array)) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    const model = (parsed as { model?: unknown } | null)?.model;
    return typeof model === "string" ? model : null;
  } catch {
    return null;
  }
}

function buildRequest(sc: Scenario): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${VK_TOKEN}`,
    "user-agent": USER_AGENT,
    ...sc.headers,
  };
  if (sc.body !== undefined) headers["content-type"] = "application/json";
  // 原生会话 header 必须真的发出去：proxy 侧的 clientSessionId 只从 header 读
  if (sc.nativeSessionId) headers["x-claude-code-session-id"] = sc.nativeSessionId;
  return new Request(`http://gateway.local${sc.path}`, {
    method: sc.method ?? "POST",
    headers,
    body: sc.body === undefined ? undefined : JSON.stringify(sc.body),
  });
}

async function runOracle(fx: Fixture, sc: Scenario): Promise<OracleResult> {
  const vk = vkOf(sc);
  const attempts: Attempt[] = [];
  const usages: RecordUsageMeta[] = [];
  const classifierUsages: RecordUsageMeta[] = [];
  const sessionHeaders: (string | null)[] = [];

  setOutboundFetchImpl(async (input: unknown, init: unknown) => {
    const url = String(input);
    const headers = (init as { headers?: Headers } | undefined)?.headers;
    const auth =
      headers?.get("authorization") ??
      headers?.get("x-api-key") ??
      headers?.get("x-goog-api-key") ??
      "";
    const plain = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : auth;
    const hit = fx.keyIndex.get(plain);
    if (!hit) throw new Error(`unexpected outbound key: ${plain}`);
    const attempt = attempts.filter((a) => a.keyId === hit.keyId).length + 1;
    sessionHeaders.push(headers?.get("x-sess") ?? null);
    attempts.push({
      upstreamId: hit.upstreamId,
      keyId: hit.keyId,
      model: bodyModel((init as { body?: unknown } | undefined)?.body),
      url,
    });
    return fx.response({ ...hit, attempt, url });
  });

  const deps: ProxyDeps = {
    resolveVirtualKey: async (token: string) => (token === VK_TOKEN ? vk : null),
    resolveUpstreamKeys: async (upstreamId: number) =>
      (fx.keys[upstreamId] ?? []).map((k) => k.apiKey),
    loadUpstreams: async () => fx.upstreams,
    loadNamedRoutes: async () => fx.routes,
    loadNamedRouteTargets: async (id: number) => fx.targets[id] ?? [],
    runClassifier: fx.classifier
      ? async () => {
          fx.classifierCalls++;
          return { routeId: fx.classifier!.routeId, usage: null };
        }
      : undefined,
    quota: { loadUsage: async () => fx.quotaUsage },
    session: sessionOf(fx),
    health: healthOf(fx),
    onUsage: async (meta: RecordUsageMeta) => {
      if (meta.status === "classifier") classifierUsages.push(meta);
      else usages.push(meta);
    },
    onComplete: async () => {},
    lookupResponseOwner: async (responseId: string) => fx.responseOwners[responseId] ?? null,
    log: () => {},
  };

  const res = await handleProxyRequest(buildRequest(sc), deps);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const errorType =
    res.ok || res.status === 200
      ? null
      : (((body as { error?: { type?: unknown } } | null)?.error?.type as string | undefined) ??
        null);
  return {
    attempts,
    usages,
    classifierUsages,
    sessionHeaders,
    marks: fx.marks,
    bindings: fx.bindings,
    status: res.status,
    errorType,
    body,
  };
}

function hasMessagesOf(body: unknown): boolean {
  const messages = (body as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) && messages.length > 0;
}

function deriveSessionInput(
  body: unknown,
  sessionModel: string,
  virtualKeyId: number,
  protocol: Protocol
): string {
  const suffix = `\u0000${sessionModel}\u0000${virtualKeyId}\u0000${protocol}`;
  const raw = extractSessionInput(body, sessionModel, virtualKeyId, protocol);
  return raw.endsWith(suffix) ? raw.slice(0, raw.length - suffix.length) : raw;
}

async function runPlan(fx: Fixture, sc: Scenario): Promise<PlanRun> {
  const vk = vkOf(sc);
  const pathname = sc.path.split("?")[0];
  const protocol = detectRequestProtocol(pathname);
  const mode = resolvePlanMode(sc.method ?? "POST", pathname);
  const isSubresource = mode === "responses-subresource";
  const model =
    mode === "router" || mode === "responses-create"
      ? extractRequestModel(pathname, sc.body ?? null)
      : null;
  // relay 侧的指纹素材只来自 body（subresource 无 model，直连侧用 path 当 model 项）
  const sessionBody = isSubresource ? null : (sc.body ?? null);
  const sessionModel = model ?? pathname;
  const sessionInput =
    sc.sessionInput ??
    (isSubresource ? "" : deriveSessionInput(sessionBody, sessionModel, vk.id, protocol));
  const classifierUsages: RecordUsageMeta[] = [];

  const deps: PlanDeps = {
    loadUpstreams: async () => fx.upstreams,
    resolveUpstreamKeys: async (upstreamId: number) => fx.keys[upstreamId] ?? [],
    loadNamedRoutes: async () => fx.routes,
    loadNamedRouteTargets: async (id: number) => fx.targets[id] ?? [],
    runClassifier: fx.classifier
      ? async () => {
          fx.classifierCalls++;
          return { routeId: fx.classifier!.routeId, usage: null };
        }
      : undefined,
    session: sessionOf(fx),
    health: healthOf(fx),
    lookupResponseOwner: async (responseId: string) => fx.responseOwners[responseId] ?? null,
    quota: { loadUsage: async () => fx.quotaUsage },
    onClassifierUsage: async (meta: RecordUsageMeta) => {
      classifierUsages.push(meta);
    },
    log: () => {},
  };

  const input: BuildPlanInput = {
    virtualKey: vk,
    mode,
    protocol,
    path: sc.path,
    model,
    responseId: isSubresource
      ? (pathname.slice("/v1/responses/".length).split("/")[0] ?? null)
      : null,
    nativeSessionId: sc.nativeSessionId ?? null,
    sessionInput,
    hasMessages: hasMessagesOf(sessionBody),
    stream:
      typeof (sc.body as { stream?: unknown } | null)?.stream === "boolean"
        ? ((sc.body as { stream: boolean }).stream as boolean)
        : undefined,
    userAgent: USER_AGENT,
    estimatedInputTokens: sc.estimatedInputTokens ?? 1000,
    bodyJson: sessionBody,
  };

  const result = await buildPlan(input, deps);
  return {
    result,
    classifierCalls: fx.classifierCalls,
    classifierUsages,
  };
}

async function runPair(
  opts: FixtureOpts,
  sc: Scenario
): Promise<{ oracle: OracleResult; plan: PlanRun; oracleFixture: Fixture; planFixture: Fixture }> {
  const oracleFixture = mkFixture(opts);
  const oracle = await runOracle(oracleFixture, sc);
  const planFixture = mkFixture(opts);
  const plan = await runPlan(planFixture, sc);
  return { oracle, plan, oracleFixture, planFixture };
}

function dedupeAttempts(attempts: Attempt[]): { keyIds: number[]; models: (string | null)[]; urls: string[] } {
  const keyIds: number[] = [];
  const models: (string | null)[] = [];
  const urls: string[] = [];
  for (const a of attempts) {
    if (keyIds[keyIds.length - 1] === a.keyId) continue;
    keyIds.push(a.keyId);
    models.push(a.model);
    urls.push(a.url);
  }
  return { keyIds, models, urls };
}

function expectPlanOk(plan: PlanRun): Extract<BuildPlanResult, { ok: true }> {
  if (!plan.result.ok) {
    throw new Error(`plan expected ok, got ${plan.result.status} ${plan.result.error.code}`);
  }
  return plan.result;
}

// 不变量 1 / 3：hops 的 (upstream, key) 序列、最终 URL、realModel 与直连实际尝试逐项相等
function expectPlanMatchesOracle(plan: PlanRun, oracle: OracleResult): void {
  const result = expectPlanOk(plan);
  const { keyIds, models, urls } = dedupeAttempts(oracle.attempts);
  expect(result.hops.map((h) => h.keyId)).toEqual(keyIds);
  expect(result.hops.map((h) => h.url)).toEqual(urls);
  expect(result.hops.map((h) => h.realModel)).toEqual(models);
}

function expectPlanError(
  plan: PlanRun,
  oracle: OracleResult,
  status: number,
  code: string
): void {
  expect(plan.result.ok).toBe(false);
  if (plan.result.ok) return;
  expect(plan.result.status).toBe(status);
  expect(plan.result.error.code).toBe(code);
  expect(plan.result.error.type).toBe(code);
  expect(oracle.status).toBe(status);
  expect(oracle.errorType).toBe(code);
}

afterEach(() => {
  setOutboundFetchImpl(null);
});

const CHAT_PATH = "/v1/chat/completions";
const chatBody = (model: string) => ({
  model,
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ],
});

// ---- 用例 ----

describe("buildPlan 契约（oracle = proxy.ts 的链组装）", () => {
  it("命名路由：priority 升序 + 组链后健康稳定重排 + pinHop 置顶", async () => {
    const opts: FixtureOpts = {
      upstreams: [up(1, ["gpt-*"]), up(2, ["gpt-auto"]), up(3, [])],
      routes: [nr(100, "smart")],
      // t1 是 auto 目标（展开顺序 exact u2 > wildcard u1），t2 是显式目标
      targets: { 100: [nt(1, null, "gpt-auto", 1), nt(2, 3, "m-c", 2)] },
      unhealthy: [1],
    };
    const { oracle, plan } = await runPair(opts, { path: CHAT_PATH, body: chatBody("smart") });
    expectPlanMatchesOracle(plan, oracle);
    // 链首目标 t1 的 pinHop = u2（首个健康 hop）→ 先 u2；u1 degraded 排尾
    expect(plan.result.ok && plan.result.hops.map((h) => h.upstreamId)).toEqual([2, 3, 1]);
    expect(plan.result.ok && plan.result.hops.map((h) => h.realModel)).toEqual([
      "gpt-auto",
      "m-c",
      "gpt-auto",
    ]);
  });

  it("givenUp 的 upstream 从命名路由目标链中剔除", async () => {
    const opts: FixtureOpts = {
      upstreams: [up(1, []), up(2, []), up(3, [])],
      routes: [nr(100, "smart")],
      targets: {
        100: [nt(1, 1, "m-a", 1), nt(2, 2, "m-b", 2), nt(3, 3, "m-c", 3)],
      },
      givenUp: [2],
    };
    const { oracle, plan } = await runPair(opts, { path: CHAT_PATH, body: chatBody("smart") });
    expectPlanMatchesOracle(plan, oracle);
    expect(plan.result.ok && plan.result.hops.map((h) => h.upstreamId)).toEqual([1, 3]);
  });

  it("嵌套 auto 目标展开：exact 候选排在 wildcard 之前", async () => {
    const opts: FixtureOpts = {
      upstreams: [up(1, ["gpt-*"]), up(2, ["gpt-auto"])],
      routes: [nr(100, "smart")],
      targets: { 100: [nt(1, null, "gpt-auto", 1)] },
    };
    const { oracle, plan } = await runPair(opts, { path: CHAT_PATH, body: chatBody("smart") });
    expectPlanMatchesOracle(plan, oracle);
    expect(plan.result.ok && plan.result.hops.map((h) => h.upstreamId)).toEqual([2, 1]);
  });

  it("LLM 分类器命中时目标排链首；已有 binding 时不再调用分类器", async () => {
    const targets = { 100: [nt(1, 1, "m-a", 1), nt(2, 2, "m-b", 2), nt(3, 3, "m-c", 3)] };
    const baseOpts: FixtureOpts = {
      upstreams: [
        up(1, [], { classifierModels: JSON.stringify([{ model: "clf", type: "chat" }]) }),
        up(2, []),
        up(3, []),
      ],
      routes: [
        nr(100, "smart", {
          classifierKind: "model",
          classifierUpstreamId: 1,
          classifierModel: "clf",
        }),
      ],
      targets,
      classifier: { routeId: 3 },
    };
    const first = await runPair(baseOpts, { path: CHAT_PATH, body: chatBody("smart") });
    expectPlanMatchesOracle(first.plan, first.oracle);
    expect(first.plan.classifierCalls).toBe(1);
    expect(first.oracle.classifierUsages.length).toBe(1);
    expect(first.plan.classifierUsages.length).toBe(1);
    expect(first.plan.result.ok && first.plan.result.hops.map((h) => h.upstreamId)).toEqual([
      3, 1, 2,
    ]);

    // 同一会话的第二次请求：binding 命中 route 粒度（upstream + targetModel），不再调分类器
    const sessionInput = deriveSessionInput(
      chatBody("smart"),
      "smart",
      VK_ID,
      "openai"
    );
    const seedBinding = (fx: Fixture) => {
      fx.bindings.set(
        computeSessionId(computeSessionIdFromInput(sessionInput, "smart", VK_ID, "openai")),
        { upstreamId: 3, targetModel: "m-c", boundAt: Date.now() }
      );
    };
    const second = await runPair(
      { ...baseOpts, seed: seedBinding },
      { path: CHAT_PATH, body: chatBody("smart") }
    );
    expectPlanMatchesOracle(second.plan, second.oracle);
    expect(second.plan.classifierCalls).toBe(0);
    expect(second.oracle.classifierUsages.length).toBe(0);
    expect(second.plan.result.ok && second.plan.result.hops.map((h) => h.upstreamId)).toEqual([
      3, 1, 2,
    ]);
  });

  it("binding 指向已禁用/不存在的 upstream → 失效回退（自动路由）", async () => {
    const opts: FixtureOpts = {
      upstreams: [up(1, ["gpt-a"]), up(2, ["gpt-a"])],
      seed: (fx) => {
        fx.bindings.set(bindingKeyOf("gpt-a"), { upstreamId: 99, boundAt: Date.now() });
      },
    };
    const { oracle, plan } = await runPair(opts, { path: CHAT_PATH, body: chatBody("gpt-a") });
    expectPlanMatchesOracle(plan, oracle);
    expect(plan.result.ok && plan.result.hops.map((h) => h.upstreamId)).toEqual([1, 2]);
  });

  it("单目标命名路由不调用分类器", async () => {
    const opts: FixtureOpts = {
      upstreams: [
        up(1, [], { classifierModels: JSON.stringify([{ model: "clf", type: "chat" }]) }),
        up(2, []),
      ],
      routes: [
        nr(100, "smart", {
          classifierKind: "model",
          classifierUpstreamId: 1,
          classifierModel: "clf",
        }),
      ],
      targets: { 100: [nt(1, 2, "m-b", 1)] },
      classifier: { routeId: 1 },
    };
    const { oracle, plan } = await runPair(opts, { path: CHAT_PATH, body: chatBody("smart") });
    expectPlanMatchesOracle(plan, oracle);
    expect(plan.classifierCalls).toBe(0);
    expect(oracle.sessionHeaders.length).toBeGreaterThan(0);
    expect(plan.result.ok && plan.result.hops.map((h) => h.keyId)).toEqual([201]);
  });

  it("upstream_keys 为空 → 该 upstream 不产生 hop", async () => {
    const opts: FixtureOpts = {
      upstreams: [up(1, ["gpt-a"]), up(2, ["gpt-a"])],
      keys: { 1: [], 2: [{ id: 201, apiKey: "sk-2-k1" }] },
    };
    const { oracle, plan } = await runPair(opts, { path: CHAT_PATH, body: chatBody("gpt-a") });
    expectPlanMatchesOracle(plan, oracle);
    expect(plan.result.ok && plan.result.hops.map((h) => h.upstreamId)).toEqual([2]);
  });

  it("router：passthrough 恒为 last-4xx（4xx 透传，全 429/5xx 归 502）", async () => {
    const blocked: FixtureOpts = {
      upstreams: [up(1, ["gpt-a"]), up(2, ["gpt-a"])],
      response: () => jsonResponse(403, { error: { message: "blocked", type: "upstream_denied" } }),
    };
    const a = await runPair(blocked, { path: CHAT_PATH, body: chatBody("gpt-a") });
    expectPlanMatchesOracle(a.plan, a.oracle);
    expect(a.oracle.status).toBe(403); // 直连：透传最后一个业务 403
    expect(a.plan.result.ok && a.plan.result.hops.map((h) => h.passthrough)).toEqual([
      "last-4xx",
      "last-4xx",
    ]);

    const broken: FixtureOpts = { upstreams: [up(1, ["gpt-a"]), up(2, ["gpt-a"])] }; // 默认 500
    const b = await runPair(broken, { path: CHAT_PATH, body: chatBody("gpt-a") });
    expectPlanMatchesOracle(b.plan, b.oracle);
    expect(b.oracle.status).toBe(502); // 直连：429/5xx 已 cancel，全链耗尽 → 502
    expect(b.plan.result.ok && b.plan.result.hops.every((h) => h.passthrough === "last-4xx")).toBe(
      true
    );
    expect(b.plan.result.ok && b.plan.result.hops.every((h) => h.retries === MAX_RETRY)).toBe(true);
    expect(
      b.plan.result.ok && b.plan.result.hops.every((h) => h.skipSiblingsOn.join(",") === "403,404")
    ).toBe(true);
  });

  it("错误码与直连逐字一致：named_route_unavailable / protocol_mismatch / model_not_found / upstream_unavailable", async () => {
    // 目标池全部解析不出 hop
    const named: FixtureOpts = {
      upstreams: [up(1, [])],
      routes: [nr(100, "smart")],
      targets: { 100: [nt(1, 99, "m-ghost", 1)] },
    };
    const a = await runPair(named, { path: CHAT_PATH, body: chatBody("smart") });
    expectPlanError(a.plan, a.oracle, 502, "named_route_unavailable");

    // model 只配在其他协议
    const mismatch: FixtureOpts = {
      upstreams: [up(5, ["claude-x"], { protocol: "anthropic", baseUrl: "https://a5.example.com" })],
    };
    const b = await runPair(mismatch, { path: CHAT_PATH, body: chatBody("claude-x") });
    expectPlanError(b.plan, b.oracle, 400, "protocol_mismatch");

    // 任何 upstream 都没有该 model
    const notFound: FixtureOpts = { upstreams: [up(1, ["gpt-a"])] };
    const c = await runPair(notFound, { path: CHAT_PATH, body: chatBody("nope") });
    expectPlanError(c.plan, c.oracle, 404, "model_not_found");

    // 有候选但全部 givenUp
    const givenUp: FixtureOpts = {
      upstreams: [up(1, ["gpt-a"]), up(2, ["gpt-a"])],
      givenUp: [1, 2],
    };
    const d = await runPair(givenUp, { path: CHAT_PATH, body: chatBody("gpt-a") });
    expectPlanError(d.plan, d.oracle, 502, "upstream_unavailable");
  });

  it("同名自动路由被命名路由 overridden → 不出现在候选里", async () => {
    const opts: FixtureOpts = {
      upstreams: [up(1, []), up(2, ["gpt-a"])],
      routes: [nr(100, "gpt-a")],
      targets: { 100: [nt(1, 1, "m-a", 1)] },
    };
    const { oracle, plan } = await runPair(opts, { path: CHAT_PATH, body: chatBody("gpt-a") });
    expectPlanMatchesOracle(plan, oracle);
    expect(plan.result.ok && plan.result.hops.map((h) => h.upstreamId)).toEqual([1]);
    expect(plan.result.ok && plan.result.hops.map((h) => h.realModel)).toEqual(["m-a"]);
  });

  it("自动路由 binding 置顶；命名路由 binding 命中的 hop 置顶（pinHop）", async () => {
    // 自动路由：binding → u2
    const auto: FixtureOpts = {
      upstreams: [up(1, ["gpt-a"]), up(2, ["gpt-a"])],
      seed: (fx) => {
        fx.bindings.set(bindingKeyOf("gpt-a"), { upstreamId: 2, boundAt: Date.now() });
      },
    };
    const a = await runPair(auto, { path: CHAT_PATH, body: chatBody("gpt-a") });
    expectPlanMatchesOracle(a.plan, a.oracle);
    expect(a.plan.result.ok && a.plan.result.hops.map((h) => h.upstreamId)).toEqual([2, 1]);

    // 命名路由：binding 指向 t1 展开链里的第二跳（u1），pinHop 把它提到 t1 的 hop 最前
    const named: FixtureOpts = {
      upstreams: [up(1, ["gpt-*"]), up(2, ["gpt-auto"]), up(3, [])],
      routes: [nr(100, "smart")],
      targets: { 100: [nt(1, null, "gpt-auto", 1), nt(2, 3, "m-c", 2)] },
      seed: (fx) => {
        fx.bindings.set(bindingKeyOf("smart"), {
          upstreamId: 1,
          targetModel: "gpt-auto",
          boundAt: Date.now(),
        });
      },
    };
    const b = await runPair(named, { path: CHAT_PATH, body: chatBody("smart") });
    expectPlanMatchesOracle(b.plan, b.oracle);
    expect(b.plan.result.ok && b.plan.result.hops.map((h) => h.upstreamId)).toEqual([1, 2, 3]);
  });

  it("responses-subresource：全 openai upstream 按 priority 遍历、404/403 零健康标记、恒 60s、reservedTokens=0", async () => {
    const notFound = (): Response =>
      jsonResponse(404, { error: { message: "no such response", type: "not_found" } });
    const opts: FixtureOpts = {
      upstreams: [up(1, []), up(2, []), up(3, [], { protocol: "anthropic" }), up(4, [])],
      response: notFound,
    };
    const sc: Scenario = { path: "/v1/responses/resp_abc/input_items?limit=2", body: {} };
    const { oracle, plan, oracleFixture } = await runPair(opts, sc);
    expectPlanMatchesOracle(plan, oracle);
    expect(oracle.attempts.map((a) => a.upstreamId)).toEqual([1, 2, 4]);
    expect(oracle.marks).toEqual([]); // 404/403 在子资源链路零健康标记
    expect(oracle.status).toBe(404); // 直连：透传最后一个业务响应
    const result = expectPlanOk(plan);
    expect(result.hops.map((h) => h.timeoutMs)).toEqual([60_000, 60_000, 60_000]);
    expect(result.hops.map((h) => h.realModel)).toEqual([null, null, null]);
    expect(result.hops.map((h) => h.passthrough)).toEqual([
      "last-business",
      "last-business",
      "last-business",
    ]);
    expect(result.hops.map((h) => h.suppressHealth)).toEqual([
      ["403", "404"],
      ["403", "404"],
      ["403", "404"],
    ]);
    expect(result.quota).toEqual({ reservedTokens: 0, reservedRpm: 1 });
    // 403/404 = upstream 级判定 → 跳过该 upstream 剩余 key
    expect(result.hops.every((h) => h.skipSiblingsOn.join(",") === "403,404")).toBe(true);
    expect(oracleFixture.marks).toEqual([]);
  });

  it("responses-subresource：429/5xx 保留最后业务响应；全 givenUp → 502", async () => {
    const broken: FixtureOpts = { upstreams: [up(1, []), up(2, [])] }; // 默认 500
    const a = await runPair(broken, { path: "/v1/responses/resp_abc", body: {} });
    expectPlanMatchesOracle(a.plan, a.oracle);
    expect(a.oracle.status).toBe(500);
    expect(a.plan.result.ok && a.plan.result.hops.every((h) => h.passthrough === "last-business")).toBe(
      true
    );

    // 全部 unhealthy（兜底回退），但 givenUp 的不再尝试
    const allDown: FixtureOpts = {
      upstreams: [up(1, []), up(2, []), up(3, [])],
      unhealthy: [1, 2, 3],
      givenUp: [3],
    };
    const b = await runPair(allDown, { path: "/v1/responses/resp_abc", body: {} });
    expectPlanMatchesOracle(b.plan, b.oracle);
    expect(b.plan.result.ok && b.plan.result.hops.map((h) => h.upstreamId)).toEqual([1, 2]);
  });

  it("responses-subresource：response id 归属不属于本 vk → 403 forbidden", async () => {
    const opts: FixtureOpts = {
      upstreams: [up(1, [])],
      responseOwners: { resp_other: 999 },
    };
    const { oracle, plan } = await runPair(opts, {
      path: "/v1/responses/resp_other",
      body: {},
    });
    expectPlanError(plan, oracle, 403, "forbidden");
    expect(oracle.attempts).toEqual([]); // 两侧都不发上游请求
  });

  it("models 模式：快照 = 非通配 enabled_models ∪ enabled 命名路由名，再按 vk allowlist 过滤", async () => {
    const opts: FixtureOpts = {
      upstreams: [up(1, ["gpt-a", "gpt-*"]), up(2, ["claude-x"], { protocol: "anthropic" })],
      routes: [nr(100, "smart"), nr(101, "smart-gem", { protocol: "gemini" })],
    };
    const all = await runPair(opts, { method: "GET", path: "/v1/models" });
    const allPlan = expectPlanOk(all.plan);
    const oracleIds = (all.oracle.body as { data?: { id: string }[] }).data?.map((m) => m.id);
    expect(allPlan.modelsSnapshot).toEqual(oracleIds);
    expect(allPlan.hops).toEqual([]);
    expect(allPlan.modelsSnapshot).toContain("smart");
    expect(allPlan.modelsSnapshot).not.toContain("gpt-*");
    expect(allPlan.modelsSnapshot).not.toContain("smart-gem");

    const limited = await runPair(
      { ...opts, seed: undefined },
      {
        method: "GET",
        path: "/v1/models",
        vk: { enabledModels: ["gpt-a"] },
      }
    );
    const limitedPlan = expectPlanOk(limited.plan);
    const limitedIds = (limited.oracle.body as { data?: { id: string }[] }).data?.map((m) => m.id);
    expect(limitedPlan.modelsSnapshot).toEqual(limitedIds);
    expect(limitedPlan.modelsSnapshot).toEqual(["gpt-a"]);
  });

  it("session 四组合（原生 header 有/无 × hasMessages 真/假）：routeSessionId / recordSessionId / sessionId 与直连逐字节相等", async () => {
    const transforms: HeaderTransform[] = [
      { id: "ht-00000001", header: "x-sess", value: "${var.sessionId}", mode: "override", enabled: true },
    ];
    const opts: FixtureOpts = {
      upstreams: [up(1, ["gpt-a"], { headerTransforms: transforms }), up(2, ["gpt-a"], { headerTransforms: transforms })],
      // 链首失败、次跳成功 → proxy 会写 session binding（可观测 routeSessionId）
      response: ({ upstreamId }) =>
        upstreamId === 1
          ? jsonResponse(500, { error: { message: "boom", type: "upstream_error" } })
          : jsonResponse(200, {
              id: "chatcmpl-1",
              choices: [{ message: { role: "assistant", content: "hi" } }],
              usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
            }),
    };
    const withMessages = chatBody("gpt-a");
    const noMessages = { model: "gpt-a", input: "hello" };
    const scenarios: { name: string; sc: Scenario }[] = [
      { name: "指纹 + hasMessages", sc: { path: CHAT_PATH, body: withMessages } },
      {
        name: "原生 header + hasMessages",
        sc: { path: CHAT_PATH, body: withMessages, nativeSessionId: "sess-native-01" },
      },
      { name: "指纹 + 无 messages", sc: { path: CHAT_PATH, body: noMessages } },
      {
        name: "原生 header + 无 messages",
        sc: { path: CHAT_PATH, body: noMessages, nativeSessionId: "sess-native-02" },
      },
    ];

    for (const { name, sc } of scenarios) {
      const { oracle, plan } = await runPair(opts, sc);
      const result = expectPlanOk(plan);
      expectPlanMatchesOracle(plan, oracle);
      // 写库口径：recordSessionId == 直连写进 token_records.session_id 的值
      expect(oracle.usages.length).toBe(1);
      expect(result.recordSessionId).toBe(oracle.usages[0].sessionId ?? null);
      // header transforms 的 ${var.sessionId}：两条入口同一个指纹
      const transformed = oracle.sessionHeaders.filter((v): v is string => v !== null);
      expect(new Set(transformed)).toEqual(new Set([result.sessionId]));
      // 路由粘性：直连成功落点非链首时写入的 binding 键 = routeSessionId
      // （relay 侧由 report 收尾时重绑，plan 只负责算出同一个键）
      expect([...oracle.bindings.keys()]).toEqual([result.routeSessionId]);
      expect(name).toBeTruthy();
    }
  });
});

// binding 键 = 由 body 素材算出的指纹（与 plan/proxy 的 routeSessionId 同口径）
function bindingKeyOf(model: string): string {
  const sessionInput = deriveSessionInput(chatBody(model), model, VK_ID, "openai");
  return computeSessionId(computeSessionIdFromInput(sessionInput, model, VK_ID, "openai"));
}
