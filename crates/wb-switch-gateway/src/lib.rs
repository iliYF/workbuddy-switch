//! wb-switch 网关管理:对接 workbuddy2api 的能力收敛层。
//!
//! 网关相关代码全部收敛在本 crate(不入 wb-switch-core);与 core 通过公开函数
//! 互调(如复用 core 的账号库/oauth/checkin,core 不反向依赖本 crate)。
//!
//! - [`wb2api`]:对接 workbuddy2api 的 HTTP 客户端 + 同机 auths/config 文件访问。
//! - [`gateway_manage`]:网关托管(二进制定位/起停/健康/端口/配置)。
//! - (后续)`account_sync` / `agent_import`:账号单向推送 / 智能体接入。

pub mod gateway_manage;
pub mod wb2api;
