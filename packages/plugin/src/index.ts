import { appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const API_ENDPOINT = process.env.TOKEN_TRACKER_ENDPOINT || "";
const API_KEY = process.env.TOKEN_TRACKER_API_KEY || "";

const LOG_DIR = join(homedir(), ".config", "opencode");
const LOG_FILE = join(LOG_DIR, "token-tracker.log");

function log(msg: string) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
        if (!existsSync(LOG_DIR)) {
            mkdirSync(LOG_DIR, { recursive: true });
        }
        appendFileSync(LOG_FILE, line);
    } catch (e) {
        console.log(line.trim());
    }
}

export const TokenTrackerPlugin = async function(_ref: any) {
    const client = _ref.client;
    
    log("Plugin loaded");
    log(`Endpoint: ${API_ENDPOINT || "NOT SET"}`);
    log(`API Key: ${API_KEY ? "SET" : "NOT SET"}`);
    
    if (!API_ENDPOINT || !API_KEY) {
        log("ERROR: TOKEN_TRACKER_ENDPOINT or TOKEN_TRACKER_API_KEY not set, plugin disabled");
        return {};
    }
    
    return {
        event: async function(_ref2: any) {
            const event = _ref2.event;
            
            try {
                if (event.type !== "message.updated") {
                    return;
                }
                
                log(`Event received: ${event.type}`);
                
                const info = event.properties && event.properties.info;
                log(`Message info: role=${info?.role}, hasTime=${!!info?.time}, completed=${info?.time?.completed}, hasTokens=${!!info?.tokens}`);
                
                if (!info || info.role !== "assistant") {
                    log("Skipped: not assistant message");
                    return;
                }
                
                if (!info.time || !info.time.completed || !info.tokens) {
                    log("Skipped: no completed time or no tokens");
                    return;
                }
                
                const payload = {
                    model: info.model || info.modelID || "unknown",
                    provider: info.provider || info.providerID || "unknown",
                    inputTokens: info.tokens.input || 0,
                    outputTokens: info.tokens.output || 0,
                    cacheRead: info.tokens.cache?.read || 0,
                    cacheWrite: info.tokens.cache?.write || 0,
                };
                
                log(`Reporting: ${JSON.stringify(payload)}`);
                
                const response = await fetch(API_ENDPOINT, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-API-Key": API_KEY,
                    },
                    body: JSON.stringify(payload),
                });
                
                log(`Response status: ${response.status}`);
                
                if (!response.ok) {
                    const text = await response.text();
                    log(`ERROR: ${text}`);
                }
            } catch (error: any) {
                log(`ERROR: ${error.message}`);
            }
        }
    };
};
