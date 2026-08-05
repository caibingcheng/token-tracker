import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import { withAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (_request: NextRequest) => {
  await initDatabase();
  try {
    const rows = await db
      .selectDistinct({
        agent: tokenRecords.agent,
      })
      .from(tokenRecords);

    const allAgents: string[] = rows
      .map((row: any) => row.agent)
      .filter((name: any): name is string => name !== null && name !== undefined);

    allAgents.sort((a, b) => a.localeCompare(b));

    const data = allAgents.map((agent) => ({
      id: agent,
      name: agent,
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
