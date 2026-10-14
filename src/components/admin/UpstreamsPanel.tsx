"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import { filterModelsByQuery } from "@/lib/model-search";
import { PROVIDER_PRESETS } from "@/lib/provider-presets";
import UpstreamModelsManager from "./UpstreamModelsManager";
import { CopyableCode } from "./CopyableCode";
import ActionMenu from "./ActionMenu";
import type { HeaderTransform } from "@/lib/gateway/header-transforms";
import { PROBE_PRESETS } from "@/lib/gateway/probe-config";
import type { ModelProbeConfig, ProbeConfig } from "@/lib/gateway/probe-config";
import type { ClassifierModelEntry } from "@/lib/gateway/classifier/types";

export interface UpstreamProbeStatus {
  lastAt: number; // 0 = 尚未探测
  ok: boolean;
  status: number; // 0 = 无 HTTP 响应（网络层失败）
  error?: string;
  nextAt: number | null;
}

export interface UpstreamItem {
  id: number;
  name: string;
  protocol: string;
  baseUrl: string;
  enabledModels: string[];
  priority: number;
  enabled: boolean;
  unhealthy: boolean;
  healthCheckModel: string | null;
  modelUnhealthy: string[];
  probe: UpstreamProbeStatus | null;
  keyCount: number;
  activeKeyCount: number;
  balance: string | null;
  balanceUpdatedAt: string | null;
  hasProxy: boolean;
  proxyDisplay: string | null;
  headerTransforms: HeaderTransform[];
  probeConfig: ProbeConfig | null;
  modelProbeConfigs: ModelProbeConfig[];
  classifierModels: ClassifierModelEntry[];
  createdAt: string;
}

export interface UpstreamKeyItem {
  id: number;
  upstreamId: number;
  maskedKey: string;
  enabled: boolean;
  lastStatus: string | null;
  createdAt: string;
}

// upstream.protocol 的 UI 展示：选项值仍是 openai/anthropic/gemini（存储/API 不变），
// 标签直接写认证头——这是三个选项之间唯一可观察的差异，避免 "protocol" 的歧义
const PROTOCOL_OPTIONS = [
  { value: "openai", label: "Authorization: Bearer" },
  { value: "anthropic", label: "x-api-key" },
  { value: "gemini", label: "x-goog-api-key" },
];
const PROTOCOL_LABELS = new Map(PROTOCOL_OPTIONS.map((p) => [p.value, p.label]));

interface FormState {
  name: string;
  protocol: string;
  baseUrl: string;
  enabledModels: string;
  priority: string;
  healthCheckModel: string;
  proxyUrl: string;
  probePath: string;
  probeBody: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  protocol: "openai",
  baseUrl: "",
  enabledModels: "",
  priority: "0",
  healthCheckModel: "",
  proxyUrl: "",
  probePath: "",
  probeBody: "",
};

interface FormKeyTestResult {
  ok: boolean;
  status: number;
  error?: string;
}

interface ModelTestResult {
  ok: boolean;
  status: number;
  error?: string;
  keysTested?: number;
}

interface ModelPickerState {
  models: string[];
  selected: Set<string>;
  /** 原本配置但上游列表已不存在的模型（底部灰色区段） */
  missing: string[];
  error?: string;
}

// 由表单内容反推预置下拉的应显示值（不单独持久化预置名）
function deriveProbePreset(path: string, body: string): string {
  const trimmed = path.trim();
  if (trimmed === "") return "auto";
  let parsed: unknown;
  try {
    parsed = body.trim() === "" ? {} : JSON.parse(body);
  } catch {
    return "custom";
  }
  const hit = PROBE_PRESETS.find(
    (p) => p.path === trimmed && JSON.stringify(p.body) === JSON.stringify(parsed)
  );
  return hit ? hit.id : "custom";
}

export default function UpstreamsPanel() {
  const [upstreams, setUpstreams] = useState<UpstreamItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formKeys, setFormKeys] = useState<string[]>([""]);
  const [formTransforms, setFormTransforms] = useState<HeaderTransform[]>([]);
  // per-model 探活端点表单（body 以 JSON 字符串暂存，提交时解析）
  const [formModelProbes, setFormModelProbes] = useState<
    { model: string; path: string; body: string }[]
  >([]);
  const [formKeyTests, setFormKeyTests] = useState<Record<number, FormKeyTestResult | null>>({});
  const [formKeyShown, setFormKeyShown] = useState<Record<number, boolean>>({});
  const [modelPicker, setModelPicker] = useState<ModelPickerState | null>(null);
  // 模型选择弹窗的搜索词（视图过滤，不改写选择集）
  const [pickerQuery, setPickerQuery] = useState("");
  const [fetchingModels, setFetchingModels] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [clearProxy, setClearProxy] = useState(false);
  const [probeCustom, setProbeCustom] = useState(false);
  const [saving, setSaving] = useState(false);

  const [keysByUpstream, setKeysByUpstream] = useState<Record<number, UpstreamKeyItem[]>>({});
  const [balanceInput, setBalanceInput] = useState<Record<number, string>>({});
  const [refreshingBalance, setRefreshingBalance] = useState<Record<number, boolean>>({});
  const [showPresets, setShowPresets] = useState(false);
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; modelCount?: number; error?: string } | null>>({});
  const [modelTests, setModelTests] = useState<Record<number, Record<string, ModelTestResult | null>>>({});
  const [testingModels, setTestingModels] = useState<Record<number, Record<string, boolean>>>({});
  const [testingAll, setTestingAll] = useState<Record<number, boolean>>({});
  const [probing, setProbing] = useState<Record<number, boolean>>({});
  // 探活倒计时基准时钟（unhealthy 行的 nextAt 倒计时随其刷新）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [pendingDelete, setPendingDelete] = useState<UpstreamItem | null>(null);
  const [hideHistory, setHideHistory] = useState(false);
  // 编辑表单中 key 启停的本地暂存（点击 Save 后才提交生效）
  const [pendingKeyEnabled, setPendingKeyEnabled] = useState<Record<number, boolean>>({});

  // 当前编辑项已配置的代理展示（仅脱敏 host，供表单提示；无法回显明文）
  const editingProxy = editingId ? upstreams.find((u) => u.id === editingId) : null;
  const hasProxyForEditing = editingProxy?.hasProxy ?? false;
  const editingProxyDisplay = editingProxy?.proxyDisplay ?? null;

  const filteredPresets = useMemo(() => {
    const query = form.name.trim().toLowerCase();
    if (!query) return PROVIDER_PRESETS;
    return PROVIDER_PRESETS.filter((p) => p.name.toLowerCase().includes(query));
  }, [form.name]);

  // 探活预置下拉的当前值：内容与预置完全一致时显示该预置，否则 custom；
  // 「custom」一旦显式选中就粘住（probeCustom），否则选中后内容仍等于预置会让下拉立即弹回
  const derivedProbePreset = useMemo(
    () => deriveProbePreset(form.probePath, form.probeBody),
    [form.probePath, form.probeBody]
  );
  const probePresetValue = probeCustom ? "custom" : derivedProbePreset;

  // per-model probe 的 model 可编辑 selector 候选：取表单里已填的 enabled models
  //（datalist 允许自由输入，未配置的 model 名仍可手填）
  const modelProbeModelOptions = useMemo(
    () =>
      form.enabledModels
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    [form.enabledModels]
  );

  // per-model 行内的预置下拉：内容与预置一致时回显该预置，否则 custom/placeholder
  const applyModelProbePreset = (index: number, value: string) => {
    if (value === "" || value === "custom") {
      // custom：path 为空时预填占位，使 body 输入框出现
      setFormModelProbes((prev) =>
        prev.map((x, i) =>
          i === index && x.path.trim() === ""
            ? { ...x, path: "/", body: x.body.trim() || "{}" }
            : x
        )
      );
      return;
    }
    const preset = PROBE_PRESETS.find((p) => p.id === value);
    if (!preset) return;
    setFormModelProbes((prev) =>
      prev.map((x, i) =>
        i === index ? { ...x, path: preset.path, body: JSON.stringify(preset.body, null, 2) } : x
      )
    );
  };

  const applyProbePreset = (value: string) => {
    if (value === "auto") {
      setProbeCustom(false);
      setForm({ ...form, probePath: "", probeBody: "" });
      return;
    }
    const preset = PROBE_PRESETS.find((p) => p.id === value);
    if (preset) {
      setProbeCustom(false);
      setForm({ ...form, probePath: preset.path, probeBody: JSON.stringify(preset.body, null, 2) });
      return;
    }
    // custom：粘住选择，并在 path 为空时预填占位，使 body 输入框立即出现
    setProbeCustom(true);
    if (form.probePath.trim() === "") {
      setForm({ ...form, probePath: "/", probeBody: form.probeBody.trim() || "{}" });
    }
  };

  const loadKeys = useCallback(async (upstreamId: number) => {
    const res = await apiFetch(`/api/admin/upstreams/${upstreamId}/keys`);
    const json = await res.json();
    if (json.success) {
      setKeysByUpstream((prev) => ({ ...prev, [upstreamId]: json.data }));
    }
  }, []);

  const loadUpstreams = useCallback(async () => {
    try {
      const res = await apiFetch("/api/admin/upstreams");
      const json = await res.json();
      if (json.success) {
        const data = json.data as UpstreamItem[];
        setUpstreams(data);
        // 默认展开详情，预加载所有 keys
        await Promise.all(data.map((u) => loadKeys(u.id)));
      } else {
        setError(json.error || "Failed to load upstreams");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [loadKeys]);

  useEffect(() => {
    loadUpstreams();
  }, [loadUpstreams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const proxyUrl = form.proxyUrl.trim();
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      protocol: form.protocol,
      baseUrl: form.baseUrl.trim(),
      enabledModels: form.enabledModels
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
      priority: Number(form.priority) || 0,
      healthCheckModel: form.healthCheckModel.trim() || null,
    };
    // Proxy URL 写后不可读：编辑态输入为空时省略字段（保持），除非勾选"清除代理"
    if (proxyUrl) {
      payload.proxyUrl = proxyUrl;
    } else if (editingId && clearProxy) {
      payload.proxyUrl = null;
    }
    // header transforms 全量替换（前端数组操作后整体提交）
    payload.headerTransforms = formTransforms;
    // 自定义探活端点：path 为空 = 不配置（回落默认 chat → responses 双风格）；
    // 编辑态清空 path 则显式下发 null 移除配置
    const probePath = form.probePath.trim();
    if (probePath) {
      let probeBody: unknown;
      try {
        probeBody = form.probeBody.trim() === "" ? {} : JSON.parse(form.probeBody);
      } catch {
        setError("Probe body is not valid JSON");
        setSaving(false);
        return;
      }
      payload.probeConfig = { path: probePath, body: probeBody };
    } else if (editingId) {
      payload.probeConfig = null;
    }
    // per-model 探活端点：model 与 path 成对必填（半行视为输入错误），全空行丢弃；
    // 编辑态清空全部行 = 显式 null 移除
    const modelProbeConfigs: ModelProbeConfig[] = [];
    for (const p of formModelProbes) {
      const model = p.model.trim();
      const path = p.path.trim();
      if (model === "" && path === "") continue;
      if (model === "" || path === "") {
        setError(`Per-model probe: model and path are both required (row: ${model || path})`);
        setSaving(false);
        return;
      }
      let body: unknown;
      try {
        body = p.body.trim() === "" ? {} : JSON.parse(p.body);
      } catch {
        setError(`Probe body for model "${model}" is not valid JSON`);
        setSaving(false);
        return;
      }
      modelProbeConfigs.push({ model, path, body: body as Record<string, unknown> });
    }
    if (modelProbeConfigs.length > 0) {
      payload.modelProbeConfigs = modelProbeConfigs;
    } else if (editingId) {
      payload.modelProbeConfigs = null;
    }
    const newKeys = formKeys.map((k) => k.trim()).filter(Boolean);
    try {
      const res = editingId
        ? await apiFetch(`/api/admin/upstreams/${editingId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await apiFetch("/api/admin/upstreams", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Failed to save upstream");
        return;
      }
      const upstreamId = editingId ?? (json.data as { id: number }).id;
      // 提交编辑期间暂存的 key 启停变更
      for (const [keyId, enabled] of Object.entries(pendingKeyEnabled)) {
        await apiFetch(`/api/admin/upstreams/${upstreamId}/keys/${keyId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
      }
      for (const apiKey of newKeys) {
        const keyRes = await apiFetch(`/api/admin/upstreams/${upstreamId}/keys`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey }),
        });
        const keyJson = await keyRes.json();
        if (!keyJson.success) {
          setError(keyJson.error || "Failed to add an API key");
          break;
        }
      }
      setForm(EMPTY_FORM);
      setFormKeys([""]);
      setFormTransforms([]);
      setFormModelProbes([]);
      setFormKeyTests({});
      setFormKeyShown({});
      setEditingId(null);
      setClearProxy(false);
      setProbeCustom(false);
      setPendingKeyEnabled({});
      loadUpstreams();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (u: UpstreamItem) => {
    setEditingId(u.id);
    setForm({
      name: u.name,
      protocol: u.protocol,
      baseUrl: u.baseUrl,
      enabledModels: u.enabledModels.join(", "),
      priority: String(u.priority),
      healthCheckModel: u.healthCheckModel ?? "",
      proxyUrl: "",
      probePath: u.probeConfig?.path ?? "",
      probeBody: u.probeConfig ? JSON.stringify(u.probeConfig.body, null, 2) : "",
    });
    setClearProxy(false);
    // 存量配置与预置不匹配时显示为 custom，且不被「内容回算」弹回
    setProbeCustom(
      u.probeConfig !== null &&
        deriveProbePreset(u.probeConfig.path, JSON.stringify(u.probeConfig.body, null, 2)) === "custom"
    );
    setFormKeys([""]);
    // 浅拷贝数组 + 展开条目，避免直接改列表缓存
    setFormTransforms(u.headerTransforms.map((t) => ({ ...t })));
    setFormModelProbes(
      (u.modelProbeConfigs ?? []).map((p) => ({
        model: p.model,
        path: p.path,
        body: JSON.stringify(p.body, null, 2),
      }))
    );
    setFormKeyTests({});
    setFormKeyShown({});
    setPendingKeyEnabled({});
    setModelPicker(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleDelete = async (u: UpstreamItem) => {
    setPendingDelete(u);
    setHideHistory(false);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setPendingDelete(null);
    const query = hideHistory ? "?hideHistory=1" : "";
    await apiFetch(`/api/admin/upstreams/${pendingDelete.id}${query}`, {
      method: "DELETE",
    });
    loadUpstreams();
  };

  const handleToggleEnabled = async (u: UpstreamItem) => {
    await apiFetch(`/api/admin/upstreams/${u.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !u.enabled }),
    });
    loadUpstreams();
  };

  const toggleKeyPending = (key: UpstreamKeyItem) => {
    setPendingKeyEnabled((prev) => ({ ...prev, [key.id]: !(prev[key.id] ?? key.enabled) }));
  };

  const handleDeleteKey = async (key: UpstreamKeyItem) => {
    if (!confirm("Delete this key?")) return;
    await apiFetch(`/api/admin/upstreams/${key.upstreamId}/keys/${key.id}`, {
      method: "DELETE",
    });
    loadKeys(key.upstreamId);
    loadUpstreams();
  };

  const handleTest = async (u: UpstreamItem) => {
    setTestResults((prev) => ({ ...prev, [u.id]: null }));
    const res = await apiFetch(`/api/admin/upstreams/${u.id}/test`, { method: "POST" });
    const json = await res.json();
    setTestResults((prev) => ({ ...prev, [u.id]: json.data ?? { ok: false, error: json.error } }));
  };

  const handleProbeNow = async (u: UpstreamItem) => {
    setProbing((prev) => ({ ...prev, [u.id]: true }));
    try {
      const res = await apiFetch(`/api/admin/upstreams/${u.id}/probe`, { method: "POST" });
      const json = await res.json();
      if (!json.success) setError(json.error || "Probe failed");
      await loadUpstreams();
    } catch {
      setError("Network error");
    } finally {
      setProbing((prev) => ({ ...prev, [u.id]: false }));
    }
  };

  const handleTestModel = async (u: UpstreamItem, model: string) => {
    setTestingModels((prev) => ({ ...prev, [u.id]: { ...(prev[u.id] ?? {}), [model]: true } }));
    try {
      const res = await apiFetch(`/api/admin/upstreams/${u.id}/test-model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const json = await res.json();
      const result: ModelTestResult = json.data ?? { ok: false, status: 0, error: json.error || "Test failed" };
      setModelTests((prev) => ({ ...prev, [u.id]: { ...(prev[u.id] ?? {}), [model]: result } }));
      loadUpstreams(); // 刷新健康标记（测试会立即更新服务端健康状态）
    } finally {
      setTestingModels((prev) => ({ ...prev, [u.id]: { ...(prev[u.id] ?? {}), [model]: false } }));
    }
  };

  const handleTestAllModels = async (u: UpstreamItem) => {
    setTestingAll((prev) => ({ ...prev, [u.id]: true }));
    const allTesting = Object.fromEntries(u.enabledModels.map((m) => [m, true]));
    setTestingModels((prev) => ({ ...prev, [u.id]: allTesting }));
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/upstreams/${u.id}/test-all-models`, { method: "POST" });
      const json = await res.json();
      if (json.success && json.data?.results) {
        const map: Record<string, ModelTestResult> = {};
        for (const r of json.data.results) {
          map[r.model] = r;
        }
        setModelTests((prev) => ({ ...prev, [u.id]: { ...(prev[u.id] ?? {}), ...map } }));
      } else {
        setError(json.error || "Failed to test models");
      }
      loadUpstreams(); // 刷新健康标记（测试会立即更新服务端健康状态）
    } catch {
      setError("Network error");
    } finally {
      setTestingAll((prev) => ({ ...prev, [u.id]: false }));
      const allIdle = Object.fromEntries(u.enabledModels.map((m) => [m, false]));
      setTestingModels((prev) => ({ ...prev, [u.id]: allIdle }));
    }
  };

  // 实际用于 unhealthy upstream 探活的模型：healthCheckModel 优先，否则第一个非通配
  const probeModelFor = (u: UpstreamItem): string | null =>
    u.healthCheckModel || u.enabledModels.find((m) => !m.endsWith("*")) || null;

  // 探活状态文本：上次时间 + 结果（ok / HTTP status / network）+ error 摘要 + 下次倒计时
  const formatProbeStatus = (p: UpstreamProbeStatus): string => {
    const parts: string[] = [];
    if (!p.lastAt) {
      parts.push("not probed yet");
    } else {
      const result = p.ok
        ? "ok"
        : p.status > 0
          ? `failed (HTTP ${p.status})`
          : "failed (no response)";
      const err = p.error ? `: ${p.error.slice(0, 60)}` : "";
      parts.push(`last ${new Date(p.lastAt).toLocaleString()} — ${result}${err}`);
    }
    if (p.nextAt !== null) {
      parts.push(`next in ${Math.max(0, Math.round((p.nextAt - now) / 60_000))}m`);
    }
    return parts.join(" · ");
  };

  const handleSaveBalance = async (u: UpstreamItem) => {
    const value = (balanceInput[u.id] ?? "").trim();
    const res = await apiFetch(`/api/admin/upstreams/${u.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: value === "" ? null : value }),
    });
    const json = await res.json();
    if (!json.success) {
      setError(json.error || "Failed to save balance");
      return;
    }
    loadUpstreams();
  };

  const handleRefreshBalance = async (u: UpstreamItem) => {
    setRefreshingBalance((prev) => ({ ...prev, [u.id]: true }));
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/upstreams/${u.id}/balance/refresh`, { method: "POST" });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Failed to refresh balance");
      } else {
        setBalanceInput((prev) => ({
          ...prev,
          [u.id]: json.data?.balance !== undefined ? String(json.data.balance) : (prev[u.id] ?? ""),
        }));
      }
      loadUpstreams();
    } catch {
      setError("Network error");
    } finally {
      setRefreshingBalance((prev) => ({ ...prev, [u.id]: false }));
    }
  };

  const addFormKeyRow = () => {
    setFormKeys((prev) => [...prev, ""]);
  };

  // Header transforms：只操作前端内存数组，随 upstream 保存整体提交
  const addTransformRow = () => {
    setFormTransforms((prev) => [
      ...prev,
      {
        id: "ht-" + crypto.randomUUID().slice(0, 8),
        header: "",
        value: "",
        mode: "fill",
        enabled: true,
      },
    ]);
  };

  const removeTransformRow = (index: number) => {
    setFormTransforms((prev) => prev.filter((_, i) => i !== index));
  };

  const updateTransformRow = (index: number, patch: Partial<HeaderTransform>) => {
    setFormTransforms((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  };
  const removeFormKeyRow = (index: number) => {
    setFormKeys((prev) => prev.filter((_, i) => i !== index));
    setFormKeyTests((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const updateFormKey = (index: number, value: string) => {
    setFormKeys((prev) => prev.map((k, i) => (i === index ? value : k)));
    setFormKeyTests((prev) => ({ ...prev, [index]: null }));
  };

  const toggleFormKeyShown = (index: number) => {
    setFormKeyShown((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const testFormKey = async (index: number) => {
    const apiKey = formKeys[index]?.trim();
    if (!apiKey) return;
    setFormKeyTests((prev) => ({ ...prev, [index]: null }));
    try {
      const res = await apiFetch("/api/admin/upstreams/test-connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol: form.protocol,
          baseUrl: form.baseUrl.trim(),
          apiKey,
          proxyUrl: form.proxyUrl.trim() || undefined,
          upstreamId: form.proxyUrl.trim() ? undefined : editingId,
        }),
      });
      const json = await res.json();
      if (json.success && json.data) {
        setFormKeyTests((prev) => ({ ...prev, [index]: json.data }));
      } else {
        setFormKeyTests((prev) => ({
          ...prev,
          [index]: { ok: false, status: 0, error: json.error || "Test failed" },
        }));
      }
    } catch {
      setFormKeyTests((prev) => ({ ...prev, [index]: { ok: false, status: 0, error: "Network error" } }));
    }
  };

  const firstFormKey = () => formKeys.map((k) => k.trim()).find(Boolean) || "";

  const hasStoredEnabledKey = editingId
    ? (keysByUpstream[editingId] ?? []).some((k) => k.enabled)
    : false;

  const handleFetchModels = async () => {
    const apiKey = firstFormKey();
    if (!apiKey && !editingId) return;
    setFetchingModels(true);
    setError(null);
    setPickerQuery("");
    try {
      const res = await apiFetch("/api/admin/upstreams/fetch-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol: form.protocol,
          baseUrl: form.baseUrl.trim(),
          apiKey,
          upstreamId: apiKey ? undefined : editingId,
          proxyUrl: form.proxyUrl.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (json.success && json.data) {
        // 拷贝后排序以对齐行内弹窗主列表展示；成员判断用 Set 避免 O(n·m)
        const rawModels = json.data.models as unknown;
        const models = Array.isArray(rawModels) ? ([...rawModels].sort() as string[]) : [];
        const modelSet = new Set(models);
        const current = form.enabledModels
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
        const selected = new Set<string>();
        const missing: string[] = [];
        for (const name of current) {
          if (name.endsWith("*")) {
            const prefix = name.slice(0, -1);
            for (const m of models) {
              if (m.startsWith(prefix)) selected.add(m);
            }
          } else if (modelSet.has(name)) {
            selected.add(name);
          } else if (!missing.includes(name)) {
            // 原本勾选但上游列表已不存在：置底灰色区段并默认保持勾选（去重）
            missing.push(name);
          }
        }
        for (const name of missing) selected.add(name);
        setModelPicker({
          models,
          selected,
          missing,
          error: json.data.error || undefined,
        });
      } else {
        setModelPicker({
          models: [],
          selected: new Set<string>(),
          missing: [],
          error: json.error || "Failed to fetch models",
        });
      }
    } catch {
      setModelPicker({
        models: [],
        selected: new Set<string>(),
        missing: [],
        error: "Network error",
      });
    } finally {
      setFetchingModels(false);
    }
  };

  const togglePickerModel = (model: string) => {
    setModelPicker((prev) => {
      if (!prev) return prev;
      const next = new Set(prev.selected);
      if (next.has(model)) {
        next.delete(model);
      } else {
        next.add(model);
      }
      return { ...prev, selected: next };
    });
  };

  // 底部「已下架」区段的组级全选/取消：作用域 = 有搜索词时的可见子集，与行内弹窗语义对齐
  const pickerMissing = modelPicker?.missing ?? [];
  const visiblePickerModels = modelPicker
    ? filterModelsByQuery(modelPicker.models, pickerQuery)
    : [];
  const visiblePickerMissing = filterModelsByQuery(pickerMissing, pickerQuery);
  const scopePickerMissing = pickerQuery.trim() ? visiblePickerMissing : pickerMissing;
  const allPickerMissingSelected =
    scopePickerMissing.length > 0 && scopePickerMissing.every((m) => modelPicker?.selected.has(m) ?? false);
  const somePickerMissingSelected =
    scopePickerMissing.length > 0 &&
    scopePickerMissing.some((m) => modelPicker?.selected.has(m) ?? false) &&
    !allPickerMissingSelected;
  const pickerMissingAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pickerMissingAllRef.current) {
      pickerMissingAllRef.current.indeterminate = somePickerMissingSelected;
    }
  }, [somePickerMissingSelected]);

  const togglePickerMissingAll = () => {
    setModelPicker((prev) => {
      if (!prev) return prev;
      const next = new Set(prev.selected);
      for (const m of scopePickerMissing) {
        if (allPickerMissingSelected) {
          next.delete(m);
        } else {
          next.add(m);
        }
      }
      return { ...prev, selected: next };
    });
  };

  const confirmModelPicker = () => {
    if (!modelPicker) return;
    const current = form.enabledModels
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    // 通配模式（如 gpt-*）无具体模型可勾选，原样保留；具体模型一律以勾选结果为准
    // （缺失模型默认已勾选，取消勾选即从 enabled models 移除）
    const patterns = current.filter((n) => n.endsWith("*"));
    const merged = Array.from(new Set([...patterns, ...Array.from(modelPicker.selected)]));
    setForm({ ...form, enabledModels: merged.join(", ") });
    setModelPicker(null);
  };

  if (loading) {
    return <div className="h-40 flex items-center justify-center text-gray-400">Loading...</div>;
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
      )}

      {/* 新建/编辑表单 */}
      <div className="rounded-lg bg-white p-4 shadow">
        <h2 className="mb-3 text-base font-semibold">
          {editingId ? `Edit Upstream #${editingId}` : "New Upstream"}
        </h2>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-[1fr_200px_200px] gap-3">
          <div className="relative">
            <label className="mb-1 block text-xs text-gray-600">Name</label>
            <input
              value={form.name}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                setShowPresets(true);
              }}
              onFocus={() => setShowPresets(true)}
              onBlur={() => setTimeout(() => setShowPresets(false), 150)}
              placeholder="e.g. deepseek"
              required
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {showPresets && filteredPresets.length > 0 && (
              <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded border border-gray-200 bg-white shadow-lg">
                {filteredPresets.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setForm({
                        ...form,
                        name: p.name,
                        protocol: p.protocol,
                        baseUrl: p.baseUrl,
                      });
                      setShowPresets(false);
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                  >
                    <span>{p.name}</span>
                    <span className="text-xs text-gray-400">{p.baseUrl}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-600">
              Auth Header{" "}
              <span
                className="cursor-help text-gray-400"
                title={"Which header carries the upstream API key — the real difference between the options. It also sets default probe endpoints and accepted request styles: anthropic adds the anthropic-version header; gemini speaks /v1beta paths (model in the URL). Relays serving anthropic/gemini models via OpenAI-compatible endpoints use 'Authorization: Bearer' (default); per-model probe overrides below cover their endpoint styles."}
              >
                (?)
              </span>
            </label>
            <select
              value={form.protocol}
              onChange={(e) => setForm({ ...form, protocol: e.target.value })}
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {PROTOCOL_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-600">Priority (model routing)</label>
            <input
              type="number"
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="md:col-span-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-gray-600">Base URL</label>
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="e.g. https://api.deepseek.com"
              required
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="min-w-0 text-xs text-gray-600">
                Proxy URL <span className="hidden md:inline text-gray-400">(optional)</span>
              </label>
              {editingId && hasProxyForEditing && (
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-gray-500">
                  <input
                    type="checkbox"
                    checked={clearProxy}
                    onChange={(e) => setClearProxy(e.target.checked)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  Clear proxy
                </label>
              )}
            </div>
            <input
              value={form.proxyUrl}
              onChange={(e) => setForm({ ...form, proxyUrl: e.target.value })}
              placeholder="http://user:pass@host:port"
              autoComplete="off"
              data-1p-ignore
              data-bitwarden-ignore
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {editingId && hasProxyForEditing && (
              <p className="mt-1 text-[10px] text-gray-400">
                Configured proxy: {editingProxyDisplay ?? "yes"}. Leave blank to keep it, or tick &quot;Clear proxy&quot; to remove.
              </p>
            )}
          </div>
          </div>
          <div className="md:col-span-3">
            <label className="mb-1 block text-xs text-gray-600">
              API Keys{" "}
              <span className="text-gray-400">
                ({editingId ? "existing keys are kept, new keys below are appended" : "optional at creation, add more later"})
              </span>
            </label>
            {editingId && (keysByUpstream[editingId] ?? []).length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {(keysByUpstream[editingId] ?? []).map((k) => {
                  const effectiveEnabled = pendingKeyEnabled[k.id] ?? k.enabled;
                  return (
                  <span
                    key={k.id}
                    title={`${effectiveEnabled ? "Enabled" : "Disabled"}${pendingKeyEnabled[k.id] !== undefined ? " (pending save)" : ""}${k.lastStatus ? ` · last: ${k.lastStatus}` : ""}`}
                    className="flex items-center gap-1.5 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${effectiveEnabled ? "bg-green-500" : "bg-gray-300"}`} />
                    <code>{k.maskedKey}</code>
                    <button
                      type="button"
                      onClick={() => toggleKeyPending(k)}
                      title={effectiveEnabled ? "Disable key (applied on Save)" : "Enable key (applied on Save)"}
                      className="ml-0.5 text-gray-400 hover:text-blue-600"
                    >
                      {effectiveEnabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteKey(k)}
                      title="Delete key"
                      className="text-gray-400 hover:text-red-600"
                    >
                      ×
                    </button>
                  </span>
                  );
                })}
              </div>
            )}
            <div className="space-y-2">
              {formKeys.map((keyValue, index) => (
                <div key={index}>
                  <div className="flex flex-1 items-center gap-2">
                    <input
                      type="text"
                      autoComplete="off"
                      data-1p-ignore
                      data-bitwarden-ignore
                      value={keyValue}
                      onChange={(e) => updateFormKey(index, e.target.value)}
                      placeholder={`API key ${index + 1}`}
                      className={`min-w-0 flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                        formKeyShown[index] ? "" : "[-webkit-text-security:disc]"
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => toggleFormKeyShown(index)}
                      className="shrink-0 rounded border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
                    >
                      {formKeyShown[index] ? "Hide" : "Show"}
                    </button>
                    <button
                      type="button"
                      onClick={() => testFormKey(index)}
                      disabled={!keyValue.trim() || !form.baseUrl.trim()}
                      className="shrink-0 rounded border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Test
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFormKeyRow(index)}
                      className="shrink-0 rounded border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
                      title="Remove key"
                    >
                      −
                    </button>
                  </div>
                  {formKeyTests[index] && (
                    <p
                      className={`mt-1 text-xs ${
                        formKeyTests[index]?.ok ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {formKeyTests[index]?.ok
                        ? "Connection OK"
                        : `Test failed: ${formKeyTests[index]?.error || "unknown error"}`}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addFormKeyRow}
              className="mt-2 rounded border border-dashed border-gray-300 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50"
            >
              + Add key
            </button>
          </div>
          <div className="md:col-span-3">
            <label className="mb-1 block text-xs text-gray-600">
              Header Transforms{" "}
              <span className="text-gray-400">
                (optional outbound headers; saved with this upstream)
              </span>
            </label>
            <div className="space-y-2">
              {formTransforms.map((t, index) => (
                <div
                  key={t.id}
                  className={`flex flex-wrap items-center gap-2 ${t.enabled ? "" : "opacity-60"}`}
                >
                  <input
                    type="text"
                    value={t.header}
                    onChange={(e) => updateTransformRow(index, { header: e.target.value })}
                    placeholder="header name"
                    autoComplete="off"
                    className="min-w-0 w-40 flex-none rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <input
                    type="text"
                    value={t.value}
                    onChange={(e) => updateTransformRow(index, { value: e.target.value })}
                    placeholder="value, e.g. tt-${var.sessionId}"
                    autoComplete="off"
                    className="min-w-0 flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-gray-500">
                    <input
                      type="checkbox"
                      checked={t.mode === "override"}
                      onChange={(e) =>
                        updateTransformRow(index, { mode: e.target.checked ? "override" : "fill" })
                      }
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    Override if client sends this header
                  </label>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-gray-500">
                    <input
                      type="checkbox"
                      checked={t.enabled}
                      onChange={(e) => updateTransformRow(index, { enabled: e.target.checked })}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    Enabled
                  </label>
                  <button
                    type="button"
                    onClick={() => removeTransformRow(index)}
                    className="shrink-0 rounded border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
                    title="Remove header transform"
                  >
                    −
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addTransformRow}
              className="mt-2 rounded border border-dashed border-gray-300 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50"
            >
              + Add header transform
            </button>
            <p className="mt-1 text-[10px] text-gray-400">
              Variables: {"${var.sessionId}"} (per-conversation), {"${var.model}"},{" "}
              {"${var.keyName}"}, {"${var.upstream}"}. Without &quot;Override&quot;, a header sent by
              the client is kept as-is (fill mode). Values are stored and returned in
              plain text — avoid putting credentials here.
            </p>
          </div>
          <div className="md:col-span-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="min-w-0 text-xs text-gray-600">
                Enabled Models{" "}
                <span className="hidden md:inline text-gray-400">
                  (comma separated, supports gpt-* wildcard)
                </span>
              </label>
              <button
                type="button"
                onClick={handleFetchModels}
                disabled={fetchingModels || !form.baseUrl.trim() || (!firstFormKey() && !hasStoredEnabledKey)}
                className="shrink-0 rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                {fetchingModels ? "Fetching..." : "Fetch Models"}
              </button>
            </div>
            <input
              value={form.enabledModels}
              onChange={(e) => setForm({ ...form, enabledModels: e.target.value })}
              placeholder="deepseek-chat, deepseek-*"
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="md:col-span-1">
            {/* min-h 与左侧 Enabled Models 行的 Fetch Models 按钮同高（text-xs + py-1 + border），
                保证两侧 input 顶边对齐 */}
            <div className="mb-1 flex min-h-[26px] items-center">
              <label className="text-xs text-gray-600">Health Check Model</label>
            </div>
            <input
              list="health-check-models"
              value={form.healthCheckModel}
              onChange={(e) => setForm({ ...form, healthCheckModel: e.target.value })}
              placeholder="deepseek-chat"
              autoComplete="off"
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <datalist id="health-check-models">
              {modelProbeModelOptions
                .filter((m) => !m.endsWith("*"))
                .map((m) => (
                  <option key={m} value={m} />
                ))}
            </datalist>
            <p className="mt-1 hidden text-[10px] text-gray-400 md:block">
              optional; probes unhealthy upstream
            </p>
          </div>
          <div className="md:col-span-3">
            <label className="mb-1 block text-xs text-gray-600">
              Probe Endpoint{" "}
              <span className="text-gray-400">
                (optional; override the endpoint used by probe / Test. Empty = default chat → responses)
              </span>
            </label>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-[260px_1fr]">
              <select
                value={probePresetValue}
                onChange={(e) => applyProbePreset(e.target.value)}
                className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="auto">auto (default chat → responses)</option>
                {PROBE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
                <option value="custom">custom</option>
              </select>
              <input
                value={form.probePath}
                onChange={(e) => setForm({ ...form, probePath: e.target.value })}
                placeholder="/v1/systemone"
                autoComplete="off"
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            {form.probePath.trim() !== "" && (
              <textarea
                value={form.probeBody}
                onChange={(e) => setForm({ ...form, probeBody: e.target.value })}
                rows={4}
                spellCheck={false}
                placeholder='{"model":"{{model}}","state":"hi","questions":{}}'
                className="mt-2 w-full rounded border border-gray-300 px-3 py-2 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            )}
            <p className="mt-1 text-[10px] text-gray-400">
              Body is JSON; {"{{model}}"} is replaced with the probed model name in both path and
              body. Configured probe endpoint is used as-is (no fallback to the second style).
            </p>
          </div>
          {/* per-model 探活端点：同一 upstream 混用 chat / embeddings 等不同端点风格时，
              按真实 model 名精确匹配各自的探活端点，优先级高于上面的 upstream 级配置 */}
          <div className="md:col-span-3">
            <label className="mb-1 block text-xs text-gray-600">
              Per-model Probe Endpoints{" "}
              <span className="text-gray-400">
                (optional; exact model name match, takes precedence over the upstream-level probe
                config above)
              </span>
            </label>
            <datalist id="model-probe-models">
              {modelProbeModelOptions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {formModelProbes.map((p, index) => {
              // 内容与预置一致时回显该预置，否则 custom；path 为空时显示占位
              const derived =
                p.path.trim() === "" ? "" : deriveProbePreset(p.path, p.body);
              return (
                <div key={index} className="mb-2">
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_220px_1fr_auto]">
                    <input
                      list="model-probe-models"
                      value={p.model}
                      onChange={(e) =>
                        setFormModelProbes((prev) =>
                          prev.map((x, i) => (i === index ? { ...x, model: e.target.value } : x))
                        )
                      }
                      placeholder="model name (pick from enabled models or type)"
                      autoComplete="off"
                      className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <select
                      value={derived}
                      onChange={(e) => applyModelProbePreset(index, e.target.value)}
                      className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    >
                      <option value="">apply preset…</option>
                      {PROBE_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>{preset.label}</option>
                      ))}
                      <option value="custom">custom</option>
                    </select>
                    <input
                      value={p.path}
                      onChange={(e) =>
                        setFormModelProbes((prev) =>
                          prev.map((x, i) => (i === index ? { ...x, path: e.target.value } : x))
                        )
                      }
                      placeholder="/v1/embeddings"
                      autoComplete="off"
                      className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setFormModelProbes((prev) => prev.filter((_, i) => i !== index))}
                      className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-500 hover:bg-gray-50"
                    >
                      Remove
                    </button>
                  </div>
                  {p.path.trim() !== "" && (
                    <textarea
                      value={p.body}
                      onChange={(e) =>
                        setFormModelProbes((prev) =>
                          prev.map((x, i) => (i === index ? { ...x, body: e.target.value } : x))
                        )
                      }
                      rows={3}
                      spellCheck={false}
                      placeholder='{"model":"{{model}}","input":"hi"}'
                      className="mt-2 w-full rounded border border-gray-300 px-3 py-2 font-mono text-xs focus:border-blue-500 focus:outline-none"
                    />
                  )}
                </div>
              );
            })}
            <button
              type="button"
              onClick={() =>
                setFormModelProbes((prev) => [...prev, { model: "", path: "", body: "" }])
              }
              className="mt-2 rounded border border-dashed border-gray-300 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50"
            >
              + Add per-model probe
            </button>
            <p className="mt-1 text-[10px] text-gray-400">
              Lets one upstream mix endpoint styles (chat / responses / embeddings / rerank /
              anthropic messages / gemini generateContent / …) without splitting into multiple
              entries. {"{{model}}"} works in both path and body. Each entry probes that model via
              its own endpoint (no fallback to the second style); models without an entry use the
              upstream-level config above.
            </p>
          </div>
          <div className="md:col-span-3 flex items-center gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : editingId ? "Save" : "Create"}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm(EMPTY_FORM);
                  setFormKeys([""]);
                  setFormTransforms([]);
                  setFormModelProbes([]);
                  setFormKeyTests({});
                  setFormKeyShown({});
                  setClearProxy(false);
                  setProbeCustom(false);
                  setPendingKeyEnabled({});
                }}
                className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>

      {modelPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="flex h-full w-full flex-col rounded-none bg-white shadow-xl md:h-auto md:max-h-[80vh] md:w-full md:max-w-2xl md:rounded-lg md:py-0">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h3 className="font-semibold">
                Select models for {form.name.trim() || "new upstream"}
                <span className="ml-2 text-xs font-normal text-gray-400">
                  {modelPicker.models.length} available · {modelPicker.selected.size} selected
                </span>
              </h3>
              <button
                type="button"
                onClick={() => {
                  setModelPicker(null);
                  setPickerQuery("");
                }}
                className="text-2xl leading-none text-gray-400 hover:text-gray-600"
              >
                ×
              </button>
            </div>

            {modelPicker.error && (
              <div className="mx-5 mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                Fetch failed: {modelPicker.error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-5">
              {modelPicker.error ? null :
                modelPicker.models.length === 0 && pickerMissing.length === 0 ? (
                  <div className="py-10 text-center text-gray-400">
                    No models found. Close this dialog and add models manually.
                  </div>
                ) : (
                  <div>
                    <div className="relative mb-3">
                      <input
                        type="text"
                        value={pickerQuery}
                        onChange={(e) => setPickerQuery(e.target.value)}
                        placeholder="Search models..."
                        className="w-full rounded border border-gray-300 bg-white py-2 pl-9 pr-8 text-base shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:text-sm"
                      />
                      <svg
                        className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"
                        />
                      </svg>
                      {pickerQuery && (
                        <button
                          type="button"
                          onClick={() => setPickerQuery("")}
                          className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center text-gray-400 hover:text-gray-600"
                          aria-label="Clear search"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {modelPicker.models.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                        {visiblePickerModels.map((model) => (
                          <label
                            key={model}
                            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-gray-50"
                          >
                            <input
                              type="checkbox"
                              checked={modelPicker.selected.has(model)}
                              onChange={() => togglePickerModel(model)}
                              className="rounded border-gray-300"
                            />
                            <code className="truncate" title={model}>{model}</code>
                          </label>
                        ))}
                      </div>
                    )}
                    {pickerQuery.trim() &&
                      visiblePickerModels.length === 0 &&
                      visiblePickerMissing.length === 0 && (
                        <p className="py-2 text-center text-xs text-gray-400">
                          No matches in {modelPicker.models.length + pickerMissing.length} models
                        </p>
                      )}

                    {pickerMissing.length > 0 && (
                      <div className="mt-5 border-t border-gray-200 pt-3">
                        <div className="flex items-center justify-between gap-2">
                          <h4 className="text-xs font-medium text-gray-500">
                            Removed from upstream ({pickerMissing.length})
                          </h4>
                          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700">
                            <input
                              ref={pickerMissingAllRef}
                              type="checkbox"
                              checked={allPickerMissingSelected}
                              onChange={togglePickerMissingAll}
                              disabled={scopePickerMissing.length === 0}
                              className="rounded border-gray-300"
                            />
                            {allPickerMissingSelected ? "Unselect all" : "Select all"}
                          </label>
                        </div>
                        <p className="mb-2 mt-1 text-xs text-gray-400">
                          These previously enabled models were not returned by the upstream list.
                          Keep them selected to retain, or clear the section to drop them.
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                          {visiblePickerMissing.map((model) => (
                            <label
                              key={model}
                              title="No longer available on this upstream"
                              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-gray-50"
                            >
                              <input
                                type="checkbox"
                                checked={modelPicker.selected.has(model)}
                                onChange={() => togglePickerModel(model)}
                                className="rounded border-gray-300"
                              />
                              <code className="truncate text-gray-400">{model}</code>
                              <span className="ml-auto shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-400">
                                removed
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
            </div>

            <div className="flex items-center justify-end border-t px-5 py-3 gap-2">
              <button
                type="button"
                onClick={() => {
                  setModelPicker(null);
                  setPickerQuery("");
                }}
                className="rounded border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmModelPicker}
                disabled={modelPicker.models.length === 0 && pickerMissing.length === 0}
                className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Apply ({modelPicker.selected.size})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 上游列表 */}
      <div className="space-y-3">
        {upstreams.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-gray-400">
            No upstreams configured yet. Create one above.
          </div>
        )}
        {upstreams.map((u) => (
          <div
            key={u.id}
            className={`rounded-lg p-3 shadow ${
              u.enabled ? "bg-white" : "bg-gray-50 ring-1 ring-gray-200"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    !u.enabled ? "bg-gray-300" : u.unhealthy ? "bg-red-500" : "bg-green-500"
                  }`}
                  title={
                    !u.enabled
                      ? "Disabled"
                      : u.unhealthy
                        ? "Unhealthy — all keys failed, skipped in routing until probe recovers"
                        : "Healthy"
                  }
                />
                <span className={`font-semibold text-sm ${u.enabled ? "" : "text-gray-500"}`}>
                  {u.name}
                </span>
                {!u.enabled && (
                  <span
                    className="rounded bg-gray-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                    title="Disabled — excluded from routing and failover. Click Enable to restore."
                  >
                    disabled
                  </span>
                )}
                {u.enabled && u.activeKeyCount === 0 && (
                  <span
                    className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-600"
                    title="No enabled API keys — this upstream cannot serve any request. Add or enable keys via Edit."
                  >
                    no active keys
                  </span>
                )}
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">{PROTOCOL_LABELS.get(u.protocol) ?? u.protocol}</span>
                <span className="text-xs text-gray-400 truncate max-w-[200px]">{u.baseUrl}</span>
                <span className="text-xs text-gray-400" title="Active / total API keys (disabled keys are excluded from routing)">
                  {u.enabledModels.length} models · {u.activeKeyCount}/{u.keyCount} keys · p{u.priority}
                  {u.headerTransforms.length > 0 &&
                    ` · ${u.headerTransforms.filter((t) => t.enabled).length}/${u.headerTransforms.length} header transforms`}
                  {u.probeConfig && ` · probe ${u.probeConfig.path}`}
                  {u.modelProbeConfigs?.length > 0 &&
                    ` · ${u.modelProbeConfigs.length} model probe${u.modelProbeConfigs.length > 1 ? "s" : ""}`}
                  {u.classifierModels && u.classifierModels.length > 0 &&
                    ` · classifier: ${u.classifierModels.map((c) => c.model).join(", ")}`}
                </span>
                {u.unhealthy && (
                  <span
                    className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600"
                    title="All keys failed on real requests. Auto-probed every 30 min; requests are routed to other upstreams meanwhile."
                  >
                    unhealthy
                  </span>
                )}
                {u.hasProxy && (
                  <span
                    className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500"
                    title="Requests to this upstream go through an HTTP(S) CONNECT proxy"
                  >
                    via proxy {u.proxyDisplay ?? ""}
                  </span>
                )}
                {u.balance !== null && (
                  <span className="text-xs font-medium text-gray-500">bal {u.balance}</span>
                )}
              </div>
              <div className="hidden md:flex items-center gap-2">
                {u.unhealthy && (
                  <button
                    type="button"
                    onClick={() => handleProbeNow(u)}
                    disabled={probing[u.id]}
                    className="rounded border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    {probing[u.id] ? "Probing..." : "Probe now"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleTest(u)}
                  className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  Test
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleEnabled(u)}
                  className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  {u.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  onClick={() => handleEdit(u)}
                  className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(u)}
                  className="rounded border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
              <ActionMenu
                items={[
                  ...(u.unhealthy
                    ? [{ label: "Probe now", onClick: () => handleProbeNow(u) }]
                    : []),
                  { label: "Test", onClick: () => handleTest(u) },
                  { label: u.enabled ? "Disable" : "Enable", onClick: () => handleToggleEnabled(u) },
                  { label: "Edit", onClick: () => handleEdit(u) },
                  { label: "Delete", onClick: () => handleDelete(u), variant: "danger" },
                ]}
              />
            </div>

            {u.unhealthy && (
              <div className="mt-2 text-xs text-red-600">
                <span title="Automatic recovery probe status">
                  Probe: {u.probe ? formatProbeStatus(u.probe) : "never"}
                </span>
              </div>
            )}

            {testResults[u.id] && (
              <div
                className={`mt-2 rounded p-2 text-xs ${
                  testResults[u.id]?.ok
                    ? "bg-green-50 text-green-700"
                    : "bg-red-50 text-red-600"
                }`}
              >
                {testResults[u.id]?.ok
                  ? `Connection OK · ${testResults[u.id]?.modelCount} models available`
                  : `Test failed: ${testResults[u.id]?.error || "unknown error"}`}
              </div>
            )}

            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              <div className="rounded border border-gray-100 bg-gray-50/60 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-gray-500">Enabled Models</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleTestAllModels(u)}
                      disabled={testingAll[u.id] || u.enabledModels.length === 0}
                      className="rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-500 hover:bg-gray-50 disabled:opacity-40"
                      title="Test all models against this upstream"
                    >
                      {testingAll[u.id] ? "Testing..." : "Test all"}
                    </button>
                    <UpstreamModelsManager upstream={u} onUpdated={loadUpstreams} />
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {u.enabledModels.length === 0 && (
                    <span className="text-xs text-gray-300">(none)</span>
                  )}
                  {u.enabledModels.map((m) => {
                    const test = modelTests[u.id]?.[m];
                    const testing = testingModels[u.id]?.[m];
                    const unavailable = u.modelUnhealthy?.includes(m);
                    return (
                      <span
                        key={m}
                        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
                          unavailable ? "bg-amber-50" : "bg-gray-100"
                        }`}
                      >
                        <CopyableCode>{m}</CopyableCode>
                        {unavailable && (
                          <span
                            title="This model returned 404/403 on this upstream and was skipped in routing. Auto-recovers after 30 min."
                            className="rounded bg-amber-100 px-1 py-px text-[9px] font-medium text-amber-600"
                          >
                            unavailable
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => handleTestModel(u, m)}
                          disabled={testing}
                          title={testing ? `Testing ${m}...` : `Test ${m}`}
                          className="flex h-4 w-8 items-center justify-center text-gray-400 hover:text-blue-600 disabled:opacity-50"
                        >
                          {testing ? (
                            <svg
                              className="h-2.5 w-2.5 animate-spin text-gray-500"
                              viewBox="0 0 24 24"
                              fill="none"
                            >
                              <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                              />
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                              />
                            </svg>
                          ) : (
                            "Test"
                          )}
                        </button>
                        {test && (
                          <span
                            onClick={
                              test.ok
                                ? undefined
                                : () =>
                                    alert(
                                      `Test failed for ${m} (status ${test.status}): ${
                                        test.error ?? "unknown error"
                                      }`
                                    )
                            }
                            title={
                              test.ok
                                ? `OK (${test.status}${test.keysTested ? `, ${test.keysTested} keys tested` : ""})`
                                : `Failed: ${test.error ?? `status ${test.status}`}${test.keysTested ? ` (${test.keysTested} keys tested)` : ""}`
                            }
                            className={
                              test.ok
                                ? "text-green-600"
                                : "cursor-pointer text-red-500 underline decoration-dotted underline-offset-2"
                            }
                          >
                            {test.ok ? "✓" : `✗ ${test.status}`}
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
                <div className="mt-1.5 text-[10px] text-gray-400">
                  {probeModelFor(u) ? (
                    <>
                      Probe model:{" "}
                      <code className="rounded bg-gray-100 px-1 py-0.5">
                        {probeModelFor(u)}
                      </code>
                      {!u.healthCheckModel && (
                        <span> (auto: first non-wildcard model)</span>
                      )}
                    </>
                  ) : (
                    <span className="text-amber-500">
                      No probe model — unhealthy upstream cannot auto-recover
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded border border-gray-100 bg-gray-50/60 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-gray-500">Balance</span>
                  <span className="text-[10px] text-gray-300">
                    {new Date(u.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <input
                    value={balanceInput[u.id] ?? u.balance ?? ""}
                    onChange={(e) =>
                      setBalanceInput((prev) => ({ ...prev, [u.id]: e.target.value }))
                    }
                    placeholder="0"
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => handleSaveBalance(u)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRefreshBalance(u)}
                    disabled={refreshingBalance[u.id]}
                    className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                  >
                    {refreshingBalance[u.id] ? "..." : "↻"}
                  </button>
                  {u.balanceUpdatedAt && (
                    <span className="text-[10px] text-gray-300">
                      updated {new Date(u.balanceUpdatedAt).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>

              <div className="md:col-span-2 rounded border border-gray-100 p-2">
                <span className="text-xs font-medium text-gray-500">API Keys</span>
                <div className="mt-1.5 space-y-1">
                  {(keysByUpstream[u.id] || []).map((key) => (
                    <div key={key.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${key.enabled ? "bg-green-500" : "bg-gray-300"}`}
                        title={key.enabled ? "Enabled" : "Disabled — excluded from routing"}
                      />
                      <code className="max-w-[180px] truncate rounded bg-gray-100 px-1.5 py-0.5 text-[11px]">
                        {key.maskedKey}
                      </code>
                      {!key.enabled && (
                        <span
                          className="rounded bg-gray-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                          title="Disabled — this key is not used for routing or failover. Click Enable to restore."
                        >
                          disabled
                        </span>
                      )}
                      {key.lastStatus && (
                        <span className="text-[11px] text-gray-400">last: {key.lastStatus}</span>
                      )}
                      <span
                        className="text-[11px] text-gray-400"
                        title={`Added ${new Date(key.createdAt).toLocaleString()}`}
                      >
                        {new Date(key.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                  {keysByUpstream[u.id]?.length === 0 && (
                    <p className="text-xs text-gray-400">No keys. Add keys via Edit.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="flex h-full w-full flex-col rounded-none bg-white shadow-xl md:h-auto md:max-w-md md:rounded-lg">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h3 className="font-semibold">Delete upstream</h3>
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="text-2xl leading-none text-gray-400 hover:text-gray-600"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <p className="text-sm text-gray-700">
                Delete upstream{" "}
                <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">
                  {pendingDelete.name}
                </code>
                ? Its usage records are kept in history.
              </p>
              <label className="mt-4 flex items-center gap-3 min-h-[40px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={hideHistory}
                  onChange={(e) => setHideHistory(e.target.checked)}
                  className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">
                  Also hide its historical data
                </span>
              </label>
              <p className="mt-1 text-xs text-gray-400">
                Adds it to Hidden Sources (Display tab) so its records disappear
                from filters and totals. Uncheck later to restore.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
