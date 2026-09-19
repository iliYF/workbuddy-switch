//! wb2api 网关对接(workbuddy-switch 网关管理面)。
//!
//! 对 workbuddy2api 的 HTTP 客户端 + 同机 auths/config 文件访问。复用 core 既有的
//! 账号库 / OAuth / 签到 / 积分,本模块只做「推账号入池 + 拉池状态 + 运维」。
//! 新增配置统一放 `~/.wbh`(既有 `~/.wb-switch` 零回归)。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use wb_switch_core::modules::account;
use wb_switch_core::modules::config::{atomic_write, home_dir, http_request};
use wb_switch_core::modules::variant::WbVariant;

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
        "baseUrl": "http://127.0.0.1:54321",
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

// ---------------------------------------------------------------------------
// 模型目录(model_catalog):直连腾讯模型接口拉取真实可用的模型清单
// ---------------------------------------------------------------------------

const V3_CONFIG_PATH: &str = "/v3/config";

/// 出站 CLI UA(镜像上游 defaultWorkBuddyUAFor)。
/// 模型目录接口有 UA 门禁:只有三段式 CLI UA 能过,/v3/config 对 web UA 直接 400。
fn cli_user_agent(realm: WbVariant) -> String {
    let platform = match realm {
        WbVariant::Ai => "WorkBuddy AI",
        WbVariant::Cn => "WorkBuddy",
    };
    format!("WorkBuddy/5.5.4 {platform}/5.5.4 CLI/2.137.1")
}

fn tencent_origin(realm: WbVariant) -> &'static str {
    match realm {
        WbVariant::Ai => "https://www.workbuddy.ai",
        WbVariant::Cn => "https://www.codebuddy.cn",
    }
}

fn tencent_model_headers(realm: WbVariant, token: &str, domain: &str) -> HashMap<String, String> {
    let origin = tencent_origin(realm);
    let mut h = HashMap::new();
    h.insert("Authorization".to_string(), format!("Bearer {token}"));
    h.insert("User-Agent".to_string(), cli_user_agent(realm));
    h.insert("Origin".to_string(), origin.to_string());
    h.insert("Referer".to_string(), format!("{origin}/"));
    if !domain.trim().is_empty() {
        h.insert("X-Domain".to_string(), domain.to_string());
    }
    h
}

async fn tencent_model_get(base: &str, path: &str, headers: &HashMap<String, String>) -> Result<Value, String> {
    let resp = http_request(&format!("{base}{path}"), "GET", None, Some(headers)).await;
    if resp.get("code").and_then(Value::as_i64) == Some(-1) {
        return Err(resp.get("message").and_then(Value::as_str).unwrap_or("请求失败").to_string());
    }
    Ok(resp)
}

/// 是否非对话模型(应从可选列表剔除):镜像上游 nonChatModel。
fn non_chat_model(mid: &str, max_output_tokens: i64, tags: &[String]) -> bool {
    let low = mid.to_lowercase();
    if low.starts_with("nes-") || low.starts_with("completion-") || low.starts_with("codewise-") {
        return true;
    }
    if max_output_tokens > 0 && max_output_tokens <= 256 {
        return true;
    }
    tags.iter().any(|t| t == "text-to-image")
}

/// 按 id 前缀推导系列名;认不出归「其他」(与 manager modelcatalog 同口径)。
fn series_of(model_id: &str) -> String {
    let mid = model_id.to_lowercase();
    const RULES: &[(&[&str], &str)] = &[
        (&["glm"], "智谱 GLM"),
        (&["deepseek"], "DeepSeek"),
        (&["kimi", "moonshot"], "Kimi"),
        (&["minimax"], "MiniMax"),
        (&["hy", "hunyuan"], "腾讯混元"),
        (&["auto"], "自动选择"),
    ];
    for (prefixes, label) in RULES {
        if prefixes.iter().any(|p| mid.starts_with(p)) {
            return label.to_string();
        }
    }
    "其他".to_string()
}

/// 解析一路模型响应(对象列表或窄表字符串数组),返回「id → 条目」与输出顺序。
/// 国内版企业端点按 agents 的 cli 白名单过滤;国际版与 /v3 全量。
fn parse_model_payload(data: &Value, realm: WbVariant) -> (HashMap<String, Value>, Vec<String>) {
    let mut items: HashMap<String, Value> = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    if let Some(list) = data.as_array() {
        for raw in list {
            if let Some(mid) = raw.as_str() {
                let mid = mid.trim().to_string();
                if !mid.is_empty() && !items.contains_key(&mid) {
                    items.insert(mid.clone(), json!({ "id": mid }));
                    order.push(mid);
                }
            }
        }
        return (items, order);
    }

    let raw_models = data.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
    let agents = data.get("agents").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut cli_ids: Vec<String> = Vec::new();
    if realm == WbVariant::Cn {
        for ag in &agents {
            if ag.get("name").and_then(Value::as_str) == Some("cli") {
                if let Some(ids) = ag.get("models").and_then(Value::as_array) {
                    cli_ids = ids.iter().filter_map(|x| x.as_str().map(str::to_string)).collect();
                }
                break;
            }
        }
    }

    let mut info: HashMap<String, Value> = HashMap::new();
    for m in raw_models {
        let Some(mid) = m.get("id").and_then(Value::as_str) else { continue };
        let mid = mid.trim().to_string();
        if mid.is_empty() {
            continue;
        }
        let reasoning = m.get("reasoning").filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({}));
        let efforts: Vec<String> = reasoning
            .get("supportedEfforts")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let tags: Vec<String> = m.get("tags")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let max_out = m.get("maxOutputTokens").and_then(Value::as_i64).unwrap_or(0);
        let non_chat = realm == WbVariant::Cn && non_chat_model(&mid, max_out, &tags);
        info.insert(
            mid.clone(),
            json!({
                "id": mid,
                "name": m.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string(),
                "context_length": m.get("maxInputTokens").and_then(Value::as_i64).unwrap_or(0),
                "max_output_tokens": max_out,
                "disabled": m.get("disabled").and_then(Value::as_bool).unwrap_or(false),
                "efforts": efforts,
                "default_effort": reasoning.get("defaultEffort").and_then(Value::as_str).unwrap_or("").trim().to_string(),
                "supports_images": m.get("supportsImages").and_then(Value::as_bool).unwrap_or(false),
                "description": m.get("descriptionZh").and_then(Value::as_str).unwrap_or("").trim().to_string(),
                "credits": m.get("credits").and_then(Value::as_str).unwrap_or("").trim().to_string(),
                "vendor": m.get("vendor").and_then(Value::as_str).unwrap_or("").trim().to_string(),
                "tags": tags,
                "is_default": m.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
                "supports_reasoning": m.get("supportsReasoning").and_then(Value::as_bool).unwrap_or(false),
                "supports_tool_call": m.get("supportsToolCall").and_then(Value::as_bool).unwrap_or(false),
                "only_reasoning": m.get("onlyReasoning").and_then(Value::as_bool).unwrap_or(false),
                "reasoning_summary": reasoning.get("summary").and_then(Value::as_str).unwrap_or("").trim().to_string(),
                "_non_chat": non_chat,
            }),
        );
    }

    let ids: Vec<String> = if cli_ids.is_empty() {
        info.keys().cloned().collect()
    } else {
        cli_ids
    };
    for mid in ids {
        let Some(item) = info.get(&mid) else { continue };
        if item.get("disabled").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        if item.get("_non_chat").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let mut entry = item.clone();
        if let Some(obj) = entry.as_object_mut() {
            obj.remove("_non_chat");
        }
        items.insert(mid.clone(), entry);
        order.push(mid);
    }
    (items, order)
}

/// 规范化模型条目:补系列,校验默认推理档位。
fn decorate_models(items: HashMap<String, Value>, order: Vec<String>) -> Vec<Value> {
    order
        .iter()
        .filter_map(|mid| items.get(mid).cloned())
        .map(|mut out| {
            let mid = out.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            out["series"] = json!(series_of(&mid));
            let efforts: Vec<String> = out
                .get("efforts")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let def = out.get("default_effort").and_then(Value::as_str).unwrap_or("").to_string();
            if !def.is_empty() && !efforts.contains(&def) {
                out["default_effort"] = json!("");
            }
            out
        })
        .collect()
}

/// 从 auths 挑一个指定版本、且有 accessToken 的账号。
async fn pick_account(realm: WbVariant) -> Option<Value> {
    let payload = pool_accounts().await;
    let accounts = payload.get("accounts")?.as_array()?;
    accounts.iter().find(|a| {
        let r = a.get("realm").and_then(Value::as_str).unwrap_or("cn");
        let realm_ok = (realm == WbVariant::Ai) == (r == "global");
        realm_ok
            && a.get("accessToken")
                .and_then(Value::as_str)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
    }).cloned()
}

/// 并发取企业端点(候选路径第一个成功)与 /v3/config,合并后过滤、装饰。
async fn fetch_tencent_catalog(realm: WbVariant, token: &str, domain: &str) -> Result<Vec<Value>, String> {
    let base = tencent_origin(realm);
    let headers = tencent_model_headers(realm, token, domain);
    let ent_paths: &[&str] = match realm {
        WbVariant::Ai => &["/v2/enterprises/personal/models", "/console/enterprises/personal/models"],
        WbVariant::Cn => &["/console/enterprises/personal/models"],
    };

    async fn probe(base: &str, paths: &[&str], headers: &HashMap<String, String>) -> Result<Value, String> {
        let mut last = String::new();
        for p in paths {
            match tencent_model_get(base, p, headers).await {
                Ok(resp) if resp.get("code").and_then(Value::as_i64).unwrap_or(-1) == 0 => {
                    return Ok(resp.get("data").cloned().unwrap_or(Value::Null));
                }
                Ok(resp) => {
                    last = format!("code={}", resp.get("code").and_then(Value::as_i64).unwrap_or(-1));
                }
                Err(e) => last = e,
            }
        }
        Err(if last.is_empty() { "全部路径失败".to_string() } else { last })
    }

    let ent_fut = probe(base, ent_paths, &headers);
    let v3_fut = probe(base, &[V3_CONFIG_PATH], &headers);
    let (ent_res, v3_res) = tokio::join!(ent_fut, v3_fut);

    let (mut items, mut order) = (HashMap::new(), Vec::new());
    let mut errors: Vec<String> = Vec::new();
    for res in [&v3_res, &ent_res] {
        match res {
            Ok(data) => {
                let (it, od) = parse_model_payload(data, realm);
                for mid in od {
                    if items.contains_key(&mid) {
                        continue;
                    }
                    if let Some(v) = it.get(&mid) {
                        items.insert(mid.clone(), v.clone());
                    }
                    order.push(mid);
                }
            }
            Err(e) => errors.push(e.clone()),
        }
    }
    if items.is_empty() {
        return Err(if errors.is_empty() {
            "模型接口未返回可用模型".to_string()
        } else {
            errors.join("; ")
        });
    }
    Ok(decorate_models(items, order))
}

/// 把上游 /v1/models 的字段名映射成内部统一形状。
fn map_upstream_model_fields(m: &mut Value) {
    for key in ["reasoning_supported_efforts", "reasoning_default_effort", "reasoning_summary"] {
        if let Some(v) = m.get(key).cloned() {
            m[if key == "reasoning_supported_efforts" {
                "efforts"
            } else {
                key
            }] = v;
        }
    }
}

/// 腾讯模型接口失败时的回退:用上游 /v1/models(字段少,至少保证页面有内容)。
async fn fallback_upstream_models(realm: WbVariant, errors: &mut Vec<String>) -> Value {
    let resp = api_request("/v1/models", "GET", None).await;
    let items = match resp {
        Ok(v) => v.get("data").and_then(Value::as_array).cloned().unwrap_or_default(),
        Err(e) => {
            errors.push(e);
            vec![]
        }
    };
    let models: Vec<Value> = items
        .into_iter()
        .filter(|m| {
            let id = m.get("id").and_then(Value::as_str).unwrap_or("").to_lowercase();
            match realm {
                WbVariant::Ai => id.starts_with("global:"),
                WbVariant::Cn => !id.starts_with("global:"),
            }
        })
        .map(|mut m| {
            let id = m.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let bare = id.split(':').last().unwrap_or(&id).to_string();
            m["id"] = json!(bare);
            map_upstream_model_fields(&mut m);
            m
        })
        .filter(|m| m.get("id").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false))
        .map(|mut m| {
            let mid = m.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            m["series"] = json!(series_of(&mid));
            m
        })
        .collect();
    json!({
        "models": models,
        "source": "upstream",
        "source_label": "上游 /v1/models(无显示名;推理档位取上游透出值)",
        "via": "workbuddy2api",
        "errors": errors,
        "realm": realm.as_str(),
    })
}

/// 模型中心:返回指定版本的模型目录。优先直连腾讯接口(真实可用 + 显示名/推理档位),
/// 失败回退上游 /v1/models。数据源现在是腾讯,但能力是「模型目录」,命名保持中性。
pub async fn model_catalog(realm: WbVariant) -> Value {
    let mut errors: Vec<String> = Vec::new();
    if let Some(acct) = pick_account(realm).await {
        let token = acct.get("accessToken").and_then(Value::as_str).unwrap_or("");
        let domain = acct.get("domain").and_then(Value::as_str).unwrap_or("");
        let nickname = acct.get("nickname").and_then(Value::as_str).unwrap_or("");
        if !token.is_empty() {
            match fetch_tencent_catalog(realm, token, domain).await {
                Ok(models) if !models.is_empty() => {
                    return json!({
                        "models": models,
                        "source": "tencent",
                        "source_label": "腾讯模型接口(含显示名与推理档位)",
                        "via": nickname,
                        "errors": errors,
                        "realm": realm.as_str(),
                    });
                }
                Ok(_) => errors.push("腾讯接口未返回可用模型".to_string()),
                Err(e) => errors.push(e),
            }
        } else {
            errors.push("账号缺少 accessToken".to_string());
        }
    } else {
        errors.push("没有可用账号".to_string());
    }
    fallback_upstream_models(realm, &mut errors).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wb2api_config_defaults_and_keeps_known_fields() {
        let defaults = default_wb2api_config();
        assert_eq!(
            defaults.get("baseUrl").and_then(Value::as_str),
            Some("http://127.0.0.1:54321")
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
        assert_ne!(wbh_dir(), wb_switch_core::modules::config::store_dir(), "hub 新数据根与既有 ~/.wb-switch 分离");
    }

    #[test]
    fn series_of_classifies_by_id_prefix() {
        assert_eq!(series_of("glm-5.2"), "智谱 GLM");
        assert_eq!(series_of("deepseek-v4.1-flash"), "DeepSeek");
        assert_eq!(series_of("kimi-k3-1"), "Kimi");
        assert_eq!(series_of("minimax-m3"), "MiniMax");
        assert_eq!(series_of("hy3-x"), "腾讯混元");
        assert_eq!(series_of("hunyuan-chat"), "腾讯混元");
        assert_eq!(series_of("auto"), "自动选择");
        assert_eq!(series_of("unknown-model"), "其他");
    }

    #[test]
    fn non_chat_model_filters_specialized_and_tiny_and_image_models() {
        assert!(non_chat_model("nes-embed", 4096, &[]));
        assert!(non_chat_model("completion-x", 4096, &[]));
        assert!(non_chat_model("codewise-x", 4096, &[]));
        assert!(non_chat_model("tiny", 256, &[]));
        assert!(!non_chat_model("tiny", 0, &[]), "0 视为未声明,不过滤");
        assert!(!non_chat_model("glm-5.2", 4096, &[]));
        assert!(non_chat_model("img", 4096, &["text-to-image".to_string()]));
    }

    #[test]
    fn parse_model_payload_applies_cli_whitelist_and_skips_disabled_non_chat() {
        // 国内版:agents 的 cli 白名单只放行 glm-5.2 / deepseek-v4.1-flash;
        // disabled 与 non_chat 模型被剔除。
        let data = json!({
            "agents": [{"name": "cli", "models": ["glm-5.2", "deepseek-v4.1-flash", "tiny"]}],
            "models": [
                {"id": "glm-5.2", "name": "GLM", "maxInputTokens": 131072, "maxOutputTokens": 8192},
                {"id": "deepseek-v4.1-flash", "name": "DeepSeek", "maxInputTokens": 131072, "maxOutputTokens": 8192, "disabled": true},
                {"id": "tiny", "name": "Tiny", "maxInputTokens": 131072, "maxOutputTokens": 256},
                {"id": "outside", "name": "Out", "maxInputTokens": 131072, "maxOutputTokens": 8192},
            ],
        });
        let (items, order) = parse_model_payload(&data, WbVariant::Cn);
        let ids = order.clone();
        assert_eq!(ids, vec!["glm-5.2"], "cli 白名单 + 剔 disabled + 剔 tiny 非对话");
        assert!(items.contains_key("glm-5.2"));
        assert_eq!(items["glm-5.2"]["name"], "GLM");
        assert_eq!(items["glm-5.2"]["context_length"], 131072);
        assert!(items["glm-5.2"].get("_non_chat").is_none(), "内部标记不得外泄");
    }

    #[test]
    fn parse_model_payload_reads_narrow_table_and_reasoning() {
        let data = json!(["glm-5.2", "deepseek-v4.1-flash"]);
        let (items, order) = parse_model_payload(&data, WbVariant::Ai);
        assert_eq!(order.len(), 2);
        assert_eq!(items["deepseek-v4.1-flash"]["id"], "deepseek-v4.1-flash");

        let full = json!({
            "models": [{
                "id": "hy3-x",
                "name": "混元",
                "maxInputTokens": 1000000,
                "maxOutputTokens": 32000,
                "reasoning": {"supportedEfforts": ["low", "high"], "defaultEffort": "high", "summary": "auto"},
                "supportsImages": true,
                "descriptionZh": "推理增强",
                "credits": "x0.05",
                "tags": ["craft"]
            }]
        });
        let (items, _) = parse_model_payload(&full, WbVariant::Cn);
        let m = &items["hy3-x"];
        assert_eq!(m["efforts"], json!(["low", "high"]));
        assert_eq!(m["default_effort"], "high");
        assert_eq!(m["supports_images"], true);
        assert_eq!(m["description"], "推理增强");
        assert_eq!(m["credits"], "x0.05");
    }

    #[test]
    fn decorate_adds_series_and_validates_default_effort() {
        let mut items = HashMap::new();
        let mut order = vec![];
        for (id, def) in [("glm-5.2", "xhigh"), ("auto", "")] {
            items.insert(id.to_string(), json!({"id": id, "efforts": ["low", "high"], "default_effort": def}));
            order.push(id.to_string());
        }
        let decorated = decorate_models(items, order);
        assert_eq!(decorated[0]["series"], "智谱 GLM");
        // xhigh 不在 [low,high] 内 → 清空;auto 无默认 → 保持空
        assert_eq!(decorated[0]["default_effort"], "");
        assert_eq!(decorated[1]["series"], "自动选择");
    }
}
