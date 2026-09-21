//! 网关管理 Tauri 命令：桌面端镜像 webui 的 /api/wb2api/* 路由
//! （见 crates/wb-switch-server/src/wb2api.rs），让网关页在桌面 App 与 webui 同样可用。

use serde_json::{json, Value};
use wb_switch_core::modules::variant::WbVariant;
use wb_switch_gateway::modules::{account_sync, gateway_manage, wb2api};

#[tauri::command]
pub async fn wb2api_status() -> Result<Value, String> {
    wb2api::status().await
}

#[tauri::command]
pub async fn wb2api_models() -> Result<Value, String> {
    wb2api::models().await
}

#[tauri::command]
pub async fn wb2api_stats() -> Result<Value, String> {
    wb2api::stats().await
}

#[tauri::command]
pub async fn wb2api_pool_accounts() -> Value {
    wb2api::pool_accounts().await
}

#[tauri::command]
pub async fn wb2api_model_catalog(realm: Option<String>) -> Value {
    wb2api::model_catalog(WbVariant::parse(realm.as_deref())).await
}

#[tauri::command]
pub async fn wb2api_account_op(
    uid: String,
    op: String,
    reason: Option<String>,
) -> Result<Value, String> {
    wb2api::account_op(&uid, &op, reason.as_deref().unwrap_or("")).await
}

#[tauri::command]
pub fn wb2api_onboard(account_id: String) -> Result<Value, String> {
    wb2api::onboard(&account_id)
}

#[tauri::command]
pub fn wb2api_offboard(uid: String) -> Result<Value, String> {
    wb2api::offboard(&uid)
}

#[tauri::command]
pub fn wb2api_get_config() -> Value {
    wb2api::load_wb2api_config()
}

#[tauri::command]
pub async fn gateway_status() -> Value {
    gateway_manage::gateway_status().await
}

#[tauri::command]
pub async fn gateway_start() -> Result<Value, String> {
    gateway_manage::start_gateway().await
}

#[tauri::command]
pub fn gateway_stop() -> Result<Value, String> {
    gateway_manage::stop_gateway()
}

#[tauri::command]
pub fn gateway_save_config(config: Value) -> Result<Value, String> {
    gateway_manage::save_gateway_config(&config).map_err(|e| e.to_string())?;
    Ok(gateway_manage::load_gateway_config())
}

#[tauri::command]
pub fn gateway_sync_now() -> Value {
    account_sync::sync_now()
}

#[tauri::command]
pub fn gateway_pick_port() -> Value {
    json!({ "port": gateway_manage::pick_random_free_port(7863, 100) })
}

#[tauri::command]
pub fn gateway_port_check(port: u16) -> Value {
    json!({
        "port": port,
        "available": port != 0 && gateway_manage::port_available(port),
    })
}

#[tauri::command]
pub async fn gateway_check_update() -> Value {
    gateway_manage::check_gateway_update().await
}

#[tauri::command]
pub async fn gateway_apply_update(sha256: Option<String>) -> Result<Value, String> {
    gateway_manage::apply_gateway_update(sha256.as_deref()).await
}

#[tauri::command]
pub fn gateway_gen_key() -> Value {
    json!({ "api_key": gateway_manage::generate_api_key() })
}
