/**
 * 假上游（OpenAI / Anthropic / Gemini 三协议），供网关透传压测。
 * node bench/mock-upstream.mjs [port]
 *
 * 行为：按协议返回带 usage 的响应，支持流式；带小幅随机延迟模拟真实上游。
 */
import http from "node:http";

const PORT = Number(process.argv[2] || 18080);
const LATENCY_MS = Number(process.env.MOCK_LATENCY_MS || 25);

const stats = { requests: 0, byPath: {}, streaming: 0 };

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/** 约 2KB 的假文本，防止 mock 响应过小失真 */
function fakeText(n = 1800) {
  return "The quick brown fox jumps over the lazy dog. ".repeat(Math.ceil(n / 45)).slice(0, n);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  stats.requests++;
  stats.byPath[p] = (stats.byPath[p] || 0) + 1;

  if (req.method === "GET" && p === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] }));
    return;
  }

  const raw = await readBody(req);
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }
  const model = body.model || (p.match(/models\/([^:/]+)/) || [])[1] || "unknown";
  const streaming =
    body.stream === true ||
    (url.searchParams.get("alt") === "sse" && p.includes("streamGenerateContent"));

  await delay(LATENCY_MS + Math.floor(Math.random() * 30));

  // ---------------- OpenAI ----------------
  if (p === "/v1/chat/completions" || p === "/v1/responses" || p === "/v1/systemone") {
    const usage = {
      prompt_tokens: 1200 + Math.floor(Math.random() * 800),
      completion_tokens: 180 + Math.floor(Math.random() * 120),
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 600 },
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

    if (streaming) {
      stats.streaming++;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const text = fakeText();
      const parts = text.match(/[\s\S]{1,600}/g) || [];
      for (const part of parts) {
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-bench",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
          })}\n\n`
        );
      }
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-bench",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage,
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-bench",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          { index: 0, message: { role: "assistant", content: fakeText() }, finish_reason: "stop" },
        ],
        usage,
      })
    );
    return;
  }

  // ---------------- Anthropic ----------------
  if (p === "/v1/messages") {
    const usage = {
      input_tokens: 900 + Math.floor(Math.random() * 400),
      output_tokens: 140 + Math.floor(Math.random() * 100),
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 0,
    };
    if (streaming) {
      stats.streaming++;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { id: "msg_bench", type: "message", role: "assistant", model, content: [], usage },
        })}\n\n`
      );
      const text = fakeText();
      for (const part of text.match(/[\s\S]{1,600}/g) || []) {
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: part },
          })}\n\n`
        );
      }
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: usage.output_tokens },
        })}\n\n`
      );
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_bench",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: fakeText() }],
        stop_reason: "end_turn",
        usage,
      })
    );
    return;
  }

  // ---------------- Gemini ----------------
  if (p.includes(":generateContent") || p.includes(":streamGenerateContent")) {
    const usageMetadata = {
      promptTokenCount: 1100 + Math.floor(Math.random() * 500),
      candidatesTokenCount: 160 + Math.floor(Math.random() * 90),
      cachedContentTokenCount: 500,
    };
    const chunk = {
      candidates: [{ content: { parts: [{ text: fakeText() }], role: "model" }, finishReason: "STOP" }],
      usageMetadata,
    };
    if (streaming) {
      stats.streaming++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const text = fakeText();
      for (const part of text.match(/[\s\S]{1,600}/g) || []) {
        res.write(
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: part }], role: "model" } }],
          })}\n\n`
        );
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chunk));
    return;
  }

  // 探活兜底：任何未知路径返回 200 + 空 usage（避免探活把 upstream 标脏）
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, usage: { prompt_tokens: 1, completion_tokens: 1 } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-upstream] listening on http://127.0.0.1:${PORT} latency=${LATENCY_MS}ms`);
});

process.on("SIGTERM", () => {
  console.log(`[mock-upstream] stats ${JSON.stringify(stats)}`);
  server.close();
  process.exit(0);
});
