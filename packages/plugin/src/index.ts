import type { Plugin } from "@opencode-ai/plugin";

const API_ENDPOINT = process.env.TOKEN_TRACKER_ENDPOINT || "";
const API_KEY = process.env.TOKEN_TRACKER_API_KEY || "";

const plugin: Plugin = async ({ client }) => {
  if (!API_ENDPOINT || !API_KEY) {
    client.app.log({
      body: {
        service: "token-tracker",
        level: "warn",
        message: "Token Tracker plugin disabled: TOKEN_TRACKER_ENDPOINT or TOKEN_TRACKER_API_KEY not set",
      },
    });
    return {};
  }

  return {
    "message.updated": async ({ event }) => {
      const message = event.properties.info;

      // 只处理 assistant 消息
      if (!message || message.role !== "assistant") {
        return;
      }

      // 只处理已完成且有 token 信息的消息
      if (!message.time?.completed || !message.tokens) {
        return;
      }

      const payload = {
        model: message.model || "unknown",
        provider: message.provider || "unknown",
        inputTokens: message.tokens.input || 0,
        outputTokens: message.tokens.output || 0,
        cacheRead: message.tokens.cache?.read || 0,
        cacheWrite: message.tokens.cache?.write || 0,
      };

      try {
        const response = await fetch(API_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const error = await response.text();
          client.app.log({
            body: {
              service: "token-tracker",
              level: "error",
              message: `Failed to report token usage: ${error}`,
            },
          });
        }
      } catch (error) {
        client.app.log({
          body: {
            service: "token-tracker",
            level: "error",
            message: `Token Tracker network error: ${(error as Error).message}`,
          },
        });
      }
    },
  };
};

export default plugin;
