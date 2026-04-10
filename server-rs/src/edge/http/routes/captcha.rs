use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use crate::bootstrap::app::AppState;
use crate::edge::http::response::success;
use crate::edge::http::routes::auth::CaptchaProvider;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct CaptchaConfigPayload {
    provider: &'static str,
    #[serde(rename = "tencentAppId", skip_serializing_if = "Option::is_none")]
    tencent_app_id: Option<u64>,
}

pub fn build_captcha_router() -> Router<AppState> {
    Router::new().route("/config", get(captcha_config_handler))
}

async fn captcha_config_handler(State(state): State<AppState>) -> Response {
    let payload = match state.auth_services.captcha_provider() {
        CaptchaProvider::Local => CaptchaConfigPayload {
            provider: "local",
            tencent_app_id: None,
        },
        CaptchaProvider::Tencent => CaptchaConfigPayload {
            provider: "tencent",
            tencent_app_id: Some(state.settings.captcha.tencent_app_id),
        },
    };
    success(payload)
}
