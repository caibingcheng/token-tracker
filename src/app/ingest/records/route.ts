import { NextRequest, NextResponse } from "next/server";
import { GatewaySecretMissingError } from "@/lib/gateway/crypto";
import { resolveIngestToken } from "@/lib/ingest/tokens";
import {
  validateIngestPayload,
  MAX_RECORDS_PER_BATCH,
  MAX_BODY_BYTES,
} from "@/lib/ingest/validate";
import { ingestRecords } from "@/lib/ingest/watermark";
import { getRateLimitKey } from "@/lib/net/client-ip";

// /ingest/records：多实例同步接收端点（位于 /api 之外，middleware matcher 天然不拦）。
// 认证：Authorization: Bearer it-xxx（全表解密比对）；限流 + body 上限 + 严格字段校验。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---- 固定窗口限流（与 status-query 同款模式，独立 bucket）----

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 60;
const ingestAttempts = new Map<string, number[]>();
let sweepCounter = 0;

function checkIngestRateLimit(key: string): boolean {
  const now = Date.now();
  sweepCounter++;
  if (sweepCounter % 64 === 0) {
    ingestAttempts.forEach((ts, k) => {
      if (ts.length === 0 || now - ts[ts.length - 1]! >= RATE_WINDOW_MS) {
        ingestAttempts.delete(k);
      }
    });
  }
  const timestamps = (ingestAttempts.get(key) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS
  );
  if (timestamps.length >= RATE_MAX_REQUESTS) {
    ingestAttempts.set(key, timestamps);
    return true;
  }
  timestamps.push(now);
  ingestAttempts.set(key, timestamps);
  return false;
}

function gatewaySecretError() {
  return NextResponse.json(
    { success: false, error: "GATEWAY_SECRET is not configured" },
    { status: 503 }
  );
}

// fire-and-forget 自动补价：只填空不覆盖，防抖每分钟最多一次，失败静默
let lastAutoFillAt = 0;
async function maybeAutoFill(models: string[]): Promise<void> {
  if (models.length === 0) return;
  const now = Date.now();
  if (now - lastAutoFillAt < 60_000) return;
  lastAutoFillAt = now;
  try {
    const { autoFillForModels } = await import("@/lib/model-prices-service");
    await autoFillForModels(models);
  } catch (err) {
    console.warn("[ingest] auto-fill skipped:", err);
  }
}

export async function POST(request: NextRequest) {
  const rateKey = getRateLimitKey(request);
  if (checkIngestRateLimit(rateKey)) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded" }, { status: 429 });
  }

  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let tokenInfo;
  try {
    tokenInfo = await resolveIngestToken(token);
  } catch (err) {
    if (err instanceof GatewaySecretMissingError) return gatewaySecretError();
    throw err;
  }
  if (!tokenInfo || !tokenInfo.enabled) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: `Body too large (max ${MAX_BODY_BYTES} bytes)` },
      { status: 413 }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const validated = validateIngestPayload(parsed);
  if (!validated.ok) {
    return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
  }
  const payload = validated.payload;
  if (payload.records.length > MAX_RECORDS_PER_BATCH) {
    return NextResponse.json(
      { success: false, error: `Too many records (max ${MAX_RECORDS_PER_BATCH} per batch)` },
      { status: 400 }
    );
  }

  try {
    const result = await ingestRecords(payload, {
      id: tokenInfo.id,
      boundInstance: tokenInfo.boundInstance,
    });

    if (result.status === "instance_mismatch") {
      return NextResponse.json(
        {
          success: false,
          error: "instance_mismatch",
          boundInstance: result.boundInstance,
        },
        { status: 403 }
      );
    }
    if (result.status === "token_disabled") {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    // 自动补价（best-effort，不阻塞响应）+ 失效模型行集缓存（推送后立即可在 Models 面板发现）
    const newModels = Array.from(
      new Set(payload.records.map((r) => r.model))
    );
    void maybeAutoFill(newModels);
    try {
      const { invalidateRemoteModelCache } = await import("@/lib/model-prices-service");
      invalidateRemoteModelCache();
    } catch {
      // 缓存失效失败不影响 ingest 主流程
    }

    return NextResponse.json({
      success: true,
      received: result.received,
      skipped: result.skipped,
      skippedInvalid: result.skippedInvalid,
      watermark: result.watermark,
      boundInstance: result.boundInstance,
    });
  } catch (err) {
    console.error("[ingest] write failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}