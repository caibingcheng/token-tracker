import { eq } from "drizzle-orm";
import { db, upstreamsTable } from "@/lib/db";
import { parseClassifierModels, isClassifierKind, VALID_CLASSIFIER_KINDS } from "@/lib/gateway/classifier/types";
import type { ClassifierKind } from "@/lib/gateway/classifier/types";

export const MAX_INSTRUCTION_LENGTH = 2000;
export const MAX_DESCRIPTION_LENGTH = 512;

// priority：可选非负整数（缺省 0），非法返回 null
export function parsePriority(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

// 校验分类器种类 + 指向：kind='model' 要求 upstream 存在且已声明该模型为分类器
// （chat 类型还要求 openai 协议 upstream；priority 走占位 0/''）
export async function validateClassifier(input: {
  classifierKind: unknown;
  classifierUpstreamId: unknown;
  classifierModel: unknown;
}): Promise<
  | { ok: true; kind: ClassifierKind; upstreamId: number; model: string }
  | { ok: false; error: string }
> {
  const kind = input.classifierKind === undefined ? "priority" : input.classifierKind;
  if (!isClassifierKind(kind)) {
    return { ok: false, error: `Invalid classifierKind, must be one of: ${VALID_CLASSIFIER_KINDS.join(", ")}` };
  }
  if (kind === "priority") {
    return { ok: true, kind, upstreamId: 0, model: "" };
  }

  const upstreamId = Number(input.classifierUpstreamId);
  const model = typeof input.classifierModel === "string" ? input.classifierModel.trim() : "";
  if (!Number.isInteger(upstreamId) || upstreamId <= 0) {
    return { ok: false, error: "classifierUpstreamId is required" };
  }
  if (!model) return { ok: false, error: "classifierModel is required" };

  const upstream = (
    await db.select().from(upstreamsTable).where(eq(upstreamsTable.id, upstreamId))
  )[0];
  if (!upstream) return { ok: false, error: "Classifier upstream not found" };
  const entry = parseClassifierModels(upstream.classifierModels).find((e) => e.model === model);
  if (!entry) {
    return {
      ok: false,
      error: `Model "${model}" is not declared as a classifier on upstream "${upstream.name}"`,
    };
  }
  // chat 类型分类器的 wire format 是 openai chat completions：upstream 协议必须匹配
  if (entry.type === "chat" && upstream.protocol !== "openai") {
    return { ok: false, error: `Classifier type "chat" requires an openai-protocol upstream` };
  }
  return { ok: true, kind, upstreamId, model };
}
