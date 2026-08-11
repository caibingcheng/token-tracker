import { notFound } from "next/navigation";
import { getStatusPageConfig } from "@/lib/auth/settings";
import StatusPage from "@/components/StatusPage";

// /status 公开页（无需登录）。fail-closed：settings 未启用时返回 404。
// force-dynamic：禁止构建期预渲染，避免把 enabled/disabled 决策烘焙进构建产物。

export const dynamic = "force-dynamic";

export default async function StatusPageRoute() {
  const config = await getStatusPageConfig();
  if (!config.enabled) {
    notFound();
  }
  return <StatusPage />;
}
