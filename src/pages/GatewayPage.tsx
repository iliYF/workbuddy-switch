import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { RefreshCw, Server, ArrowLeftRight, Trash2, Plug } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OAuthLoginDialog } from "@/components/oauth-login-dialog";
import * as api from "@/lib/api";
import { asError } from "@/lib/api";
import type {
  GatewayConfig,
  GatewayStatus,
  Wb2apiConfig,
  Wb2apiModel,
  Wb2apiPoolAccounts,
  Wb2apiPoolSummary,
  Wb2apiStats,
} from "@/lib/types";
import { useAccountsStore } from "@/stores/accounts";

function StatusBadge({ state }: { state: Wb2apiPoolAccounts["accounts"][number]["pool"] }) {
  if (!state) return <Badge variant="secondary">未在池中</Badge>;
  if (state.manual_disabled) return <Badge variant="destructive">手动停用</Badge>;
  if (state.disabled) return <Badge variant="destructive">禁用</Badge>;
  if (state.cooling) return <Badge variant="outline">冷却中</Badge>;
  return <Badge>正常</Badge>;
}

function SummaryCards({ summary }: { summary: Wb2apiPoolSummary | null }) {
  const items = [
    { label: "总数", value: summary?.total ?? "-" },
    { label: "健康", value: summary?.healthy ?? "-" },
    { label: "冷却", value: summary?.cooling ?? "-" },
    { label: "禁用", value: summary?.disabled ?? "-" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label}>
          <CardContent className="py-4 text-center">
            <div className="text-2xl font-semibold tabular-nums">{item.value}</div>
            <div className="text-xs text-muted-foreground">{item.label}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function GatewayPage() {
  const localAccounts = useAccountsStore((s) => s.accounts);
  const reconcileAccounts = useAccountsStore((s) => s.reconcileAccounts);

  const [config, setConfig] = useState<Wb2apiConfig | null>(null);
  const [pool, setPool] = useState<Wb2apiPoolAccounts | null>(null);
  const [summary, setSummary] = useState<Wb2apiPoolSummary | null>(null);
  const [stats, setStats] = useState<Wb2apiStats | null>(null);
  const [models, setModels] = useState<Wb2apiModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("pool");

  // 纳管
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [onboarding, setOnboarding] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);

  // 配置表单
  const [form, setForm] = useState<Wb2apiConfig | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);

  // 上游 config.json 编辑
  const [upstreamText, setUpstreamText] = useState("");
  const [upstreamPath, setUpstreamPath] = useState("");
  const [loadingUpstream, setLoadingUpstream] = useState(false);
  const [savingUpstream, setSavingUpstream] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [connOpen, setConnOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [catalogSource, setCatalogSource] = useState("");

  // 网关托管
  const [gw, setGw] = useState<GatewayStatus | null>(null);
  const [gwForm, setGwForm] = useState<GatewayConfig | null>(null);
  const [gwBusy, setGwBusy] = useState(false);

  const configured = Boolean(config && (config.authDir || config.baseUrl));

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const cfg = await api.wb2api.getConfig();
      setConfig(cfg);
      setForm(cfg);
      // 网关托管状态与对接配置相互独立,始终获取。
      const gwRes = await api.wb2api.gatewayStatus().catch(() => null);
      setGw(gwRes);
      setGwForm((f) => f ?? gwRes?.config ?? null);
      if (cfg.authDir || cfg.baseUrl) {
        const [p, summaryRes, statsRes, catalogRes] = await Promise.all([
          api.wb2api.poolAccounts(),
          api.wb2api.status().catch(() => null),
          api.wb2api.stats().catch(() => null),
          api.wb2api.modelCatalog().catch(() => null),
        ]);
        setPool(p);
        setSummary(summaryRes);
        setStats(statsRes);
        setModels(catalogRes?.models ?? []);
        setCatalogSource(catalogRes?.source_label ?? "上游");
      }
    } catch (e) {
      setError(asError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // webui 轮询模式:每 20s 刷新一次池账号。
  useEffect(() => {
    if (!configured) return;
    const timer = window.setInterval(() => {
      void api.wb2api.poolAccounts().then(setPool).catch(() => {});
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [configured]);

  async function handleOnboard() {
    if (!selectedAccountId) return;
    setOnboarding(true);
    try {
      const res = await api.wb2api.onboard(selectedAccountId);
      toast.success("已纳管到网关", { description: `${res.uid} · 5s 内热加载入池` });
      setSelectedAccountId("");
      void loadAll();
    } catch (e) {
      toast.error("纳管失败", { description: asError(e) });
    } finally {
      setOnboarding(false);
    }
  }

  async function handleAccountOp(uid: string, op: "disable" | "enable" | "revive") {
    try {
      await api.wb2api.accountOp(uid, op);
      toast.success("操作成功");
      void loadAll();
    } catch (e) {
      toast.error("操作失败", { description: asError(e) });
    }
  }

  async function handleOffboard(uid: string) {
    if (!window.confirm(`确定把 ${uid} 从网关池移除?凭证文件将被删除。`)) return;
    try {
      await api.wb2api.offboard(uid);
      toast.success("已移除");
      void loadAll();
    } catch (e) {
      toast.error("移除失败", { description: asError(e) });
    }
  }

  async function handleSaveConfig() {
    if (!form) return;
    setSavingConfig(true);
    try {
      const saved = await api.wb2api.saveConfig(form);
      setConfig(saved);
      toast.success("对接配置已保存");
      void loadAll();
    } catch (e) {
      toast.error("保存失败", { description: asError(e) });
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleLoadUpstream() {
    setLoadingUpstream(true);
    try {
      const res = await api.wb2api.getUpstreamConfig();
      setUpstreamPath(res.path);
      setUpstreamText(JSON.stringify(res.config, null, 2));
    } catch (e) {
      toast.error("读取失败", { description: asError(e) });
    } finally {
      setLoadingUpstream(false);
    }
  }

  async function handleSaveUpstream() {
    setSavingUpstream(true);
    try {
      const parsed = JSON.parse(upstreamText);
      await api.wb2api.saveUpstreamConfig(parsed);
      toast.success("config.json 已保存(已自动备份 .bak)");
    } catch (e) {
      toast.error("保存失败", { description: asError(e) });
    } finally {
      setSavingUpstream(false);
    }
  }

  async function refreshGw() {
    const s = await api.wb2api.gatewayStatus();
    setGw(s);
    setGwForm((f) => f ?? s.config);
  }

  async function handleGwStart() {
    setGwBusy(true);
    try {
      await api.wb2api.gatewayStart();
      toast.success("网关已启动");
      await refreshGw();
    } catch (e) {
      toast.error("启动失败", { description: asError(e) });
    } finally {
      setGwBusy(false);
    }
  }

  async function handleGwStop() {
    setGwBusy(true);
    try {
      await api.wb2api.gatewayStop();
      toast.success("网关已停止");
      await refreshGw();
    } catch (e) {
      toast.error("停止失败", { description: asError(e) });
    } finally {
      setGwBusy(false);
    }
  }

  async function handleGwSaveConfig() {
    if (!gwForm) return;
    try {
      const saved = await api.wb2api.gatewaySaveConfig(gwForm);
      setGwForm(saved);
      toast.success("网关配置已保存");
    } catch (e) {
      toast.error("保存失败", { description: asError(e) });
    }
  }

  const [syncResult, setSyncResult] = useState("");

  async function handleGwSync() {
    setGwBusy(true);
    try {
      const res = await api.wb2api.gatewaySyncNow();
      setSyncResult(
        res.error
          ? `同步失败: ${res.error}`
          : `已导出 ${res.exported} 个、清理 ${res.removed} 个(共 ${res.accounts} 个账号)`,
      );
      toast.success("账号已同步到网关 auths");
    } catch (e) {
      toast.error("同步失败", { description: asError(e) });
    } finally {
      setGwBusy(false);
    }
  }

  const [gwUpdateMsg, setGwUpdateMsg] = useState("");
  const [gwUpdating, setGwUpdating] = useState(false);

  async function handleGwCheckUpdate() {
    setGwUpdating(true);
    try {
      const r = await api.wb2api.gatewayCheckUpdate();
      setGwUpdateMsg(
        r.available ? `更新可用: ${r.path || r.url || ""}${r.size ? ` (${r.size} 字节)` : ""}` : `无可用更新: ${r.message ?? ""}`,
      );
    } catch (e) {
      setGwUpdateMsg(asError(e));
    } finally {
      setGwUpdating(false);
    }
  }

  async function handleGwApplyUpdate() {
    setGwUpdating(true);
    try {
      const r = await api.wb2api.gatewayApplyUpdate();
      setGwUpdateMsg(
        r.ok
          ? `已更新 ${r.bin}(${r.size} 字节)${r.restarted ? ",网关已重启" : ""}${r.restart_error ? `,重启失败: ${r.restart_error}` : ""}`
          : "更新失败",
      );
      await refreshGw();
    } catch (e) {
      setGwUpdateMsg(`更新失败: ${asError(e)}`);
    } finally {
      setGwUpdating(false);
    }
  }

  const setGwField = (key: keyof GatewayConfig) => (e: ChangeEvent<HTMLInputElement>) =>
    setGwForm((f) => (f ? { ...f, [key]: e.target.value } : f));

  const onboardOptions = useMemo(
    () =>
      localAccounts.filter((a) => a.uid).map((a) => ({
        id: a.id,
        label: a.nickname || a.email || a.uid || a.id,
      })),
    [localAccounts],
  );

  const set = (key: keyof Wb2apiConfig) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => (f ? { ...f, [key]: e.target.value } : f));

  // 接入信息(cc-switch / OpenAI 兼容客户端)
  const connBaseUrl = (config?.baseUrl || form?.baseUrl || "").trim().replace(/\/+$/, "");
  const connApiKey = config?.apiKey || form?.apiKey || "";
  const connBaseUrlV1 = `${connBaseUrl || "http://127.0.0.1:7863"}/v1`;
  const maskedKey = connApiKey ? `${connApiKey.slice(0, 4)}••••${connApiKey.slice(-4)}` : "(未配置,填写 apiKey 后生效)";
  const sampleModels = models.slice(0, 8).map((m) => m.id);

  // ── 模型中心:系列分类(按 id 前缀推导,与 manager modelcatalog 同口径) ──
  const SERIES_RULES: [string[], string][] = [
    [["glm"], "智谱 GLM"],
    [["deepseek"], "DeepSeek"],
    [["kimi", "moonshot"], "Kimi"],
    [["minimax"], "MiniMax"],
    [["hy", "hunyuan"], "腾讯混元"],
    [["auto"], "自动选择"],
  ];
  function seriesOf(modelId: string): string {
    const mid = modelId.toLowerCase();
    for (const [prefixes, label] of SERIES_RULES) {
      if (prefixes.some((p) => mid.startsWith(p))) return label;
    }
    return "其他";
  }
  function bareModelId(id: string): string {
    return id.split(":").pop() ?? id;
  }

  const modelGroups = useMemo(() => {
    const groups = new Map<string, Wb2apiModel[]>();
    const q = modelQuery.trim().toLowerCase();
    for (const m of models) {
      if (
        q &&
        ![m.id, m.name ?? "", m.description ?? ""].some((s) => s.toLowerCase().includes(q))
      ) {
        continue;
      }
      const series = seriesOf(bareModelId(m.id));
      if (!groups.has(series)) groups.set(series, []);
      groups.get(series)!.push(m);
    }
    const entries = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh"));
    for (const [, list] of entries) {
      list.sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) || a.id.localeCompare(b.id));
    }
    return entries;
  }, [models, modelQuery]);

  const modelSummary = useMemo(() => {
    const reasoning = models.filter(
      (m) => m.supports_reasoning || m.only_reasoning || (m.reasoning_supported_efforts?.length ?? 0) > 0,
    ).length;
    const large = models.filter((m) => (m.context_length ?? 0) >= 131072).length;
    const maxCtx = Math.max(0, ...models.map((m) => m.context_length ?? 0));
    return { total: models.length, reasoning, large, maxCtx };
  }, [models]);

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label}已复制`);
    } catch {
      toast.error("复制失败", { description: "请手动选中复制" });
    }
  }

  // 扫码新增关闭时回写本地账号库,让「纳管」下拉拿到新账号。
  const prevOauthOpen = useRef(false);
  useEffect(() => {
    if (prevOauthOpen.current && !oauthOpen) {
      void reconcileAccounts();
    }
    prevOauthOpen.current = oauthOpen;
  }, [oauthOpen, reconcileAccounts]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Server className="size-5" /> 网关管理
          </h1>
          <p className="text-sm text-muted-foreground">
            对接 workbuddy2api:纳管账号入池、查看池状态与用量、维护配置。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setConnOpen(true)}
            title="接入配置(WorkBuddy Provider)"
            aria-label="接入配置"
          >
            <Plug className="size-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => void loadAll()} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> 刷新
          </Button>
        </div>
      </div>

      <Dialog open={connOpen} onOpenChange={setConnOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>接入配置 · WorkBuddy Provider</DialogTitle>
            <DialogDescription>
              把本反代作为 Provider 配到客户端(cc-switch / Codex / OpenAI 兼容工具)所需的关键信息。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Base URL(OpenAI 兼容)</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs">
                  {connBaseUrlV1}
                </code>
                <Button size="sm" variant="outline" onClick={() => void copyText(connBaseUrlV1, "Base URL")}>
                  复制
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>API Key</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs">
                  {showKey ? connApiKey || "(未配置)" : maskedKey}
                </code>
                <Button size="sm" variant="outline" onClick={() => setShowKey((s) => !s)}>
                  {showKey ? "隐藏" : "显示"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void copyText(connApiKey, "API Key")}
                  disabled={!connApiKey}
                >
                  复制
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label>模型(带 cn:/global: 前缀)</Label>
            {sampleModels.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {sampleModels.map((id) => (
                  <Badge key={id} variant="secondary">
                    {id}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">池有账号后模型列表会自动出现,如 cn:hy3-x。</p>
            )}
          </div>

          <Separator />

          <div className="space-y-2 text-sm">
            <div className="font-medium">在 cc-switch 中添加 WorkBuddy Provider:</div>
            <ol className="list-inside list-decimal space-y-1 text-muted-foreground">
              <li>打开 cc-switch,新建 Provider(类型按客户端选:Claude Code 走 Anthropic / Codex、Cherry Studio 等走 OpenAI)</li>
              <li>
                Base URL:OpenAI 兼容客户端填 <code>{connBaseUrlV1}</code>;Anthropic 客户端(Claude Code)填{" "}
                <code>{connBaseUrl || "http://127.0.0.1:7863"}</code>(不带 /v1)
              </li>
              <li>API Key 填上方密钥(直连 wb2api 用 apiKey;若走 manager 网关用其签发的 wbk_ 密钥)</li>
              <li>模型填上方列表中的带前缀模型名(如 cn:hy3-x),可自定义)</li>
            </ol>
          </div>

          <Alert>
            <Server className="size-4" />
            <AlertDescription>
              直连 wb2api 用上方信息(base={connBaseUrlV1})。若要用 manager 网关(带密钥分发/配额/模型白名单),改填{" "}
              <code>http://127.0.0.1:7864/v1</code> + manager 签发的 <code>wbk_…</code> 密钥。
            </AlertDescription>
          </Alert>
          </div>
        </DialogContent>
      </Dialog>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!configured && !loading && (
        <Alert>
          <Server className="size-4" />
          <AlertTitle>尚未配置网关对接</AlertTitle>
          <AlertDescription>
            请到「配置」页填写 workbuddy2api 的 baseUrl / apiKey / authDir 后即可纳管账号与查看池状态。
          </AlertDescription>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="pool">池账号</TabsTrigger>
          <TabsTrigger value="stats">统计</TabsTrigger>
          <TabsTrigger value="config">配置</TabsTrigger>
          <TabsTrigger value="manage">托管</TabsTrigger>
        </TabsList>

        <TabsContent value="pool" className="space-y-4">
          {configured ? (
            <>
              <SummaryCards summary={summary} />

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">纳管账号</CardTitle>
                  <CardDescription>
                    把本地账号库的账号推入网关池(写入 auths 目录,5s 热加载)。
                    与桌面切换共用同一批腾讯账号。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-[220px] flex-1 space-y-1.5">
                      <Label>选择本地账号</Label>
                      <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                        <SelectTrigger>
                          <SelectValue placeholder="选择要纳管的账号" />
                        </SelectTrigger>
                        <SelectContent>
                          {onboardOptions.length === 0 && (
                            <div className="px-2 py-1.5 text-sm text-muted-foreground">
                              本地账号库为空,请先扫码添加
                            </div>
                          )}
                          {onboardOptions.map((opt) => (
                            <SelectItem key={opt.id} value={opt.id}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      onClick={() => void handleOnboard()}
                      disabled={!selectedAccountId || onboarding}
                    >
                      <Plug className="size-4" /> {onboarding ? "纳管中…" : "纳管到网关"}
                    </Button>
                    <Button variant="outline" onClick={() => setOauthOpen(true)}>
                      <ArrowLeftRight className="size-4" /> 扫码新增账号
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">池账号</CardTitle>
                  <CardDescription>
                    {pool?.configured
                      ? `${pool.accounts.length} 个凭证文件;状态来自 /status`
                      : "未配置 authDir,仅显示池状态"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {loading && !pool ? (
                    <Skeleton className="h-24 w-full" />
                  ) : pool && pool.accounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">auths 目录中没有账号。</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>昵称</TableHead>
                          <TableHead>UID</TableHead>
                          <TableHead>域</TableHead>
                          <TableHead>积分</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead className="text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(pool?.accounts ?? []).map((acc) => (
                          <TableRow key={acc.uid}>
                            <TableCell className="font-medium">
                              {acc.nickname || acc.uid}
                            </TableCell>
                            <TableCell className="font-mono text-xs">{acc.uid.slice(0, 8)}</TableCell>
                            <TableCell className="text-xs">{acc.realm || "cn"}</TableCell>
                            <TableCell className="tabular-nums">
                              {acc.pool ? acc.pool.credits : "—"}
                            </TableCell>
                            <TableCell>
                              <StatusBadge state={acc.pool} />
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1.5">
                                {acc.pool?.manual_disabled ? (
                                  <Button size="sm" variant="outline" onClick={() => void handleAccountOp(acc.uid, "enable")}>
                                    启用
                                  </Button>
                                ) : (
                                  <Button size="sm" variant="outline" onClick={() => void handleAccountOp(acc.uid, "disable")}>
                                    停用
                                  </Button>
                                )}
                                {acc.pool?.disabled && (
                                  <Button size="sm" variant="secondary" onClick={() => void handleAccountOp(acc.uid, "revive")}>
                                    复活
                                  </Button>
                                )}
                                <Button size="sm" variant="ghost" onClick={() => void handleOffboard(acc.uid)}>
                                  <Trash2 className="size-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </>
          ) : null}
        </TabsContent>

        <TabsContent value="stats" className="space-y-4">
          {configured ? (
            <>
              <SummaryCards summary={summary} />
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">模型中心</CardTitle>
                  <CardDescription>
                    共 {modelSummary.total} 个 · 推理 {modelSummary.reasoning} · 大上下文(≥128K){" "}
                    {modelSummary.large} · 最大上下文 {modelSummary.maxCtx.toLocaleString()} · 来源{" "}
                    {catalogSource}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {models.length === 0 ? (
                    <p className="text-sm text-muted-foreground">暂无模型(可能无健康账号或拉取失败)。</p>
                  ) : (
                    <>
                      <Input
                        value={modelQuery}
                        onChange={(e) => setModelQuery(e.target.value)}
                        placeholder="搜索模型(id / 名称 / 描述)…"
                        className="max-w-sm"
                      />
                      {modelGroups.length === 0 ? (
                        <p className="text-sm text-muted-foreground">没有匹配的模型。</p>
                      ) : (
                        <div className="max-h-[480px] space-y-5 overflow-y-auto pr-1">
                          {modelGroups.map(([series, list]) => (
                            <div key={series} className="space-y-2">
                              <div className="flex items-center gap-2 text-sm font-medium">
                                {series}
                                <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                                  {list.length}
                                </span>
                              </div>
                              <div className="grid gap-2 lg:grid-cols-2">
                                {list.map((m) => {
                                  const bare = bareModelId(m.id);
                                  const capBadges = [
                                    m.is_default && "默认",
                                    m.credits && `倍率 ${m.credits}`,
                                    m.supports_images && "图像",
                                    m.supports_reasoning && "推理",
                                    m.supports_tool_call && "工具",
                                  ].filter(Boolean) as string[];
                                  return (
                                    <div
                                      key={m.id}
                                      className="rounded-lg border bg-card p-3 text-sm shadow-none"
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="font-medium">{m.name || bare}</span>
                                        <span className="font-mono text-xs text-muted-foreground">
                                          {bare}
                                        </span>
                                      </div>
                                      {m.description ? (
                                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                          {m.description}
                                        </p>
                                      ) : null}
                                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                        <Badge variant="secondary">{(m.context_length ?? 0) >= 1024 ? `${Math.round((m.context_length ?? 0) / 1024)}K` : m.context_length ?? "—"}</Badge>
                                        {m.reasoning_effort || m.reasoning_summary ? (
                                          <Badge variant="outline">
                                            {m.reasoning_effort || m.reasoning_summary}
                                          </Badge>
                                        ) : null}
                                        {capBadges.map((b) => (
                                          <Badge key={b} variant="outline">
                                            {b}
                                          </Badge>
                                        ))}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">请求统计</CardTitle>
                  <CardDescription>来自 /v1/stats(进程内计数,重启清零)</CardDescription>
                </CardHeader>
                <CardContent>
                  {!stats || stats.models.length === 0 ? (
                    <p className="text-sm text-muted-foreground">暂无统计。</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>模型</TableHead>
                          <TableHead className="text-right">请求</TableHead>
                          <TableHead className="text-right">成功</TableHead>
                          <TableHead className="text-right">失败</TableHead>
                          <TableHead className="text-right">流式</TableHead>
                          <TableHead className="text-right">Token(总)</TableHead>
                          <TableHead className="text-right">Credit</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {stats.models.map((m) => (
                          <TableRow key={m.model}>
                            <TableCell className="font-mono text-xs">{m.model || "(合计)"}</TableCell>
                            <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                            <TableCell className="text-right tabular-nums">{m.success}</TableCell>
                            <TableCell className="text-right tabular-nums">{m.failed}</TableCell>
                            <TableCell className="text-right tabular-nums">{m.streaming}</TableCell>
                            <TableCell className="text-right tabular-nums">{m.total_tokens}</TableCell>
                            <TableCell className="text-right tabular-nums">{m.credit.toFixed(3)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </>
          ) : null}
        </TabsContent>

        <TabsContent value="config" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">对接配置</CardTitle>
              <CardDescription>存于 ~/.wbh/wb2api.json(workbuddy-hub 数据根)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>baseUrl</Label>
                  <Input value={form?.baseUrl ?? ""} onChange={set("baseUrl")} placeholder="http://127.0.0.1:7863" />
                </div>
                <div className="space-y-1.5">
                  <Label>apiKey</Label>
                  <Input value={form?.apiKey ?? ""} onChange={set("apiKey")} placeholder="留空=不鉴权" type="password" />
                </div>
                <div className="space-y-1.5">
                  <Label>authDir</Label>
                  <Input value={form?.authDir ?? ""} onChange={set("authDir")} placeholder="wb2api 部署的 auths/ 绝对路径" />
                </div>
                <div className="space-y-1.5">
                  <Label>configPath(可选)</Label>
                  <Input value={form?.configPath ?? ""} onChange={set("configPath")} placeholder="wb2api 的 config.json 路径" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={() => void handleSaveConfig()} disabled={savingConfig || !form}>
                  {savingConfig ? "保存中…" : "保存对接配置"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">上游 config.json</CardTitle>
              <CardDescription>
                直接编辑 wb2api 的 config.json(仅本机可用;保存前自动备份为 .bak,需先配置 configPath)。
                改 admin.enabled / global.enabled / cooldown 等需重启 wb2api 生效。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void handleLoadUpstream()} disabled={loadingUpstream}>
                  {loadingUpstream ? "读取中…" : "读取 config.json"}
                </Button>
                {upstreamPath && <span className="text-xs text-muted-foreground">{upstreamPath}</span>}
              </div>
              <textarea
                value={upstreamText}
                onChange={(e) => setUpstreamText(e.target.value)}
                spellCheck={false}
                placeholder="点击「读取 config.json」后在此编辑 JSON…"
                className="min-h-[240px] w-full rounded-md border bg-muted/40 p-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
              <Button onClick={() => void handleSaveUpstream()} disabled={savingUpstream || !upstreamText}>
                {savingUpstream ? "保存中…" : "保存 config.json"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="manage" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">网关托管</CardTitle>
              <CardDescription>
                托管独立的 workbuddy2api 二进制:起停/健康/端口/工作模式;升级走独立通道,与客户端解耦。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant={gw?.running ? (gw.healthy ? "default" : "destructive") : "secondary"}>
                  {gw?.running ? (gw.healthy ? "运行中" : "运行但不健康") : "未运行"}
                </Badge>
                <span className="text-sm text-muted-foreground">端口 {gw?.port ?? gwForm?.port ?? 7863}</span>
                {gw?.bin && <span className="text-xs text-muted-foreground">{gw.bin}</span>}
                <div className="ml-auto flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => void handleGwSync()} disabled={gwBusy}>
                    立即同步账号
                  </Button>
                  <Button size="sm" onClick={() => void handleGwStart()} disabled={gwBusy || gw?.running}>
                    {gwBusy ? "处理中…" : "启动"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void handleGwStop()} disabled={gwBusy || !gw?.running}>
                    停止
                  </Button>
                </div>
              </div>
              {syncResult && <p className="text-sm text-muted-foreground">{syncResult}</p>}

              <Separator />

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>bin_path(留空自动找 ~/.wbh/gateway/bin)</Label>
                  <Input value={gwForm?.bin_path ?? ""} onChange={setGwField("bin_path")} placeholder="/path/to/wb2api" />
                </div>
                <div className="space-y-1.5">
                  <Label>端口</Label>
                  <Input
                    type="number"
                    value={gwForm?.port ?? 7863}
                    onChange={(e) =>
                      setGwForm((f) => (f ? { ...f, port: Number(e.target.value) || 7863 } : f))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>api_key(留空=不鉴权)</Label>
                  <Input value={gwForm?.api_key ?? ""} onChange={setGwField("api_key")} type="password" placeholder="留空=不鉴权" />
                </div>
                <div className="space-y-1.5">
                  <Label>升级源 update_source(二进制 URL 或本地路径)</Label>
                  <Input value={gwForm?.update_source ?? ""} onChange={setGwField("update_source")} placeholder="https://…/wb2api 或 /path/to/wb2api" />
                </div>
                <div className="space-y-1.5">
                  <Label>工作模式</Label>
                  <Select
                    value={gwForm?.mode ?? "balance"}
                    onValueChange={(v) => setGwForm((f) => (f ? { ...f, mode: v as GatewayConfig["mode"] } : f))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="balance">负载均衡</SelectItem>
                      <SelectItem value="pinned">指定账号</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {gwForm?.mode === "pinned" && (
                  <div className="space-y-1.5">
                    <Label>指定账号 uid</Label>
                    <Input
                      value={gwForm?.pinned_uid ?? ""}
                      onChange={(e) => setGwForm((f) => (f ? { ...f, pinned_uid: e.target.value } : f))}
                      placeholder="账号 uid"
                    />
                  </div>
                )}
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={gwForm?.auto_start ?? false}
                      onCheckedChange={(v) => setGwForm((f) => (f ? { ...f, auto_start: v } : f))}
                    />
                    随 App 启动
                  </label>
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="font-medium text-sm">网关独立升级(与客户端升级解耦)</div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => void handleGwCheckUpdate()} disabled={gwUpdating}>
                    {gwUpdating ? "处理中…" : "检查更新"}
                  </Button>
                  <Button size="sm" onClick={() => void handleGwApplyUpdate()} disabled={gwUpdating}>
                    下载并替换(可选 sha256 校验,网关在跑则重启)
                  </Button>
                </div>
                {gwUpdateMsg && <p className="text-sm text-muted-foreground">{gwUpdateMsg}</p>}
              </div>

              <Button onClick={() => void handleGwSaveConfig()} disabled={!gwForm}>
                保存网关配置
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <OAuthLoginDialog open={oauthOpen} onOpenChange={setOauthOpen} />
    </div>
  );
}
