use std::time::Instant;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;

pub const HTTP_SLOW_REQUEST_THRESHOLD_MS: u128 = 250;

pub async fn log_slow_request(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let ip = request
        .headers()
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let path = strip_query_from_path(uri.path_and_query().map(|value| value.as_str()).unwrap_or(uri.path()));

    if path.starts_with("/uploads") {
        return next.run(request).await;
    }

    let started_at = Instant::now();
    let response = next.run(request).await;
    let total_cost_ms = started_at.elapsed().as_millis();

    if total_cost_ms > HTTP_SLOW_REQUEST_THRESHOLD_MS {
        let content_length = response
            .headers()
            .get(axum::http::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());

        tracing::warn!(
            kind = "slow_http_request",
            threshold_ms = HTTP_SLOW_REQUEST_THRESHOLD_MS,
            total_cost_ms,
            method = %method,
            path,
            status_code = response.status().as_u16(),
            ip = ip.as_deref().unwrap_or(""),
            content_length,
            "slow http request"
        );
    }

    response
}

fn strip_query_from_path(raw: &str) -> &str {
    raw.split('?').next().unwrap_or(raw)
}

#[cfg(test)]
mod tests {
    use super::strip_query_from_path;

    #[test]
    fn strip_query_from_path_removes_query_string() {
        assert_eq!(strip_query_from_path("/api/test?foo=bar"), "/api/test");
        assert_eq!(strip_query_from_path("/api/test"), "/api/test");
    }
}
