use std::net::SocketAddr;

use axum::http::HeaderMap;

use crate::shared::error::AppError;

pub fn resolve_request_ip(headers: &HeaderMap) -> Result<String, AppError> {
    resolve_request_ip_with_socket_addr(headers, None)
}

pub fn resolve_request_ip_with_socket_addr(
    headers: &HeaderMap,
    socket_addr: Option<SocketAddr>,
) -> Result<String, AppError> {
    if let Some(value) = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
    {
        let ip = value.split(',').next().unwrap_or_default().trim();
        if !ip.is_empty() {
            return Ok(ip.to_string());
        }
    }
    if let Some(value) = headers
        .get("x-real-ip")
        .and_then(|value| value.to_str().ok())
    {
        let ip = value.trim();
        if !ip.is_empty() {
            return Ok(ip.to_string());
        }
    }
    if let Some(value) = headers
        .get("forwarded")
        .and_then(|value| value.to_str().ok())
    {
        for segment in value.split(';') {
            let normalized = segment.trim();
            if normalized.len() < 4 || !normalized[..4].eq_ignore_ascii_case("for=") {
                continue;
            }
            let candidate = normalized[4..]
                .trim()
                .trim_matches('"')
                .trim_matches('[')
                .trim_matches(']');
            let candidate = candidate
                .rsplit_once(':')
                .map(|(host, tail)| {
                    if tail.chars().all(|ch| ch.is_ascii_digit()) && host.contains('.') {
                        host
                    } else {
                        candidate
                    }
                })
                .unwrap_or(candidate)
                .trim();
            if !candidate.is_empty() && !candidate.eq_ignore_ascii_case("unknown") {
                return Ok(candidate.to_string());
            }
        }
    }
    if let Some(socket_addr) = socket_addr {
        return Ok(socket_addr.ip().to_string());
    }
    Err(AppError::service_unavailable("请求 IP 不能为空"))
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn forwarded_for_has_priority() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("1.2.3.4, 10.0.0.1"),
        );
        headers.insert("x-real-ip", HeaderValue::from_static("5.6.7.8"));
        assert_eq!(
            super::resolve_request_ip(&headers).ok().as_deref(),
            Some("1.2.3.4")
        );
    }

    #[test]
    fn forwarded_header_is_supported() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "forwarded",
            HeaderValue::from_static("for=203.0.113.9;proto=http;by=203.0.113.43"),
        );
        assert_eq!(
            super::resolve_request_ip_with_socket_addr(&headers, None)
                .ok()
                .as_deref(),
            Some("203.0.113.9")
        );
    }

    #[test]
    fn socket_addr_is_used_as_last_resort() {
        let headers = HeaderMap::new();
        let socket_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 6011);
        assert_eq!(
            super::resolve_request_ip_with_socket_addr(&headers, Some(socket_addr))
                .ok()
                .as_deref(),
            Some("127.0.0.1")
        );
    }
}
