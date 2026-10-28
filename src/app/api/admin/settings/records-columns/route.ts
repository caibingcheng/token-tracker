import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { getSetting, setSetting } from "@/lib/auth/settings";
import { parseRecordColumns, isValidRecordColumns } from "@/lib/records-columns";
import { withSkipCache } from "@/lib/db/cache";

// Records 表列可见性（settings 表 records_columns，明文 JSON 数组 = 可见列 id）
// 与 admin Display 面板无关：配置点就在 Records 页 Columns 下拉

export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  return withSkipCache(async () => {
    const columns = parseRecordColumns(await getSetting("records_columns"));
    return NextResponse.json({ success: true, data: { columns } });
  });
});

export const PUT = withAuth(async (request: NextRequest) => {
  return withSkipCache(async () => {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const columns = body.columns;
    if (!isValidRecordColumns(columns)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid columns: non-empty array of unique known column ids",
        },
        { status: 400 }
      );
    }

    await setSetting("records_columns", JSON.stringify(columns));
    return NextResponse.json({ success: true });
  });
});
