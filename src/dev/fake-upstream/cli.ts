// 独立进程入口：npm run fake-upstream [-- --config fake-upstream.json] [--port 4010]
// 配置来源优先级：--config > FAKE_UPSTREAM_CONFIG > 内置默认（三协议各 2 个 model + 6 个 key）。
// 内置默认里刻意留了「固定 401 的 key」和「第一次 503 的 key」，用来手动验证 key 轮换/failover。
// 注意：本文件不能用 top-level await（package.json 无 "type":"module"，tsx 按 CJS 转译）。
import { readFileSync } from "node:fs";
import { createFakeUpstream } from "./server";
import type { FakeUpstreamConfig } from "./types";

const DEFAULT_CONFIG: FakeUpstreamConfig = {
  port: 4010,
  host: "127.0.0.1",
  models: {
    "gpt-4o-mini": { protocol: "openai", promptTokens: 12, completionTokens: 8 },
    "gpt-4o": { protocol: "openai", promptTokens: 40, completionTokens: 20 },
    "gpt-5-codex": { protocol: "responses", promptTokens: 30, completionTokens: 15 },
    "claude-sonnet-4": { protocol: "anthropic", promptTokens: 24, completionTokens: 11, cachedTokens: 64 },
    "claude-3-5-haiku": { protocol: "anthropic", promptTokens: 10, completionTokens: 5 },
    "gemini-2.0-flash": { protocol: "gemini", promptTokens: 18, completionTokens: 9 },
    "gemini-2.5-pro": { protocol: "gemini", promptTokens: 50, completionTokens: 25, cachedTokens: 128 },
  },
  keys: [
    { key: "sk-fake-openai", protocols: ["openai", "responses"] },
    { key: "sk-fake-anthropic", protocols: ["anthropic"] },
    { key: "sk-fake-gemini", protocols: ["gemini"] },
    { key: "sk-fake-limited", models: ["gpt-4o-mini"] },
    { key: "sk-fake-revoked", fail: { status: 401, message: "invalid api key" } },
    { key: "sk-fake-flaky", failFirst: { status: 503, message: "temporarily overloaded" } },
  ],
};

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

function loadConfig(argv: string[]): FakeUpstreamConfig {
  const file = flag(argv, "config") || process.env.FAKE_UPSTREAM_CONFIG;
  let config: FakeUpstreamConfig = DEFAULT_CONFIG;
  if (file) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as FakeUpstreamConfig;
    // 配置文件只覆盖它写了的字段（models/keys 整体替换）
    config = { ...DEFAULT_CONFIG, ...parsed };
  }
  const port = flag(argv, "port") || process.env.FAKE_UPSTREAM_PORT;
  const host = flag(argv, "host") || process.env.FAKE_UPSTREAM_HOST;
  if (port) config = { ...config, port: Number(port) };
  if (host) config = { ...config, host };
  if (!Number.isInteger(config.port) || (config.port ?? 0) < 0) {
    throw new Error(`invalid port: ${String(config.port)}`);
  }
  if (Object.keys(config.models ?? {}).length === 0) throw new Error("config.models is empty");
  return config;
}

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2));
  const upstream = await createFakeUpstream(config);

  const byProtocol = (protocol: string) =>
    Object.entries(config.models)
      .filter(([, model]) => (model.protocol ?? "openai") === protocol)
      .map(([id]) => id);

  console.log(`fake upstream listening on ${upstream.url}`);
  console.log(`  openai     POST /v1/chat/completions            models: ${byProtocol("openai").join(", ") || "-"}`);
  console.log(`  responses  POST /v1/responses                   models: ${byProtocol("responses").join(", ") || "-"}`);
  console.log(`  anthropic  POST /v1/messages                    models: ${byProtocol("anthropic").join(", ") || "-"}`);
  console.log(`  gemini     POST /v1beta/models/<model>:generateContent  models: ${byProtocol("gemini").join(", ") || "-"}`);
  console.log(`  models     GET  /v1/models  GET /v1beta/models`);
  if (config.keys.length === 0) console.log("  keys       (none configured — auth is disabled, any key accepted)");
  for (const key of config.keys) {
    const scope = [
      key.protocols ? `protocols=${key.protocols.join("|")}` : null,
      key.models ? `models=${Array.isArray(key.models) ? key.models.join("|") : key.models}` : null,
      key.fail ? `always ${key.fail.status}` : null,
      key.failFirst ? `first 1x ${key.failFirst.status}` : null,
    ].filter(Boolean);
    console.log(`  key        ${key.key}${scope.length ? `  (${scope.join(", ")})` : ""}`);
  }
  console.log(`  log        GET ${upstream.url}/__fake/requests    reset: POST ${upstream.url}/__fake/reset`);
  console.log("");
  console.log("example:");
  console.log(
    `  curl -s ${upstream.url}/v1/chat/completions -H 'authorization: Bearer sk-fake-openai' -H 'content-type: application/json' \\\n    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'`
  );
  console.log(
    `  curl -s ${upstream.url}/v1/messages -H 'x-api-key: sk-fake-anthropic' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \\\n    -d '{"model":"claude-sonnet-4","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}'`
  );
  console.log(
    `  curl -s '${upstream.url}/v1beta/models/gemini-2.0-flash:generateContent?alt=sse' -H 'x-goog-api-key: sk-fake-gemini' -H 'content-type: application/json' \\\n    -d '{"contents":[{"parts":[{"text":"hi"}]}]}'`
  );
  console.log("");
  console.log(`point an upstream baseUrl at ${upstream.url} (and set the matching key) to test the gateway/relay.`);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} received, closing fake upstream`);
    void upstream.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
