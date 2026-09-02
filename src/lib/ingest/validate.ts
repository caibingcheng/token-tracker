// ingest payload 校验（纯逻辑，可单测）。
// 两类错误语义：
// - 结构性错误（非法 JSON、缺 instance/epoch、超上限）→ 整批 400
// - 单条记录校验失败 → 跳过该条，其余照常写入（skippedInvalid 携带 sourceRecordId）

export const INSTANCE_NAME_RE = /^[a-z0-9-]{1,32}$/;
export const INSTANCE_UID_RE = /^u-[a-f0-9]{32}$/;
export const MAX_RECORDS_PER_BATCH = 500;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_MODEL_LENGTH = 256;
export const MAX_NAME_LENGTH = 512;

// 远程来源命名空间保留前缀：本机 upstream / vk 名禁止以 remote/ 开头，
// 保证与 ingest 写入的 provider/agent（remote/{instance}/{原名}）命名空间干净隔离
export const REMOTE_NAME_PREFIX = "remote/";

export function isReservedRemoteName(name: string): boolean {
  return name.startsWith(REMOTE_NAME_PREFIX);
}

export interface IngestRecordPayload {
  sourceRecordId: number;
  model: string;
  provider: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  status: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  requestModel: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface IngestPayload {
  instanceUid: string; // B 端稳定身份键（TOFU/水位/级联删除的身份依据）
  instance: string; // 展示名（仅展示与 provider/agent 前缀编码）
  epoch: string;
  records: IngestRecordPayload[];
}

export interface ValidatedIngestPayload extends IngestPayload {
  skippedInvalid: number[];
}

export type ValidateIngestResult =
  | { ok: true; payload: ValidatedIngestPayload }
  | { ok: false; error: string };

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function isFiniteNonNull(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function isNull(value: unknown): value is null {
  return value === null;
}

export function isValidInstanceName(instance: string): boolean {
  return INSTANCE_NAME_RE.test(instance);
}

export function isValidInstanceUid(uid: string): boolean {
  return INSTANCE_UID_RE.test(uid);
}

// 单条记录校验：非法返回错误信息，合法返回归一化后的记录
function validateRecord(raw: unknown): IngestRecordPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  if (!Number.isInteger(r.sourceRecordId) || (r.sourceRecordId as number) <= 0) return null;
  if (typeof r.model !== "string" || r.model.length === 0 || r.model.length > MAX_MODEL_LENGTH) return null;
  if (typeof r.provider !== "string" || r.provider.length === 0 || r.provider.length > MAX_NAME_LENGTH) return null;
  if (typeof r.agent !== "string" || r.agent.length === 0 || r.agent.length > MAX_NAME_LENGTH) return null;

  for (const field of ["inputTokens", "outputTokens", "cacheRead", "cacheWrite"] as const) {
    if (!isFiniteNonNegative(r[field])) return null;
  }

  if (!(r.status === null || typeof r.status === "string")) return null;
  if (!(isNull(r.latencyMs) || isFiniteNonNull(r.latencyMs))) return null;
  if (!(isNull(r.ttftMs) || isFiniteNonNull(r.ttftMs))) return null;
  if (!(isNull(r.requestModel) || typeof r.requestModel === "string")) return null;
  if (!(isNull(r.userAgent) || typeof r.userAgent === "string")) return null;
  // 与 DB 落库口径一致：userAgent 截断 512
  const userAgent =
    typeof r.userAgent === "string" && r.userAgent.trim() !== ""
      ? r.userAgent.slice(0, 512)
      : null;

  const createdAt = r.createdAt;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return null;

  return {
    sourceRecordId: r.sourceRecordId as number,
    model: r.model as string,
    provider: r.provider as string,
    agent: r.agent as string,
    inputTokens: r.inputTokens as number,
    outputTokens: r.outputTokens as number,
    cacheRead: r.cacheRead as number,
    cacheWrite: r.cacheWrite as number,
    status: r.status as string | null,
    latencyMs: r.latencyMs === null ? null : (r.latencyMs as number),
    ttftMs: r.ttftMs === null ? null : (r.ttftMs as number),
    requestModel: r.requestModel === null ? null : (r.requestModel as string),
    userAgent,
    createdAt: createdAt as string,
  };
}

export function validateIngestPayload(body: unknown): ValidateIngestResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid JSON body" };
  }
  const b = body as Record<string, unknown>;

  const instanceUid = b.instanceUid;
  if (typeof instanceUid !== "string" || !INSTANCE_UID_RE.test(instanceUid)) {
    return { ok: false, error: "Invalid instanceUid (expected u-[a-f0-9]{32})" };
  }
  const instance = b.instance;
  if (typeof instance !== "string" || !INSTANCE_NAME_RE.test(instance)) {
    return { ok: false, error: "Invalid instance (expected [a-z0-9-]{1,32})" };
  }
  const epoch = b.epoch;
  if (typeof epoch !== "string" || epoch.length === 0 || epoch.length > 64) {
    return { ok: false, error: "Invalid epoch" };
  }
  if (!Array.isArray(b.records)) {
    return { ok: false, error: "records must be an array" };
  }
  if (b.records.length > MAX_RECORDS_PER_BATCH) {
    return { ok: false, error: `Too many records (max ${MAX_RECORDS_PER_BATCH} per batch)` };
  }
  if (b.records.length === 0) {
    return { ok: true, payload: { instanceUid, instance, epoch, records: [], skippedInvalid: [] } };
  }

  const records: IngestRecordPayload[] = [];
  const skippedInvalid: number[] = [];
  for (const raw of b.records) {
    const record = validateRecord(raw);
    if (record) {
      records.push(record);
    } else if (raw && typeof raw === "object" && Number.isInteger((raw as Record<string, unknown>).sourceRecordId)) {
      skippedInvalid.push((raw as Record<string, unknown>).sourceRecordId as number);
    } else {
      // 连 sourceRecordId 都没有的记录无法标识，静默跳过（不入 skippedInvalid 也无法计数，
      // 只能靠 received + 批量长度差异推断；此处直接忽略）
    }
  }

  return { ok: true, payload: { instanceUid, instance, epoch, records, skippedInvalid } };
}