use axum::http::{HeaderValue, Uri};
use axum::Router;
use socketioxide::SocketIo;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

use crate::http;
use crate::realtime::public_socket::mount_public_socket;
use crate::shared::error::AppError;
use crate::state::AppState;

pub fn build_router(state: AppState) -> Result<Router, AppError> {
    let state = state;
    let cors_layer = build_cors_layer(&state.config.http.cors_origin)?;
    let uploads_dir = state.config.storage.uploads_dir.clone();
    let (game_socket_layer, game_socket_io) =
        SocketIo::builder().req_path("/game-socket").build_layer();
    let (socket_io_fallback_layer, socket_io_fallback) =
        SocketIo::builder().req_path("/socket.io").build_layer();
    state.attach_socket_io(game_socket_io.clone());

    mount_public_socket(&game_socket_io, state.clone());
    mount_public_socket(&socket_io_fallback, state.clone());

    Ok(http::router()
        .nest_service("/uploads", ServeDir::new(uploads_dir))
        .with_state(state)
        .layer(game_socket_layer)
        .layer(socket_io_fallback_layer)
        .layer(TraceLayer::new_for_http())
        .layer(cors_layer))
}

fn build_cors_layer(cors_origin: &str) -> Result<CorsLayer, AppError> {
    let raw = cors_origin.trim();

    if raw.is_empty() {
        return Ok(CorsLayer::very_permissive().allow_origin(AllowOrigin::predicate(
            |origin: &HeaderValue, _request_parts| {
                std::str::from_utf8(origin.as_bytes())
                    .ok()
                    .and_then(|value| value.parse::<Uri>().ok())
                    .map(|uri: Uri| {
                        let scheme = uri.scheme_str().unwrap_or("http");
                        let port = uri
                            .port_u16()
                            .unwrap_or(if scheme.eq_ignore_ascii_case("https") { 443 } else { 80 });
                        port == 6010
                    })
                    .unwrap_or(false)
            },
        )));
    }

    if raw == "*" {
        return Ok(CorsLayer::very_permissive());
    }

    let origins = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            let header = HeaderValue::from_str(value)
                .map_err(|error| AppError::config(format!("invalid CORS_ORIGIN value: {error}")))?;
            let uri = value
                .parse::<Uri>()
                .map_err(|error| AppError::config(format!("invalid CORS_ORIGIN value: {error}")))?;
            if uri.scheme_str().is_none() || uri.host().is_none() {
                return Err(AppError::config(format!(
                    "invalid CORS_ORIGIN value: {value}"
                )));
            }
            Ok(header)
        })
        .collect::<Result<Vec<_>, AppError>>()?;

    Ok(CorsLayer::very_permissive()
        .allow_origin(origins)
    )
}

#[cfg(test)]
mod tests {
    use super::build_cors_layer;

    #[test]
    fn build_cors_layer_accepts_wildcard_with_credentials_safe_shape() {
        let _ = build_cors_layer("*").expect("wildcard cors should build");
    }

    #[test]
    fn build_cors_layer_accepts_explicit_origins_with_credentials() {
        let _ = build_cors_layer("http://localhost:5173,https://example.com")
            .expect("explicit cors origins should build");
    }

    #[test]
    fn build_cors_layer_rejects_invalid_header_value() {
        let error = build_cors_layer("http://localhost:5173,\ninvalid")
            .expect_err("invalid cors origin should fail");
        assert!(error.client_message().contains("invalid CORS_ORIGIN value"));
    }
}
