//! 网关管理页的演示(demo/截图)数据:读接口返回虚构数据,写操作抛「演示模式下不可操作」。
//! 与 screenshot-demo.ts 的约定一致,让网关页在 demo 构建里和其他页面一样可展示。

import { DEMO_UNAVAILABLE_MESSAGE } from "./demo-mode";
import type {
  GatewayConfig,
  GatewayStatus,
  GatewayUpdateCheck,
  WB2APIConfig,
  WB2APIModel,
  WB2APIModelCatalog,
  WB2APIPoolAccounts,
  WB2APIPoolSummary,
  WB2APIStats,
  WB2APIStatsModel,
} from "./types";

/** demo 中不可操作的写命令(与截图约定一致:只展示,不可改)。 */
const WRITE_COMMANDS = new Set([
  "wb2api_account_op",
  "wb2api_onboard",
  "wb2api_offboard",
  "gateway_start",
  "gateway_stop",
  "gateway_save_config",
  "gateway_sync_now",
  "gateway_apply_update",
]);

const DEMO_PORT = 7863;
const DEMO_API_KEY = "wbs-demo-9f3c2a41b7d8e5f0";
const DEMO_AUTH_DIR = "~/.wb-switch/gateway/auths";

const demoConfig: WB2APIConfig = {
  baseUrl: `http://127.0.0.1:${DEMO_PORT}`,
  apiKey: DEMO_API_KEY,
  authDir: DEMO_AUTH_DIR,
  configPath: "~/.wb-switch/gateway/wbs_wb2api.json",
};

const demoGatewayConfig: GatewayConfig = {
  enabled: true,
  bin_path: "",
  port: DEMO_PORT,
  api_key: DEMO_API_KEY,
  mode: "balance",
  pinned_uid: null,
  rotation_uid: null,
  auto_start: true,
  artifact: {
    source_url: "https://github.com/iliYF/workbuddy-switch/releases/latest",
    version: "1.2.3",
    assets: { "darwin-arm64": "wb2api-darwin-arm64" },
  },
  sync_enabled: true,
  sync_interval_seconds: 30,
  webui_poll_seconds: 5,
  pool_uids: [],
  no_sync_uids: ["demo-user-001"],
};

const demoGatewayStatus: GatewayStatus = {
  running: true,
  healthy: true,
  version: "1.2.3",
  port: DEMO_PORT,
  port_available: false,
  bin: "wb2api",
  auth_dir: DEMO_AUTH_DIR,
  config: demoGatewayConfig,
};

const demoPoolSummary: WB2APIPoolSummary = {
  total: 3,
  healthy: 3,
  cooling: 0,
  disabled: 0,
  in_flight_full: false,
  realm_totals: {
    cn: { total: 3, healthy: 3, cooling: 0, disabled: 0, in_flight_full: 0 },
  },
  sticky_sessions: 0,
  redis_mode: "off",
};

const demoPoolAccounts: WB2APIPoolAccounts = {
  configured: true,
  pool: null,
  accounts: [
    {
      uid: "demo-user-001",
      accessToken: "wbs-demo-token-1",
      nickname: "测试 A",
      enterpriseId: "demo-enterprise-1",
      domain: "https://workbuddy.qq.com",
      realm: "cn",
      file: "demo-user-001.json",
      pool: {
        uid: "demo-user-001",
        realm: "cn",
        nickname: "测试 A",
        credits: 1270.62,
        cooling: false,
        disabled: false,
        manual_disabled: false,
        in_flight: 0,
      },
      credit: { total: 5000, remaining: 1270.62, soonestExpireAt: 0, expiringSoon: false, expired: false },
    },
    {
      uid: "demo-user-002",
      accessToken: "wbs-demo-token-2",
      nickname: "测试 B",
      enterpriseId: "demo-enterprise-2",
      domain: "https://workbuddy.qq.com",
      realm: "cn",
      file: "demo-user-002.json",
      pool: {
        uid: "demo-user-002",
        realm: "cn",
        nickname: "测试 B",
        credits: 2497.16,
        cooling: false,
        disabled: false,
        manual_disabled: false,
        in_flight: 0,
      },
      credit: { total: 5000, remaining: 2497.16, soonestExpireAt: 0, expiringSoon: false, expired: false },
    },
    {
      uid: "demo-user-003",
      accessToken: "wbs-demo-token-3",
      nickname: "测试 C",
      enterpriseId: "demo-enterprise-3",
      domain: "https://workbuddy.qq.com",
      realm: "cn",
      file: "demo-user-003.json",
      pool: {
        uid: "demo-user-003",
        realm: "cn",
        nickname: "测试 C",
        credits: 595.08,
        cooling: true,
        cool_remaining_sec: 42,
        disabled: false,
        manual_disabled: false,
        in_flight: 0,
      },
      credit: { total: 5000, remaining: 595.08, soonestExpireAt: 0, expiringSoon: false, expired: false },
    },
  ],
};

function statsRow(
  model: string,
  requests: number,
  credit: number,
  extra?: Partial<WB2APIStatsModel>,
): WB2APIStatsModel {
  const success = Math.round(requests * 0.97);
  const failed = requests - success;
  const totalTokens = requests * 1540;
  return {
    model,
    requests,
    success,
    failed,
    streaming: Math.round(requests * 0.72),
    avg_ttfb_ms: 412,
    avg_latency_ms: 1890,
    tokens_per_sec: 38.2,
    prompt_tokens: Math.round(totalTokens * 0.4),
    completion_tokens: Math.round(totalTokens * 0.6),
    total_tokens: totalTokens,
    cache_hit_tokens: Math.round(totalTokens * 0.55),
    cache_miss_tokens: Math.round(totalTokens * 0.45),
    cache_write_tokens: Math.round(totalTokens * 0.2),
    cache_hit_rate: 0.55,
    credit,
    credit_per_req: Number((credit / requests).toFixed(4)),
    last_seen: null,
    ...extra,
  };
}

const demoStats: WB2APIStats = {
  enabled: true,
  since: "2026-09-01T00:00:00Z",
  now: new Date().toISOString(),
  uptime_sec: 86400 * 13,
  total: statsRow("total", 2133 + 24 + 62, 1794.39 + 2497.16, {
    model: "total",
    avg_ttfb_ms: 428,
    avg_latency_ms: 1834,
  }),
  models: [
    statsRow("deepseek-v4-flash", 2133, 1794.39),
    statsRow("kimi-k3-1", 24, 2497.16, { cache_hit_rate: 0.62 }),
    statsRow("hy3", 62, 0, { cache_hit_rate: 0.21 }),
  ],
};

const demoModels: WB2APIModel[] = [
  {
    id: "cn:deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    context_length: 65536,
    credits: "x0.05",
    vendor: "deepseek",
    series: "deepseek",
    is_default: true,
    supports_reasoning: true,
    reasoning_effort: "medium",
    reasoning_supported_efforts: ["low", "medium", "high"],
  },
  {
    id: "cn:kimi-k3-1",
    name: "Kimi K3.1",
    context_length: 131072,
    credits: "x0.20",
    vendor: "moonshot",
    series: "kimi",
    supports_tool_call: true,
  },
  {
    id: "cn:glm-5.2",
    name: "GLM 5.2",
    context_length: 131072,
    credits: "x0.16",
    vendor: "zhipu",
    series: "glm",
    supports_images: true,
  },
];

const demoTencentCatalog: WB2APIModelCatalog = {
  models: demoModels,
  source: "tencent",
  source_label: "模型中心",
  realm: "cn",
};

const demoGlobalCatalog: WB2APIModelCatalog = {
  models: [
    {
      id: "global:deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      context_length: 65536,
      credits: "x0.05",
      vendor: "deepseek",
      series: "deepseek",
      is_default: true,
    },
    {
      id: "global:o4-mini",
      name: "o4-mini",
      context_length: 131072,
      credits: "x0.20",
      vendor: "openai",
      series: "openai",
    },
  ],
  source: "tencent",
  source_label: "模型中心",
  realm: "global",
};

const demoUpdateCheck: GatewayUpdateCheck = {
  available: true,
  message: "发现新版本",
  source: "github",
  current: "1.2.3",
  remote: "1.3.0",
};

/** demo 模式的网关读接口/工具接口返回虚构数据;写命令抛「演示模式下不可操作」。 */
export function gatewayDemoResponse(command: string, args?: Record<string, unknown>): unknown {
  if (WRITE_COMMANDS.has(command)) throw new Error(DEMO_UNAVAILABLE_MESSAGE);
  switch (command) {
    case "wb2api_status":
      return demoPoolSummary;
    case "wb2api_models":
      return { object: "list", data: demoModels };
    case "wb2api_stats":
      return demoStats;
    case "wb2api_pool_accounts":
      return demoPoolAccounts;
    case "wb2api_model_catalog":
      return args?.realm === "global" ? demoGlobalCatalog : demoTencentCatalog;
    case "wb2api_get_config":
      return demoConfig;
    case "gateway_status":
      return demoGatewayStatus;
    case "gateway_pick_port":
      return { port: 7911 };
    case "gateway_port_check":
      return { port: Number(args?.port ?? 0), available: Number(args?.port) === 7863 ? false : true };
    case "gateway_check_update":
      return demoUpdateCheck;
    case "gateway_gen_key":
      return { api_key: "wbs-demo-5f0e4d3c2b1a9f8e" };
    default:
      throw new Error(DEMO_UNAVAILABLE_MESSAGE);
  }
}
