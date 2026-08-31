import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import {
  refreshSnapshot,
  LITELLM_MODEL_PRICES_URL,
  type ModelsDevFetchError,
  type ModelsDevSource,
} from "@/lib/models-dev/snapshot";
import { loadModelsDevSource } from "@/lib/auth/settings-models-dev-source";

// 强制刷新快照（models.dev / GitHub LiteLLM 双源，按设置开关）：
// 拉取失败回退旧快照，按失败分类返回错误文案供 UI 提示。

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<ModelsDevSource, string> = {
  "models.dev": "models.dev",
  github: "LiteLLM model prices",
};

function sourceHint(source: ModelsDevSource): string {
  return source === "github"
    ? `make sure the server can reach ${LITELLM_MODEL_PRICES_URL} — use Upload… to apply a snapshot file as a workaround`
    : "make sure the server can reach https://models.dev/api.json — use Upload… to apply a snapshot file as a workaround";
}

function describeRefreshError(
  error: ModelsDevFetchError,
  source: ModelsDevSource
): string {
  const label = SOURCE_LABEL[source];
  switch (error.kind) {
    case "network":
      return `Failed to fetch ${label} data: network error (${sourceHint(source)})`;
    case "http":
      return `Failed to fetch ${label} data: upstream responded with HTTP ${error.status ?? "unknown status"} — use Upload… to apply a snapshot file as a workaround`;
    case "invalid":
      return `Failed to fetch ${label} data: invalid response shape — use Upload… to apply a snapshot file as a workaround`;
  }
}

export const POST = withAuth(async (request: NextRequest) => {
  const source = await loadModelsDevSource();
  const result = await refreshSnapshot({ source });
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: describeRefreshError(result.error, source) },
      { status: 502 }
    );
  }
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "models_dev_refresh",
    targetType: "system",
    ip,
    userAgent,
    details: { fetchedAt: result.snapshot.fetchedAt, source },
  });
  return NextResponse.json({ success: true, data: { fetchedAt: result.snapshot.fetchedAt, source } });
});
