import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  RefreshCw,
  Server,
  Trash2,
  Plug,
  Shuffle,
  UserRound,
  Square,
  Play,
  Loader2,
  Copy,
  Recycle,
  Wand2,
  Eye,
  EyeOff,
  RotateCw,
  Download,
  ExternalLink,
  Plus,
  QrCode,
  Save,
  Boxes,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OAuthLoginDialog } from "@/components/oauth-login-dialog";
import { asError, getCreditExpiry } from "@/lib/api";
import { wb2api, DEFAULT_GATEWAY_PORT, PORT_PICK_BASE, PORT_PICK_MAX } from "@/lib/wb2api";
import type {
  CreditExpiry,
  GatewayConfig,
  GatewayStatus,
  WB2APIConfig,
  WB2APIModel,
  WB2APIPoolAccounts,
  WB2APIPoolSummary,
  WB2APIStats,
} from "@/lib/types";
import { useAccountsStore } from "@/stores/accounts";
import { cn } from "@/lib/utils";

/** 托管网关(wb2api)项目主页兜底(fork);网关配置就绪时按钮改用其 source_url。 */
const GATEWAY_REPO_URL = "https://github.com/iliYF/workbuddy2api";

/** 从 GitHub 仓库地址提取作者(owner);非 github.com 地址返回 null。 */
function githubOwner(url?: string): string | null {
  if (!url) return null;
  return /github\.com\/([^/]+)/.exec(url)?.[1] ?? null;
}

function StatusBadge({
  state,
  gatewayRunning,
}: {
  state: WB2APIPoolAccounts["accounts"][number]["pool"];
  gatewayRunning: boolean;
}) {
  // 网关未运行时 /status 无数据,运行时状态未知,不猜测「未在池中」。
  if (!gatewayRunning) return <Badge variant="outline">网关未运行</Badge>;
  // 已入池但尚未被网关 /status 加载(刚加入/热加载中)为过渡态。
  if (!state) return <Badge variant="outline">同步中…</Badge>;
  if (state.manual_disabled) return <Badge variant="destructive">手动停用</Badge>;
  if (state.disabled) return <Badge variant="destructive">禁用</Badge>;
  if (state.cooling) return <Badge variant="outline">冷却中</Badge>;
  return <Badge>健康</Badge>;
}

/** 到期展示:官方积分到期状态;查询失败时返回「—」(档位已由昵称旁标签展示)。 */
function poolExpiryLabel(credit?: CreditExpiry): string {
  if (!credit) return "—";
  if (credit.expired) return "已过期";
  if (credit.expiringSoon) return "即将到期";
  if (credit.soonestExpireAt) return new Date(credit.soonestExpireAt).toLocaleDateString("zh-CN");
  return "—";
}

/** 积分展示:保留 1 位小数;空值显示「—」。 */
function formatCredits(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toFixed(1);
}

/** 网关版本 `v<YYYYMMDDHHMM>-<revision>` 解析;不匹配返回 null(用原始值展示)。 */
function parseGatewayVersion(version: string | null | undefined): { time: string; revision: string } | null {
  if (!version) return null;
  const m = version.trim().match(/^v?(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})-([0-9a-fA-F]+)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, revision] = m;
  return { time: `${y}-${mo}-${d} ${h}:${mi}`, revision };
}

/** 「运行版本」:时间在标签右边(黑色),revision 标签在下方,运行状态色与服务状态一致。 */
function RunningVersion({ version, bin, running }: { version?: string | null; bin?: string | null; running?: boolean }) {
  const ver = parseGatewayVersion(version);
  const hasBin = Boolean(bin);
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-[13px]">运行版本</span>
        {ver && <span className="min-w-0 truncate text-[13px] text-foreground">{ver.time}</span>}
      </div>
      <div className={cn("mt-0.5 flex min-w-0 items-center gap-1.5 text-xs", !hasBin ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
        {!hasBin ? (
          "未安装网关"
        ) : ver ? (
          <span className="inline-flex shrink-0 items-center rounded-md bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-700 dark:text-cyan-300">
            {ver.revision}
          </span>
        ) : version ? (
          `版本 ${version}`
        ) : (
          bin?.split("/").pop()
        )}
        {hasBin && (
          <span className={running ? "text-emerald-600 dark:text-emerald-400" : undefined}>
            {running ? "运行中" : "未运行"}
          </span>
        )}
      </div>
    </div>
  );
}

/** 小节:卡片外的小标题 + Card(描述/标题放在卡片内部标题栏,与 Token 统计页一致;
 * `headerTitle` 与描述同样式,`headerAction` 槽位可放 Tab 切换等小组件)。 */
function Section({
  title,
  description,
  headerTitle,
  headerAction,
  children,
  className,
}: {
  title: string;
  description?: string;
  headerTitle?: React.ReactNode;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col space-y-2.5", className)}>
      <div className="px-1">
        <h2 className="text-[13px] font-medium leading-5">{title}</h2>
      </div>
      <Card className="min-w-0 flex-1 gap-0 overflow-hidden rounded-xl py-0 shadow-none">
        {headerTitle || description || headerAction ? (
          <CardHeader className="gap-0 px-4 pt-3 pb-0 sm:px-5">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                {headerTitle ? <CardDescription className="min-w-0 text-xs">{headerTitle}</CardDescription> : null}
                {description ? (
                  <CardDescription className="mt-0.5 min-w-0 text-xs">{description}</CardDescription>
                ) : null}
              </div>
              {headerAction ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{headerAction}</div> : null}
            </div>
          </CardHeader>
        ) : null}
        {children}
      </Card>
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
  tone?: "ok" | "warn" | "off" | "bad";
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 truncate text-[15px] font-medium tabular-nums",
          tone === "ok" && "text-emerald-600 dark:text-emerald-400",
          tone === "warn" && "text-amber-600 dark:text-amber-400",
          tone === "off" && "text-muted-foreground",
          tone === "bad" && "text-red-600 dark:text-red-400",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function SummaryStats({ summary }: { summary: WB2APIPoolSummary | null }) {
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

  const [config, setConfig] = useState<WB2APIConfig | null>(null);
  const [pool, setPool] = useState<WB2APIPoolAccounts | null>(null);
  const [summary, setSummary] = useState<WB2APIPoolSummary | null>(null);
  const [stats, setStats] = useState<WB2APIStats | null>(null);
  const [models, setModels] = useState<WB2APIModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("gateway");

  // 「关于」:网关升级
  const [gwUpdating, setGwUpdating] = useState<string | null>(null);
  /** 未安装网关时的安装确认弹窗。 */
  const [gwInstallOpen, setGwInstallOpen] = useState(false);
  /** 弹窗里展示的远端最新版本(打开时抓取)。 */
  const [gwInstallRemote, setGwInstallRemote] = useState<string | null>(null);
  /** 安装弹窗阶段:confirm 确认 / installing 阻塞安装中 / done 完成询问启动。 */
  type GwInstallPhase = "confirm" | "installing" | "done";
  const [gwInstallPhase, setGwInstallPhase] = useState<GwInstallPhase>("confirm");
  /** 安装弹窗模式:install 首次安装 / upgrade 升级。 */
  const [gwInstallMode, setGwInstallMode] = useState<"install" | "upgrade">("install");
  /** 升级确认弹窗里展示的当前版本(仅 upgrade 模式)。 */
  const [gwInstallCurrent, setGwInstallCurrent] = useState<string | null>(null);
  /** 安装成功后的版本 tag(done 阶段展示)。 */
  const [gwInstalledVersion, setGwInstalledVersion] = useState<string | null>(null);

  // 纳管
  const [onboarding, setOnboarding] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  // 自动入池黑名单(不入池名单)对话框
  const [blacklistOpen, setBlacklistOpen] = useState(false);
  const [blacklistDraft, setBlacklistDraft] = useState<string[]>([]);
  // 「选择账号」对话框:从本地账号库挑选账号纳管入池
  const [pickAccountOpen, setPickAccountOpen] = useState(false);
  /** 选择账号弹窗中的勾选(account id 集合)。 */
  const [pickSelection, setPickSelection] = useState<string[]>([]);
  /** 池账号 uid → 官方积分/到期(页面加载与手动刷新时拉取,不进页面轮询)。 */
  const [creditMap, setCreditMap] = useState<Record<string, CreditExpiry>>({});

  // 对接配置(由网关设置自动派生,只读用于状态判断)
  const [form, setForm] = useState<WB2APIConfig | null>(null);

  const [showKey, setShowKey] = useState(false);
  const [connOpen, setConnOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  /** 模型中心的系列过滤:"" = 全部。 */
  const [modelSeries, setModelSeries] = useState("");
  /** 模型中心的排序:default(系列内默认) / name / context / credits。 */
  const [modelSort, setModelSort] = useState<"default" | "name" | "context" | "credits">("default");
  const [catalogSource, setCatalogSource] = useState("");

  // 网关托管
  const [gw, setGw] = useState<GatewayStatus | null>(null);
  const [gwForm, setGwForm] = useState<GatewayConfig | null>(null);
  const [gwBusy, setGwBusy] = useState(false);
  /** 保存网关配置按钮进行中。 */
  const [savingGw, setSavingGw] = useState(false);
  /** 网关 API Key 是否明文显示(默认隐藏)。 */
  const [showApiKey, setShowApiKey] = useState(false);
  /** 服务端口可用性(手动改/新生成端口时实时探测;null = 未知)。 */
  const [portOk, setPortOk] = useState<boolean | null>(null);
  /** 端口/API Key 变更后是否重启网关的确认弹窗。 */
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  /** 最近一次保存的端口与 API Key(检测变更用)。 */
  const savedPortRef = useRef(DEFAULT_GATEWAY_PORT);
  const savedApiKeyRef = useRef("");
  /** 待保存配置(端口/API Key 变更时先存于此,待重启确认后写入)。 */
  const pendingGwRef = useRef<GatewayConfig | null>(null);

  const configured = Boolean(config && (config.authDir || config.baseUrl));

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const cfg = await wb2api.getConfig();
      setConfig(cfg);
      setForm(cfg);
      // 网关托管状态与对接配置相互独立,始终获取。
      const gwRes = await wb2api.gatewayStatus().catch(() => null);
      setGw(gwRes);
      setGwForm((f) => f ?? gwRes?.config ?? null);
      if (gwRes?.config) {
        savedPortRef.current = gwRes.config.port;
        savedApiKeyRef.current = gwRes.config.api_key;
      }
      if (cfg.authDir || cfg.baseUrl) {
        const [p, summaryRes, statsRes, catalogRes] = await Promise.all([
          wb2api.poolAccounts(),
          wb2api.status().catch(() => null),
          wb2api.stats().catch(() => null),
          wb2api.modelCatalog().catch(() => null),
        ]);
        setPool(p);
        setSummary(summaryRes);
        setStats(statsRes);
        setModels(catalogRes?.models ?? []);
        setCatalogSource(catalogRes?.source_label ?? "上游");
        // 官方积分/到期:按 uid 关联本地账号逐项查询(仅页面加载/手动刷新时,不进页面轮询)。
        const uidToId = new Map(
          useAccountsStore.getState().accounts.filter((a) => a.uid).map((a) => [a.uid, a.id]),
        );
        const map: Record<string, CreditExpiry> = {};
        await Promise.all((p?.accounts ?? []).map(async (acc) => {
          const id = uidToId.get(acc.uid);
          if (!id) return;
          try {
            const expiry = await getCreditExpiry(id);
            if (expiry.ok) map[acc.uid] = expiry;
          } catch {
            // 单个账号查询失败不影响其它展示。
          }
        }));
        setCreditMap(map);
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

  // webui 轮询:按配置间隔(webui_poll_seconds,缺省 5s,钳制 5–3600)刷新池账号与运行汇总。
  const pollSeconds = Math.min(3600, Math.max(5, gwForm?.webui_poll_seconds ?? 5));
  useEffect(() => {
    if (!configured) return;
    const timer = window.setInterval(() => {
      void wb2api.poolAccounts().then(setPool).catch(() => {});
      void wb2api.status().then(setSummary).catch(() => {});
    }, pollSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [configured, pollSeconds]);

  // 服务端口可用性:与配置端口一致时用状态探测,否则实时探测(防抖 250ms)。
  const formPort = gwForm?.port ?? DEFAULT_GATEWAY_PORT;
  useEffect(() => {
    if (formPort === gw?.port) {
      setPortOk(null);
      return;
    }
    const t = window.setTimeout(() => {
      void wb2api
        .gatewayPortCheck(formPort)
        .then((r) => setPortOk(r.available))
        .catch(() => setPortOk(null));
    }, 250);
    return () => window.clearTimeout(t);
  }, [formPort, gw?.port]);
  const portUsable =
    gw?.running && formPort === gw?.port
      ? gw.healthy
      : formPort === gw?.port
        ? (gw?.port_available ?? true)
        : portOk;

  // 进入网关 Tab 且未安装网关二进制时,自动弹出安装引导。
  useEffect(() => {
    if (activeTab === "gateway" && gw && !gw.bin) {
      void openInstallDialog();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, gw]);

  /** 选择账号弹窗:确认后批量纳管到网关池。 */
  async function confirmPickAccounts() {
    const ids = pickSelection;
    if (ids.length === 0) return;
    setOnboarding(true);
    setPickAccountOpen(false);
    let ok = 0;
    for (const id of ids) {
      try {
        await wb2api.onboard(id);
        ok += 1;
      } catch {
        // 单个失败不阻塞其余
      }
    }
    toast.success(`已纳管 ${ok}/${ids.length} 个账号到网关池`);
    setPickSelection([]);
    setOnboarding(false);
    void loadAll();
  }

  async function handleAccountOp(uid: string, op: "disable" | "enable" | "revive") {
    try {
      await wb2api.accountOp(uid, op);
      toast.success("操作成功");
      void loadAll();
    } catch (e) {
      toast.error("操作失败", { description: asError(e) });
    }
  }

  async function handleOffboard(uid: string) {
    if (!window.confirm(`确定把 ${uid} 从网关池移除?凭证文件将被删除。`)) return;
    try {
      await wb2api.offboard(uid);
      toast.success("已移除");
      void loadAll();
    } catch (e) {
      toast.error("移除失败", { description: asError(e) });
    }
  }

  async function refreshGw() {
    const s = await wb2api.gatewayStatus();
    setGw(s);
    setGwForm((f) => f ?? s.config);
  }

  async function handleGwStart() {
    setGwBusy(true);
    try {
      await wb2api.gatewayStart();
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
      await wb2api.gatewayStop();
      toast.success("网关已停止");
      await refreshGw();
    } catch (e) {
      toast.error("停止失败", { description: asError(e) });
    } finally {
      setGwBusy(false);
    }
  }

  /** 重启网关:先停(若在跑)再启(复用后端 healthz 健康检测)。 */
  async function handleGwRestart() {
    setGwBusy(true);
    try {
      await wb2api.gatewayStop().catch(() => {});
      await wb2api.gatewayStart();
      toast.success("网关已重启");
      await refreshGw();
    } catch (e) {
      toast.error("重启失败", { description: asError(e) });
    } finally {
      setGwBusy(false);
    }
  }

  /** 写盘保存并更新本地「已保存」值。返回是否成功。 */
  async function persistConfig(next: GatewayConfig): Promise<boolean> {
    try {
      const saved = await wb2api.gatewaySaveConfig(next);
      setGwForm(saved);
      savedPortRef.current = saved.port;
      savedApiKeyRef.current = saved.api_key;
      // 端口/Key 变更后,后端已把 baseUrl/apiKey 派生进 wb2api 对接配置;重新拉取保持 OpenAI 兼容接口显示同步。
      const conn = await wb2api.getConfig().catch(() => null);
      if (conn) {
        setConfig(conn);
        setForm(conn);
      }
      return true;
    } catch (e) {
      toast.error("保存失败", { description: asError(e) });
      return false;
    }
  }

  /** 保存入口:端口/API Key 有变更时弹窗确认是否重启网关,确认后才写入新值。 */
  async function handleGwSaveConfig() {
    if (!gwForm) return;
    setSavingGw(true);
    try {
      const portChanged = gwForm.port !== savedPortRef.current;
      const apiKeyChanged = gwForm.api_key !== savedApiKeyRef.current;
      if (portChanged || apiKeyChanged) {
        pendingGwRef.current = gwForm;
        setRestartConfirmOpen(true);
        return;
      }
      const ok = await persistConfig(gwForm);
      if (ok) toast.success("配置已保存");
    } catch (e) {
      toast.error("保存失败", { description: asError(e) });
    } finally {
      setSavingGw(false);
    }
  }

  /** 表单字段变更只更新本地表单,点保存后统一落盘生效。 */
  function updateGwField<K extends keyof GatewayConfig>(key: K, value: GatewayConfig[K]) {
    setGwForm((f) => (f ? { ...f, [key]: value } : f));
  }

  /** 确认重启:保存新端口/新 key 并重启网关(未运行则仅保存,下次启动生效)。 */
  async function confirmRestartAndSave() {
    const next = pendingGwRef.current;
    pendingGwRef.current = null;
    setSavingGw(false);
    setRestartConfirmOpen(false);
    if (!next) return;
    const ok = await persistConfig(next);
    if (!ok) return;
    // 用实时运行状态决定是否重启,避免页面快照过期导致端口变更静默不生效。
    const s = await wb2api.gatewayStatus().catch(() => null);
    if (s?.running) {
      await handleGwRestart();
      toast.success("配置已保存并重启网关");
    } else {
      toast.success("配置已保存(网关未运行,下次启动生效)");
    }
  }

  /** 取消:端口/API Key 保持原值(不写入),其余配置照常保存。 */
  async function cancelRestartSave() {
    const next = pendingGwRef.current;
    pendingGwRef.current = null;
    setSavingGw(false);
    setRestartConfirmOpen(false);
    if (!next) return;
    const reverted: GatewayConfig = {
      ...next,
      port: savedPortRef.current,
      api_key: savedApiKeyRef.current,
    };
    setGwForm(reverted);
    const ok = await persistConfig(reverted);
    if (ok) toast.success("已取消,端口与 API Key 保持原值,其余配置已保存");
  }

  /** 生成随机空闲端口:填入表单(保存后生效)。 */
  async function handleGwPickPort() {
    try {
      const r = await wb2api.gatewayPickPort();
      setGwForm((f) => (f ? { ...f, port: r.port } : f));
      toast.success(`已选空闲端口 ${r.port}(保存后生效)`);
    } catch (e) {
      toast.error("选端口失败", { description: asError(e) });
    }
  }

  /** 自动入池开关:开启需先经黑名单对话框确认,确定后与黑名单一并写入;取消则开关不生效。
   * 关闭则立即持久化。 */
  async function toggleSyncEnabled(v: boolean) {
    if (!gwForm) return;
    if (v) {
      openBlacklistDialog();
      return;
    }
    try {
      const saved = await wb2api.gatewaySaveConfig({ ...gwForm, sync_enabled: false });
      setGwForm(saved);
      toast.success("已关闭自动入池");
      void wb2api.poolAccounts().then(setPool).catch(() => {});
    } catch (e) {
      toast.error("保存失败", { description: asError(e) });
    }
  }

  /** 打开自动入池黑名单对话框(不入池名单)。 */
  function openBlacklistDialog() {
    setBlacklistDraft(gwForm?.no_sync_uids ?? []);
    setBlacklistOpen(true);
  }

  /** 确认开启自动入池并保存不入池名单(开关与黑名单一同写入)。 */
  async function saveBlacklist() {
    if (!gwForm) return;
    try {
      const saved = await wb2api.gatewaySaveConfig({ ...gwForm, sync_enabled: true, no_sync_uids: blacklistDraft });
      setGwForm(saved);
      setBlacklistOpen(false);
      toast.success("已开启自动入池,不入池名单已保存");
      void wb2api.poolAccounts().then(setPool).catch(() => {});
    } catch (e) {
      toast.error("保存失败", { description: asError(e) });
    }
  }

  /** 生成随机访问密钥(wbs- 前缀):填入表单(保存后生效)。 */
  async function handleGenKey() {
    try {
      const r = await wb2api.gatewayGenKey();
      setGwForm((f) => (f ? { ...f, api_key: r.api_key } : f));
      toast.success("已生成访问密钥(保存后生效)");
    } catch (e) {
      toast.error("生成失败", { description: asError(e) });
    }
  }

  /** 升级入口:先检查,已是最新则提示;发现新版本则弹出升级确认对话框(复用安装弹窗)。 */
  async function handleGwUpgrade() {
    setGwUpdating("check");
    try {
      const r = await wb2api.gatewayCheckUpdate();
      if (!r.available) {
        toast.success("已是最新", { description: r.message || "已是最新" });
        return;
      }
      setGwInstallMode("upgrade");
      setGwInstallCurrent(r.current ?? null);
      setGwInstallRemote(r.remote ?? null);
      setGwInstallPhase("confirm");
      setGwInstallOpen(true);
    } catch (e) {
      toast.error("检查升级失败", { description: asError(e) });
    } finally {
      setGwUpdating(null);
    }
  }

  /** 打开首次安装弹窗并抓取远端最新版本信息(已开则不重复抓)。 */
  async function openInstallDialog() {
    if (gwInstallOpen) return;
    setGwInstallMode("install");
    setGwInstallCurrent(null);
    setGwInstallPhase("confirm");
    setGwInstallOpen(true);
    setGwInstallRemote(null);
    try {
      const r = await wb2api.gatewayCheckUpdate();
      setGwInstallRemote(r.remote ?? null);
    } catch {
      setGwInstallRemote(null);
    }
  }

  /** 确认安装:进入阻塞安装态,下载完成后询问是否立即启动。 */
  async function installGw() {
    setGwInstallPhase("installing");
    setGwInstalledVersion(null);
    try {
      const r = await wb2api.gatewayApplyUpdate();
      if (r.ok) {
        setGwInstalledVersion(r.version ?? null);
        setGwInstallPhase("done");
        await refreshGw();
      } else {
        toast.error("安装失败");
        setGwInstallPhase("confirm");
      }
    } catch (e) {
      toast.error("安装失败", { description: asError(e) });
      setGwInstallPhase("confirm");
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
  const connBaseUrlV1 = `${connBaseUrl || `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`}/v1`;
  const maskedKey = connApiKey ? `${connApiKey.slice(0, 4)}••••${connApiKey.slice(-4)}` : "(未配置,填写 apiKey 后生效)";
  // 接入弹窗的模型列表:按倍率从小到大排。
  const creditOf = (m: WB2APIModel) => {
    const n = Number.parseFloat((m.credits ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  };
  const sortedModels = useMemo(() => [...models].sort((a, b) => creditOf(a) - creditOf(b)), [models]);

  // 首次安装弹窗:目标平台资产名(与后端 platform_asset 同口径)。
  const ua = navigator.userAgent.toLowerCase();
  const isMac = ua.includes("mac");
  const isWin = ua.includes("win");
  const isArm = /arm|aarch/.test(ua);
  const gwPlatformKey = isMac ? (isArm ? "darwin-arm64" : "darwin-amd64") : isWin ? "windows-amd64" : isArm ? "linux-arm64" : "linux-amd64";
  const gwAssetName = gw?.config.artifact?.assets?.[gwPlatformKey] ?? null;

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

  /** 模型中心全部系列(供过滤下拉)。 */
  const allSeries = useMemo(() => {
    const set = new Set<string>();
    for (const m of models) set.add(seriesOf(bareModelId(m.id)));
    return [...set].sort((a, b) => a.localeCompare(b, "zh"));
  }, [models]);

  const modelGroups = useMemo(() => {
    const groups = new Map<string, WB2APIModel[]>();
    const q = modelQuery.trim().toLowerCase();
    for (const m of models) {
      if (
        q &&
        ![m.id, m.name ?? "", m.description ?? ""].some((s) => s.toLowerCase().includes(q))
      ) {
        continue;
      }
      const series = seriesOf(bareModelId(m.id));
      if (modelSeries && series !== modelSeries) continue;
      if (!groups.has(series)) groups.set(series, []);
      groups.get(series)!.push(m);
    }
    const entries = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh"));
    for (const [, list] of entries) {
      list.sort((a, b) => {
        switch (modelSort) {
          case "name":
            return (a.name || bareModelId(a.id)).localeCompare(b.name || bareModelId(b.id), "zh");
          case "context":
            return (b.context_length ?? 0) - (a.context_length ?? 0);
          case "credits":
            return (a.credits ?? "").localeCompare(b.credits ?? "");
          default:
            return (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) || a.id.localeCompare(b.id);
        }
      });
    }
    return entries;
  }, [models, modelQuery, modelSeries, modelSort]);

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
    <div className="mx-auto w-full max-w-[1180px] space-y-6 px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6 flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold tracking-tight">网关管理</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            开启 OpenAI 兼容网关，将帐号池中帐号的模型反代给任意 SDK / 客户端使用。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-sm" onClick={() => setConnOpen(true)}>
            <Plug className="size-4" /> 接入配置
          </Button>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-sm" onClick={() => void loadAll()} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} /> 刷新
          </Button>
        </div>
      </header>

      <Dialog open={connOpen} onOpenChange={setConnOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>WorkBuddy Provider</DialogTitle>
            <DialogDescription>
              在 CC Switch 中新建 Provider,按下方信息填写即可。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-3 rounded-lg border bg-card p-3 shadow-none">
              <div className="space-y-1.5">
                <Label>Base URL(OpenAI 兼容)</Label>
                <div className="flex items-center gap-2">
                  <code
                    className="truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs"
                    style={{ width: 231 }}
                  >
                    {connBaseUrlV1}
                  </code>
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-8 shrink-0"
                    onClick={() => void copyText(connBaseUrlV1, "Base URL")}
                    aria-label="复制 Base URL"
                    title="复制 Base URL"
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>API Key</Label>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <code
                      className="block truncate rounded-md border bg-muted/40 py-1.5 pl-2 pr-8 font-mono text-xs"
                      style={{ width: 231 }}
                    >
                      {showKey ? connApiKey || "(未配置)" : maskedKey}
                    </code>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="absolute right-0 top-0 h-full w-8 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowKey((s) => !s)}
                      aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                      title={showKey ? "隐藏" : "显示"}
                    >
                      {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </Button>
                  </div>
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-8 shrink-0"
                    onClick={() => void copyText(connApiKey, "API Key")}
                    disabled={!connApiKey}
                    aria-label="复制 API Key"
                    title="复制 API Key"
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>可用模型</Label>
              {sortedModels.length > 0 ? (
                <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border bg-muted/20 p-1.5">
                  {sortedModels.map((m) => {
                    const bare = bareModelId(m.id);
                    const isGlobal = m.id.toLowerCase().startsWith("global:");
                    const isAuto = bareModelId(m.id).toLowerCase().startsWith("auto");
                    return (
                      <div key={m.id} className="flex items-start gap-2 rounded-lg border bg-card px-2.5 py-2 text-sm shadow-none">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium">{m.name || bare}</span>
                            <Badge variant={isGlobal ? "outline" : "secondary"} className="h-4 px-1.5 text-[10px]">
                              {isGlobal ? "国际版" : "国内版"}
                            </Badge>
                          </div>
                          <div className="mt-1 flex items-center gap-1">
                            <code className="truncate font-mono text-xs text-muted-foreground">{bare}</code>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6 shrink-0"
                              onClick={() => void copyText(m.id, "模型名")}
                              aria-label={`复制 ${m.id}`}
                              title="复制模型名"
                            >
                              <Copy className="size-3.5" />
                            </Button>
                          </div>
                        </div>
                        <div className="flex flex-wrap justify-end gap-1.5" style={{ maxWidth: "55%" }}>
                          <Badge variant="secondary">
                            {(m.context_length ?? 0) >= 1024 ? `${Math.round((m.context_length ?? 0) / 1024)}K` : m.context_length ?? "—"}
                          </Badge>
                          {m.credits ? <Badge variant="outline">倍率 {m.credits}</Badge> : null}
                          {m.supports_images ? <Badge variant="outline">多模态</Badge> : null}
                          {m.reasoning_effort || m.reasoning_summary ? (
                            <Badge variant="outline">{m.reasoning_effort || m.reasoning_summary}</Badge>
                          ) : null}
                          {m.supports_reasoning ? <Badge variant="outline">推理</Badge> : null}
                          {isAuto ? <Badge variant="outline">Auto</Badge> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center">
                  <Boxes className="size-5 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">账号池暂无可展示的账号</p>
                  <p className="text-sm text-muted-foreground">无可用的模型供选择</p>
                </div>
              )}
            </div>
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
                      {/* 工具栏:搜索 + 系列过滤 + 排序 */}
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          value={modelQuery}
                          onChange={(e) => setModelQuery(e.target.value)}
                          placeholder="搜索模型(id / 名称 / 描述)…"
                          className="h-8 max-w-xs flex-1 text-xs"
                        />
                        <Select value={modelSeries || "__all__"} onValueChange={(v) => setModelSeries(v === "__all__" ? "" : v)}>
                          <SelectTrigger size="sm" className="h-8 w-40 text-xs">
                            <SelectValue placeholder="全部系列" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__all__">全部系列</SelectItem>
                            {allSeries.map((s) => (
                              <SelectItem key={s} value={s}>
                                {s}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select value={modelSort} onValueChange={(v) => setModelSort(v as typeof modelSort)}>
                          <SelectTrigger size="sm" className="h-8 w-32 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="default">默认排序</SelectItem>
                            <SelectItem value="name">按名称</SelectItem>
                            <SelectItem value="context">按上下文</SelectItem>
                            <SelectItem value="credits">按倍率</SelectItem>
                          </SelectContent>
                        </Select>
                        {(modelQuery || modelSeries) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 text-xs"
                            onClick={() => {
                              setModelQuery("");
                              setModelSeries("");
                            }}
                          >
                            清除筛选
                          </Button>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        匹配 {modelGroups.reduce((n, [, l]) => n + l.length, 0)} 个模型
                      </div>
                      {modelGroups.length === 0 ? (
                        <p className="text-sm text-muted-foreground">没有匹配的模型。</p>
                      ) : (
                        <div className="max-h-[520px] space-y-5 overflow-y-auto pr-1">
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
                                        <button
                                          type="button"
                                          className="truncate font-mono text-xs text-muted-foreground hover:text-foreground"
                                          title="点击复制模型名"
                                          onClick={() => void copyText(m.id, "模型名")}
                                        >
                                          {bare}
                                        </button>
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
          <Section title="账号池概览" description={`状态每 ${pollSeconds} 秒自动刷新`}>
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
          <div className="grid gap-6 lg:grid-cols-2">
          <Section title="运行状态" description={`账号池状态每 ${pollSeconds} 秒自动刷新`}>
              <div className="mx-4 grid grid-cols-2 gap-2 py-3 sm:mx-5 sm:grid-cols-4">
                <Stat
                  label="服务状态"
                  value={gw?.bin ? (gw?.running ? (gw.healthy ? "运行中" : "已启动") : "未运行") : "未安装"}
                  tone={gw?.running ? "ok" : gw?.bin ? "off" : "bad"}
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
                  <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{connBaseUrlV1}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="ghost" size="icon" className="size-7" onClick={() => void copyText(connBaseUrlV1, "接口地址")} aria-label="复制接口地址">
                    <Copy className="size-3.5" />
                  </Button>
                  {gw?.running ? (
                    <>
                      <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void handleGwRestart()} disabled={gwBusy}>
                        {gwBusy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
                        重启
                      </Button>
                      <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void handleGwStop()} disabled={gwBusy}>
                        {gwBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
                        停止
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void handleGwStart()} disabled={gwBusy}>
                      {gwBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                      启动网关
                    </Button>
                  )}
                </div>
              </Row>

              <Row className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <div className="text-[13px]">服务端口</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">开放接口地址随端口变化;可一键生成随机空闲端口({PORT_PICK_BASE}~{PORT_PICK_MAX} 随机探测)</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      portUsable === true && "bg-emerald-500",
                      portUsable === false && "bg-red-500",
                      portUsable == null && "bg-muted-foreground/40",
                    )}
                    title={portUsable === true ? "端口可用" : portUsable === false ? "端口被占用" : "可用性探测中…"}
                  />
                  <Input
                    type="number"
                    className="h-8 w-24 text-xs"
                    value={gwForm?.port ?? DEFAULT_GATEWAY_PORT}
                    onChange={(e) => setGwForm((f) => (f ? { ...f, port: Number(e.target.value) || DEFAULT_GATEWAY_PORT } : f))}
                  />
                  <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => void handleGwPickPort()}>
                    <Wand2 className="size-3.5" /> 生成
                  </Button>
                </div>
              </Row>

              <Row className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <div className="text-[13px]">API Key</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">用于客户端接入鉴权(wbs- 前缀);可一键生成或复制</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    onClick={() => void copyText(gwForm?.api_key ?? "", "API Key")}
                    disabled={!gwForm?.api_key}
                    aria-label="复制 API Key"
                    title="复制 API Key"
                  >
                    <Copy className="size-3.5" />
                  </Button>
                  <div className="relative">
                    <Input
                      value={gwForm?.api_key ?? ""}
                      onChange={setGwField("api_key")}
                      type={showApiKey ? "text" : "password"}
                      placeholder="点击生成"
                      className="h-8 w-full pr-8 font-mono text-xs sm:w-64"
                    />
                    <button
                      type="button"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowApiKey((s) => !s)}
                      aria-label={showApiKey ? "隐藏" : "显示"}
                      title={showApiKey ? "隐藏" : "显示"}
                    >
                      {showApiKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  </div>
                  <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => void handleGenKey()}>
                    <Wand2 className="size-3.5" /> 生成
                  </Button>
                </div>
              </Row>

          </Section>

          <Section title="基本设置" description="工作模式、自动启动与巡检间隔(保存后生效)">
              <Row className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <div className="text-[13px]">工作模式</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
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
                    onClick={() => updateGwField("mode", "balance")}
                  >
                    <Shuffle className="size-3.5" /> 负载均衡
                  </Button>
                  <Button
                    variant={gwForm?.mode === "rotation" ? "default" : "outline"}
                    size="sm"
                    className="h-8 gap-1.5 px-2.5 text-xs"
                    onClick={() => updateGwField("mode", "rotation")}
                  >
                    <Recycle className="size-3.5" /> 积分轮转
                  </Button>
                  <Button
                    variant={gwForm?.mode === "pinned" ? "default" : "outline"}
                    size="sm"
                    className="h-8 gap-1.5 px-2.5 text-xs"
                    onClick={() => updateGwField("mode", "pinned")}
                  >
                    <UserRound className="size-3.5" /> 指定账号
                  </Button>
                </div>
              </Row>

              {gwForm?.mode === "pinned" && (
                <Row className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                  <div className="min-w-0">
                    <Label className="text-[13px] font-normal">使用账号</Label>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {localAccounts.length ? `共 ${localAccounts.length} 个账号可选` : "账号库为空"}
                    </div>
                  </div>
                  <Select
                    value={gwForm?.pinned_uid ?? "__none__"}
                    onValueChange={(v) => updateGwField("pinned_uid", v === "__none__" ? null : v)}
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
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      轮转由 hub 按积分到期日巡检维护;留空则由网关自身调度
                    </div>
                  </div>
                  <Select
                    value={gwForm?.rotation_uid ?? "__none__"}
                    onValueChange={(v) => updateGwField("rotation_uid", v === "__none__" ? null : v)}
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

              <Row>
                <div className="min-w-0">
                  <div className="text-[13px]">自动启动网关</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">应用启动时自动拉起网关</div>
                </div>
                <Switch checked={gwForm?.auto_start ?? false} onCheckedChange={(v) => updateGwField("auto_start", v)} />
              </Row>
              <Row className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <div className="text-[13px]">自动入池巡检间隔</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">开启自动入池后按此间隔(秒)同步账号库;未开启则不巡检</div>
                </div>
                <Input
                  type="number"
                  className="h-8 w-24 text-xs"
                  value={gwForm?.sync_interval_seconds ?? 30}
                  onChange={(e) => setGwForm((f) => (f ? { ...f, sync_interval_seconds: Number(e.target.value) || 30 } : f))}
                />
              </Row>
              <Row className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <div className="text-[13px]">池状态刷新间隔</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">页面轮询池账号/汇总的间隔(秒),范围 5–3600</div>
                </div>
                <Input
                  type="number"
                  className="h-8 w-24 text-xs"
                  value={gwForm?.webui_poll_seconds ?? 5}
                  onChange={(e) => setGwForm((f) => (f ? { ...f, webui_poll_seconds: Number(e.target.value) || 5 } : f))}
                />
              </Row>
              <Row className="justify-end">
                <Button
                  size="sm"
                  className="h-8 gap-1.5 px-4 text-sm"
                  onClick={() => void handleGwSaveConfig()}
                  disabled={savingGw || !gwForm}
                >
                  {savingGw ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} 保存网关配置
                </Button>
              </Row>
          </Section>
          </div>

          <Section
            title="账号池"
            description={gw?.running ? `${(pool?.accounts ?? []).length}个帐号在帐号池` : "启动网关后可见"}
            headerAction={
              gw?.running ? (
                <>
                  <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch checked={gwForm?.sync_enabled ?? false} onCheckedChange={(v) => void toggleSyncEnabled(v)} />
                    自动入池
                  </label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" className="h-8 gap-1.5 px-2.5 text-xs" disabled={onboarding}>
                        <Plus className="size-3.5" /> 添加账号
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem onSelect={() => setPickAccountOpen(true)} disabled={onboardOptions.length === 0}>
                        <UserRound className="size-3.5" /> 选择账号
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setOauthOpen(true)}>
                        <QrCode className="size-3.5" /> 扫码添加
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : undefined
            }
          >
            {/* 入池账号卡片(网关未运行时整体提示,不展示池信息) */}
            {gw?.running ? (
              <div className="min-w-0 px-4 pt-3 pb-4 sm:px-5">
              {loading && !pool ? (
                <Skeleton className="h-24 w-full" />
              ) : (pool?.accounts ?? []).length === 0 ? (
                <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  账号池暂无可展示的账号。
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {pool!.accounts.map((acc) => (
                    <div key={acc.uid} className="flex flex-col rounded-lg border border-border/60">
                      {/* 上半:帐号名 + 完整 UID(缩略) + 状态 */}
                      <div className="min-w-0 space-y-1 px-3 pt-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="min-w-0 truncate text-sm font-medium">{acc.nickname || acc.uid}</span>
                            <Badge variant="secondary" className="shrink-0 px-1.5 text-[10px] leading-4">
                              {acc.realm === "global" ? "国际版" : "国内版"}
                            </Badge>
                          </div>
                          <StatusBadge state={acc.pool} gatewayRunning={gw?.running ?? false} />
                        </div>
                        <code className="block truncate font-mono text-[11px] text-muted-foreground" title={acc.uid}>
                          {acc.uid}
                        </code>
                      </div>
                      <Separator className="my-2" />
                      {/* 下半:剩余积分 / 到期档位 + 操作 */}
                      <div className="flex items-end justify-between gap-2 px-3 pb-2.5">
                        <div className="min-w-0 space-y-0.5 text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground">剩余积分</span>
                            <span className="tabular-nums font-medium">
                              {formatCredits(creditMap[acc.uid]?.totalRemaining ?? (acc.pool ? acc.pool.credits : undefined))}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground">到期档位</span>
                            <span className="tabular-nums">{poolExpiryLabel(creditMap[acc.uid])}</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {acc.pool?.manual_disabled ? (
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void handleAccountOp(acc.uid, "enable")}>
                              启用
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void handleAccountOp(acc.uid, "disable")}>
                              停用
                            </Button>
                          )}
                          {acc.pool?.disabled && (
                            <Button size="sm" variant="secondary" className="h-7 px-2 text-xs" onClick={() => void handleAccountOp(acc.uid, "revive")}>
                              复活
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="size-7 p-0" onClick={() => void handleOffboard(acc.uid)} aria-label="移除出池" title="移除出池">
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              </div>
            ) : (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground sm:px-5">网关未运行</div>
            )}
          </Section>

          <Section
            title="兼容网关"
            headerTitle="网关版本与升级检查"
            headerAction={
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() =>
                  window.open(
                    gw?.config?.artifact?.source_url?.replace(/\/releases\/?$/, "") ?? GATEWAY_REPO_URL,
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
                aria-label="打开项目主页"
                title="打开项目主页"
              >
                <ExternalLink className="size-4" />
              </Button>
            }
          >
            <Row>
              <RunningVersion version={gw?.version} bin={gw?.bin} running={gw?.running} />
              <div className="flex shrink-0 items-center gap-1.5">
                {gw?.bin ? (
                  <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void handleGwUpgrade()} disabled={gwUpdating !== null}>
                    <RefreshCw className={cn("size-3.5", gwUpdating !== null && "animate-spin")} /> 升级
                  </Button>
                ) : (
                  <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void openInstallDialog()} disabled={gwUpdating !== null}>
                    <Download className="size-3.5" /> 安装网关
                  </Button>
                )}
              </div>
            </Row>
            <Row>
              <div className="min-w-0">
                <div className="text-[13px]">网关可执行文件</div>
                <code className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{gw?.bin ?? "未安装"}</code>
              </div>
            </Row>
            <Row>
              <div className="min-w-0">
                <div className="text-[13px]">网关账号凭证目录</div>
                <code className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                  {gw?.auth_dir ?? "~/.wb-switch/gateway/wbs_auths"}
                </code>
              </div>
            </Row>
            <Row className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
              <div className="min-w-0">
                <div className="text-[13px]">致谢</div>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {(() => {
                    const up = gw?.config?.artifact?.upstream_repo;
                    const upOwner = githubOwner(up) ?? "作者";
                    const src = gw?.config?.artifact?.source_url?.replace(/\/releases\/?$/, "");
                    const srcOwner = githubOwner(src) ?? "作者";
                    return (
                      <>
                        <a href={`https://github.com/${upOwner}`} target="_blank" rel="noopener noreferrer" className="rounded bg-blue-500/15 px-1 font-semibold text-blue-700 hover:bg-blue-500/25 dark:text-blue-400">@{upOwner}</a> 开源项目{" "}
                        「<a href={up} target="_blank" rel="noopener noreferrer" className="rounded bg-blue-500/15 px-1 font-semibold text-blue-700 hover:bg-blue-500/25 dark:text-blue-400">WorkBuddy2API</a>」，更新源由{" "}
                        <a href={`https://github.com/${srcOwner}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-foreground hover:opacity-80">@{srcOwner}</a> 提供的{" "}
                        「<a href={src} target="_blank" rel="noopener noreferrer" className="font-semibold text-foreground hover:opacity-80">WorkBuddy2API</a>」 获取。
                      </>
                    );
                  })()}
                </p>
              </div>
            </Row>
          </Section>
        </TabsContent>
      </Tabs>

      <OAuthLoginDialog open={oauthOpen} onOpenChange={setOauthOpen} />

      {/* 自动入池黑名单:不入池名单配置 */}
      <Dialog open={blacklistOpen} onOpenChange={setBlacklistOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>自动入池黑名单</DialogTitle>
            <DialogDescription>
              确认后开启自动入池;勾选「不入池」的账号不会自动加入网关池。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[320px] space-y-1.5 overflow-y-auto">
            {localAccounts.filter((a) => a.uid).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">本地账号库为空。</p>
            ) : (
              localAccounts
                .filter((a) => a.uid)
                .map((acc) => {
                  const uid = acc.uid!;
                  const inBlacklist = blacklistDraft.includes(uid);
                  return (
                    <label key={acc.id} className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2 text-sm">
                      <span className="min-w-0 truncate">{acc.nickname || acc.email || uid}</span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                        不入池
                        <Switch
                          checked={inBlacklist}
                          onCheckedChange={() =>
                            setBlacklistDraft((d) => (inBlacklist ? d.filter((u) => u !== uid) : [...d, uid]))
                          }
                        />
                      </span>
                    </label>
                  );
                })
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setBlacklistOpen(false)}>取消</Button>
            <Button onClick={() => void saveBlacklist()}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 添加账号:从本地账号库多选纳管入池 */}
      <Dialog open={pickAccountOpen} onOpenChange={(o) => { setPickAccountOpen(o); if (!o) setPickSelection([]); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>选择账号</DialogTitle>
            <DialogDescription>勾选要加入网关池的账号,确认后一并纳管。</DialogDescription>
          </DialogHeader>
          <div className="max-h-[320px] space-y-1.5 overflow-y-auto">
            {onboardOptions.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">本地账号库为空,请先扫码添加。</p>
            ) : (
              onboardOptions.map((opt) => {
                const selected = pickSelection.includes(opt.id);
                return (
                  <label
                    key={opt.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">{opt.label}</span>
                    <Switch
                      checked={selected}
                      onCheckedChange={() =>
                        setPickSelection((s) => (selected ? s.filter((id) => id !== opt.id) : [...s, opt.id]))
                      }
                    />
                  </label>
                );
              })
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPickAccountOpen(false)}>取消</Button>
            <Button onClick={() => void confirmPickAccounts()} disabled={pickSelection.length === 0 || onboarding}>
              确定添加({pickSelection.length})
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 端口/API Key 变更:保存时确认是否重启网关 */}
      <Dialog
        open={restartConfirmOpen}
        onOpenChange={(o) => {
          if (!o) void cancelRestartSave();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>端口或 API Key 已修改</DialogTitle>
            <DialogDescription>
              保存并立即重启网关才能生效。若取消,端口与 API Key 保持原值,其余配置照常保存。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => void cancelRestartSave()}>
              取消
            </Button>
            <Button onClick={() => void confirmRestartAndSave()}>
              保存并重启
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={gwInstallOpen} onOpenChange={(o) => { if (gwInstallPhase !== "installing") setGwInstallOpen(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{gwInstallMode === "upgrade" ? "升级网关" : "安装网关"}</DialogTitle>
            <DialogDescription>
              {gwInstallPhase === "done"
                ? gwInstallMode === "upgrade"
                  ? "网关已升级到最新版本。"
                  : "网关已安装完成,可以立即启动。"
                : gwInstallPhase === "installing"
                  ? "正在下载并安装网关,请稍候…"
                  : gwInstallMode === "upgrade"
                    ? "发现新版本,确认后下载并替换网关二进制。"
                    : "尚未检测到 wb2api 网关二进制。确认后将自动下载最新版本并生成默认配置。"}
            </DialogDescription>
          </DialogHeader>

          {gwInstallPhase === "installing" ? (
            <div className="flex items-center gap-3 py-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              <span>正在下载并安装网关…</span>
            </div>
          ) : gwInstallPhase === "done" ? (
            <div className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">已安装版本</span>
                <span className="font-mono tabular-nums">{gwInstalledVersion ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">安装位置</span>
                <code className="truncate font-mono">~/.wb-switch/gateway/bin/wb2api</code>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs">
              {gwInstallMode === "upgrade" && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">当前版本</span>
                  <span className="font-mono tabular-nums">{gwInstallCurrent ?? "—"}</span>
                </div>
              )}
              {gwInstallMode === "install" && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">项目</span>
                  <span className="truncate">workbuddy2api(上游 OpenAI 兼容网关)</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">最新版本</span>
                <span className="font-mono tabular-nums">{gwInstallRemote ?? "获取中…"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">目标文件</span>
                <code className="truncate font-mono">{gwAssetName ?? gwPlatformKey}</code>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">安装位置</span>
                <code className="truncate font-mono">~/.wb-switch/gateway/bin/wb2api</code>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            {gwInstallPhase === "done" ? (
              <>
                <Button variant="outline" onClick={() => setGwInstallOpen(false)}>稍后再说</Button>
                <Button onClick={() => { setGwInstallOpen(false); void handleGwStart(); }}>
                  <Play className="size-3.5" /> 启动网关
                </Button>
              </>
            ) : gwInstallPhase === "installing" ? null : (
              <>
                <Button variant="outline" onClick={() => setGwInstallOpen(false)} disabled={gwUpdating !== null}>取消</Button>
                <Button onClick={() => void installGw()} disabled={gwUpdating !== null}>
                  <Download className="size-3.5" /> {gwInstallMode === "upgrade" ? "确认升级" : "确认安装"}
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
