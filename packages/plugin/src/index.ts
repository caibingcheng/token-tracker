import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";

const API_ENDPOINT = process.env.TOKEN_TRACKER_ENDPOINT || "";
const API_KEY = process.env.TOKEN_TRACKER_API_KEY || "";

const id = "token-tracker-plugin";

const tui: TuiPlugin = async (api) => {
  console.log("[TokenTracker] Plugin loaded");
  console.log("[TokenTracker] Endpoint:", API_ENDPOINT || "NOT SET");
  console.log("[TokenTracker] API Key:", API_KEY ? "SET" : "NOT SET");

  if (!API_ENDPOINT || !API_KEY) {
    console.warn("[TokenTracker] TOKEN_TRACKER_ENDPOINT or TOKEN_TRACKER_API_KEY not set, plugin disabled");
    return;
  }

  api.event.on("message.updated", (event) => {
    console.log("[TokenTracker] Event received:", event.type);
    
    const info = event.properties.info;
    console.log("[TokenTracker] Message info:", {
      role: info?.role,
      hasTime: !!(info as any)?.time,
      completed: (info as any)?.time?.completed,
      hasTokens: !!(info as any)?.tokens,
    });

    if (!info || info.role !== "assistant") {
      console.log("[TokenTracker] Skipped: not assistant message");
      return;
    }

    const assistantInfo = info as any;
    if (!assistantInfo.time?.completed || !assistantInfo.tokens) {
      console.log("[TokenTracker] Skipped: no completed time or no tokens");
      return;
    }

    const payload = {
      model: assistantInfo.model || assistantInfo.modelID || "unknown",
      provider: assistantInfo.provider || assistantInfo.providerID || "unknown",
      inputTokens: assistantInfo.tokens.input || 0,
      outputTokens: assistantInfo.tokens.output || 0,
      cacheRead: assistantInfo.tokens.cache?.read || 0,
      cacheWrite: assistantInfo.tokens.cache?.write || 0,
    };

    console.log("[TokenTracker] Reporting:", payload);

    fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
      },
      body: JSON.stringify(payload),
    }).then((res) => {
      console.log("[TokenTracker] Response status:", res.status);
      if (!res.ok) {
        res.text().then((text) => console.error("[TokenTracker] Error:", text));
      }
    }).catch((err) => {
      console.error("[TokenTracker] Failed to report:", err.message);
    });
  });

  console.log("[TokenTracker] Event listener registered");
};

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
};

export default plugin;
