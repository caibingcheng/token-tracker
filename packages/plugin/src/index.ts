import { appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";

const API_ENDPOINT = process.env.TOKEN_TRACKER_ENDPOINT || "";
const API_KEY = process.env.TOKEN_TRACKER_API_KEY || "";

const id = "token-tracker-plugin";

// 日志文件路径
const logDir = join(homedir(), ".config", "opencode");
const logFile = join(logDir, "token-tracker.log");

function ensureLogDir() {
  try {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  } catch {
    // ignore
  }
}

function log(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    ensureLogDir();
    appendFileSync(logFile, line);
  } catch {
    // 如果文件写入失败，fallback 到 console
    console.log(line.trim());
  }
}

const tui: TuiPlugin = async (api) => {
  log("Plugin loaded");
  log(`Endpoint: ${API_ENDPOINT || "NOT SET"}`);
  log(`API Key: ${API_KEY ? "SET" : "NOT SET"}`);

  if (!API_ENDPOINT || !API_KEY) {
    log("ERROR: TOKEN_TRACKER_ENDPOINT or TOKEN_TRACKER_API_KEY not set, plugin disabled");
    return;
  }

  api.event.on("message.updated", (event) => {
    log(`Event received: ${event.type}`);

    const info = event.properties.info;
    log(`Message info: role=${info?.role}, hasTime=${!!(info as any)?.time}, completed=${(info as any)?.time?.completed}, hasTokens=${!!(info as any)?.tokens}`);

    if (!info || info.role !== "assistant") {
      log("Skipped: not assistant message");
      return;
    }

    const assistantInfo = info as any;
    if (!assistantInfo.time?.completed || !assistantInfo.tokens) {
      log("Skipped: no completed time or no tokens");
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

    log(`Reporting: ${JSON.stringify(payload)}`);

    fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
      },
      body: JSON.stringify(payload),
    }).then((res) => {
      log(`Response status: ${res.status}`);
      if (!res.ok) {
        res.text().then((text) => log(`ERROR: ${text}`));
      }
    }).catch((err) => {
      log(`ERROR: Failed to report: ${err.message}`);
    });
  });

  log("Event listener registered");
};

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
};

export default plugin;
