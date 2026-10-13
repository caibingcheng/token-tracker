"use client";

// Named Routes 管理：一个命名路由 = 虚拟名 + 协议 → 目标池（多目标 failover 链）+ 可选分类器。
// classifierKind='priority' = 无 LLM 分类器（链首 = 首个健康目标，按 priority，零 LLM 开销）；
// 'model' = LLM 分类器从目标池选链首（每 session 一次）。与同名自动路由互斥：命名路由完全替代它。
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import type { Protocol } from "@/lib/gateway/model-router";
import { CopyableCode } from "./CopyableCode";
import {
  AdminMobileCard,
  AdminMobileCards,
  AdminTable,
  AdminTableBody,
  AdminTableCard,
  AdminTableEmptyRow,
  AdminTableHead,
  AdminTd,
} from "./table";

interface TargetRow {
  id: number;
  upstreamId: number;
  upstreamName: string;
  upstreamProtocol: Protocol;
  targetModel: string;
  description: string | null;
  priority: number;
}

interface NamedRouteRow {
  id: number;
  name: string;
  protocol: Protocol;
  instruction: string;
  classifierUpstreamId: number;
  classifierUpstreamName: string;
  classifierModel: string;
  classifierKind: "model" | "priority";
  enabled: boolean;
  targets: TargetRow[];
  createdAt: string;
}

// 规则分类器选项的内置 key（非 upstream:classifierModel 格式）
const RULE_CLASSIFIER_KEY = "rule:priority";

interface ClassifierOption {
  upstreamId: number;
  upstreamName: string;
  model: string;
  type: string;
  maxInputTokens?: number;
}

interface UpstreamRow {
  id: number;
  name: string;
  protocol: Protocol;
  enabled: boolean;
  classifierModels: { model: string; type: string; maxInputTokens?: number }[];
  enabledModels?: string[];
}

interface RouteTargetOption {
  upstreamId: number;
  upstreamName: string;
  upstreamProtocol: Protocol;
  model: string;
}

const protocolBadgeClass = (protocol: Protocol): string =>
  protocol === "openai"
    ? "border-gray-200 text-gray-600"
    : protocol === "anthropic"
      ? "border-orange-200 text-orange-600"
      : "border-blue-200 text-blue-600";

export default function NamedRoutesPanel({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<NamedRouteRow[]>([]);
  const [classifierOptions, setClassifierOptions] = useState<ClassifierOption[]>([]);
  const [routeTargets, setRouteTargets] = useState<RouteTargetOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("openai");
  const [instruction, setInstruction] = useState("");
  const [classifierKey, setClassifierKey] = useState(RULE_CLASSIFIER_KEY);
  const [submitting, setSubmitting] = useState(false);
  // 新建时可一并给出首个目标（无分类器命名路由的一步到位路径）
  const [firstUpstreamId, setFirstUpstreamId] = useState<number | "">("");
  const [firstModel, setFirstModel] = useState("");
  const [firstDescription, setFirstDescription] = useState("");
  const [firstPriority, setFirstPriority] = useState("0");

  const [busyId, setBusyId] = useState<number | null>(null);
  const [editingInstructionId, setEditingInstructionId] = useState<number | null>(null);
  const [instructionDraft, setInstructionDraft] = useState("");
  const [expandedRouteId, setExpandedRouteId] = useState<number | null>(null);
  const [editingTarget, setEditingTarget] = useState<{
    id: number;
    targetModel: string;
    description: string;
    priority: string;
  } | null>(null);

  // 新增目标表单（属于 expandedRouteId 指向的路由）
  const [targetUpstreamId, setTargetUpstreamId] = useState<number | "">("");
  const [targetModel, setTargetModel] = useState("");
  const [targetDescription, setTargetDescription] = useState("");
  const [targetPriority, setTargetPriority] = useState("0");
  const [addingTarget, setAddingTarget] = useState(false);

  const load = useCallback(async () => {
    try {
      const [routeRes, upRes] = await Promise.all([
        apiFetch("/api/admin/named-routes"),
        apiFetch("/api/admin/upstreams"),
      ]);
      const routeJson = await routeRes.json();
      const upJson = await upRes.json();
      if (routeJson.success) setRows(routeJson.data);
      if (upJson.success) {
        const ups = upJson.data as UpstreamRow[];
        const classifiers: ClassifierOption[] = [];
        const targets: RouteTargetOption[] = [];
        for (const u of ups) {
          if (!u.enabled) continue;
          for (const cm of u.classifierModels ?? []) {
            classifiers.push({
              upstreamId: u.id,
              upstreamName: u.name,
              model: cm.model,
              type: cm.type,
              maxInputTokens: cm.maxInputTokens,
            });
          }
          for (const m of u.enabledModels ?? []) {
            if (m.endsWith("*")) continue;
            targets.push({ upstreamId: u.id, upstreamName: u.name, upstreamProtocol: u.protocol, model: m });
          }
        }
        setClassifierOptions(classifiers);
        setRouteTargets(targets);
      }
      setError(null);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selectedClassifier = useMemo(
    () => classifierOptions.find((o) => `${o.upstreamId}:${o.model}` === classifierKey) ?? null,
    [classifierOptions, classifierKey]
  );
  const isRuleClassifier = classifierKey === RULE_CLASSIFIER_KEY;

  const upstreamOptionsForProtocol = (proto: Protocol) =>
    Array.from(
      new Map(
        routeTargets.filter((t) => t.upstreamProtocol === proto).map((t) => [t.upstreamId, t])
      ).values()
    );

  const modelCandidatesFor = (upstreamId: number | ""): string[] =>
    upstreamId === "" ? [] : routeTargets.filter((t) => t.upstreamId === upstreamId).map((t) => t.model);

  // 写操作成功后联动父级（ModelsPanel 的路由表/模拟器数据源）
  const reload = async () => {
    await load();
    onChanged?.();
  };

  const createRoute = async () => {
    if (!name.trim() || (!isRuleClassifier && !selectedClassifier)) return;
    if (firstUpstreamId !== "" && !firstModel.trim()) {
      setError("Target model is required when a provider is selected");
      return;
    }
    if (firstUpstreamId === "" && firstModel.trim()) {
      setError("Select a provider for the target model");
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        protocol,
        instruction: isRuleClassifier ? "" : instruction.trim(),
        classifierKind: isRuleClassifier ? "priority" : "model",
        ...(isRuleClassifier
          ? {}
          : {
              classifierUpstreamId: selectedClassifier!.upstreamId,
              classifierModel: selectedClassifier!.model,
            }),
      };
      if (firstUpstreamId !== "" && firstModel.trim()) {
        payload.target = {
          upstreamId: firstUpstreamId,
          targetModel: firstModel.trim(),
          description: firstDescription.trim() || undefined,
          priority: firstPriority.trim() === "" ? 0 : Number(firstPriority),
        };
      }
      const res = await apiFetch("/api/admin/named-routes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) {
        setName("");
        setInstruction("");
        setClassifierKey(RULE_CLASSIFIER_KEY);
        setFirstUpstreamId("");
        setFirstModel("");
        setFirstDescription("");
        setFirstPriority("0");
        await reload();
      } else {
        setError(json.error || "Failed to create named route");
      }
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const patchRoute = async (id: number, payload: Record<string, unknown>) => {
    setBusyId(id);
    try {
      const res = await apiFetch(`/api/admin/named-routes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) await reload();
      else setError(json.error || "Failed to update named route");
    } catch {
      setError("Network error");
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = (row: NamedRouteRow) => patchRoute(row.id, { enabled: !row.enabled });

  const saveInstruction = (row: NamedRouteRow) =>
    patchRoute(row.id, { instruction: instructionDraft }).then(() => setEditingInstructionId(null));

  const deleteRoute = async (row: NamedRouteRow) => {
    if (!window.confirm(`Delete named route "${row.name}" (${row.protocol}) and its targets?`)) return;
    try {
      const res = await apiFetch(`/api/admin/named-routes/${row.id}`, { method: "DELETE" });
      const json = await res.json();
      if (json.success) await reload();
      else setError(json.error || "Failed to delete named route");
    } catch {
      setError("Network error");
    }
  };

  const addTarget = async (row: NamedRouteRow) => {
    if (targetUpstreamId === "" || !targetModel.trim()) return;
    setAddingTarget(true);
    try {
      const res = await apiFetch(`/api/admin/named-routes/${row.id}/targets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          upstreamId: targetUpstreamId,
          targetModel: targetModel.trim(),
          description: targetDescription.trim() || undefined,
          priority: targetPriority.trim() === "" ? 0 : Number(targetPriority),
        }),
      });
      const json = await res.json();
      if (json.success) {
        setTargetUpstreamId("");
        setTargetModel("");
        setTargetDescription("");
        setTargetPriority("0");
        await reload();
      } else {
        setError(json.error || "Failed to add target");
      }
    } catch {
      setError("Network error");
    } finally {
      setAddingTarget(false);
    }
  };

  const saveTarget = async (row: NamedRouteRow) => {
    if (!editingTarget) return;
    const priority = Number(editingTarget.priority);
    if (!Number.isInteger(priority) || priority < 0) {
      setError("Priority must be a non-negative integer");
      return;
    }
    if (!editingTarget.targetModel.trim()) {
      setError("Target model cannot be empty");
      return;
    }
    setBusyId(editingTarget.id);
    try {
      const res = await apiFetch(`/api/admin/named-routes/${row.id}/targets/${editingTarget.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetModel: editingTarget.targetModel.trim(),
          description: editingTarget.description.trim() || null,
          priority,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setEditingTarget(null);
        await reload();
      } else {
        setError(json.error || "Failed to update target");
      }
    } catch {
      setError("Network error");
    } finally {
      setBusyId(null);
    }
  };

  const deleteTarget = async (row: NamedRouteRow, target: TargetRow) => {
    if (!window.confirm(`Delete target ${target.upstreamName} → ${target.targetModel}?`)) return;
    try {
      const res = await apiFetch(`/api/admin/named-routes/${row.id}/targets/${target.id}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (json.success) await reload();
      else setError(json.error || "Failed to delete target");
    } catch {
      setError("Network error");
    }
  };

  const toggleExpanded = (id: number) => {
    setExpandedRouteId((prev) => (prev === id ? null : id));
    setEditingTarget(null);
    setTargetUpstreamId("");
    setTargetModel("");
    setTargetDescription("");
    setTargetPriority("0");
  };

  const targetActions = (row: NamedRouteRow, target: TargetRow, compact: boolean) => {
    const editing = editingTarget?.id === target.id;
    const btn = compact
      ? "min-h-[40px] rounded border px-3 py-1.5 text-xs"
      : "text-xs";
    if (editing) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => saveTarget(row)}
            disabled={busyId === target.id}
            className={compact ? `${btn} border-blue-200 bg-blue-50 text-blue-600 disabled:opacity-50` : `${btn} font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50`}
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditingTarget(null)}
            className={compact ? `${btn} border-gray-200 text-gray-500` : `${btn} text-gray-500 hover:text-gray-700`}
          >
            Cancel
          </button>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            setEditingTarget({
              id: target.id,
              targetModel: target.targetModel,
              description: target.description ?? "",
              priority: String(target.priority),
            })
          }
          className={compact ? `${btn} border-gray-200 text-gray-600` : `${btn} text-gray-600 hover:text-gray-800`}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => deleteTarget(row, target)}
          className={compact ? `${btn} border-red-200 text-red-500` : `${btn} text-red-500 hover:text-red-700`}
        >
          Delete
        </button>
      </div>
    );
  };

  return (
    <AdminTableCard
      title={<h2 className="text-base font-semibold">Named Routes</h2>}
      actions={
        <p className="text-xs text-gray-400">
          A named route maps a client-requested model name to a pool of upstream targets. Without an LLM
          classifier the chain head is the first healthy target by priority; with one, the classifier picks
          the chain head once per session. A same-name automatic route is fully overridden.
        </p>
      }
    >
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {/* 新建命名路由 */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.4fr_110px_1.6fr]">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Route Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Virtual name clients request (e.g. cheap / precise)"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Protocol</label>
          <select
            value={protocol}
            onChange={(e) => {
              setProtocol(e.target.value as Protocol);
              setFirstUpstreamId("");
              setFirstModel("");
            }}
            className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
            <option value="gemini">gemini</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Classifier</label>
          <select
            value={classifierKey}
            onChange={(e) => setClassifierKey(e.target.value)}
            className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value={RULE_CLASSIFIER_KEY}>Rule — priority &amp; availability (no LLM)</option>
            {classifierOptions.map((o) => (
              <option key={`${o.upstreamId}:${o.model}`} value={`${o.upstreamId}:${o.model}`}>
                {o.upstreamName} / {o.model} ({o.type}
                {o.maxInputTokens ? `, ≤${o.maxInputTokens}` : ""})
              </option>
            ))}
          </select>
          {classifierOptions.length === 0 && (
            <p className="mt-1 text-[11px] text-gray-400">
              No LLM classifiers declared (optional — the rule classifier needs none).
            </p>
          )}
        </div>
      </div>

      <div className="mt-3">
        <label className="mb-1 block text-xs font-medium text-gray-700">
          Instruction{" "}
          <span className="font-normal text-gray-400">(decision prompt for the LLM classifier)</span>
        </label>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={2}
          disabled={isRuleClassifier}
          placeholder="e.g. Route simple, low-stakes requests to the cheap tier; complex reasoning or long-context tasks to the precise tier."
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400"
        />
      </div>

      {/* 首个目标（可选，与路由同建） */}
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_1.6fr_80px_auto]">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">
            First Target Provider <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <select
            value={firstUpstreamId}
            onChange={(e) => {
              setFirstUpstreamId(e.target.value === "" ? "" : Number(e.target.value));
              setFirstModel("");
            }}
            className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">Select upstream…</option>
            {upstreamOptionsForProtocol(protocol).map((t) => (
              <option key={t.upstreamId} value={t.upstreamId}>
                {t.upstreamName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Target Model</label>
          <input
            value={firstModel}
            onChange={(e) => setFirstModel(e.target.value)}
            placeholder="Real model on upstream"
            list="named-route-first-models"
            disabled={firstUpstreamId === ""}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
          <datalist id="named-route-first-models">
            {modelCandidatesFor(firstUpstreamId).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">
            Description <span className="font-normal text-gray-400">(for the classifier)</span>
          </label>
          <input
            value={firstDescription}
            onChange={(e) => setFirstDescription(e.target.value)}
            placeholder="e.g. cheap tier, simple Q&A"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Priority</label>
          <input
            value={firstPriority}
            onChange={(e) => setFirstPriority(e.target.value)}
            type="number"
            min={0}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={createRoute}
            disabled={!name.trim() || (!isRuleClassifier && !selectedClassifier) || submitting}
            className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 md:w-auto"
          >
            {submitting ? "Adding…" : "Add Route"}
          </button>
        </div>
      </div>

      {/* 列表：桌面 table + 移动端卡片 */}
      {loading ? (
        <p className="mt-4 text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="mt-4 space-y-3">
          {rows.length === 0 && <p className="text-sm text-gray-400">No named routes</p>}
          {rows.map((row) => (
            <div key={row.id} className="rounded-lg border border-gray-200">
              {/* 概要行：点击整行展开/折叠（与 ModelsPanel 路由表交互一致），行内按钮 stopPropagation */}
              <div
                className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 hover:bg-gray-50"
                onClick={() => toggleExpanded(row.id)}
              >
                <CopyableCode className="text-xs font-medium">{row.name}</CopyableCode>
                <span className={`rounded border px-1.5 py-0.5 text-[10px] ${protocolBadgeClass(row.protocol)}`}>
                  {row.protocol}
                </span>
                {row.classifierKind === "priority" ? (
                  <span
                    className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-700"
                    title="Rule classifier: chain head = first healthy target by priority; zero LLM cost"
                  >
                    classifier: rule (priority &amp; availability)
                  </span>
                ) : (
                  <span className="text-xs text-gray-500">
                    classifier: {row.classifierUpstreamName} / {row.classifierModel}
                  </span>
                )}
                <span
                  className={`text-xs ${row.targets.length > 1 ? "text-gray-500" : "text-amber-600"}`}
                  title={row.targets.length > 1 ? undefined : "≤1 target: no classifier call needed"}
                >
                  {row.targets.length} targets
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleEnabled(row);
                    }}
                    disabled={busyId === row.id}
                    className={`rounded px-2 py-0.5 text-xs ${
                      row.enabled ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"
                    } disabled:opacity-50`}
                  >
                    {row.enabled ? "enabled" : "disabled"}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingInstructionId(row.id);
                      setInstructionDraft(row.instruction);
                    }}
                    className="text-xs text-gray-600 hover:text-gray-800"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteRoute(row);
                    }}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    Delete
                  </button>
                  <span className="text-xs text-gray-400">
                    {expandedRouteId === row.id ? "▲" : "▼"}
                  </span>
                </div>
                {/* 概要行 instruction：单行截断，悬停 tooltip 看全文（移动端无悬停，展开区看全文） */}
                {row.instruction && (
                  <span className="w-full truncate text-xs text-gray-500" title={row.instruction}>
                    <span className="text-gray-400">instruction: </span>
                    {row.instruction}
                  </span>
                )}
              </div>
              {editingInstructionId === row.id && (
                <div className="flex items-start gap-2 border-t border-gray-100 px-4 py-2">
                  <textarea
                    value={instructionDraft}
                    onChange={(e) => setInstructionDraft(e.target.value)}
                    rows={2}
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => saveInstruction(row)}
                    disabled={busyId === row.id}
                    className="shrink-0 rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingInstructionId(null)}
                    className="shrink-0 rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-500"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* 目标池编辑区 */}
              {expandedRouteId === row.id && (
                <div className="border-t border-gray-100 px-4 py-3">
                  {row.instruction && (
                    <div className="mb-3">
                      <p className="mb-1 text-xs font-medium text-gray-700">
                        Instruction{" "}
                        <span className="font-normal text-gray-400">(decision prompt for the classifier)</span>
                      </p>
                      <p className="whitespace-pre-wrap break-words rounded border border-gray-100 bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600">
                        {row.instruction}
                      </p>
                    </div>
                  )}
                  {row.targets.length === 0 && (
                    <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
                      No targets: requests to this name return 502 named_route_unavailable. Add at least one.
                    </p>
                  )}
                  <AdminTable>
                    <AdminTableHead
                      columns={[
                        { label: "Provider" },
                        { label: "Model" },
                        { label: "Description" },
                        { label: "Priority" },
                        { label: "", align: "right" },
                      ]}
                    />
                    <AdminTableBody>
                      {row.targets.length === 0 && <AdminTableEmptyRow colSpan={5}>No targets</AdminTableEmptyRow>}
                      {row.targets.map((target) => {
                        const editing = editingTarget?.id === target.id;
                        return (
                          <tr key={target.id}>
                            <AdminTd>
                              <span className="text-xs font-medium">{target.upstreamName}</span>
                              <span
                                className={`ml-1.5 rounded border px-1.5 py-0.5 text-[10px] ${protocolBadgeClass(target.upstreamProtocol)}`}
                              >
                                {target.upstreamProtocol}
                              </span>
                            </AdminTd>
                            <AdminTd>
                              {editing ? (
                                <input
                                  value={editingTarget!.targetModel}
                                  onChange={(e) =>
                                    setEditingTarget({ ...editingTarget!, targetModel: e.target.value })
                                  }
                                  className="w-40 rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                                />
                              ) : (
                                <CopyableCode className="text-xs">{target.targetModel}</CopyableCode>
                              )}
                            </AdminTd>
                            <AdminTd>
                              {editing ? (
                                <input
                                  value={editingTarget!.description}
                                  onChange={(e) =>
                                    setEditingTarget({ ...editingTarget!, description: e.target.value })
                                  }
                                  className="w-56 rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                                />
                              ) : (
                                <span className="text-xs text-gray-500">{target.description ?? "—"}</span>
                              )}
                            </AdminTd>
                            <AdminTd>
                              {editing ? (
                                <input
                                  value={editingTarget!.priority}
                                  onChange={(e) =>
                                    setEditingTarget({ ...editingTarget!, priority: e.target.value })
                                  }
                                  type="number"
                                  min={0}
                                  className="w-16 rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                                />
                              ) : (
                                <span className="rounded bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600">
                                  p{target.priority}
                                </span>
                              )}
                            </AdminTd>
                            <AdminTd align="right" className="whitespace-nowrap">
                              {targetActions(row, target, false)}
                            </AdminTd>
                          </tr>
                        );
                      })}
                    </AdminTableBody>
                  </AdminTable>

                  <AdminMobileCards>
                    {row.targets.length === 0 && <AdminMobileCard>No targets</AdminMobileCard>}
                    {row.targets.map((target) => {
                      const editing = editingTarget?.id === target.id;
                      return (
                        <AdminMobileCard key={target.id}>
                          <div className="mb-2 flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-xs text-gray-500">Provider</p>
                              <p className="text-sm font-medium">{target.upstreamName}</p>
                            </div>
                            {targetActions(row, target, true)}
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="col-span-2">
                              <p className="text-xs text-gray-500">Model</p>
                              {editing ? (
                                <input
                                  value={editingTarget!.targetModel}
                                  onChange={(e) =>
                                    setEditingTarget({ ...editingTarget!, targetModel: e.target.value })
                                  }
                                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                                />
                              ) : (
                                <CopyableCode className="text-xs">{target.targetModel}</CopyableCode>
                              )}
                            </div>
                            <div className="col-span-2">
                              <p className="text-xs text-gray-500">Description</p>
                              {editing ? (
                                <input
                                  value={editingTarget!.description}
                                  onChange={(e) =>
                                    setEditingTarget({ ...editingTarget!, description: e.target.value })
                                  }
                                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                                />
                              ) : (
                                <p className="text-sm text-gray-600">{target.description ?? "—"}</p>
                              )}
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Priority</p>
                              {editing ? (
                                <input
                                  value={editingTarget!.priority}
                                  onChange={(e) =>
                                    setEditingTarget({ ...editingTarget!, priority: e.target.value })
                                  }
                                  type="number"
                                  min={0}
                                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                                />
                              ) : (
                                <span className="rounded bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600">
                                  p{target.priority}
                                </span>
                              )}
                            </div>
                          </div>
                        </AdminMobileCard>
                      );
                    })}
                  </AdminMobileCards>

                  {/* 新增 target */}
                  <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-[1.2fr_1.2fr_2fr_80px_auto]">
                    <select
                      value={targetUpstreamId}
                      onChange={(e) => {
                        setTargetUpstreamId(e.target.value === "" ? "" : Number(e.target.value));
                        setTargetModel("");
                      }}
                      className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    >
                      <option value="">Select upstream…</option>
                      {upstreamOptionsForProtocol(row.protocol).map((t) => (
                        <option key={t.upstreamId} value={t.upstreamId}>
                          {t.upstreamName}
                        </option>
                      ))}
                    </select>
                    <input
                      value={targetModel}
                      onChange={(e) => setTargetModel(e.target.value)}
                      placeholder="Real model on upstream"
                      list={`named-route-models-${row.id}`}
                      className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <datalist id={`named-route-models-${row.id}`}>
                      {modelCandidatesFor(targetUpstreamId).map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                    <input
                      value={targetDescription}
                      onChange={(e) => setTargetDescription(e.target.value)}
                      placeholder="Characteristics for the classifier"
                      className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <input
                      value={targetPriority}
                      onChange={(e) => setTargetPriority(e.target.value)}
                      type="number"
                      min={0}
                      placeholder="p"
                      className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => addTarget(row)}
                      disabled={targetUpstreamId === "" || !targetModel.trim() || addingTarget}
                      className="rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {addingTarget ? "Adding…" : "Add Target"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </AdminTableCard>
  );
}
