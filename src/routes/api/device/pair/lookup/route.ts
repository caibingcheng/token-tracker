// 配对码查看（会话 token 保护）：授权前的身份确认 —— 管理员必须看到 name / fingerprint / IP
// 才能判断「这个码背后是不是自己那台机器」。**不消费码**、不改状态。
// 路径在 pair/ 下但属于会话态接口（不是 withDeviceAuth）。
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import {
  readJsonBodyLimited,
  BodyTooLargeError,
  InvalidJsonBodyError,
} from "@/lib/auth/request-body";
import { lookupPairing } from "@/lib/device/store";

export const POST = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBodyLimited(request);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json({ success: false, error: "Request body too large" }, { status: 413 });
    }
    if (err instanceof InvalidJsonBodyError) {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }
    throw err;
  }
  const code = typeof body.code === "string" ? body.code : "";
  const pairing = await lookupPairing(code);
  if (!pairing) {
    return NextResponse.json(
      { success: false, error: "Unknown or expired pairing code" },
      { status: 404 }
    );
  }
  return NextResponse.json({ success: true, data: pairing });
});
