//! wb2api 网关对接(workbuddy-hub Phase 1 管理面)。
//!
//! 对 workbuddy2api 的 HTTP 客户端 + 同机 auths/config 文件访问。复用 switch 既有的
//! 账号库 / OAuth / 签到 / 积分,本模块只做「推账号入池 + 拉池状态 + 运维」。
//! 新增 hub 配置统一放 `~/.wbh`(既有 `~/.wb-switch` 零回归)。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::modules::account;
use crate::modules::config::{atomic_write, home_dir, http_request};
use crate::modules::variant::WbVariant;

// ---------------------------------------------------------------------------
// hub 数据根与对接配置(三件套,仿 config.rs 既有模式)
// ---------------------------------------------------------------------------

/// hub 新数据根:新增配置统一放 `~/.wbh`。
pub fn wbh_dir() -> PathBuf {
    home_dir().join(".wbh")
}

pub fn wb2api_config_file() -> PathBuf {
    wbh_dir().join("wb2api.json")
}

pub fn default_wb2api_config() -> Value {
    json!({
        "baseUrl": "http://127.0.0.1:7863",
        "apiKey": "",
        "authDir": "",
        "configPath": "",
    })
}

fn merge_wb2api_config(input: &Value) -> Value {
    let mut merged = default_wb2api_config();
    if let Some(map) = input.as_object() {
        for key in ["baseUrl", "apiKey", "authDir", "configPath"] {
            if let Some(v) = map.get(key).and_then(Value::as_str) {
                if !v.trim().is_empty() {
                    merged[key] = json!(v.trim());
                }
            }
        }
    }
    merged
}

/// 读取对接配置(缺失/损坏时合并默认值)。
pub fn load_wb2api_config() -> Value {
    let f = wb2api_config_file();
    if f.exists() {
        if let Ok(text) = std::fs::read_to_string(&f) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                return merge_wb2api_config(&value);
            }
        }
    }
    default_wb2api_config()
}

/// 保存对接配置(只保留已知字段)。
pub fn save_wb2api_config(cfg: &Value) -> std::io::Result<()> {
    let merged = merge_wb2api_config(cfg);
    std::fs::create_dir_all(wbh_dir())?;
    let content = serde_json::to_string_pretty(&merged).unwrap_or_default();
    atomic_write(&wb2api_config_file(), &content)
}

fn config_str(key: &str) -> String {
    load_wb2api_config()
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn base_url() -> String {
    config_str("baseUrl").trim_end_matches('/').to_string()
}

fn auth_headers() -> HashMap<String, String> {
    let mut headers = HashMap::new();
    let key = config_str("apiKey");
    if !key.is_empty() {
        headers.insert("Authorization".to_string(), format!("Bearer {key}"));
    }
    headers
}

/// 网关 HTTP 请求封装:自动拼 baseUrl + Bearer 头;未配置或网络错误返回 Err。
async fn api_request(path: &str, method: &str, body: Option<Value>) -> Result<Value, String> {
    let base = base_url();
    if base.is_empty() {
        return Err("未配置网关 baseUrl,请先在「网关管理 → 配置」填写".to_string());
    }
    let url = format!("{base}{path}");
    let resp = http_request(&url, method, body, Some(&auth_headers())).await;
    if resp.get("code").and_then(Value::as_i64) == Some(-1) {
        return Err(resp
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("请求网关失败")
            .to_string());
    }
    Ok(resp)
}

// ---------------------------------------------------------------------------
// 只读查询
// ---------------------------------------------------------------------------

/// 池状态:`GET /status`。
pub async fn status() -> Result<Value, String> {
    api_request("/status", "GET", None).await
}

/// 模型列表:`GET /v1/models`。
pub async fn models() -> Result<Value, String> {
    api_request("/v1/models", "GET", None).await
}

/// 请求统计:`GET /v1/stats`。
pub async fn stats() -> Result<Value, String> {
    api_request("/v1/stats", "GET", None).await
}

/// 存活探活:`GET /healthz`。
pub async fn healthz() -> Result<Value, String> {
    api_request("/healthz", "GET", None).await
}

// ---------------------------------------------------------------------------
// 账号运维(走 wb2api admin 端点,不直接改 state.json)
// ---------------------------------------------------------------------------

/// 停用 / 启用 / 复活账号:`POST /admin/accounts/{uid}/{op}`。
/// op 限定白名单(disable/enable/revive),disable 可带 reason。
pub async fn account_op(uid: &str, op: &str, reason: &str) -> Result<Value, String> {
    if uid.trim().is_empty() {
        return Err("缺少 uid".to_string());
    }
    if !matches!(op, "disable" | "enable" | "revive") {
        return Err(format!("未知操作: {op}"));
    }
    let mut body = json!({});
    if op == "disable" && !reason.trim().is_empty() {
        body["reason"] = json!(reason.trim());
    }
    let resp = api_request(&format!("/admin/accounts/{uid}/{op}"), "POST", Some(body)).await?;
    // 成功:adminState({uid, manual_disabled, ..., disabled, changed}),无 code/error 字段。
    // 失败:OpenAI 风格 {"error": {...}} 或 HTTP 信封 {"code": <status>, "message": ...}(含 admin 未开启的 404)。
    if let Some(error) = resp.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("操作失败")
            .to_string());
    }
    if resp.get("code").is_some() {
        let code = resp.get("code").and_then(Value::as_i64).unwrap_or(0);
        let msg = resp.get("message").and_then(Value::as_str).unwrap_or("操作失败");
        return Err(format!("操作失败({code}): {msg}"));
    }
    Ok(resp)
}

// ---------------------------------------------------------------------------
// 池账号(auths 文件扫描 + /status 合并)
// ---------------------------------------------------------------------------

/// 解析单个 auths 文件(嵌套形 / 扁平形双形态,对齐 wb2api internal/auth.Parse)。
fn parse_pool_auth(text: &str) -> Option<Value> {
    let root: Value = serde_json::from_str(text).ok()?;
    let auth = if root.get("auth").is_some() {
        root.get("auth")
    } else {
        Some(&root)
    }?;
    let account_part = if root.get("account").is_some() {
        root.get("account")
    } else {
        Some(&root)
    }?;
    let uid = account_part.get("uid").and_then(Value::as_str)?.to_string();
    // 对齐 wb2api Parse:缺 accessToken 视为坏文件(热加载静默跳过),不算池账号。
    let access_token = auth
        .get("accessToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let mut entry = json!({
        "uid": uid,
        "accessToken": access_token,
        "nickname": account_part.get("nickname").and_then(Value::as_str).unwrap_or(""),
        "enterpriseId": account_part.get("enterpriseId").and_then(Value::as_str).unwrap_or(""),
        "domain": auth.get("domain").and_then(Value::as_str).unwrap_or(""),
        "realm": auth.get("realm").and_then(Value::as_str).unwrap_or(""),
        "hasAccessToken": true,
    });
    if let Some(dt) = root.get("device_token").and_then(Value::as_str) {
        if !dt.trim().is_empty() {
            entry["deviceToken"] = json!(dt);
        }
    }
    Some(entry)
}

/// 池账号清单:扫描 authDir 下 `workbuddy*.json` 解析凭证,并按 uid 合并 `/status`
/// 的运行时状态(尽力而为:status 不可达不影响文件解析)。
pub async fn pool_accounts() -> Value {
    let dir = config_str("authDir");
    let mut accounts = vec![];
    if !dir.is_empty() {
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("workbuddy") && name.ends_with(".json") {
                    let path = entry.path();
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        if let Some(mut acc) = parse_pool_auth(&text) {
                            acc["file"] = json!(path.to_string_lossy());
                            accounts.push(acc);
                        }
                    }
                }
            }
        }
    }

    let mut pool: Option<Value> = None;
    if let Ok(status) = status().await {
        let mut pool_by_uid: HashMap<String, Value> = HashMap::new();
        if let Some(Value::Array(list)) = status.get("accounts") {
            for acc in list {
                if let Some(uid) = acc.get("uid").and_then(Value::as_str) {
                    pool_by_uid.insert(uid.to_string(), acc.clone());
                }
            }
        }
        for acc in accounts.iter_mut() {
            if let Some(uid) = acc.get("uid").and_then(Value::as_str) {
                if let Some(state) = pool_by_uid.get(uid) {
                    acc["pool"] = state.clone();
                }
            }
        }
        pool = Some(status);
    }

    json!({
        "accounts": accounts,
        "configured": !dir.is_empty(),
        "pool": pool,
    })
}

// ---------------------------------------------------------------------------
// 纳管 / 移除(把本地账号库的凭证推进 wb2api 的 auths 目录,5s 热加载入池)
// ---------------------------------------------------------------------------

/// 把本地账号库的某账号推一份凭证到 wb2api auths(嵌套形,对齐 SaveAtomic)。
/// 同一腾讯账号的两个用途:本地库用于桌面切换,池凭证用于网关。
pub fn onboard(account_id: &str) -> Result<Value, String> {
    let account = account::find_account(account_id).ok_or("本地账号不存在")?;
    let uid = account::get_str(&account, "uid").ok_or("该账号缺少 uid,无法纳管")?;
    let access = account::get_str(&account, "access_token").ok_or("该账号缺少 access_token")?;
    let refresh = account::get_str(&account, "refresh_token").unwrap_or_default();
    let domain = account::get_str(&account, "domain").unwrap_or_default();
    let nickname = account::get_str(&account, "nickname").unwrap_or_default();
    let enterprise_id = account::get_str(&account, "enterpriseId")
        .or_else(|| account::get_str(&account, "enterprise_id"))
        .unwrap_or_default();
    let expires_ms = account.get("expiresAt").and_then(Value::as_i64).unwrap_or(0);
    let realm = match account::variant_of(&account) {
        WbVariant::Cn => "cn",
        WbVariant::Ai => "global",
    };
    let device_token = account
        .get("auth_raw")
        .and_then(|raw| raw.get("deviceToken"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    let dir = config_str("authDir");
    if dir.is_empty() {
        return Err("未配置 authDir(网关 auths 目录),请先在「网关管理 → 配置」填写".to_string());
    }
    let dir_path = PathBuf::from(&dir);
    std::fs::create_dir_all(&dir_path).map_err(|e| format!("创建 auths 目录失败: {e}"))?;

    let mut doc = json!({
        "auth": {
            "accessToken": access,
            "refreshToken": refresh,
            // wb2api 的 expiresAt 是 Unix 秒(本地库存毫秒)
            "expiresAt": expires_ms / 1000,
            "domain": domain,
            "realm": realm,
        },
        "account": {
            "uid": uid,
            "enterpriseId": enterprise_id,
            "nickname": nickname,
        },
    });
    if !device_token.is_empty() {
        doc["device_token"] = json!(device_token);
    }

    let path = dir_path.join(format!("workbuddy-{uid}.json"));
    let content = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    atomic_write(&path, &content).map_err(|e| format!("写 auths 文件失败: {e}"))?;
    write_restrict(&path);
    Ok(json!({ "ok": true, "uid": uid, "file": path.to_string_lossy() }))
}

/// 移除池账号:删除对应 auths 文件(wb2api 热加载自动剔除,状态保留)。
pub fn offboard(uid: &str) -> Result<Value, String> {
    if uid.trim().is_empty() {
        return Err("缺少 uid".to_string());
    }
    let dir = config_str("authDir");
    if dir.is_empty() {
        return Err("未配置 authDir(网关 auths 目录)".to_string());
    }
    let path = PathBuf::from(&dir).join(format!("workbuddy-{uid}.json"));
    if !path.exists() {
        return Err(format!("auths 目录中不存在该账号: {uid}"));
    }
    std::fs::remove_file(&path).map_err(|e| format!("删除 auths 文件失败: {e}"))?;
    Ok(json!({ "ok": true, "uid": uid }))
}

/// Unix 上把凭证文件收紧为 0600(与 wb2api SaveAtomic 一致;Windows 无此语义,跳过)。
#[cfg(unix)]
fn write_restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn write_restrict(_path: &Path) {}

// ---------------------------------------------------------------------------
// 上游 config.json 编辑(同机读写,原子写 + 备份)
// ---------------------------------------------------------------------------

/// 读取 wb2api 的 config.json(需在对接配置填写 configPath)。
pub fn upstream_config_get() -> Result<Value, String> {
    let path = config_str("configPath");
    if path.is_empty() {
        return Err("未配置 configPath(wb2api config.json 路径)".to_string());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取 config.json 失败: {e}"))?;
    let config: Value = serde_json::from_str(&text).map_err(|e| format!("config.json 不是合法 JSON: {e}"))?;
    Ok(json!({ "path": path, "config": config }))
}

/// 写回 wb2api 的 config.json:仅接受 JSON 对象,写前先备份为 `path.bak`。
pub fn upstream_config_save(config: &Value) -> Result<Value, String> {
    let path = config_str("configPath");
    if path.is_empty() {
        return Err("未配置 configPath(wb2api config.json 路径)".to_string());
    }
    if !config.is_object() {
        return Err("config 必须是 JSON 对象".to_string());
    }
    let path_buf = PathBuf::from(&path);
    if path_buf.exists() {
        let _ = std::fs::copy(&path_buf, PathBuf::from(format!("{path}.bak")));
    }
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    atomic_write(&path_buf, &content).map_err(|e| format!("写 config.json 失败: {e}"))?;
    Ok(json!({ "ok": true, "path": path }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wb2api_config_defaults_and_keeps_known_fields() {
        let defaults = default_wb2api_config();
        assert_eq!(
            defaults.get("baseUrl").and_then(Value::as_str),
            Some("http://127.0.0.1:7863")
        );
        assert_eq!(defaults.get("apiKey").and_then(Value::as_str), Some(""));

        let merged = merge_wb2api_config(&json!({
            "baseUrl": " http://127.0.0.1:9000/ ",
            "apiKey": "secret",
            "unknown": "x",
        }));
        assert_eq!(
            merged.get("baseUrl").and_then(Value::as_str),
            Some("http://127.0.0.1:9000/")
        );
        assert_eq!(merged.get("apiKey").and_then(Value::as_str), Some("secret"));
        assert!(merged.get("unknown").is_none(), "只保留已知字段");
        assert_eq!(merged.get("authDir").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn parse_pool_auth_reads_nested_form() {
        let entry = parse_pool_auth(
            r#"{
  "auth": {"accessToken": "at", "refreshToken": "rt", "expiresAt": 123, "domain": "www.codebuddy.cn", "realm": "cn"},
  "account": {"uid": "u-1", "enterpriseId": "e-1", "nickname": "小明"},
  "device_token": "dt-1"
}"#,
        )
        .expect("nested form");
        assert_eq!(entry["uid"], "u-1");
        assert_eq!(entry["nickname"], "小明");
        assert_eq!(entry["realm"], "cn");
        assert_eq!(entry["domain"], "www.codebuddy.cn");
        assert_eq!(entry["deviceToken"], "dt-1");
        assert_eq!(entry["hasAccessToken"], true);
    }

    #[test]
    fn parse_pool_auth_reads_flat_form() {
        let entry = parse_pool_auth(
            r#"{"accessToken": "at", "uid": "u-2", "nickname": "手动", "realm": "global"}"#,
        )
        .expect("flat form");
        assert_eq!(entry["uid"], "u-2");
        assert_eq!(entry["realm"], "global");
        assert_eq!(entry["hasAccessToken"], true);
    }

    #[test]
    fn parse_pool_auth_skips_invalid_and_missing_access() {
        assert!(parse_pool_auth("not-json").is_none());
        assert!(parse_pool_auth(r#"{"uid": "u-3"}"#).is_none(), "缺 accessToken 不应解析为可纳管条目");
    }

    #[test]
    fn wb2api_config_file_lives_under_wbh_dir() {
        assert!(wb2api_config_file().starts_with(wbh_dir()));
        assert!(wbh_dir().ends_with(".wbh"));
        assert_ne!(wbh_dir(), crate::modules::config::store_dir(), "hub 新数据根与既有 ~/.wb-switch 分离");
    }
}
