// 配额 in-flight 预留（进程内）。
//
// 为什么需要：配额检查读的是 token_records，而记录在**响应结束后**才写入（流式更晚，
// 长连接可能几分钟）。并发突发时所有请求都在写库前读到同一份旧用量 → maxRpm / maxTpm /
// 日 / 月限额可被并发绕过。转发前先做进程内预留，检查时把预留叠加到 DB 用量上，
// 请求真正结束（成功 / 失败 / 异常）时释放。
// 作用域：单进程部署（Hono bundle）下完备；多实例同步是离线推库（ingest），不共享配额状态。
// 预留只存 vk id 与估算 token 数，不存任何请求内容。

interface Reservation {
  tokens: number;
}

const inflight = new Map<number, Set<Reservation>>();

// 预留一次在途请求，返回幂等的释放函数
export function reserveInflight(virtualKeyId: number, tokens: number): () => void {
  const reservation: Reservation = { tokens: Math.max(0, Math.floor(tokens) || 0) };
  const bucket = inflight.get(virtualKeyId);
  if (bucket) bucket.add(reservation);
  else inflight.set(virtualKeyId, new Set([reservation]));

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = inflight.get(virtualKeyId);
    if (!current) return;
    current.delete(reservation);
    if (current.size === 0) inflight.delete(virtualKeyId);
  };
}

// 当前在途量（含刚预留的这一次）：rpm = 请求数，tokens = 估算 token 之和
export function getInflight(virtualKeyId: number): { rpm: number; tokens: number } {
  const bucket = inflight.get(virtualKeyId);
  if (!bucket || bucket.size === 0) return { rpm: 0, tokens: 0 };
  let tokens = 0;
  for (const reservation of bucket) tokens += reservation.tokens;
  return { rpm: bucket.size, tokens };
}
