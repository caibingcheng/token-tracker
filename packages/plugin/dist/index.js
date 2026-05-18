const API_ENDPOINT = process.env.TOKEN_TRACKER_ENDPOINT || "";
const API_KEY = process.env.TOKEN_TRACKER_API_KEY || "";
const id = "token-tracker-plugin";
const tui = async (api) => {
    if (!API_ENDPOINT || !API_KEY) {
        console.warn("[TokenTracker] TOKEN_TRACKER_ENDPOINT or TOKEN_TRACKER_API_KEY not set, plugin disabled");
        return;
    }
    api.event.on("message.updated", (event) => {
        const info = event.properties.info;
        // 只处理 assistant 消息
        if (!info || info.role !== "assistant") {
            return;
        }
        // 只处理已完成且有 token 信息的消息
        if (!info.time?.completed || !info.tokens) {
            return;
        }
        // 构建上报数据（兼容 model/modelID 和 provider/providerID）
        const payload = {
            model: info.model || info.modelID || "unknown",
            provider: info.provider || info.providerID || "unknown",
            inputTokens: info.tokens.input || 0,
            outputTokens: info.tokens.output || 0,
            cacheRead: info.tokens.cache?.read || 0,
            cacheWrite: info.tokens.cache?.write || 0,
        };
        // 异步上报（不阻塞 UI）
        fetch(API_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": API_KEY,
            },
            body: JSON.stringify(payload),
        }).catch((err) => {
            console.error("[TokenTracker] Failed to report:", err.message);
        });
    });
};
const plugin = {
    id,
    tui,
};
export default plugin;
