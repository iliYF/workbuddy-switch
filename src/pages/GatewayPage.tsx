import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { RefreshCw, Server, ArrowLeftRight, Trash2, Plug } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OAuthLoginDialog } from "@/components/oauth-login-dialog";
import * as api from "@/lib/api";
import { asError } from "@/lib/api";
import type {
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

  const configured = Boolean(config && (config.authDir || config.baseUrl));

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const cfg = await api.wb2api.getConfig();
      setConfig(cfg);
      setForm(cfg);
      if (cfg.authDir || cfg.baseUrl) {
        const [p, summaryRes, statsRes, modelsRes] = await Promise.all([
          api.wb2api.poolAccounts(),
          api.wb2api.status().catch(() => null),
          api.wb2api.stats().catch(() => null),
          api.wb2api.models().catch(() => null),
        ]);
        setPool(p);
        setSummary(summaryRes);
        setStats(statsRes);
        setModels(modelsRes?.data ?? []);
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
        <Button variant="outline" size="sm" onClick={() => void loadAll()} disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> 刷新
        </Button>
      </div>

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
        </TabsList>

        <TabsContent value="pool" className="space-y-4">
          {configured ? (
            <>
              <SummaryCards summary={summary} />

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">纳管账号</CardTitle>
                  <CardDescription>
                    把 switch 本地账号库的账号推入网关池(write 到 auths 目录,5s 热加载)。
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
                  <CardTitle className="text-base">模型列表</CardTitle>
                  <CardDescription>{models.length} 个模型(/v1/models,id 带 cn:/global: 前缀)</CardDescription>
                </CardHeader>
                <CardContent>
                  {models.length === 0 ? (
                    <p className="text-sm text-muted-foreground">暂无模型(可能无健康账号或拉取失败)。</p>
                  ) : (
                    <div className="flex max-h-72 flex-wrap gap-1.5 overflow-y-auto">
                      {models.map((m) => (
                        <Badge key={m.id} variant="secondary">
                          {m.id}
                        </Badge>
                      ))}
                    </div>
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
      </Tabs>

      <OAuthLoginDialog open={oauthOpen} onOpenChange={setOauthOpen} />
    </div>
  );
}
