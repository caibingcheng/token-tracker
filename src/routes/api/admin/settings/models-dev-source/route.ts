import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import {
  isValidModelsDevSource,
  loadModelsDevSource,
  setModelsDevSource,
  type ModelsDevSource,
} from "@/lib/auth/settings-models-dev-source";
import { readSnapshotFile } from "@/lib/models-dev/snapshot";

// 快照数据源开关（settings 表 models_dev_source）：
// GET 返回开关值 + 当前快照实际来源（过渡期可与开关不一致，供 UI 判断提示）；
// PUT 仅写开关不触发拉取，下次 Refresh / 懒刷新按新源。

export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  const source = await loadModelsDevSource();
  const snapshotSource = readSnapshotFile()?.source ?? null;
  return NextResponse.json({ success: true, data: { source, snapshotSource } });
});

export const PUT = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const source = body.source;
  if (!isValidModelsDevSource(source)) {
    return NextResponse.json(
      { success: false, error: "source must be 'models.dev' or 'github'" },
      { status: 400 }
    );
  }
  await setModelsDevSource(source as ModelsDevSource);
  return NextResponse.json({ success: true });
});
