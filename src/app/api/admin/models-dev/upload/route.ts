import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import {
  uploadSnapshot,
  sanitizeModelsDevData,
  isValidModelsDevData,
  type ModelsDevData,
} from "@/lib/models-dev/snapshot";

// 手动上传 models.dev 快照（api.json 原文，或 {fetchedAt, data} 包装格式）。
// 安全：withAuth 会话认证 + body 上限 10MB + 规模上限 + sanitize（有限非负价格校验），
// 非法条目丢弃并返回 dropped 计数；上传后立即更新内存缓存 + 落盘，无需重启。
// 响应/审计不包含上传内容本身。

export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // api.json 现约 3.6MB
const MAX_PROVIDERS = 1000;
const MAX_MODELS = 50_000;

function countModelsDevModels(data: ModelsDevData): number {
  let total = 0;
  for (const provider of Object.values(data)) {
    total += Object.keys(provider?.models ?? {}).length;
  }
  return total;
}

export const POST = withAuth(async (request: NextRequest) => {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { success: false, error: "Upload too large (max 10MB)" },
      { status: 413 }
    );
  }

  const text = await request.text();
  if (text.length > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { success: false, error: "Upload too large (max 10MB)" },
      { status: 413 }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  // 格式识别：api.json 原文 / {fetchedAt, data} 快照包装格式（复用已下载的快照文件）
  let raw: unknown;
  if (isValidModelsDevData(parsed)) {
    raw = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    isValidModelsDevData((parsed as Record<string, unknown>).data)
  ) {
    raw = (parsed as Record<string, unknown>).data;
  } else {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid models.dev data: expected api.json or {fetchedAt, data} snapshot",
      },
      { status: 400 }
    );
  }

  const rawData = raw as ModelsDevData;
  const providerCount = Object.keys(rawData).length;
  if (providerCount > MAX_PROVIDERS || countModelsDevModels(rawData) > MAX_MODELS) {
    return NextResponse.json(
      { success: false, error: "Snapshot too large" },
      { status: 400 }
    );
  }

  const { data, dropped } = sanitizeModelsDevData(rawData);
  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { success: false, error: "Snapshot contains no valid models" },
      { status: 400 }
    );
  }

  const snapshot = uploadSnapshot(data);

  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "models_dev_upload",
    targetType: "system",
    ip,
    userAgent,
    details: {
      fetchedAt: snapshot.fetchedAt,
      providerCount: Object.keys(data).length,
      modelCount: countModelsDevModels(data),
      dropped,
    },
  });
  return NextResponse.json({
    success: true,
    data: { fetchedAt: snapshot.fetchedAt },
    dropped,
  });
});
