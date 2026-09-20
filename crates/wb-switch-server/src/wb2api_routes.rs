//! wb2api 网关管理路由:对接 workbuddy2api、网关托管、账号单向推送 的 HTTP 层。
//!
//! 独立成文件,`api.rs` 只 `.merge(wb2api_routes::router())`,保持既有文件低侵入。

use axum::extract::{Path, RawQuery};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use wb_switch_core::modules::variant::WbVariant;
use wb_switch_gateway::modules::{account_sync, gateway_manage, wb2api};

fn json_ok(v: Value) -> Response {
    Json(v).into_response()
}

fn json_err(e: String, code: StatusCode) -> Response {
    (code, Json(json!({ "ok": false, "error": e }))).into_response()
}

/// /api/wb2api/* 的全部路由。
pub fn router() -> Router {
    Router::new()
        .route("/api/wb2api/status", get(api_wb2api_status))
        .route("/api/wb2api/models", get(api_wb2api_models))
        .route("/api/wb2api/stats", get(api_wb2api_stats))
        .route("/api/wb2api/pool-accounts", get(api_wb2api_pool_accounts))
        .route("/api/wb2api/model-catalog", get(api_wb2api_model_catalog))
        // 网关托管(gateway_manage)
        .route("/api/wb2api/gateway", get(api_gateway_status))
        .route("/api/wb2api/gateway/start", post(api_gateway_start))
        .route("/api/wb2api/gateway/stop", post(api_gateway_stop))
        .route(
            "/api/wb2api/gateway/config",
            get(api_gateway_config_get).post(api_gateway_config_save),
        )
        .route("/api/wb2api/gateway/update/check", get(api_gateway_update_check))
        .route("/api/wb2api/gateway/update", post(api_gateway_update_apply))
        .route("/api/wb2api/gateway/pick-port", post(api_gateway_pick_port))
        .route("/api/wb2api/gateway/gen-key", post(api_gateway_gen_key))
        // 账号单向推送
        .route("/api/wb2api/sync/now", post(api_sync_now))
        .route(
            "/api/wb2api/accounts/:uid/disable",
            post(api_wb2api_account_disable),
        )
        .route(
            "/api/wb2api/accounts/:uid/enable",
            post(api_wb2api_account_enable),
        )
        .route(
            "/api/wb2api/accounts/:uid/revive",
            post(api_wb2api_account_revive),
        )
        .route("/api/wb2api/onboard", post(api_wb2api_onboard))
        .route("/api/wb2api/offboard", post(api_wb2api_offboard))
        .route(
            "/api/wb2api/config",
            get(api_wb2api_config_get).post(api_wb2api_config_save),
        )
        .route(
            "/api/wb2api/upstream-config",
            get(api_wb2api_upstream_config_get).post(api_wb2api_upstream_config_save),
        )
}

async fn api_wb2api_status() -> Response {
    match wb2api::status().await {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_GATEWAY),
    }
}

async fn api_wb2api_models() -> Response {
    match wb2api::models().await {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_GATEWAY),
    }
}

async fn api_wb2api_stats() -> Response {
    match wb2api::stats().await {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_GATEWAY),
    }
}

async fn api_wb2api_pool_accounts() -> Response {
    json_ok(wb2api::pool_accounts().await)
}

/// 模型中心:指定版本的模型目录(realm 缺省 cn;直连腾讯,失败回退上游)。
async fn api_wb2api_model_catalog(RawQuery(query): RawQuery) -> Response {
    let realm = query
        .as_deref()
        .and_then(|q| {
            q.split('&').find_map(|p| {
                let (k, v) = p.split_once('=').unwrap_or((p, ""));
                (k == "realm").then_some(v)
            })
        })
        .unwrap_or("cn");
    json_ok(wb2api::model_catalog(WbVariant::parse(Some(realm))).await)
}

// ---------------------------------------------------------------------------
// 网关托管(gateway_manage)
// ---------------------------------------------------------------------------

/// 网关托管状态(进程/健康/端口/配置)。
async fn api_gateway_status() -> Response {
    json_ok(gateway_manage::gateway_status().await)
}

async fn api_gateway_start() -> Response {
    match gateway_manage::start_gateway().await {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_REQUEST),
    }
}

async fn api_gateway_stop() -> Response {
    match gateway_manage::stop_gateway() {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_REQUEST),
    }
}

/// 网关托管配置(读)。
async fn api_gateway_config_get() -> Response {
    json_ok(gateway_manage::load_gateway_config())
}

/// 网关托管配置(存)。
async fn api_gateway_config_save(Json(body): Json<Value>) -> Response {
    let submitted = body.get("config").unwrap_or(&body);
    match gateway_manage::save_gateway_config(submitted) {
        Ok(()) => json_ok(gateway_manage::load_gateway_config()),
        Err(e) => json_err(e.to_string(), StatusCode::BAD_REQUEST),
    }
}

/// 账号单向推送:立即把账号库导出到网关 auths(手动触发)。
async fn api_sync_now() -> Response {
    json_ok(account_sync::sync_now())
}

/// 网关独立升级:检查更新源可达性。
async fn api_gateway_update_check() -> Response {
    json_ok(gateway_manage::check_gateway_update().await)
}

/// 网关独立升级:下载/拷贝并替换二进制(可选 sha256 校验),网关在跑则重启。
async fn api_gateway_update_apply(Json(body): Json<Value>) -> Response {
    let sha256 = body.get("sha256").and_then(Value::as_str);
    match gateway_manage::apply_gateway_update(sha256).await {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_REQUEST),
    }
}

/// 自动挑选一个空闲端口(从 54321 起)。
async fn api_gateway_pick_port() -> Response {
    json_ok(json!({ "port": gateway_manage::pick_free_port(54321) }))
}

/// 生成一个网关访问密钥(wbs- 前缀)。
async fn api_gateway_gen_key() -> Response {
    json_ok(json!({ "api_key": gateway_manage::generate_api_key() }))
}

async fn api_wb2api_account_disable(Path(uid): Path<String>, Json(body): Json<Value>) -> Response {
    let reason = body.get("reason").and_then(Value::as_str).unwrap_or("");
    match wb2api::account_op(&uid, "disable", reason).await {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_REQUEST),
    }
}

async fn api_wb2api_account_enable(Path(uid): Path<String>, _body: Option<Json<Value>>) -> Response {
    match wb2api::account_op(&uid, "enable", "").await {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_REQUEST),
    }
}

async fn api_wb2api_account_revive(Path(uid): Path<String>, _body: Option<Json<Value>>) -> Response {
    match wb2api::account_op(&uid, "revive", "").await {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_REQUEST),
    }
}

async fn api_wb2api_onboard(Json(body): Json<Value>) -> Response {
    let account_id = body.get("accountId").and_then(Value::as_str).unwrap_or("");
    match wb2api::onboard(account_id) {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_REQUEST),
    }
}

async fn api_wb2api_offboard(Json(body): Json<Value>) -> Response {
    let uid = body.get("uid").and_then(Value::as_str).unwrap_or("");
    match wb2api::offboard(uid) {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_REQUEST),
    }
}

/// switch 侧对接配置(读)。
async fn api_wb2api_config_get() -> Response {
    json_ok(wb2api::load_wb2api_config())
}

/// switch 侧对接配置(存)。
async fn api_wb2api_config_save(Json(body): Json<Value>) -> Response {
    let submitted = body.get("config").unwrap_or(&body);
    match wb2api::save_wb2api_config(submitted) {
        Ok(()) => json_ok(wb2api::load_wb2api_config()),
        Err(e) => json_err(e.to_string(), StatusCode::BAD_REQUEST),
    }
}

/// 上游 wb2api config.json(读)。
async fn api_wb2api_upstream_config_get() -> Response {
    match wb2api::upstream_config_get() {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_REQUEST),
    }
}

/// 上游 wb2api config.json(写,自动备份)。
async fn api_wb2api_upstream_config_save(Json(body): Json<Value>) -> Response {
    let submitted = body.get("config").unwrap_or(&body);
    match wb2api::upstream_config_save(submitted) {
        Ok(v) => json_ok(v),
        Err(e) => json_err(e, StatusCode::BAD_REQUEST),
    }
}
