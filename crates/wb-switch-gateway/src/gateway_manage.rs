//! 网关托管:定位 wb2api 二进制、起停子进程、健康检查、端口管理、配置生成。
//!
//! 网关是**独立二进制**(wb2api 独立发布),本模块负责托管它:写原生配置 →
//! 拉起子进程 → `/healthz` 校验 `service=="workbuddy2api"` 防假启动。工作模式
//! (balance/pinned)存储于此,由账号单向推送(account_sync)据此决定导出哪些账号。

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use wb_switch_core::modules::config::{atomic_write, http_request};

use crate::wb2api::wbh_dir;

/// 进程句柄:server 进程内单例(与账号库并发写一致,单实例保护由宿主负责)。
static GATEWAY_PROC: Mutex<Option<Child>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// 路径与配置三件套(~/.wbh/gateway.json)
// ---------------------------------------------------------------------------

pub fn gateway_config_file() -> PathBuf {
    wbh_dir().join("gateway.json")
}

pub fn gateway_bin_dir() -> PathBuf {
    wbh_dir().join("gateway").join("bin")
}

pub fn gateway_native_config_file() -> PathBuf {
    wbh_dir().join("gateway").join("gateway_native_config.json")
}

/// 被托管网关的账号凭证目录(account_sync 推送至此)。
pub fn gateway_auth_dir() -> PathBuf {
    wbh_dir().join("gateway").join("auths")
}

fn gateway_state_file() -> PathBuf {
    wbh_dir().join("gateway").join("data").join("state.json")
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
        "update_source": "",
        // 自动入池:开启后本地账号库的账号自动进入网关池(仍需不在 no_sync_uids)。
        "sync_enabled": false,
        // 手动入池:显式勾选要入池的账号(自动入池关闭时是唯一来源)。
        "pool_uids": [],
        // 永不入池:无论自动/手动都不导出(如主账号,避免风控)。
        "no_sync_uids": [],
    })
}

/// 生成访问密钥:`wbs-` 前缀 + 32 位十六进制随机。
pub fn generate_api_key() -> String {
    format!("wbs-{}", uuid::Uuid::new_v4().simple())
}

fn merge_gateway_config(input: &Value) -> Value {
    let mut merged = default_gateway_config();
    if let Some(map) = input.as_object() {
        for key in ["bin_path", "api_key", "update_source"] {
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
    }
    merged
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
    // 文件缺失:生成默认配置(含自动生成的 api_key)并落盘,保证 key 稳定不漂移。
    let defaults = default_gateway_config();
    if std::fs::create_dir_all(wbh_dir()).is_ok() {
        let content = serde_json::to_string_pretty(&defaults).unwrap_or_default();
        let _ = atomic_write(&f, &content);
    }
    defaults
}

/// 保存托管配置,并从端口/密钥派生出 wb2api 对接配置(baseUrl/apiKey/authDir)。
///
/// 网关页只让用户填一次(端口 + API Key);hub 连网关所需的对接信息由这里自动
/// 写入 `~/.wbh/wb2api.json`,避免两处重复填写。
pub fn save_gateway_config(cfg: &Value) -> std::io::Result<()> {
    let merged = merge_gateway_config(cfg);
    std::fs::create_dir_all(wbh_dir())?;
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
    let _ = crate::wb2api::save_wb2api_config(&derived);
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

/// 定位网关二进制:env `WB_SWITCH_GATEWAY_BIN` → `~/.wbh/gateway/bin/` → 配置 `bin_path`。
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

// ---------------------------------------------------------------------------
// 配置生成 / 进程托管
// ---------------------------------------------------------------------------

/// 把 gateway.json 转成 wb2api 原生配置(listen/api_key/auth_dir/state_file/admin/global)。
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

fn process_alive() -> bool {
    let mut guard = GATEWAY_PROC.lock().unwrap();
    guard
        .as_mut()
        .is_some_and(|c| c.try_wait().map(|s| s.is_none()).unwrap_or(false))
}

/// 健康检查:`GET /healthz`,校验 `service=="workbuddy2api"`(防假启动)。
pub async fn probe_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/healthz");
    let resp = http_request(&url, "GET", None, None).await;
    resp.get("service").and_then(Value::as_str) == Some("workbuddy2api")
}

/// 启动网关:写配置 → 拉起子进程 → 健康检查重试(最多 5s)。
pub async fn start_gateway() -> Result<Value, String> {
    if process_alive() {
        return Ok(json!({ "ok": true, "running": true, "message": "网关已在运行" }));
    }
    let bin = locate_gateway().ok_or("未找到网关二进制:请配置 bin_path 或放入 ~/.wbh/gateway/bin")?;
    if !port_available(cfg_port()) {
        return Err(format!("端口 {} 已被占用,可先选择空闲端口", cfg_port()));
    }
    let config_path = write_native_config()?;
    std::fs::create_dir_all(gateway_auth_dir()).map_err(|e| format!("创建 auths 目录失败: {e}"))?;
    // 启动前先同步一次账号,让网关池有凭证。
    crate::account_sync::sync_now();
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

/// 停止网关:杀子进程(Windows 尽力 taskkill 子树防孤儿)。
pub fn stop_gateway() -> Result<Value, String> {
    let mut guard = GATEWAY_PROC.lock().unwrap();
    let Some(mut child) = guard.take() else {
        return Ok(json!({ "ok": true, "running": false }));
    };
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &child.id().to_string()]).status();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
    Ok(json!({ "ok": true, "running": false }))
}

/// 网关运行状态:进程存活 + 健康 + 端口 + 二进制路径 + 配置。
pub async fn gateway_status() -> Value {
    let running = process_alive();
    let port = cfg_port();
    let healthy = if running { probe_health(port).await } else { false };
    json!({
        "running": running,
        "healthy": healthy,
        "port": port,
        "bin": locate_gateway().map(|p| p.to_string_lossy().to_string()),
        "config": load_gateway_config(),
    })
}

// ---------------------------------------------------------------------------
// 网关独立升级(与客户端升级解耦)
// ---------------------------------------------------------------------------

fn cfg_update_source() -> String {
    cfg_str("update_source")
}

/// 检查更新源:本地路径则报 size;URL 则 HEAD 探测可达性。
pub async fn check_gateway_update() -> Value {
    let src = cfg_update_source();
    if src.is_empty() {
        return json!({ "available": false, "message": "未配置更新源(update_source)" });
    }
    let path = std::path::Path::new(&src);
    if path.exists() {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        return json!({ "available": true, "source": "local", "path": src, "size": size });
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => return json!({ "available": false, "message": format!("HTTP 客户端失败: {e}") }),
    };
    match client.head(&src).send().await {
        Ok(resp) if resp.status().is_success() => {
            json!({ "available": true, "source": "url", "url": src })
        }
        Ok(resp) => json!({ "available": false, "message": format!("更新源响应 {}", resp.status()) }),
        Err(e) => json!({ "available": false, "message": format!("更新源不可达: {e}") }),
    }
}

/// 下载(或拷贝本地)并原子替换网关二进制;可选 sha256 校验;网关在跑则用新二进制重启。
pub async fn apply_gateway_update(sha256: Option<&str>) -> Result<Value, String> {
    let src = cfg_update_source();
    if src.is_empty() {
        return Err("未配置更新源(update_source)".to_string());
    }
    std::fs::create_dir_all(gateway_bin_dir()).map_err(|e| e.to_string())?;

    let path = std::path::Path::new(&src);
    let bytes = if path.exists() {
        std::fs::read(path).map_err(|e| format!("读取本地更新文件失败: {e}"))?
    } else {
        let resp = reqwest::get(&src).await.map_err(|e| format!("下载失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("下载失败: HTTP {}", resp.status()));
        }
        resp.bytes().await.map_err(|e| format!("读取下载内容失败: {e}"))?.to_vec()
    };
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
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写临时文件失败: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("替换二进制失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }

    let mut out = json!({
        "ok": true,
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
    fn gateway_paths_live_under_wbh_dir() {
        assert!(gateway_config_file().starts_with(wbh_dir()));
        assert!(gateway_auth_dir().starts_with(wbh_dir()));
        assert!(gateway_bin_dir().ends_with("gateway/bin"));
    }
}
