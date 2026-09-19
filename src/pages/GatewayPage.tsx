import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  RefreshCw,
  Server,
  ArrowLeftRight,
  Trash2,
  Plug,
  Shuffle,
  UserRound,
  Square,
  Play,
  Loader2,
  Zap,
  Copy,
  Recycle,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { cn } from "@/lib/utils";

function StatusBadge({ state }: { state: Wb2apiPoolAccounts["accounts"][number]["pool"] }) {
  if (!state) return <Badge variant="secondary">未在池中</Badge>;
  if (state.manual_disabled) return <Badge variant="destructive">手动停用</Badge>;
  if (state.disabled) return <Badge variant="destructive">禁用</Badge>;
  if (state.cooling) return <Badge variant="outline">冷却中</Badge>;
  return <Badge>正常</Badge>;
}

/** 小节:卡片外的小标题 + Card(flex-1 让同栅格行等高)。 */
function Section({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col space-y-2.5", className)}>
      <div className="px-1">
        <h2 className="text-[13px] font-medium leading-5">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <Card className="min-w-0 flex-1 gap-0 overflow-hidden rounded-xl py-0 shadow-none">{children}</Card>
    </section>
  );
}

/** 卡片内的设置/状态行(border-b 分隔,末行无边框)。 */
function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "mx-4 flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border/50 py-2.5 last:border-b-0 sm:mx-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 状态小方块(label + 值 + 可选色调)。 */
function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "ok" | "warn" | "off";
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 truncate text-[15px] font-medium tabular-nums",
          tone === "ok" && "text-emerald-600 dark:text-emerald-400",
          tone === "warn" && "text-amber-600 dark:text-amber-400",
          tone === "off" && "text-muted-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function SummaryStats({ summary }: { summary: Wb2apiPoolSummary | null }) {
  return (
    <div className="mx-4 grid grid-cols-2 gap-2 py-3 sm:mx-5 sm:grid-cols-4">
      <Stat label="总数" value={summary?.total ?? "—"} />
      <Stat label="健康" value={summary?.healthy ?? "—"} tone={(summary?.healthy ?? 0) > 0 ? "ok" : "warn"} />
      <Stat label="冷却 / 禁用" value={`${summary?.cooling ?? 0} / ${summary?.disabled ?? 0}`} tone="warn" />
      <Stat label="粘性会话" value={summary?.sticky_sessions ?? 0} />
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
  const [activeTab, setActiveTab] = useState("gateway");
  const [gwSubTab, setGwSubTab] = useState("status");

  // 纳管
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [onboarding, setOnboarding] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);

  // 对接配置(由网关设置自动派生,只读用于状态判断)
  const [form, setForm] = useState<Wb2apiConfig | null>(null);

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
  async function handleGwPickPort() {
    try {
      const r = await api.wb2api.gatewayPickPort();
      setGwForm((f) => (f ? { ...f, port: r.port } : f));
      toast.success(`已选空闲端口 ${r.port}`);
    } catch (e) {
      toast.error("选端口失败", { description: asError(e) });
    }
  }

  /** 勾选/取消某账号入网关池(持久化到 gateway.json pool_uids)。 */
  async function togglePoolUid(uid: string) {
    if (!gwForm || !uid) return;
    const cur = gwForm.pool_uids ?? [];
    const next = cur.includes(uid) ? cur.filter((u) => u !== uid) : [...cur, uid];
    try {
      const saved = await api.wb2api.gatewaySaveConfig({ ...gwForm, pool_uids: next });
      setGwForm(saved);
      toast.success(next.includes(uid) ? "已加入网关池选择" : "已移出网关池选择");
    } catch (e) {
      toast.error("保存失败", { description: asError(e) });
    }
  }

  /** 切换某账号的「永不入池」标记(持久化到 no_sync_uids)。 */
  async function toggleNoSyncUid(uid: string) {
    if (!gwForm || !uid) return;
    const cur = gwForm.no_sync_uids ?? [];
    const next = cur.includes(uid) ? cur.filter((u) => u !== uid) : [...cur, uid];
    try {
      const saved = await api.wb2api.gatewaySaveConfig({ ...gwForm, no_sync_uids: next });
      setGwForm(saved);
      toast.success(next.includes(uid) ? "已设为永不入池" : "已取消永不入池");
    } catch (e) {
      toast.error("保存失败", { description: asError(e) });
    }
  }

  /** 生成随机访问密钥(wbs- 前缀)。 */
  async function handleGenKey() {
    try {
      const r = await api.wb2api.gatewayGenKey();
      setGwForm((f) => (f ? { ...f, api_key: r.api_key } : f));
      toast.success("已生成访问密钥(记得保存)");
    } catch (e) {
      toast.error("生成失败", { description: asError(e) });
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

  // 接入信息(cc-switch / OpenAI 兼容客户端)
  const connBaseUrl = (config?.baseUrl || form?.baseUrl || "").trim().replace(/\/+$/, "");
  const connApiKey = config?.apiKey || form?.apiKey || "";
  const connBaseUrlV1 = `${connBaseUrl || "http://127.0.0.1:54321"}/v1`;
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
    <div className="mx-auto w-full max-w-[1800px] space-y-6 px-5 py-6 sm:px-8 sm:py-8">
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-medium leading-6">
            <Server className="size-4.5 shrink-0" /> 网关管理
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            对接 workbuddy2api:纳管账号入池、查看池状态与用量、维护配置。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setConnOpen(true)}>
            <Plug className="size-3.5" /> 接入配置
          </Button>
          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => void loadAll()} disabled={loading} aria-label="刷新">
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>
      </header>

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
                <code>{connBaseUrl || "http://127.0.0.1:54321"}</code>(不带 /v1)
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
          <TabsTrigger value="gateway">网关</TabsTrigger>
          <TabsTrigger value="models">模型</TabsTrigger>
          <TabsTrigger value="usage">用量</TabsTrigger>
        </TabsList>

        <TabsContent value="models" className="space-y-6">
          {configured ? (
            <Section
              title="模型中心"
              description={`共 ${modelSummary.total} 个 · 推理 ${modelSummary.reasoning} · 大上下文(≥128K) ${modelSummary.large} · 最大上下文 ${modelSummary.maxCtx.toLocaleString()} · 来源 ${catalogSource}`}
            >
                <div className="min-w-0 px-4 pt-3 pb-4 sm:px-5 space-y-4">
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
                </div>
            </Section>
          ) : null}
        </TabsContent>

        <TabsContent value="usage" className="space-y-6">
          <Section title="账号池概览" description="状态每 20 秒自动刷新">
            <SummaryStats summary={summary} />
          </Section>
          <Section title="请求统计" description="来自 /v1/stats(进程内计数,重启清零)">
            <div className="min-w-0 px-4 pt-3 pb-4 sm:px-5">
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
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="gateway" className="space-y-6">
          <Tabs value={gwSubTab} onValueChange={setGwSubTab}>
            <TabsList>
              <TabsTrigger value="status">状态</TabsTrigger>
              <TabsTrigger value="settings">设置</TabsTrigger>
              <TabsTrigger value="accounts">账号池</TabsTrigger>
            </TabsList>

            <TabsContent value="status" className="space-y-6">
              <Section title="运行状态" description="账号池状态每 20 秒自动刷新">
              <div className="mx-4 grid grid-cols-2 gap-2 py-3 sm:mx-5 sm:grid-cols-4">
                <Stat
                  label="服务状态"
                  value={gw?.running ? (gw.healthy ? "运行中" : "已启动") : "未运行"}
                  tone={gw?.running ? "ok" : "off"}
                />
                <Stat label="健康账号" value={summary?.healthy ?? "—"} tone={(summary?.healthy ?? 0) > 0 ? "ok" : "warn"} />
                <Stat
                  label="冷却 / 禁用"
                  value={`${summary?.cooling ?? 0} / ${summary?.disabled ?? 0}`}
                  tone="warn"
                />
                <Stat label="粘性会话" value={summary?.sticky_sessions ?? 0} />
              </div>

              <Row>
                <div className="min-w-0">
                  <div className="text-[13px]">OpenAI 兼容接口</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{connBaseUrlV1}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="ghost" size="icon" className="size-7" onClick={() => void copyText(connBaseUrlV1, "接口地址")} aria-label="复制接口地址">
                    <Copy className="size-3.5" />
                  </Button>
                  {gw?.running ? (
                    <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void handleGwStop()} disabled={gwBusy}>
                      {gwBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
                      停止
                    </Button>
                  ) : (
                    <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void handleGwStart()} disabled={gwBusy}>
                      {gwBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                      启动网关
                    </Button>
                  )}
                </div>
              </Row>

              <Row>
                <div className="min-w-0">
                  <div className="text-[13px]">账号同步</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {gwForm?.sync_enabled ? "自动同步已开启(仅勾选账号)" : "自动同步已关闭(默认)"} · 手动纳管不受影响
                  </div>
                </div>
                <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1.5 text-xs" onClick={() => void handleGwSync()} disabled={gwBusy}>
                  <Zap className="size-3.5" />
                  立即同步
                </Button>
              </Row>
              {syncResult && <div className="mx-4 pb-3 text-[11px] text-muted-foreground sm:mx-5">{syncResult}</div>}
              </Section>
            </TabsContent>

            <TabsContent value="settings" className="space-y-6">
              <Section title="网关设置" description="工作模式、服务端口与访问密钥(保存后生效)">
              <Row className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <div className="text-[13px]">工作模式</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {gwForm?.mode === "pinned"
                      ? "只使用指定的这一个账号"
                      : gwForm?.mode === "rotation"
                        ? "只用一个账号烧到不可用再换下一个(按到期日排序)"
                        : "使用全部入池账号,负载均衡分摊"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant={gwForm?.mode === "balance" ? "default" : "outline"}
                    size="sm"
                    className="h-8 gap-1.5 px-2.5 text-xs"
                    onClick={() => setGwForm((f) => (f ? { ...f, mode: "balance" } : f))}
                  >
                    <Shuffle className="size-3.5" /> 负载均衡
                  </Button>
                  <Button
                    variant={gwForm?.mode === "rotation" ? "default" : "outline"}
                    size="sm"
                    className="h-8 gap-1.5 px-2.5 text-xs"
                    onClick={() => setGwForm((f) => (f ? { ...f, mode: "rotation" } : f))}
                  >
                    <Recycle className="size-3.5" /> 积分轮转
                  </Button>
                  <Button
                    variant={gwForm?.mode === "pinned" ? "default" : "outline"}
                    size="sm"
                    className="h-8 gap-1.5 px-2.5 text-xs"
                    onClick={() => setGwForm((f) => (f ? { ...f, mode: "pinned" } : f))}
                  >
                    <UserRound className="size-3.5" /> 指定账号
                  </Button>
                </div>
              </Row>

              {gwForm?.mode === "pinned" && (
                <Row className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                  <div className="min-w-0">
                    <Label className="text-[13px] font-normal">使用账号</Label>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {localAccounts.length ? `共 ${localAccounts.length} 个账号可选` : "账号库为空"}
                    </div>
                  </div>
                  <Select
                    value={gwForm?.pinned_uid ?? "__none__"}
                    onValueChange={(v) => setGwForm((f) => (f ? { ...f, pinned_uid: v === "__none__" ? null : v } : f))}
                  >
                    <SelectTrigger size="sm" className="w-44 shrink-0">
                      <SelectValue placeholder="(未选择)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">(未选择)</SelectItem>
                      {localAccounts.filter((a) => a.uid).map((acc) => (
                        <SelectItem key={acc.id} value={acc.uid!}>
                          {acc.nickname || acc.email || acc.uid}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Row>
              )}

              {gwForm?.mode === "rotation" && (
                <Row className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                  <div className="min-w-0">
                    <div className="text-[13px]">当前活跃账号</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      轮转由 hub 按积分到期日巡检维护;留空则由网关自身调度
                    </div>
                  </div>
                  <Select
                    value={gwForm?.rotation_uid ?? "__none__"}
                    onValueChange={(v) => setGwForm((f) => (f ? { ...f, rotation_uid: v === "__none__" ? null : v } : f))}
                  >
                    <SelectTrigger size="sm" className="w-44 shrink-0">
                      <SelectValue placeholder="(自动)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">(自动)</SelectItem>
                      {localAccounts.filter((a) => a.uid).map((acc) => (
                        <SelectItem key={acc.id} value={acc.uid!}>
                          {acc.nickname || acc.email || acc.uid}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Row>
              )}

              <Row className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <div className="text-[13px]">服务端口</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">预设或自由设置;开放接口中的地址随之变化</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Input
                    type="number"
                    className="h-8 w-24 text-xs"
                    value={gwForm?.port ?? 54321}
                    onChange={(e) => setGwForm((f) => (f ? { ...f, port: Number(e.target.value) || 54321 } : f))}
                  />
                  <Select onValueChange={(v) => setGwForm((f) => (f ? { ...f, port: Number(v) } : f))}>
                    <SelectTrigger size="sm" className="w-28">
                      <SelectValue placeholder="预设" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="54321">54321(默认)</SelectItem>
                      <SelectItem value="7863">7863</SelectItem>
                      <SelectItem value="17863">17863</SelectItem>
                      <SelectItem value="54320">54320</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => void handleGwPickPort()}>
                    自动
                  </Button>
                </div>
              </Row>

              <Row className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <div className="text-[13px]">访问密钥 API Key</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">建议设置;留空 = 不鉴权。可随机生成(wbs- 前缀)</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Input
                    value={gwForm?.api_key ?? ""}
                    onChange={setGwField("api_key")}
                    type="text"
                    placeholder="留空=不鉴权"
                    className="h-8 w-full font-mono text-xs sm:w-64"
                  />
                  <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => void handleGenKey()}>
                    <Wand2 className="size-3.5" /> 生成
                  </Button>
                </div>
              </Row>

              <Row>
                <div className="min-w-0">
                  <div className="text-[13px]">自动启动网关</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">应用启动时自动拉起网关</div>
                </div>
                <Switch checked={gwForm?.auto_start ?? false} onCheckedChange={(v) => setGwForm((f) => (f ? { ...f, auto_start: v } : f))} />
              </Row>
              <div className="flex justify-end px-4 py-3 sm:px-5">
                <Button onClick={() => void handleGwSaveConfig()} disabled={!gwForm}>
                  保存网关配置
                </Button>
              </div>
              </Section>
            </TabsContent>

            <TabsContent value="accounts" className="space-y-6">
              <Section
                title="池内账号"
                description={
                  pool?.configured
                    ? `${pool.accounts.length} 个账号在网关池中;状态来自 /status`
                    : "未配置 authDir,仅显示池状态"
                }
              >
                <div className="min-w-0 px-4 pt-3 pb-4 sm:px-5">
                  {loading && !pool ? (
                    <Skeleton className="h-24 w-full" />
                  ) : pool && pool.accounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">池内暂无账号,请在下方添加。</p>
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
                            <TableCell className="font-medium">{acc.nickname || acc.uid}</TableCell>
                            <TableCell className="font-mono text-xs">{acc.uid.slice(0, 8)}</TableCell>
                            <TableCell className="text-xs">{acc.realm || "cn"}</TableCell>
                            <TableCell className="tabular-nums">{acc.pool ? acc.pool.credits : "—"}</TableCell>
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
                </div>
              </Section>

              <Section title="添加账号入池" description="选择本地账号库中的账号入池;也可扫码新增账号">
                <div className="flex flex-wrap items-end gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-[220px] flex-1 space-y-1.5">
                    <Label>选择本地账号</Label>
                    <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                      <SelectTrigger>
                        <SelectValue placeholder="选择要入池的账号" />
                      </SelectTrigger>
                      <SelectContent>
                        {onboardOptions.length === 0 && (
                          <div className="px-2 py-1.5 text-sm text-muted-foreground">本地账号库为空,请先扫码添加</div>
                        )}
                        {onboardOptions.map((opt) => (
                          <SelectItem key={opt.id} value={opt.id}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button onClick={() => void handleOnboard()} disabled={!selectedAccountId || onboarding}>
                    <Plug className="size-4" /> {onboarding ? "入池中…" : "添加进池"}
                  </Button>
                  <Button variant="outline" onClick={() => setOauthOpen(true)}>
                    <ArrowLeftRight className="size-4" /> 扫码新增账号
                  </Button>
                </div>
              </Section>

              <Section title="入池策略" description="手动勾选入池、自动入池与永不入池名单">
                <Row>
                  <div className="min-w-0">
                    <div className="text-[13px]">自动入池</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      开启后本地账号库的账号自动进入网关池(仍受下方「永不入池」约束)
                    </div>
                  </div>
                  <Switch
                    checked={gwForm?.sync_enabled ?? false}
                    onCheckedChange={(v) => setGwForm((f) => (f ? { ...f, sync_enabled: v } : f))}
                  />
                </Row>
                <div className="min-w-0 space-y-3 px-4 pt-3 pb-4 sm:px-5">
                  <div className="text-[13px]">
                    账号入池与永不入池
                    <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                      左侧开关「入池选择」,右侧开关「永不入池」(优先)
                    </span>
                  </div>
                  {localAccounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">本地账号库为空,请先扫码添加</p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {localAccounts.map((acc) => {
                        const uid = acc.uid ?? "";
                        const inPool = (gwForm?.pool_uids ?? []).includes(uid);
                        const never = (gwForm?.no_sync_uids ?? []).includes(uid);
                        return (
                          <div key={acc.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
                            <span className={cn("truncate text-sm", never && "text-muted-foreground line-through")}>
                              {acc.nickname || acc.email || acc.uid || acc.id}
                            </span>
                            <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
                              <label className="flex items-center gap-1.5">
                                <Switch checked={inPool} onCheckedChange={() => void togglePoolUid(uid)} disabled={!uid || never} />
                                入池
                              </label>
                              <label className="flex items-center gap-1.5">
                                <Switch checked={never} onCheckedChange={() => void toggleNoSyncUid(uid)} disabled={!uid} />
                                永不入池
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="flex justify-end px-4 py-3 sm:px-5">
                  <Button onClick={() => void handleGwSaveConfig()} disabled={!gwForm}>
                    保存配置
                  </Button>
                </div>
              </Section>
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>

      <OAuthLoginDialog open={oauthOpen} onOpenChange={setOauthOpen} />
    </div>
  );
}
