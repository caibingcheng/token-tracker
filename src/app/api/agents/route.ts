import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import { withAuth } from "@/lib/auth/guard";
import { loadHiddenSources } from "@/lib/auth/settings";

export const dynamic = "force-dynamic";

const UNKNOWN_AGENT = "unknown";
const UNKNOWN_DISPLAY = "(unknown)";

export const GET = withAuth(async (request: NextRequest) => {
  await initDatabase();
  try {
    const { searchParams } = new URL(request.url);
    const includeHidden = searchParams.get("includeHidden") === "1";

    const hiddenSources = includeHidden ? null : await loadHiddenSources();
    const hiddenAgents = new Set(hiddenSources?.virtualKeys ?? []);

    const rows = await db
      .selectDistinct({
        agent: tokenRecords.agent,
      })
      .from(tokenRecords);

    const allAgents: string[] = rows
      .map((row: any) => row.agent)
      .filter((name: any): name is string => name !== null && name !== undefined);

    allAgents.sort((a, b) => a.localeCompare(b));

    const data = allAgents
      .filter((agent) => (includeHidden ? true : !hiddenAgents.has(agent)))
      .map((agent) => ({
        id: agent,
        name: agent === UNKNOWN_AGENT ? UNKNOWN_DISPLAY : agent,
      }));

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching agents:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch agents",
      },
      { status: 500 }
    );
  }
});
