//! 网关管理 API 客户端(workbuddy2api 对接)。
//!
//! 双通道:webui 直连本地 server 的 /api/wb2api/* 路由;桌面 App 走 Tauri invoke。
//! 与 api.ts 的 call() 结构一致,网关页在两种形态下同样可用。

import { invoke } from "@tauri-apps/api/core";
import { demoModeEnabled } from "./demo-mode";
import { gatewayDemoResponse } from "./gateway-demo";
import { API_BASE } from "./api";
import type { WB2APIAdminState, WB2APIConfig, WB2APIModel, WB2APIModelCatalog, WB2APIPoolAccounts, WB2APIPoolSummary, WB2APIStats, GatewayConfig, GatewayStatus, GatewayUpdateCheck, GatewayUpdateResult, WbVariant } from "./types";

/** 网关默认监听端口(与后端 DEFAULT_GATEWAY_PORT 同口径)。 */
export const DEFAULT_GATEWAY_PORT = 54321;
/** 自动选端口候选下限(与后端 PORT_PICK_BASE 同口径)。 */
export const PORT_PICK_BASE = 7863;
/** 自动选端口候选上限(与后端 PORT_PICK_MAX 同口径)。 */
export const PORT_PICK_MAX = 65535;

function isWebui(): boolean {
  return typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
}

/** 网关管理在 webui / 桌面 App / demo 均可用;写操作在 demo 下抛「演示模式下不可操作」。 */
export function wb2apiAvailable(): boolean {
  return true;
}

/** webui 通道:直连本地 server 的 /api/wb2api/* 路由。 */
async function wb2apiFetch<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
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

/** 双通道:demo 走虚构数据,桌面走 Tauri invoke,webui 走本地 HTTP。 */
async function call<T>(
  invokeName: string,
  http: { method: "GET" | "POST"; path: string; body?: unknown },
  invokeArgs?: Record<string, unknown>,
): Promise<T> {
  if (demoModeEnabled) return gatewayDemoResponse(invokeName, invokeArgs) as T;
  if (!isWebui()) return invoke<T>(invokeName, invokeArgs);
  return wb2apiFetch<T>(http.method, http.path, http.body);
}

/** 网关管理 API(桌面命令见 src-tauri/src/gateway.rs;webui 路由见 server api.rs)。 */
export const wb2api = {
  status: () =>
    call<WB2APIPoolSummary>("wb2api_status", { method: "GET", path: "/api/wb2api/status" }),
  models: () =>
    call<{ object: string; data: WB2APIModel[] }>("wb2api_models", { method: "GET", path: "/api/wb2api/models" }),
  /** 模型中心:直连腾讯拉真实可用模型(失败回退上游);realm 缺省 cn。 */
  modelCatalog: (realm?: WbVariant) =>
    call<WB2APIModelCatalog>(
      "wb2api_model_catalog",
      { method: "GET", path: `/api/wb2api/model-catalog${realm === "ai" ? "?realm=global" : ""}` },
      { realm: realm === "ai" ? "global" : "cn" },
    ),
  stats: () =>
    call<WB2APIStats>("wb2api_stats", { method: "GET", path: "/api/wb2api/stats" }),
  poolAccounts: () =>
    call<WB2APIPoolAccounts>("wb2api_pool_accounts", { method: "GET", path: "/api/wb2api/pool-accounts" }),
  accountOp: (uid: string, op: "disable" | "enable" | "revive", reason?: string) =>
    call<WB2APIAdminState>(
      "wb2api_account_op",
      {
        method: "POST",
        path: `/api/wb2api/accounts/${encodeURIComponent(uid)}/${op}`,
        body: reason ? { reason } : {},
      },
      { uid, op, reason },
    ),
  onboard: (accountId: string) =>
    call<{ ok: boolean; uid: string; file: string }>(
      "wb2api_onboard",
      { method: "POST", path: "/api/wb2api/onboard", body: { accountId } },
      { accountId },
    ),
  offboard: (uid: string) =>
    call<{ ok: boolean; uid: string }>(
      "wb2api_offboard",
      { method: "POST", path: "/api/wb2api/offboard", body: { uid } },
      { uid },
    ),
  getConfig: () =>
    call<WB2APIConfig>("wb2api_get_config", { method: "GET", path: "/api/wb2api/config" }),
  // 网关托管
  gatewayStatus: () => call<GatewayStatus>("gateway_status", { method: "GET", path: "/api/wb2api/gateway" }),
  gatewayStart: () =>
    call<{ ok: boolean; running: boolean }>("gateway_start", { method: "POST", path: "/api/wb2api/gateway/start", body: {} }),
  gatewayStop: () =>
    call<{ ok: boolean; running: boolean }>("gateway_stop", { method: "POST", path: "/api/wb2api/gateway/stop", body: {} }),
  gatewaySaveConfig: (config: Partial<GatewayConfig>) =>
    call<GatewayConfig>(
      "gateway_save_config",
      { method: "POST", path: "/api/wb2api/gateway/config", body: { config } },
      { config },
    ),
  /** 账号单向推送:立即把账号库导出到网关 auths。 */
  gatewaySyncNow: () =>
    call<{ exported: number; removed: number; accounts: number; error?: string }>(
      "gateway_sync_now",
      { method: "POST", path: "/api/wb2api/sync/now", body: {} },
    ),
  /** 自动挑选空闲端口(PORT_PICK_BASE~PORT_PICK_MAX 随机探测)。 */
  gatewayPickPort: () =>
    call<{ port: number }>("gateway_pick_port", { method: "POST", path: "/api/wb2api/gateway/pick-port", body: {} }),
  /** 探测某端口是否可绑定(服务端口可用性指示)。 */
  gatewayPortCheck: (port: number) =>
    call<{ port: number; available: boolean }>(
      "gateway_port_check",
      { method: "GET", path: `/api/wb2api/gateway/port-check?port=${encodeURIComponent(port)}` },
      { port },
    ),
  /** 网关独立升级:检查更新源。 */
  gatewayCheckUpdate: () =>
    call<GatewayUpdateCheck>("gateway_check_update", { method: "GET", path: "/api/wb2api/gateway/update/check" }),
  /** 网关独立升级:下载并替换二进制(可选 sha256),网关在跑则重启。 */
  gatewayApplyUpdate: (sha256?: string) =>
    call<GatewayUpdateResult>(
      "gateway_apply_update",
      { method: "POST", path: "/api/wb2api/gateway/update", body: { sha256 } },
      { sha256 },
    ),
  /** 生成一个网关访问密钥(wbs- 前缀)。 */
  gatewayGenKey: () =>
    call<{ api_key: string }>("gateway_gen_key", { method: "POST", path: "/api/wb2api/gateway/gen-key", body: {} }),
};
