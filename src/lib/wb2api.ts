//! 网关管理 API 客户端(workbuddy2api 对接)。
//!
//! 独立成文件,`api.ts` 不再堆网关相关代码;此处只服务 webui(不走 Tauri 双通道)。

import { DEMO_UNAVAILABLE_MESSAGE, demoModeEnabled } from "./demo-mode";
import type { WB2APIAdminState, WB2APIConfig, WB2APIModel, WB2APIModelCatalog, WB2APIPoolAccounts, WB2APIPoolSummary, WB2APIStats, GatewayConfig, GatewayStatus, GatewayUpdateCheck, GatewayUpdateResult, WbVariant } from "./types";

/** 网关管理服务地址(与 server 默认端口一致)。 */
const API_BASE = "http://127.0.0.1:54320";

function isWebui(): boolean {
  return typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
}


function guardWB2API(): void {
  if (demoModeEnabled) throw new Error(DEMO_UNAVAILABLE_MESSAGE);
  if (!isWebui()) throw new Error("网关管理仅在 webui 模式可用");
}

/** webui 且非演示模式时,网关区块可用。 */
export function wb2apiAvailable(): boolean {
  return isWebui() && !demoModeEnabled;
}

async function wb2apiFetch<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  guardWB2API();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`无法连接本地服务(${API_BASE})`);
  }
  const data = await res.json().catch(() => ({})) as {
    ok?: boolean;
    error?: string;
    message?: string;
  } & T;
  if (!res.ok) {
    throw new Error(data.error || data.message || `请求失败 (${res.status})`);
  }
  return data;
}

/** 网关管理 API(见 server api.rs 的 /api/wb2api/* 段)。 */
export const wb2api = {
  status: () =>
    wb2apiFetch<WB2APIPoolSummary>("GET", "/api/wb2api/status"),
  models: () =>
    wb2apiFetch<{ object: string; data: WB2APIModel[] }>("GET", "/api/wb2api/models"),
  /** 模型中心:直连腾讯拉真实可用模型(失败回退上游);realm 缺省 cn。 */
  modelCatalog: (realm?: WbVariant) =>
    wb2apiFetch<WB2APIModelCatalog>(
      "GET",
      `/api/wb2api/model-catalog${realm === "ai" ? "?realm=global" : ""}`,
    ),
  stats: () =>
    wb2apiFetch<WB2APIStats>("GET", "/api/wb2api/stats"),
  poolAccounts: () =>
    wb2apiFetch<WB2APIPoolAccounts>("GET", "/api/wb2api/pool-accounts"),
  accountOp: (uid: string, op: "disable" | "enable" | "revive", reason?: string) =>
    wb2apiFetch<WB2APIAdminState>(
      "POST",
      `/api/wb2api/accounts/${encodeURIComponent(uid)}/${op}`,
      reason ? { reason } : {},
    ),
  onboard: (accountId: string) =>
    wb2apiFetch<{ ok: boolean; uid: string; file: string }>("POST", "/api/wb2api/onboard", {
      accountId,
    }),
  offboard: (uid: string) =>
    wb2apiFetch<{ ok: boolean; uid: string }>("POST", "/api/wb2api/offboard", { uid }),
  getConfig: () =>
    wb2apiFetch<WB2APIConfig>("GET", "/api/wb2api/config"),
  // 网关托管
  gatewayStatus: () => wb2apiFetch<GatewayStatus>("GET", "/api/wb2api/gateway"),
  gatewayStart: () => wb2apiFetch<{ ok: boolean; running: boolean }>("POST", "/api/wb2api/gateway/start", {}),
  gatewayStop: () => wb2apiFetch<{ ok: boolean; running: boolean }>("POST", "/api/wb2api/gateway/stop", {}),
  gatewaySaveConfig: (config: Partial<GatewayConfig>) =>
    wb2apiFetch<GatewayConfig>("POST", "/api/wb2api/gateway/config", { config }),
  /** 账号单向推送:立即把账号库导出到网关 auths。 */
  gatewaySyncNow: () =>
    wb2apiFetch<{ exported: number; removed: number; accounts: number; error?: string }>(
      "POST",
      "/api/wb2api/sync/now",
      {},
    ),
  /** 自动挑选空闲端口(从 7863 起随机探测)。 */
  gatewayPickPort: () => wb2apiFetch<{ port: number }>("POST", "/api/wb2api/gateway/pick-port", {}),
  /** 探测某端口是否可绑定(服务端口可用性指示)。 */
  gatewayPortCheck: (port: number) =>
    wb2apiFetch<{ port: number; available: boolean }>(
      "GET",
      `/api/wb2api/gateway/port-check?port=${encodeURIComponent(port)}`,
    ),
  /** 网关独立升级:检查更新源。 */
  gatewayCheckUpdate: () =>
    wb2apiFetch<GatewayUpdateCheck>("GET", "/api/wb2api/gateway/update/check"),
  /** 网关独立升级:下载并替换二进制(可选 sha256),网关在跑则重启。 */
  gatewayApplyUpdate: (sha256?: string) =>
    wb2apiFetch<GatewayUpdateResult>("POST", "/api/wb2api/gateway/update", { sha256 }),
  /** 生成一个网关访问密钥(wbs- 前缀)。 */
  gatewayGenKey: () => wb2apiFetch<{ api_key: string }>("POST", "/api/wb2api/gateway/gen-key", {}),
};
