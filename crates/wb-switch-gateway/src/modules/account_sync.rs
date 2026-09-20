//! 账号单向推送:账号库(真源)→ 网关 auths(派生),保证网关池账号与账号库一致。
//!
//! 只做 账号库→auths 单向:新账号入池、删除出池、token 刷新重推;不做 auths→账号库
//! 回写(腾讯 refresh_token 不撤销,网关刷新不会让账号库 token 失效,两边各自刷新均有效)。
//! 导出时**保留既有 `credit` 块**(网关写入的分层选号依据,不要抹掉)。

use serde_json::{json, Value};
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use wb_switch_core::modules::account;
use wb_switch_core::modules::config::atomic_write;
use wb_switch_core::modules::variant::WbVariant;

use crate::modules::gateway_manage::{gateway_auth_dir, load_gateway_config};
use crate::modules::wb2api::gateway_root;

fn sync_state_file() -> PathBuf {
    gateway_root().join("sync.json")
}

/// 单个账号 → wb2api 嵌套凭证(对齐 SaveAtomic);保留既有 `credit` 块。
fn build_auth_doc(acc: &Value, existing: Option<&Value>) -> Value {
    let uid = account::get_str(acc, "uid").unwrap_or_default();
    let realm = match account::variant_of(acc) {
        WbVariant::Cn => "cn",
        WbVariant::Ai => "global",
    };
    let mut doc = json!({
        "auth": {
            "accessToken": account::get_str(acc, "access_token").unwrap_or_default(),
            "refreshToken": account::get_str(acc, "refresh_token").unwrap_or_default(),
            "expiresAt": acc.get("expiresAt").and_then(Value::as_i64).unwrap_or(0) / 1000,
            "domain": account::get_str(acc, "domain").unwrap_or_default(),
            "realm": realm,
        },
        "account": {
            "uid": uid,
            "enterpriseId": account::get_str(acc, "enterpriseId")
                .or_else(|| account::get_str(acc, "enterprise_id"))
                .unwrap_or_default(),
            "nickname": account::get_str(acc, "nickname").unwrap_or_default(),
        },
    });
    let device_token = acc
        .get("auth_raw")
        .and_then(|raw| raw.get("deviceToken"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if !device_token.is_empty() {
        doc["device_token"] = json!(device_token);
    }
    if let Some(ex) = existing {
        if let Some(credit) = ex.get("credit").filter(|v| v.is_object()).cloned() {
            doc["credit"] = credit;
        }
    }
    doc
}

/// 导出集合指纹:账号库导出相关字段 + 网关同步配置(sync_enabled / pool_uids)的稳定哈希。
fn accounts_fingerprint(accounts: &[Value]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for acc in accounts {
        for key in ["uid", "access_token", "refresh_token", "variant", "needs_relogin"] {
            acc.get(key).hash(&mut hasher);
        }
    }
    let gw = load_gateway_config();
    gw.get("sync_enabled").hash(&mut hasher);
    gw.get("pool_uids").hash(&mut hasher);
    gw.get("no_sync_uids").hash(&mut hasher);
    gw.get("mode").hash(&mut hasher);
    gw.get("pinned_uid").hash(&mut hasher);
    gw.get("rotation_uid").hash(&mut hasher);
    hasher.finish()
}

fn load_last_fingerprint() -> Option<u64> {
    let text = std::fs::read_to_string(sync_state_file()).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("fingerprint").and_then(Value::as_u64)
}

fn save_fingerprint(fp: u64) -> std::io::Result<()> {
    std::fs::create_dir_all(gateway_root())?;
    let content = serde_json::to_string_pretty(&json!({ "fingerprint": fp })).unwrap_or_default();
    atomic_write(&sync_state_file(), &content)
}

/// 导出账号库到网关 auths(只导出**用户勾选入池**的账号;sync_enabled 关闭则不导出)。
/// 按托管配置:mode=pinned 且 pinned_uid 非空时只导出该 uid;否则导出 pool_uids 交集。
/// 导出时保留既有 `credit` 块(分层选号依据)。清理残留仅在启用同步时进行。
pub fn export_accounts_to_auths() -> Result<Value, String> {
    let gw = load_gateway_config();
    let sync_enabled = gw.get("sync_enabled").and_then(Value::as_bool).unwrap_or(false);
    let mode = gw.get("mode").and_then(Value::as_str).unwrap_or("balance");
    let pinned = gw.get("pinned_uid").and_then(Value::as_str).unwrap_or("");
    let rotation = gw.get("rotation_uid").and_then(Value::as_str).unwrap_or("");
    // 手动入池:显式勾选的账号集合。
    let pool_uids: HashSet<String> = gw
        .get("pool_uids")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    // 永不入池:无论自动/手动都排除(如主账号,避免风控)。
    let no_sync_uids: HashSet<String> = gw
        .get("no_sync_uids")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let dir = gateway_auth_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let accounts = account::load_accounts();
    let mut wanted_uids: HashSet<String> = HashSet::new();
    let mut exported = 0;
    for acc in &accounts {
        let Some(uid) = account::get_str(acc, "uid") else { continue };
        if account::get_str(acc, "access_token").is_none() {
            continue; // 缺 token 不导出
        }
        if acc.get("needs_relogin").and_then(Value::as_bool).unwrap_or(false) {
            continue; // 需重登不导出
        }
        if no_sync_uids.contains(&uid) {
            continue; // 永不入池名单:优先级最高,排除
        }
        // 入池来源:手动勾选(pool_uids)或自动入池(sync_enabled)二者之一。
        let selected = pool_uids.contains(&uid) || sync_enabled;
        if !selected {
            continue;
        }
        // 工作模式收窄:指定账号只留 pinned;积分轮转只留当前活跃号;负载均衡不限。
        match mode {
            "pinned" if !pinned.is_empty() && uid != pinned => continue,
            "rotation" if !rotation.is_empty() && uid != rotation => continue,
            _ => {}
        }
        wanted_uids.insert(uid.clone());
        let path = dir.join(format!("workbuddy-{uid}.json"));
        let existing = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        let doc = build_auth_doc(acc, existing.as_ref());
        let content = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
        atomic_write(&path, &content).map_err(|e| format!("写 auths 失败: {e}"))?;
        exported += 1;
    }

    let mut removed = 0;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.starts_with("workbuddy") && name.ends_with(".json")) {
                continue;
            }
            let uid = name
                .trim_start_matches("workbuddy-")
                .trim_end_matches(".json")
                .to_string();
            if !wanted_uids.contains(&uid) {
                let _ = std::fs::remove_file(entry.path());
                removed += 1;
            }
        }
    }
    Ok(json!({ "exported": exported, "removed": removed, "accounts": wanted_uids.len() }))
}

/// 手动/启动强制同步:无条件导出并记录指纹。
pub fn sync_now() -> Value {
    let result = export_accounts_to_auths().unwrap_or_else(|e| json!({ "error": e }));
    let accounts = account::load_accounts();
    let _ = save_fingerprint(accounts_fingerprint(&accounts));
    result
}

/// 增量同步:账号库指纹变化才导出(供 30s 巡检),避免无意义写盘。
pub fn sync_if_changed() -> Value {
    let accounts = account::load_accounts();
    let fp = accounts_fingerprint(&accounts);
    if load_last_fingerprint() == Some(fp) {
        return json!({ "changed": false });
    }
    let result = export_accounts_to_auths().unwrap_or_else(|e| json!({ "error": e }));
    let _ = save_fingerprint(fp);
    let mut out = json!({ "changed": true });
    if let Some(obj) = out.as_object_mut() {
        if let Some(r) = result.as_object() {
            for (k, v) in r {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_auth_doc_maps_account_fields_and_realm() {
        let acc = json!({
            "uid": "u-1",
            "nickname": "xStart",
            "access_token": "at",
            "refresh_token": "rt",
            "domain": "www.codebuddy.cn",
            "variant": "cn",
            "expiresAt": 1792367556073i64,
            "auth_raw": {"deviceToken": "dt-1"},
        });
        let doc = build_auth_doc(&acc, None);
        assert_eq!(doc["auth"]["accessToken"], "at");
        assert_eq!(doc["auth"]["expiresAt"], 1792367556, "毫秒→秒");
        assert_eq!(doc["auth"]["realm"], "cn");
        assert_eq!(doc["account"]["uid"], "u-1");
        assert_eq!(doc["device_token"], "dt-1");
        assert!(doc.get("credit").is_none());
    }

    #[test]
    fn build_auth_doc_preserves_existing_credit_block() {
        let acc = json!({ "uid": "u-1", "access_token": "at", "variant": "ai" });
        let existing = json!({
            "auth": {"accessToken": "old"},
            "credit": {"soonestExpireAt": 123, "total": 100},
        });
        let doc = build_auth_doc(&acc, Some(&existing));
        assert_eq!(doc["auth"]["realm"], "global", "ai → global");
        assert_eq!(doc["credit"]["soonestExpireAt"], 123, "保留分层依据");
    }

    #[test]
    fn build_auth_doc_skips_empty_credit() {
        let acc = json!({ "uid": "u-1", "access_token": "at", "variant": "cn" });
        let existing = json!({ "auth": {"accessToken": "old"}, "credit": null });
        let doc = build_auth_doc(&acc, Some(&existing));
        assert!(doc.get("credit").is_none(), "null credit 不保留");
    }

    #[test]
    fn accounts_fingerprint_changes_on_token_or_uid() {
        let a = vec![json!({"uid": "u-1", "access_token": "at", "variant": "cn"})];
        let b = vec![json!({"uid": "u-1", "access_token": "at2", "variant": "cn"})];
        let c = vec![json!({"uid": "u-2", "access_token": "at", "variant": "cn"})];
        assert_ne!(accounts_fingerprint(&a), accounts_fingerprint(&b));
        assert_ne!(accounts_fingerprint(&a), accounts_fingerprint(&c));
        assert_eq!(accounts_fingerprint(&a), accounts_fingerprint(&a));
    }
}
