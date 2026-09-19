//! 网关托管:定位 wb2api 二进制、起停子进程、健康检查、端口管理、配置生成。
//!
//! 网关是**独立二进制**(wb2api 独立发布),本模块负责托管它:写原生配置 →
//! 拉起子进程 → `/healthz` 校验 `service=="workbuddy2api"` 防假启动。工作模式
//! (balance/pinned)存储于此,由账号单向推送(account_sync)据此决定导出哪些账号。

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use wb_switch_core::modules::config::{atomic_write, http_request, http_request_raw};

use crate::modules::wb2api::{gateway_root, GATEWAY_PREFIX};

/// 进程句柄:server 进程内单例(与账号库并发写一致,单实例保护由宿主负责)。
static GATEWAY_PROC: Mutex<Option<Child>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// 路径与配置三件套(~/.wb-switch/gateway/wbs_gateway.json)
// ---------------------------------------------------------------------------

pub fn gateway_config_file() -> PathBuf {
    gateway_root().join(format!("{GATEWAY_PREFIX}gateway.json"))
}

/// 网关二进制托管目录(bin 保持无前缀,便于手工放入 wb2api*)。
pub fn gateway_bin_dir() -> PathBuf {
    gateway_root().join("bin")
}

pub fn gateway_native_config_file() -> PathBuf {
    gateway_root().join(format!("{GATEWAY_PREFIX}gateway_native_config.json"))
}

/// 被托管网关的账号凭证目录(account_sync 推送至此)。
pub fn gateway_auth_dir() -> PathBuf {
    gateway_root().join(format!("{GATEWAY_PREFIX}auths"))
}

fn gateway_state_file() -> PathBuf {
    gateway_root().join(format!("{GATEWAY_PREFIX}data")).join("state.json")
}

pub fn default_gateway_config() -> Value {
    json!({
        "enabled": false,
        "bin_path": "",
        "port": 54321,
        // 访问密钥默认自动生成一个(网关必须鉴权,不允许留空)。
        "api_key": generate_api_key(),
        "mode": "balance",
        "pinned_uid": null,
        // 积分轮转模式下的当前活跃账号(由 hub 巡检轮转维护)。
        "rotation_uid": null,
        "auto_start": false,
        // 网关产物:来源基址 / 当前版本 / 平台资产名(发新版或产物改名时改这里)。
        "artifact": {
            "source_url": "https://github.com/iliYF/workbuddy2api/releases",
            "version": "",
            "assets": {
                "darwin-arm64": "wb2api-darwin-arm64",
                "darwin-amd64": "wb2api-darwin-amd64",
                "windows-amd64": "wb2api-windows-amd64.exe",
                "linux-amd64": "wb2api-linux-amd64",
                "linux-arm64": "wb2api-linux-arm64",
            },
        },
        // 自动入池:开启后本地账号库的账号自动进入网关池(仍需不在 no_sync_uids)。
        "sync_enabled": false,
        // 手动入池:显式勾选要入池的账号(自动入池关闭时是唯一来源)。
        "pool_uids": [],
        // 永不入池:无论自动/手动都不导出(如主账号,避免风控)。
        "no_sync_uids": [],
        // 自动入池巡检间隔(秒):开启自动入池后按此间隔同步账号库;未开启不巡检。
        "sync_interval_seconds": 30,
        // webui 池状态刷新间隔(秒):前端页面轮询池账号/汇总的间隔;最小 5s,最大 3600s。
        "webui_poll_seconds": 5,
    })
}

/// 生成访问密钥:`wbs-` 前缀 + 32 位十六进制随机。
pub fn generate_api_key() -> String {
    format!("wbs-{}", uuid::Uuid::new_v4().simple())
}

fn merge_gateway_config(input: &Value) -> Value {
    let mut merged = default_gateway_config();
    if let Some(map) = input.as_object() {
        for key in ["bin_path", "api_key"] {
            if let Some(v) = map.get(key).and_then(Value::as_str) {
                if !v.trim().is_empty() {
                    merged[key] = json!(v.trim());
                }
            }
        }
        // mode 限定三值,非法回落 balance。
        if let Some(v) = map.get("mode").and_then(Value::as_str) {
            let m = v.trim();
            if matches!(m, "balance" | "rotation" | "pinned") {
                merged["mode"] = json!(m);
            }
        }
        if let Some(v) = map.get("port").and_then(Value::as_i64) {
            if (1..=65535).contains(&v) {
                merged["port"] = json!(v);
            }
        }
        for key in ["enabled", "auto_start", "sync_enabled"] {
            if let Some(v) = map.get(key).and_then(Value::as_bool) {
                merged[key] = json!(v);
            }
        }
        if let Some(v) = map.get("sync_interval_seconds").and_then(Value::as_i64) {
            if (10..=3600).contains(&v) {
                merged["sync_interval_seconds"] = json!(v);
            }
        }
        if let Some(v) = map.get("webui_poll_seconds").and_then(Value::as_i64) {
            if (5..=3600).contains(&v) {
                merged["webui_poll_seconds"] = json!(v);
            }
        }
        for key in ["pool_uids", "no_sync_uids"] {
            if let Some(v) = map.get(key).and_then(Value::as_array) {
                let uids: Vec<&str> = v.iter().filter_map(Value::as_str).collect();
                merged[key] = json!(uids);
            }
        }
        for key in ["pinned_uid", "rotation_uid"] {
            if let Some(v) = map.get(key).cloned() {
                if !v.is_null() {
                    merged[key] = v;
                }
            }
        }
        // artifact:source_url / version 字符串,assets 按键覆盖(发新版或产物改名时改这里)。
        if let Some(art) = map.get("artifact").and_then(Value::as_object) {
            if let Some(v) = art.get("source_url").and_then(Value::as_str) {
                if !v.trim().is_empty() {
                    merged["artifact"]["source_url"] = json!(v.trim());
                }
            }
            if let Some(v) = art.get("version").and_then(Value::as_str) {
                if !v.trim().is_empty() {
                    merged["artifact"]["version"] = json!(v.trim());
                }
            }
            if let Some(am) = art.get("assets").and_then(Value::as_object) {
                for (k, v) in am {
                    if let Some(s) = v.as_str() {
                        if !s.trim().is_empty() {
                            merged["artifact"]["assets"][k] = json!(s.trim());
                        }
                    }
                }
            }
        }
    }
    merged
}

/// 未落盘前的内存默认配置:首次安装未确认前不生成配置文件,进程内缓存保证 api_key 稳定。
static DEFAULT_GW_CFG: Mutex<Option<Value>> = Mutex::new(None);

fn default_gateway_config_cached() -> Value {
    DEFAULT_GW_CFG
        .lock()
        .unwrap()
        .get_or_insert_with(default_gateway_config)
        .clone()
}

pub fn load_gateway_config() -> Value {
    let f = gateway_config_file();
    if f.exists() {
        if let Ok(text) = std::fs::read_to_string(&f) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                let had_key = value
                    .get("api_key")
                    .and_then(Value::as_str)
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false);
                let merged = merge_gateway_config(&value);
                // 迁移:旧文件 api_key 为空 → 补一个稳定的并落盘,避免每次读都漂移。
                if !had_key {
                    let content = serde_json::to_string_pretty(&merged).unwrap_or_default();
                    let _ = atomic_write(&f, &content);
                }
                return merged;
            }
        }
    }
    // 文件缺失:返回内存默认(不落盘),等安装确认/保存时才生成配置文件。
    default_gateway_config_cached()
}

/// 保存托管配置,并从端口/密钥派生出 wb2api 对接配置(baseUrl/apiKey/authDir)。
///
/// 网关页只让用户填一次(端口 + API Key);hub 连网关所需的对接信息由这里自动
/// 写入 `~/.wb-switch/gateway/wbs_wb2api.json`,避免两处重复填写。
pub fn save_gateway_config(cfg: &Value) -> std::io::Result<()> {
    let merged = merge_gateway_config(cfg);
    std::fs::create_dir_all(gateway_root())?;
    let content = serde_json::to_string_pretty(&merged).unwrap_or_default();
    atomic_write(&gateway_config_file(), &content)?;
    write_derived_wb2api_config(&merged);
    Ok(())
}

/// 把网关配置派生进 wb2api 对接配置(端口→baseUrl,api_key→apiKey,凭证目录→authDir)。
fn write_derived_wb2api_config(gw: &Value) {
    let port = gw.get("port").and_then(Value::as_i64).unwrap_or(54321);
    let api_key = gw.get("api_key").and_then(Value::as_str).unwrap_or("");
    let derived = json!({
        "baseUrl": format!("http://127.0.0.1:{port}"),
        "apiKey": api_key,
        "authDir": gateway_auth_dir().to_string_lossy(),
        "configPath": gateway_native_config_file().to_string_lossy(),
    });
    let _ = crate::modules::wb2api::save_wb2api_config(&derived);
}

fn cfg_str(key: &str) -> String {
    load_gateway_config()
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn cfg_port() -> u16 {
    load_gateway_config()
        .get("port")
        .and_then(Value::as_i64)
        .unwrap_or(54321)
        .clamp(1, 65535) as u16
}

// ---------------------------------------------------------------------------
// 二进制定位 / 端口
// ---------------------------------------------------------------------------

/// 定位网关二进制:env `WB_SWITCH_GATEWAY_BIN` → `~/.wb-switch/gateway/bin/` → 配置 `bin_path`。
pub fn locate_gateway() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("WB_SWITCH_GATEWAY_BIN") {
        let p = p.trim().to_string();
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return Some(PathBuf::from(p));
        }
    }
    if let Ok(rd) = std::fs::read_dir(gateway_bin_dir()) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("wb2api") {
                return Some(entry.path());
            }
        }
    }
    let p = cfg_str("bin_path");
    if !p.is_empty() && std::path::Path::new(&p).exists() {
        return Some(PathBuf::from(p));
    }
    None
}

/// 端口是否空闲(尝试绑定 127.0.0.1)。
pub fn port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// 从起始端口向上找空闲端口。
pub fn pick_free_port(from: u16) -> u16 {
    (from..from.saturating_add(100)).find(|p| port_available(*p)).unwrap_or(from)
}

/// 伪随机种子(时间纳秒 ^ pid),避免每次生成同一起点。
fn random_seed() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    let mut x = nanos ^ pid.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xC2B2_AE3D_27D4_EB4F;
    x ^= x >> 30;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^= x >> 31;
    x
}

/// 从 `base` 起随机挑一个空闲端口:在 [base, base+range) 内从随机起点逐个探测可用性。
pub fn pick_random_free_port(base: u16, range: u16) -> u16 {
    let start = (random_seed() % range as u64) as u16;
    for i in 0..range {
        let candidate = base + ((start + i) % range);
        if port_available(candidate) {
            return candidate;
        }
    }
    base
}

// ---------------------------------------------------------------------------
// 配置生成 / 进程托管
// ---------------------------------------------------------------------------

/// 把 wbs_gateway.json 转成 wb2api 原生配置(listen/api_key/auth_dir/state_file/admin/global)。
fn write_native_config() -> Result<PathBuf, String> {
    let port = cfg_port();
    let cfg = json!({
        "listen": format!("127.0.0.1:{port}"),
        "api_key": cfg_str("api_key"),
        "auth_dir": gateway_auth_dir().to_string_lossy(),
        "state_file": gateway_state_file().to_string_lossy(),
        "admin": { "enabled": true },
        "global": { "enabled": true },
    });
    if let Some(parent) = gateway_native_config_file().parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建网关目录失败: {e}"))?;
    }
    let content = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    atomic_write(&gateway_native_config_file(), &content).map_err(|e| format!("写网关配置失败: {e}"))?;
    Ok(gateway_native_config_file())
}

/// 扫描进程列表,返回命令行含 `needle` 的进程 PID(ps -A -o pid=,command=;排除自身)。
/// ps 的 pid 列右对齐带前导空格,须按空白整体切分。
fn process_pids_matching(needle: &str) -> Vec<u32> {
    let Ok(output) = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,command="])
        .output()
    else {
        return vec![];
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let self_pid = std::process::id();
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse::<u32>().ok()?;
            if pid == self_pid {
                return None;
            }
            let cmd = parts.collect::<Vec<&str>>().join(" ");
            cmd.contains(needle).then_some(pid)
        })
        .collect()
}

/// 当前网关二进制绝对路径(进程识别的标记)。
fn gateway_bin_marker() -> Option<String> {
    let bin = locate_gateway()?;
    let path = bin.to_string_lossy();
    if path.is_empty() {
        return None;
    }
    Some(path.into_owned())
}

/// 网关进程是否存活:优先看当前进程托管的子进程;若句柄丢失(wb-switch 重启后网关成孤儿
/// 进程仍占端口),按网关二进制路径扫描进程列表兜底识别,避免误报「未运行」导致重复启动。
fn process_alive() -> bool {
    let mut guard = GATEWAY_PROC.lock().unwrap();
    if guard
        .as_mut()
        .is_some_and(|c| c.try_wait().map(|s| s.is_none()).unwrap_or(false))
    {
        return true;
    }
    drop(guard);
    gateway_bin_marker()
        .map(|marker| !process_pids_matching(&marker).is_empty())
        .unwrap_or(false)
}

/// 健康检查:`GET /healthz`,校验 `service=="workbuddy2api"`(防假启动)。
pub async fn probe_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/healthz");
    let resp = http_request(&url, "GET", None, None).await;
    resp.get("service").and_then(Value::as_str) == Some("workbuddy2api")
}

/// 读取 `/healthz` 的 version 字段(构建时经 ldflags 注入,未注入为 "dev")。
async fn probe_version(port: u16) -> Option<String> {
    let url = format!("http://127.0.0.1:{port}/healthz");
    let resp = http_request(&url, "GET", None, None).await;
    resp.get("version").and_then(Value::as_str).map(str::to_string)
}

/// 启动网关:写配置 → 拉起子进程 → 健康检查重试(最多 5s)。
pub async fn start_gateway() -> Result<Value, String> {
    if process_alive() {
        // 进程活着:仍以 healthz 复核;健康则直接返回,不健康则报错(提示重启)。
        if probe_health(cfg_port()).await {
            return Ok(json!({ "ok": true, "running": true, "healthy": true, "port": cfg_port() }));
        }
        return Err("网关进程在,但 /healthz 不健康;可尝试重启".to_string());
    }
    let bin = locate_gateway().ok_or("未找到网关二进制:请配置 bin_path 或放入 ~/.wb-switch/gateway/bin")?;
    if !port_available(cfg_port()) {
        return Err(format!("端口 {} 已被占用,可先选择空闲端口", cfg_port()));
    }
    let config_path = write_native_config()?;
    std::fs::create_dir_all(gateway_auth_dir()).map_err(|e| format!("创建 auths 目录失败: {e}"))?;
    // 预创建 state 目录,保证 state_file 路径就绪(wb2api 落盘时自建,这里提前建好)。
    if let Some(parent) = gateway_state_file().parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 state 目录失败: {e}"))?;
    }
    // 启动前先同步一次账号,让网关池有凭证。
    crate::modules::account_sync::sync_now();
    let child = Command::new(&bin)
        .arg("-config")
        .arg(&config_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("启动网关失败: {e}"))?;
    *GATEWAY_PROC.lock().unwrap() = Some(child);

    for _ in 0..10 {
        if probe_health(cfg_port()).await {
            return Ok(json!({
                "ok": true,
                "running": true,
                "healthy": true,
                "port": cfg_port(),
                "bin": bin.to_string_lossy(),
            }));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err("网关进程已启动但健康检查失败(/healthz service 不符)".to_string())
}

/// 停止网关:杀托管的子进程(Windows 尽力 taskkill 子树防孤儿),并兜底杀按二进制
/// 路径识别到的孤儿网关进程(wb-switch 重启后未被托管的残留)。
pub fn stop_gateway() -> Result<Value, String> {
    {
        let mut guard = GATEWAY_PROC.lock().unwrap();
        if let Some(mut child) = guard.take() {
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &child.id().to_string()]).status();
            }
            #[cfg(not(windows))]
            {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
    if let Some(marker) = gateway_bin_marker() {
        for pid in process_pids_matching(&marker) {
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).status();
            }
            #[cfg(not(windows))]
            {
                let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
            }
        }
    }
    Ok(json!({ "ok": true, "running": false }))
}

/// 网关运行状态:进程存活 + 健康 + 版本 + 端口 + 二进制路径 + 配置。
pub async fn gateway_status() -> Value {
    let running = process_alive();
    let port = cfg_port();
    let (healthy, version) = if running {
        let url = format!("http://127.0.0.1:{port}/healthz");
        let resp = http_request(&url, "GET", None, None).await;
        let healthy = resp.get("service").and_then(Value::as_str) == Some("workbuddy2api");
        let version = resp.get("version").and_then(Value::as_str).map(str::to_string);
        (healthy, version)
    } else {
        (false, None)
    };
    json!({
        "running": running,
        "healthy": healthy,
        "version": version,
        "port": port,
        "port_available": port_available(port),
        "bin": locate_gateway().map(|p| p.to_string_lossy().to_string()),
        "auth_dir": gateway_auth_dir().to_string_lossy(),
        "config": load_gateway_config(),
    })
}

// ---------------------------------------------------------------------------
// 网关独立升级(与客户端升级解耦)
// ---------------------------------------------------------------------------

/// artifact.source_url:网关 release 基址(配一次不动)。
fn cfg_source_url() -> String {
    load_gateway_config()
        .get("artifact")
        .and_then(|a| a.get("source_url"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// artifact.version:当前记录版本(升级成功后写回,与 /healthz 一致)。
fn cfg_artifact_version() -> String {
    load_gateway_config()
        .get("artifact")
        .and_then(|a| a.get("version"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 平台键(artifact.assets 查询用):OS/arch → 稳定键,产物名可经配置覆盖。
fn platform_key() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-amd64",
        ("windows", "x86_64") => "windows-amd64",
        ("linux", "x86_64") => "linux-amd64",
        ("linux", "aarch64") => "linux-arm64",
        _ => "unknown",
    }
}

/// 平台对应的 release 产物名:读配置 `artifact.assets[platform_key()]`,缺省回落 "wb2api"。
fn platform_asset() -> String {
    load_gateway_config()
        .get("artifact")
        .and_then(|a| a.get("assets"))
        .and_then(|m| m.get(platform_key()))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("wb2api")
        .to_string()
}

/// 从 `{source_url}.atom` 取最新 release tag(第一个 `<entry>` 的 `<title>`)。
/// GitHub 原生 feed,无需 API 鉴权/限流;无 stable 时也能给出最新 canary tag。
async fn fetch_latest_tag(src: &str) -> Option<String> {
    let url = format!("{}.atom", src.trim_end_matches('/'));
    let (status, _, body) = http_request_raw(&url, "GET", None, None, None, true).await;
    if status != 200 {
        return None;
    }
    // feed 级 <title> 在 <entry> 之前,须从第一个 <entry> 之后取 <title>。
    let body = &body[body.find("<entry>")?..];
    let (a, b) = (body.find("<title>")?, body.find("</title>")?);
    if a >= b {
        return None;
    }
    let tag = body[a + "<title>".len()..b].trim();
    (!tag.is_empty()).then(|| tag.to_string())
}

/// 检查网关更新:远端取 releases.atom 最新 tag,对比当前版本(/healthz,网关未跑则用 artifact.version)。
pub async fn check_gateway_update() -> Value {
    let src = cfg_source_url();
    if src.is_empty() {
        return json!({ "available": false, "message": "未配置 artifact.source_url" });
    }
    let current = if process_alive() {
        probe_version(cfg_port()).await.or_else(|| {
            let v = cfg_artifact_version();
            (!v.is_empty()).then_some(v)
        })
    } else {
        let v = cfg_artifact_version();
        (!v.is_empty()).then_some(v)
    };
    let Some(remote) = fetch_latest_tag(&src).await else {
        return json!({
            "available": false,
            "current": current,
            "remote": Value::Null,
            "message": "无法读取远端 release 版本(releases.atom)",
        });
    };
    let updatable = current.as_deref() != Some(remote.as_str());
    let message = match (&current, updatable) {
        (Some(c), true) => format!("发现新版本 {remote}(当前 {c})"),
        (Some(_), false) => format!("已是最新({remote})"),
        (None, _) => format!("远端 {remote},当前版本未知(网关未运行)"),
    };
    json!({
        "available": updatable,
        "current": current,
        "remote": remote,
        "source": src,
        "message": message,
    })
}

/// 下载并原子替换网关二进制;可选 sha256 校验;网关在跑则用新二进制重启。
/// 目标版本取 releases.atom 最新 tag,下载 `{source_url}/download/{tag}/{asset}`;
/// 成功后把 artifact.version 写回为该 tag(与 /healthz 一致)。
pub async fn apply_gateway_update(sha256: Option<&str>) -> Result<Value, String> {
    let src = cfg_source_url();
    if src.is_empty() {
        return Err("未配置 artifact.source_url".to_string());
    }
    let tag = fetch_latest_tag(&src).await.ok_or("无法解析远端最新版本(releases.atom)")?;
    // 已记录版本与远端一致且二进制在位时不重复下载覆盖(升级只在有新版本时生效)。
    let installed = cfg_artifact_version();
    let bin_path = gateway_bin_dir().join("wb2api");
    if !installed.is_empty() && installed == tag && bin_path.exists() {
        return Ok(json!({
            "ok": true,
            "skipped": true,
            "version": tag,
            "bin": bin_path.to_string_lossy(),
        }));
    }
    let url = format!("{}/download/{tag}/{}", src.trim_end_matches('/'), platform_asset());
    let resp = reqwest::get(&url).await.map_err(|e| format!("下载失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取下载内容失败: {e}"))?.to_vec();
    if bytes.is_empty() {
        return Err("下载内容为空".to_string());
    }

    if let Some(expected) = sha256.map(str::trim).filter(|s| !s.is_empty()) {
        use sha2::Digest;
        let mut hasher = sha2::Sha256::new();
        hasher.update(&bytes);
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(format!("SHA256 校验失败: 期望 {expected},实际 {actual}"));
        }
    }

    let was_running = process_alive();
    if was_running {
        let _ = stop_gateway();
    }

    let target = gateway_bin_dir().join("wb2api");
    let tmp = gateway_bin_dir().join("wb2api.new");
    std::fs::create_dir_all(gateway_bin_dir()).map_err(|e| format!("创建网关目录失败: {e}"))?;
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写临时文件失败: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("替换二进制失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }

    // 记录当前版本到 artifact.version(与 /healthz 保持一致)。
    let mut cfg = load_gateway_config();
    cfg["artifact"]["version"] = json!(tag);
    let _ = save_gateway_config(&cfg);

    let mut out = json!({
        "ok": true,
        "version": tag,
        "bin": target.to_string_lossy(),
        "size": bytes.len(),
    });
    if was_running {
        match start_gateway().await {
            Ok(v) => {
                out["restarted"] = json!(true);
                out["status"] = v;
            }
            Err(e) => out["restart_error"] = json!(e),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_config_defaults_and_keeps_known_fields() {
        let defaults = default_gateway_config();
        assert_eq!(defaults.get("port").and_then(Value::as_i64), Some(54321));
        assert_eq!(defaults.get("mode").and_then(Value::as_str), Some("balance"));
        assert_eq!(defaults.get("enabled").and_then(Value::as_bool), Some(false));
        assert_eq!(
            defaults.get("sync_enabled").and_then(Value::as_bool),
            Some(false),
            "自动入池默认关闭"
        );
        // 默认配置自带一个自动生成的访问密钥(网关必须鉴权,不允许留空)。
        let dk = defaults.get("api_key").and_then(Value::as_str).unwrap_or("");
        assert!(dk.starts_with("wbs-"), "默认 api_key 应为 wbs- 前缀: {dk}");

        let merged = merge_gateway_config(&json!({
            "port": 9000,
            "api_key": "wbs-x",
            "mode": "rotation",
            "rotation_uid": "u-1",
            "sync_enabled": true,
            "pool_uids": ["u-1", "u-2"],
            "no_sync_uids": ["u-9"],
            "unknown": 1,
        }));
        assert_eq!(merged.get("port").and_then(Value::as_i64), Some(9000));
        assert_eq!(merged.get("mode").and_then(Value::as_str), Some("rotation"));
        assert_eq!(merged.get("rotation_uid").and_then(Value::as_str), Some("u-1"));
        assert_eq!(merged.get("sync_enabled").and_then(Value::as_bool), Some(true));
        assert_eq!(merged.get("pool_uids"), Some(&json!(["u-1", "u-2"])));
        assert_eq!(merged.get("no_sync_uids"), Some(&json!(["u-9"])));
        assert!(merged.get("unknown").is_none());
    }

    #[test]
    fn gateway_config_rejects_unknown_mode() {
        let merged = merge_gateway_config(&json!({ "mode": "bogus" }));
        assert_eq!(merged.get("mode").and_then(Value::as_str), Some("balance"), "非法模式回落");
    }

    #[test]
    fn generate_api_key_has_wbs_prefix_and_is_unique() {
        let a = generate_api_key();
        let b = generate_api_key();
        assert!(a.starts_with("wbs-"), "前缀 wbs-: {a}");
        assert_eq!(a.len(), 4 + 32, "wbs- + 32 位十六进制");
        assert_ne!(a, b, "每次生成不同");
    }

    #[test]
    fn gateway_config_rejects_bad_port() {
        let merged = merge_gateway_config(&json!({ "port": 99999 }));
        assert_eq!(merged.get("port").and_then(Value::as_i64), Some(54321), "越界端口保持默认");
    }

    #[test]
    fn pick_free_port_finds_an_available_one() {
        let p = pick_free_port(58000);
        assert!(port_available(p), "挑出的端口应空闲");
    }

    #[test]
    fn pick_random_free_port_finds_an_available_one_in_range() {
        for _ in 0..5 {
            let p = pick_random_free_port(7863, 100);
            assert!((7863..7963).contains(&p), "应在 7863 起的 100 个端口范围内,实际 {p}");
            assert!(port_available(p), "随机挑出的端口应探测为空闲");
        }
    }

    #[test]
    fn gateway_paths_live_under_gateway_root() {
        let root = gateway_root();
        assert!(gateway_config_file().starts_with(&root));
        assert!(gateway_auth_dir().starts_with(&root));
        assert!(gateway_bin_dir().ends_with("bin"));
        // 网关配置根 = ~/.wb-switch/gateway(统一收归 switch 项目配置目录)。
        assert!(root.ends_with("gateway") && root.starts_with(wb_switch_core::modules::config::store_dir()));
    }
}
