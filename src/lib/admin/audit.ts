import { db, initDatabase, adminAuditLogsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { resolveClientIp, getXForwardedForRaw } from "@/lib/net/client-ip";

export type AuditAction =
  | "setup_admin_key"
  | "login_success"
  | "login_failure"
  | "api_key_changed"
  | "sessions_revoked"
  | "totp_enabled"
  | "totp_changed"
  | "totp_disabled"
  | "recovery_codes_regenerated"
  | "upstream_created"
  | "upstream_updated"
  | "upstream_deleted"
  | "virtual_key_created"
  | "virtual_key_updated"
  | "virtual_key_deleted"
  | "upstream_key_created"
  | "upstream_key_updated"
  | "upstream_key_deleted"
  | "routing_rule_created"
  | "routing_rule_updated"
  | "routing_rule_deleted"
  | "model_price_updated"
  | "model_price_deleted"
  | "model_price_selected"
  | "model_price_auto_fill"
  | "models_dev_refresh"
  | "models_dev_upload"
  | "model_aliases_updated";

export type AuditTargetType =
  | "upstream"
  | "virtual_key"
  | "upstream_key"
  | "routing_rule"
  | "system";

export interface AuditLogInput {
  action: AuditAction;
  actor?: string | null;
  targetType?: AuditTargetType;
  targetId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
}

// 审计埋点：写入失败吞异常并 console.error，不得阻断业务主流程
export async function recordAuditLog(input: AuditLogInput): Promise<void> {
  try {
    await initDatabase();
    await withSkipCache(async () => {
      await db.insert(adminAuditLogsTable).values({
        action: input.action,
        actor: input.actor ?? "admin",
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        details: input.details != null ? JSON.stringify(input.details) : null,
      });
    });
  } catch (err) {
    console.error(`[audit] failed to record ${input.action}:`, err);
  }
}

// 提取客户端信息：IP 只取可信源（resolveClientIp，防 XFF 伪造）；
// xffRaw 保留原始头全文仅供审计展示；user-agent 空值归一 null，截断 512 字符
export function extractClientInfo(request: Request): {
  ip: string;
  userAgent: string | null;
  xffRaw: string | null;
} {
  const ip = resolveClientIp(request) ?? "unknown";
  const xffRaw = getXForwardedForRaw(request);
  const rawUA = request.headers.get("user-agent");
  const userAgent = rawUA && rawUA.trim() !== "" ? rawUA.slice(0, 512) : null;
  return { ip, userAgent, xffRaw };
}
