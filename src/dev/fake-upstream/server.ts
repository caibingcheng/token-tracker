// 模拟上游：一个 node:http 服务，按路径识别 openai / anthropic / gemini / responses 四种形状。
// 设计目标（只做这四件事）：
//   1) 可路由：多 key（各自白名单）、多 model（各自协议/usage 数字）、按需失败；
//   2) 可断言：requests[] 记录收到的每个请求（key/model/body/status）；
//   3) 可进程内使用（vitest import createFakeUpstream）也可独立进程（cli.ts）；
//   4) 零依赖、不碰本项目任何中心模块（测试组件不能反过来依赖被测代码）。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { contentText, errorBody, modelsList, streamFrames, type Usage } from "./protocols";
import type { FakeProtocol, FakeRequestLog, FakeUpstream, FakeUpstreamConfig } from "./types";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOGGED_HEADERS = ["content-type", "user-agent", "anthropic-version", "accept"];

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return null;
}

/** openai/responses: Authorization: Bearer；anthropic: x-api-key；gemini: x-goog-api-key 或 ?key= */
function extractKey(req: IncomingMessage, url: URL, protocol: FakeProtocol): string | null {
  if (protocol === "anthropic") return headerValue(req, "x-api-key")?.trim() || null;
  if (protocol === "gemini") {
    return (
      headerValue(req, "x-goog-api-key")?.trim() ||
      url.searchParams.get("key")?.trim() ||
      null
    );
  }
  const auth = headerValue(req, "authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match ? match[1]!.trim() : null;
}

function detectModelListProtocol(req: IncomingMessage, pathname: string): FakeProtocol {
  if (pathname === "/v1beta/models") return "gemini";
  return headerValue(req, "x-api-key") !== null ? "anthropic" : "openai";
}

interface Route {
  protocol: FakeProtocol;
  /** null = GET /models（模型清单，不需要 body） */
  modelFromBody: boolean;
  modelFromPath: string | null;
  stream: boolean;
  listModels: boolean;
}

/** 只认本文件头部列出的路径；其余一律 404（未知路径不该被当成"上游正常"） */
function matchRoute(req: IncomingMessage, url: URL): Route | null {
  const pathname = url.pathname;
  if (req.method === "GET") {
    if (pathname === "/v1/models" || pathname === "/v1beta/models") {
      return {
        protocol: detectModelListProtocol(req, pathname),
        modelFromBody: false,
        modelFromPath: null,
        stream: false,
        listModels: true,
      };
    }
    return null;
  }
  if (req.method !== "POST") return null;
  if (pathname === "/v1/chat/completions") {
    return { protocol: "openai", modelFromBody: true, modelFromPath: null, stream: false, listModels: false };
  }
  if (pathname === "/v1/messages") {
    return { protocol: "anthropic", modelFromBody: true, modelFromPath: null, stream: false, listModels: false };
  }
  if (pathname === "/v1/responses") {
    return { protocol: "responses", modelFromBody: true, modelFromPath: null, stream: false, listModels: false };
  }
  const gemini = /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/.exec(pathname);
  if (gemini) {
    return {
      protocol: "gemini",
      modelFromBody: false,
      modelFromPath: decodeURIComponent(gemini[1]!),
      stream: gemini[2] === "streamGenerateContent",
      listModels: false,
    };
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function createFakeUpstream(config: FakeUpstreamConfig): Promise<FakeUpstream> {
  const keys = new Map(config.keys.map((k) => [k.key, k]));
  const failCounts = new Map<string, number>();
  const requests: FakeRequestLog[] = [];

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, errorBody("openai", 500, undefined, String(err)));
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    const route = matchRoute(req, url);

    // 控制面：给独立进程/脚本用；进程内测试可直接读 upstream.requests
    if (url.pathname === "/__fake/requests" && req.method === "GET") {
      sendJson(res, 200, { requests });
      return;
    }
    if (url.pathname === "/__fake/reset" && req.method === "POST") {
      requests.length = 0;
      failCounts.clear();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!route) {
      sendJson(res, 404, { error: { message: `fake upstream: no route for ${req.method} ${url.pathname}`, type: "not_found" } });
      return;
    }

    const key = extractKey(req, url, route.protocol);
    const rawBody = req.method === "POST" ? await readBody(req) : "";
    let parsed: Record<string, unknown> | null = null;
    if (rawBody) {
      try {
        const value = JSON.parse(rawBody) as unknown;
        parsed = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
    }
    const bodyModel = parsed && typeof parsed.model === "string" ? (parsed.model as string) : null;
    const model = route.modelFromPath ?? bodyModel;
    const stream = route.stream || (parsed?.stream === true && route.protocol !== "gemini");

    const headers: Record<string, string> = {};
    for (const name of LOGGED_HEADERS) {
      const value = headerValue(req, name);
      if (value !== null) headers[name] = value;
    }
    const entry: FakeRequestLog = {
      at: new Date().toISOString(),
      method: req.method ?? "GET",
      path: url.pathname + url.search,
      protocol: route.protocol,
      key,
      model,
      stream,
      headers,
      body: parsed ?? rawBody,
      status: 0,
    };
    requests.push(entry);

    const fail = (status: number, type?: string, message?: string): void => {
      entry.status = status;
      sendJson(res, status, errorBody(route.protocol, status, type, message));
    };

    const keyConfig = key === null ? null : (keys.get(key) ?? null);
    if (keys.size > 0 && keyConfig === null) {
      fail(401, undefined, key === null ? "missing api key" : "invalid api key");
      return;
    }
    if (keyConfig?.protocols && !keyConfig.protocols.includes(route.protocol)) {
      fail(403, undefined, `key is not allowed for ${route.protocol}`);
      return;
    }
    const allowed = keyConfig?.models;
    const modelAllowed = allowed === undefined || allowed === "*" || (model !== null && allowed.includes(model));

    if (route.listModels) {
      const ids = Object.entries(config.models)
        .filter(([, model]) => (model.protocol ?? "openai") === route.protocol)
        .filter(([id]) => allowed === undefined || allowed === "*" || allowed.includes(id))
        .map(([id]) => id)
        .sort();
      entry.status = 200;
      sendJson(res, 200, modelsList(route.protocol, ids));
      return;
    }

    if (!model) {
      fail(400, undefined, "model is required");
      return;
    }
    const modelConfig = config.models[model];
    if (!modelConfig) {
      fail(404, undefined, `model ${model} is not served by this fake upstream`);
      return;
    }
    if (modelConfig.protocol && modelConfig.protocol !== route.protocol) {
      fail(404, undefined, `model ${model} is served as ${modelConfig.protocol}, not ${route.protocol}`);
      return;
    }
    if (!modelAllowed) {
      fail(403, undefined, `key is not allowed to use model ${model}`);
      return;
    }

    const attempts = failCounts.get(key ?? "") ?? 0;
    failCounts.set(key ?? "", attempts + 1);
    const injected = keyConfig?.fail ?? (keyConfig?.failFirst && attempts < 1 ? keyConfig.failFirst : undefined);
    await sleep((config.latencyMs ?? 0) + (keyConfig?.latencyMs ?? 0));
    if (injected) {
      fail(injected.status, injected.type, injected.message);
      return;
    }

    const usage: Usage = {
      prompt: modelConfig.promptTokens ?? 12,
      completion: modelConfig.completionTokens ?? 8,
      cached: modelConfig.cachedTokens ?? 0,
    };
    const options = {
      model: modelConfig.reportAs ?? model,
      text: modelConfig.text ?? "fake upstream ok",
      usage,
      now: Date.now(),
    };

    entry.status = 200;
    if (stream) {
      const frames = streamFrames(route.protocol, options);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      let closed = false;
      req.on("close", () => {
        closed = true;
      });
      for (const frame of frames) {
        if (closed) break;
        const head = frame.event ? `event: ${frame.event}\n` : "";
        res.write(`${head}data: ${frame.data}\n\n`);
        await sleep(config.streamChunkDelayMs ?? 0);
      }
      res.end();
      return;
    }
    sendJson(res, 200, contentText(route.protocol, options));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port ?? 0, config.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake upstream: no tcp address");
  const url = `http://${config.host ?? "127.0.0.1"}:${address.port}`;

  return {
    url,
    port: address.port,
    requests,
    reset() {
      requests.length = 0;
      failCounts.clear();
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
