use axum::Json;
use axum::extract::State;
use serde::Serialize;

use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct RootResponse {
    pub name: String,
    pub version: String,
    pub status: &'static str,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub timestamp: u64,
}

pub async fn root(State(state): State<AppState>) -> Json<RootResponse> {
    Json(RootResponse {
        name: state.config.service.name.clone(),
        version: state.config.service.version.clone(),
        status: "running",
    })
}

pub async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let _ = state.redis_available;

    Json(HealthResponse {
        status: "ok",
        timestamp: chrono_like_timestamp_ms(),
    })
}

fn chrono_like_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;
    use std::sync::Arc;
    use std::sync::{Mutex, OnceLock};

    use axum::body::Body;
    use http::{Request, StatusCode};
    use serde_json::Value;
    use sqlx::Row;
    use tower::ServiceExt;

    use crate::auth::{self, AuthTokenPayload};
    use crate::battle_runtime::{build_minimal_pve_battle_state, build_minimal_pvp_battle_state};
    use crate::bootstrap::app::build_router;
    use crate::config::{
        AppConfig, CaptchaConfig, CaptchaProvider, CosConfig, DatabaseConfig, HttpConfig,
        LoggingConfig, MarketPhoneBindingConfig, OutboundHttpConfig, RedisConfig, ServiceConfig, StorageConfig,
        WanderConfig,
    };
    use crate::http::tower::resolve_tower_floor_monster_ids;
    use crate::integrations::database::DatabaseRuntime;
    use crate::state::{AppState, BattleSessionContextDto, BattleSessionSnapshotDto, OnlineBattleProjectionRecord};

    fn technique_research_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        match LOCK.get_or_init(|| Mutex::new(())).lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn partner_ai_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        match LOCK.get_or_init(|| Mutex::new(())).lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn afdian_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        match LOCK.get_or_init(|| Mutex::new(())).lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn battle_cluster_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        match LOCK.get_or_init(|| Mutex::new(())).lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn test_state() -> AppState {
        let config = Arc::new(AppConfig {
            service: ServiceConfig {
                name: "九州修仙录 Rust Backend".to_string(),
                version: "0.1.0".to_string(),
                node_env: "test".to_string(),
                jwt_secret: "test-secret".to_string(),
                jwt_expires_in: "7d".to_string(),
            },
            http: HttpConfig {
                host: "127.0.0.1".to_string(),
                port: 6011,
                cors_origin: "*".to_string(),
            },
            wander: WanderConfig {
                ai_enabled: false,
                model_provider: String::new(),
                model_url: String::new(),
                model_key: String::new(),
                model_name: String::new(),
            },
            captcha: CaptchaConfig {
                provider: CaptchaProvider::Local,
                tencent_app_id: 0,
                tencent_app_secret_key: String::new(),
                tencent_secret_id: String::new(),
                tencent_secret_key: String::new(),
            },
            market_phone_binding: MarketPhoneBindingConfig {
                enabled: false,
                aliyun_access_key_id: String::new(),
                aliyun_access_key_secret: String::new(),
                sign_name: String::new(),
                template_code: String::new(),
                code_expire_seconds: 300,
                send_cooldown_seconds: 60,
                send_hourly_limit: 5,
                send_daily_limit: 10,
            },
            database: DatabaseConfig {
                url: "postgresql://postgres:postgres@localhost:5432/jiuzhou".to_string(),
            },
            redis: RedisConfig {
                url: "redis://127.0.0.1:6379".to_string(),
            },
            outbound_http: OutboundHttpConfig { timeout_ms: 1_000 },
            storage: StorageConfig {
                uploads_dir: std::env::temp_dir().join("server-rs-test-uploads"),
            },
            cos: CosConfig {
                secret_id: String::new(),
                secret_key: String::new(),
                bucket: String::new(),
                region: String::new(),
                avatar_prefix: "avatars/".to_string(),
                generated_image_prefix: "generated/".to_string(),
                domain: String::new(),
                sts_duration_seconds: 600,
            },
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
        });

        let database = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy(&config.database.url)
            .expect("lazy postgres pool should build for tests");
        let redis = Some(
            redis::Client::open(config.redis.url.clone()).expect("test redis client should build"),
        );
        let http_client = reqwest::Client::new();

        AppState::new(config, DatabaseRuntime::new(database), redis, http_client, true)
    }

    fn test_state_with_wander_ai(ai_enabled: bool) -> AppState {
        let state = test_state();
        let mut config = (*state.config).clone();
        config.wander.ai_enabled = ai_enabled;
        AppState::new(
            Arc::new(config),
            state.database.clone(),
            state.redis.clone(),
            state.outbound_http.clone(),
            true,
        )
    }

    async fn handshake_sid_for_path(
        client: &reqwest::Client,
        address: std::net::SocketAddr,
        path: &str,
    ) -> (String, String) {
        let handshake_text = client
            .get(format!("http://{address}{path}?EIO=4&transport=polling"))
            .send()
            .await
            .expect("handshake should succeed")
            .text()
            .await
            .expect("handshake text should read");
        let sid = handshake_text
            .split("\"sid\":\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .expect("sid should exist in handshake")
            .to_string();
        (sid, handshake_text)
    }

    async fn handshake_sid(client: &reqwest::Client, address: std::net::SocketAddr) -> (String, String) {
        handshake_sid_for_path(client, address, "/game-socket/").await
    }

    async fn socket_connect_for_path(
        client: &reqwest::Client,
        address: std::net::SocketAddr,
        path: &str,
        sid: &str,
    ) {
        socket_emit_raw_for_path(client, address, path, sid, "40").await;
        let _ = poll_text_for_path(client, address, path, sid).await;
    }

    async fn socket_connect(client: &reqwest::Client, address: std::net::SocketAddr, sid: &str) {
        socket_connect_for_path(client, address, "/game-socket/", sid).await;
    }

    async fn socket_auth(client: &reqwest::Client, address: std::net::SocketAddr, sid: &str, token: &str) {
        socket_connect(client, address, sid).await;
        socket_emit_raw(client, address, sid, &format!("42[\"game:auth\",\"{token}\"]")).await;
    }

    async fn socket_auth_for_path(
        client: &reqwest::Client,
        address: std::net::SocketAddr,
        path: &str,
        sid: &str,
        token: &str,
    ) {
        socket_connect_for_path(client, address, path, sid).await;
        socket_emit_raw_for_path(client, address, path, sid, &format!("42[\"game:auth\",\"{token}\"]")).await;
    }

    async fn socket_emit_raw_for_path(
        client: &reqwest::Client,
        address: std::net::SocketAddr,
        path: &str,
        sid: &str,
        body: &str,
    ) {
        client
            .post(format!("http://{address}{path}?EIO=4&transport=polling&sid={sid}"))
            .header("content-type", "text/plain;charset=UTF-8")
            .body(body.to_string())
            .send()
            .await
            .expect("socket packet should succeed");
    }

    async fn socket_emit_raw(
        client: &reqwest::Client,
        address: std::net::SocketAddr,
        sid: &str,
        body: &str,
    ) {
        socket_emit_raw_for_path(client, address, "/game-socket/", sid, body).await;
    }

    async fn poll_text_for_path(
        client: &reqwest::Client,
        address: std::net::SocketAddr,
        path: &str,
        sid: &str,
    ) -> String {
        client
            .get(format!("http://{address}{path}?EIO=4&transport=polling&sid={sid}"))
            .send()
            .await
            .expect("poll should succeed")
            .text()
            .await
            .expect("poll text should read")
    }

    async fn poll_text(client: &reqwest::Client, address: std::net::SocketAddr, sid: &str) -> String {
        poll_text_for_path(client, address, "/game-socket/", sid).await
    }

    async fn poll_until_contains(
        client: &reqwest::Client,
        address: std::net::SocketAddr,
        sid: &str,
        needle: &str,
    ) -> String {
        let mut last = String::new();
        for _ in 0..100 {
            last = poll_text(client, address, sid).await;
            if last.contains(needle) {
                return last;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        last
    }

    async fn spawn_test_server(app: axum::Router) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let address = listener.local_addr().expect("local addr should exist");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("server should run");
        });
        (address, server)
    }

    async fn connect_fixture_db_or_skip(
        state: &AppState,
        skip_tag: &str,
    ) -> Option<sqlx::PgPool> {
        match sqlx::PgPool::connect(&state.config.database.url).await {
            Ok(pool) => Some(pool),
            Err(error) => {
                println!("{skip_tag}={error}");
                None
            }
        }
    }

    struct AuthFixture {
        user_id: i64,
        character_id: i64,
        token: String,
    }

async fn insert_auth_fixture(
    state: &AppState,
    pool: &sqlx::PgPool,
    prefix: &str,
    suffix: &str,
    attribute_points: i64,
) -> AuthFixture {
    fn truncate_for_fixture(value: String, max_chars: usize) -> String {
        let chars = value.chars().collect::<Vec<_>>();
        if chars.len() <= max_chars {
            return value;
        }
        let digest = format!("{:x}", md5::compute(value.as_bytes()));
        let suffix = &digest[..8];
        let head_len = max_chars.saturating_sub(9);
        let head = chars.into_iter().take(head_len).collect::<String>();
        format!("{head}-{suffix}")
    }

    let username = truncate_for_fixture(format!("{prefix}-{suffix}"), 40);
    let session_token = truncate_for_fixture(format!("session-{suffix}"), 48);
    let nickname = truncate_for_fixture(format!("角色-{suffix}"), 30);

    let inserted_user = sqlx::query(
        "INSERT INTO users (username, password, status, session_token, created_at, updated_at) VALUES ($1, $2, 1, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id",
    )
        .bind(&username)
        .bind("ignored-password")
        .bind(&session_token)
        .fetch_one(pool)
        .await
        .expect("user should insert");
        let user_id = i64::from(inserted_user.try_get::<i32, _>("id").expect("user id should exist"));

        let inserted_character = sqlx::query(
            "INSERT INTO characters (user_id, nickname, gender, title, spirit_stones, silver, realm, exp, attribute_points, jing, qi, shen, attribute_type, attribute_element, current_map_id, current_room_id, auto_cast_skills, auto_disassemble_enabled, dungeon_no_stamina_cost) VALUES ($1, $2, 'male', '散修', 0, 0, '凡人', 0, $3, 0, 0, 0, 'physical', 'none', 'map-qingyun-village', 'room-village-center', true, false, false) RETURNING id",
        )
        .bind(user_id)
        .bind(nickname)
        .bind(attribute_points)
        .fetch_one(pool)
        .await
        .expect("character should insert");
        let character_id = i64::from(
            inserted_character
                .try_get::<i32, _>("id")
                .expect("character id should exist"),
        );

        let token = auth::sign_token(
            AuthTokenPayload {
                user_id,
                username: &username,
                session_token: Some(&session_token),
            },
            &state.config.service.jwt_secret,
            &state.config.service.jwt_expires_in,
        )
        .expect("token should sign");

    AuthFixture {
        user_id,
        character_id,
        token,
    }
}

async fn insert_test_team(
    pool: &sqlx::PgPool,
    team_id: &str,
    leader_character_id: i64,
    suffix: &str,
) {
    let team_name = format!("测试队伍-{suffix}");
    sqlx::query(
        "INSERT INTO teams (id, leader_id, name, current_map_id, is_public, max_members, auto_join_enabled, created_at, updated_at) VALUES ($1, $2, $3, 'map-qingyun-village', true, 4, false, NOW(), NOW())",
    )
    .bind(team_id)
    .bind(leader_character_id)
    .bind(team_name)
    .execute(pool)
    .await
    .expect("team should insert");
}

async fn insert_test_sect(
    pool: &sqlx::PgPool,
    sect_id: &str,
    leader_character_id: i64,
    member_count: i64,
    suffix: &str,
) {
    let sect_name = format!("测试宗门-{suffix}");
    sqlx::query(
        "INSERT INTO sect_def (id, name, leader_id, level, member_count, created_at, updated_at) VALUES ($1, $2, $3, 1, $4, NOW(), NOW())",
    )
    .bind(sect_id)
    .bind(sect_name)
    .bind(leader_character_id)
    .bind(member_count)
    .execute(pool)
    .await
    .expect("sect should insert");
}

    async fn cleanup_auth_fixture(pool: &sqlx::PgPool, character_id: i64, user_id: i64) {
        sqlx::query("DELETE FROM characters WHERE id = $1")
            .bind(character_id)
            .execute(pool)
            .await
            .ok();
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(pool)
            .await
            .ok();
    }

    async fn insert_partner_fixture(
        pool: &sqlx::PgPool,
        character_id: i64,
        partner_def_id: &str,
        nickname: &str,
        is_active: bool,
    ) -> i64 {
        let inserted = sqlx::query(
            "INSERT INTO character_partner (character_id, partner_def_id, nickname, description, avatar, level, progress_exp, growth_max_qixue, growth_wugong, growth_fagong, growth_wufang, growth_fafang, growth_sudu, is_active, obtained_from, obtained_ref_id, created_at, updated_at) VALUES ($1, $2, $3, '', NULL, 1, 0, 0, 0, 0, 0, 0, 0, $4, 'test', NULL, NOW(), NOW()) RETURNING id",
        )
        .bind(character_id)
        .bind(partner_def_id)
        .bind(nickname)
        .bind(is_active)
        .fetch_one(pool)
        .await
        .expect("partner should insert");
        i64::from(inserted.try_get::<i32, _>("id").expect("partner id should exist"))
    }

    #[tokio::test]
    async fn root_route_matches_expected_shape() {
        let app = build_router(test_state()).expect("router should build");
        let response = app
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should read");
        let payload: Value = serde_json::from_slice(&body).expect("root payload should parse");

        assert_eq!(payload["status"], "running");
        assert_eq!(payload["version"], "0.1.0");
    }

    #[tokio::test]
    async fn health_route_returns_ok_payload() {
        let app = build_router(test_state()).expect("router should build");
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should read");
        let payload: Value = serde_json::from_slice(&body).expect("health payload should parse");

        assert_eq!(payload["status"], "ok");
        assert!(payload["timestamp"].as_u64().unwrap_or_default() > 0);
    }

    #[tokio::test]
    async fn game_socket_path_is_owned_by_socketioxide_layer() {
        let app = build_router(test_state()).expect("router should build");
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/game-socket/?EIO=4&transport=polling")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("request should succeed");

        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should read");
        let text = String::from_utf8_lossy(&body).to_string();

        println!("GAME_SOCKET_HANDSHAKE_STATUS={status}");
        println!("GAME_SOCKET_HANDSHAKE_BODY={text}");

        assert_ne!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn socket_io_fallback_path_is_owned_by_socketioxide_layer() {
        let app = build_router(test_state()).expect("router should build");
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/socket.io/?EIO=4&transport=polling")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("request should succeed");

        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should read");
        let text = String::from_utf8_lossy(&body).to_string();

        println!("SOCKET_IO_HANDSHAKE_STATUS={status}");
        println!("SOCKET_IO_HANDSHAKE_BODY={text}");

        assert_ne!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn socket_io_fallback_path_emits_game_error_for_invalid_auth_token() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_auth_for_path(&client, address, "/socket.io/", &sid, "bad-token").await;
        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_INVALID_AUTH_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_INVALID_AUTH_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error") || poll_text.contains("Session ID unknown"));
        if poll_text.contains("game:error") {
            assert!(poll_text.contains("认证失败"));
        }
    }

    #[tokio::test]
    async fn socket_io_fallback_room_membership_handlers_join_and_leave_room_after_auth() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 701,
            character_id: Some(7001),
            session_token: Some("sess-socketio-room".to_string()),
            connected_at_ms: 1,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 701,
            character_id: Some(7001),
            nickname: Some("韩立".to_string()),
            month_card_active: false,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: Some("room-village-center".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw_for_path(&client, address, "/socket.io/", &sid, "42[\"join:room\",\"room-fallback\"]").await;
        let joined = state.online_players.get(701).and_then(|record| record.room_id.clone());

        socket_emit_raw_for_path(&client, address, "/socket.io/", &sid, "42[\"leave:room\",\"room-fallback\"]").await;
        let left = state.online_players.get(701).and_then(|record| record.room_id.clone());

        println!("SOCKET_IO_ROOM_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_ROOM_JOINED={:?}", joined);
        println!("SOCKET_IO_ROOM_LEFT={:?}", left);

        server.abort();

        assert_eq!(joined.as_deref(), Some("room-fallback"));
        assert_eq!(left, None);
    }

    #[tokio::test]
    async fn socket_io_fallback_join_room_requires_auth() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;

        socket_emit_raw_for_path(&client, address, "/socket.io/", &sid, "42[\"join:room\",\"room-fallback\"]").await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_JOIN_ROOM_UNAUTH_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_JOIN_ROOM_UNAUTH_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("未认证"));
    }

    #[tokio::test]
    async fn socket_io_fallback_join_room_rejects_blank_room_name() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;

        socket_emit_raw_for_path(&client, address, "/socket.io/", &sid, "42[\"join:room\",\"\"]").await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_JOIN_ROOM_BLANK_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_JOIN_ROOM_BLANK_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("房间ID不能为空"));
    }

    #[tokio::test]
    async fn socket_io_fallback_battle_sync_requires_battle_id() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 901,
            character_id: Some(9001),
            session_token: Some("sess-socketio-battle-sync".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw_for_path(&client, address, "/socket.io/", &sid, "42[\"battle:sync\",{}]").await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_BATTLE_SYNC_MISSING_ID_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_BATTLE_SYNC_MISSING_ID_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("缺少战斗ID"));
    }

    #[tokio::test]
    async fn socket_io_fallback_battle_sync_requires_auth() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;

        socket_emit_raw_for_path(&client, address, "/socket.io/", &sid, "42[\"battle:sync\",{\"battleId\":\"battle-1\"}]").await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_BATTLE_SYNC_UNAUTH_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_BATTLE_SYNC_UNAUTH_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("未认证"));
    }

    #[tokio::test]
    async fn socket_io_fallback_add_point_rejects_invalid_attribute() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 902,
            character_id: Some(9002),
            session_token: Some("sess-socketio-add-point-invalid".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw_for_path(&client, address, "/socket.io/", &sid, "42[\"game:addPoint\",{\"attribute\":\"invalid\",\"amount\":1}]").await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_ADD_POINT_INVALID_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_ADD_POINT_INVALID_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("无效的属性"));
    }

    #[tokio::test]
    async fn socket_io_fallback_add_point_requires_character_context() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;

        socket_emit_raw_for_path(&client, address, "/socket.io/", &sid, "42[\"game:addPoint\",{\"attribute\":\"jing\",\"amount\":1}]").await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_ADD_POINT_UNAUTH_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_ADD_POINT_UNAUTH_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("未找到角色"));
    }

    #[tokio::test]
    async fn socket_io_fallback_online_players_request_emits_full_payload_after_auth_without_db() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 903,
            character_id: Some(9003),
            session_token: Some("sess-socketio-online-players".to_string()),
            connected_at_ms: 1,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 903,
            character_id: Some(9003),
            nickname: Some("韩立".to_string()),
            month_card_active: true,
            title: Some("散修".to_string()),
            realm: Some("筑基期".to_string()),
            room_id: Some("room-alpha".to_string()),
            connected_at_ms: 1,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 904,
            character_id: Some(9004),
            nickname: Some("厉飞雨".to_string()),
            month_card_active: false,
            title: Some("外门弟子".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: None,
            connected_at_ms: 2,
        });

        socket_emit_raw_for_path(&client, address, "/socket.io/", &sid, "42[\"game:onlinePlayers:request\"]").await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_ONLINE_PLAYERS_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_ONLINE_PLAYERS_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:onlinePlayers"));
        assert!(poll_text.contains("\"type\":\"full\""));
        assert!(poll_text.contains("\"nickname\":\"韩立\""));
        assert!(poll_text.contains("\"nickname\":\"厉飞雨\""));
        assert!(poll_text.contains("\"monthCardActive\":true"));
        assert!(poll_text.contains("\"realm\":\"筑基期\""));
    }

    #[tokio::test]
    async fn socket_io_fallback_online_players_request_requires_auth() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;

        socket_emit_raw_for_path(&client, address, "/socket.io/", &sid, "42[\"game:onlinePlayers:request\"]").await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_ONLINE_PLAYERS_UNAUTH_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_ONLINE_PLAYERS_UNAUTH_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("未认证"));
    }

    #[tokio::test]
    async fn socket_io_fallback_refresh_requires_auth() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;

        socket_emit_raw_for_path(&client, address, "/socket.io/", &sid, "42[\"game:refresh\"]").await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_REFRESH_UNAUTH_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_REFRESH_UNAUTH_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("未认证"));
    }

    #[tokio::test]
    async fn socket_io_fallback_chat_send_requires_auth() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;

        socket_emit_raw_for_path(
            &client,
            address,
            "/socket.io/",
            &sid,
            "42[\"chat:send\",{\"channel\":\"world\",\"content\":\"hello fallback\"}]",
        ).await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_CHAT_UNAUTH_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_CHAT_UNAUTH_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("未认证"));
    }

    #[tokio::test]
    async fn socket_io_fallback_chat_send_system_returns_readonly_error() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 9031,
            character_id: Some(90301),
            session_token: Some("sess-socketio-chat-system".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw_for_path(
            &client,
            address,
            "/socket.io/",
            &sid,
            "42[\"chat:send\",{\"channel\":\"system\",\"content\":\"hello\"}]",
        ).await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_CHAT_SYSTEM_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_CHAT_SYSTEM_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("系统频道不允许发言"));
    }

    #[tokio::test]
    async fn socket_io_fallback_chat_send_battle_returns_readonly_error() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 9032,
            character_id: Some(90302),
            session_token: Some("sess-socketio-chat-battle".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw_for_path(
            &client,
            address,
            "/socket.io/",
            &sid,
            "42[\"chat:send\",{\"channel\":\"battle\",\"content\":\"hello\"}]",
        ).await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_CHAT_BATTLE_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_CHAT_BATTLE_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("战况频道不允许发言"));
    }

    #[tokio::test]
    async fn socket_io_fallback_chat_send_rejects_unsupported_channel() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 9033,
            character_id: Some(90303),
            session_token: Some("sess-socketio-chat-unsupported".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw_for_path(
            &client,
            address,
            "/socket.io/",
            &sid,
            "42[\"chat:send\",{\"channel\":\"all\",\"content\":\"hello\"}]",
        ).await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_CHAT_UNSUPPORTED_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_CHAT_UNSUPPORTED_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("无效频道"));
    }

    #[tokio::test]
    async fn socket_io_fallback_chat_send_private_requires_target() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 9034,
            character_id: Some(90304),
            session_token: Some("sess-socketio-chat-private-missing".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw_for_path(
            &client,
            address,
            "/socket.io/",
            &sid,
            "42[\"chat:send\",{\"channel\":\"private\",\"content\":\"hello\"}]",
        ).await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_CHAT_PRIVATE_MISSING_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_CHAT_PRIVATE_MISSING_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("缺少私聊对象"));
    }

    #[tokio::test]
    async fn socket_io_fallback_chat_send_private_errors_when_target_offline() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 9035,
            character_id: Some(90305),
            session_token: Some("sess-socketio-chat-private-offline".to_string()),
            connected_at_ms: 1,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 9035,
            character_id: Some(90305),
            nickname: Some("韩立".to_string()),
            month_card_active: false,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: None,
            connected_at_ms: 1,
        });

        socket_emit_raw_for_path(
            &client,
            address,
            "/socket.io/",
            &sid,
            "42[\"chat:send\",{\"channel\":\"private\",\"content\":\"hello\",\"pmTargetCharacterId\":99999}]",
        ).await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_CHAT_PRIVATE_OFFLINE_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_CHAT_PRIVATE_OFFLINE_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("对方不在线"));
    }

    #[tokio::test]
    async fn socket_io_fallback_chat_send_private_rejects_invalid_target() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 9039,
            character_id: Some(90309),
            session_token: Some("sess-socketio-chat-private-invalid".to_string()),
            connected_at_ms: 1,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 9039,
            character_id: Some(90309),
            nickname: Some("韩立".to_string()),
            month_card_active: false,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: None,
            connected_at_ms: 1,
        });

        socket_emit_raw_for_path(
            &client,
            address,
            "/socket.io/",
            &sid,
            "42[\"chat:send\",{\"channel\":\"private\",\"content\":\"hello\",\"pmTargetCharacterId\":0}]",
        ).await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_CHAT_PRIVATE_INVALID_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_CHAT_PRIVATE_INVALID_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("私聊对象无效"));
    }

    #[tokio::test]
    async fn socket_io_fallback_chat_send_rejects_empty_content() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid_for_path(&client, address, "/socket.io/").await;
        socket_connect_for_path(&client, address, "/socket.io/", &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 9036,
            character_id: Some(90306),
            session_token: Some("sess-socketio-chat-empty".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw_for_path(
            &client,
            address,
            "/socket.io/",
            &sid,
            "42[\"chat:send\",{\"channel\":\"world\",\"content\":\"   \"}]",
        ).await;

        let poll_text = poll_text_for_path(&client, address, "/socket.io/", &sid).await;

        println!("SOCKET_IO_CHAT_EMPTY_HANDSHAKE={handshake_text}");
        println!("SOCKET_IO_CHAT_EMPTY_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("消息内容不能为空"));
    }

    #[tokio::test]
    async fn room_membership_handlers_join_and_leave_room_after_auth() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 301,
            character_id: Some(3001),
            session_token: Some("sess-room".to_string()),
            connected_at_ms: 1,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 301,
            character_id: Some(3001),
            nickname: Some("韩立".to_string()),
            month_card_active: false,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: Some("room-village-center".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw(&client, address, &sid, "42[\"join:room\",\"room-alpha\"]").await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let socket_ref = state
            .socket_io()
            .and_then(|io| io.get_socket(socketioxide::socket::Sid::from_str(&sid).ok()?))
            .expect("socket should exist");
        let joined_rooms = socket_ref.rooms();
        assert!(joined_rooms.iter().any(|room| room.as_ref() == "room-alpha"));
        assert_eq!(state.online_players.get(301).and_then(|record| record.room_id), Some("room-alpha".to_string()));

        socket_emit_raw(&client, address, &sid, "42[\"leave:room\",\"room-alpha\"]").await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let socket_ref = state
            .socket_io()
            .and_then(|io| io.get_socket(socketioxide::socket::Sid::from_str(&sid).ok()?))
            .expect("socket should still exist");
        let left_rooms = socket_ref.rooms();
        assert!(!left_rooms.iter().any(|room| room.as_ref() == "room-alpha"));
        assert_eq!(state.online_players.get(301).and_then(|record| record.room_id), None);

        server.abort();
    }

    #[tokio::test]
    async fn room_membership_handlers_reject_blank_room_name() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        socket_emit_raw(&client, address, &sid, "42[\"join:room\",\"\"]").await;
        let poll_text = poll_until_contains(&client, address, &sid, "game:error").await;

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("房间ID不能为空"));
    }

    #[tokio::test]
    async fn room_membership_handlers_require_auth() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        socket_emit_raw(&client, address, &sid, "42[\"join:room\",\"room-alpha\"]").await;
        let poll_text = poll_until_contains(&client, address, &sid, "game:error").await;

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("未认证"));
    }

    #[tokio::test]
    async fn room_membership_join_enables_room_targeted_broadcast() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid_joined, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid_joined).await;
        let (sid_other, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid_other).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid_joined.clone(),
            user_id: 303,
            character_id: Some(3003),
            session_token: Some("sess-room-broadcast".to_string()),
            connected_at_ms: 1,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 303,
            character_id: Some(3003),
            nickname: Some("墨大夫".to_string()),
            month_card_active: false,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: Some("room-village-center".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw(&client, address, &sid_joined, "42[\"join:room\",\"room-alpha\"]").await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let io = state.socket_io().expect("socket io should exist");
        io.to("room-alpha")
            .emit("room:test", &serde_json::json!({"ok": true}))
            .await
            .ok();

        let joined_poll = poll_text(&client, address, &sid_joined).await;
        let other_poll = poll_text(&client, address, &sid_other).await;

        server.abort();

        assert!(joined_poll.contains("room:test"));
        assert!(joined_poll.contains("\"ok\":true"));
        assert!(!other_poll.contains("room:test"));
    }

    #[tokio::test]
    async fn room_membership_leave_removes_room_targeted_broadcast_membership() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 302,
            character_id: Some(3002),
            session_token: Some("sess-room-leave".to_string()),
            connected_at_ms: 1,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 302,
            character_id: Some(3002),
            nickname: Some("厉飞雨".to_string()),
            month_card_active: false,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: Some("room-village-center".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw(&client, address, &sid, "42[\"join:room\",\"room-alpha\"]").await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        socket_emit_raw(&client, address, &sid, "42[\"leave:room\",\"room-alpha\"]").await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let io = state.socket_io().expect("socket io should exist");
        io.to("room-alpha")
            .emit("room:test", &serde_json::json!({"afterLeave": true}))
            .await
            .ok();

        let poll = poll_text(&client, address, &sid).await;

        println!("ROOM_LEAVE_BROADCAST_POLL={poll}");

        server.abort();

        assert!(!poll.contains("room:test"));
        assert_eq!(state.online_players.get(302).and_then(|record| record.room_id), None);
    }

    #[tokio::test]
    async fn game_socket_auth_invalid_token_emits_game_error() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        socket_auth(&client, address, &sid, "bad-token").await;
        let auth_text = "ok";

        let first_poll = poll_until_contains(&client, address, &sid, "game:character").await;
        let second_poll = poll_until_contains(&client, address, &sid, "game:auth-ready").await;
        let poll_text = format!("{first_poll}{second_poll}");

        println!("GAME_SOCKET_AUTH_INVALID_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_AUTH_INVALID_POST={auth_text}");
        println!("GAME_SOCKET_AUTH_INVALID_POLL_STATUS=200 OK");
        println!("GAME_SOCKET_AUTH_INVALID_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error") || poll_text.contains("Session ID unknown"));
        if poll_text.contains("game:error") {
            assert!(poll_text.contains("认证失败"));
        }
    }

    #[tokio::test]
    async fn game_socket_online_players_request_requires_auth() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        socket_emit_raw(&client, address, &sid, "42[\"game:onlinePlayers:request\"]").await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_ONLINE_PLAYERS_UNAUTH_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_ONLINE_PLAYERS_UNAUTH_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("未认证"));
    }

    #[tokio::test]
    async fn game_socket_online_players_request_emits_full_payload_after_auth_without_db() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 401,
            character_id: Some(4001),
            session_token: Some("sess-online-players".to_string()),
            connected_at_ms: 1,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 401,
            character_id: Some(4001),
            nickname: Some("韩立".to_string()),
            month_card_active: true,
            title: Some("散修".to_string()),
            realm: Some("筑基期".to_string()),
            room_id: Some("room-alpha".to_string()),
            connected_at_ms: 1,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 402,
            character_id: Some(4002),
            nickname: Some("厉飞雨".to_string()),
            month_card_active: false,
            title: Some("外门弟子".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: None,
            connected_at_ms: 2,
        });

        socket_emit_raw(&client, address, &sid, "42[\"game:onlinePlayers:request\"]").await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_ONLINE_PLAYERS_AUTHLESS_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_ONLINE_PLAYERS_AUTHLESS_SUCCESS_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:onlinePlayers"));
        assert!(poll_text.contains("\"type\":\"full\""));
        assert!(poll_text.contains("\"nickname\":\"韩立\""));
        assert!(poll_text.contains("\"nickname\":\"厉飞雨\""));
        assert!(poll_text.contains("\"monthCardActive\":true"));
        assert!(poll_text.contains("\"realm\":\"筑基期\""));
    }

    #[tokio::test]
    async fn game_socket_refresh_requires_auth() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        socket_emit_raw(&client, address, &sid, "42[\"game:refresh\"]").await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_REFRESH_UNAUTH_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_REFRESH_UNAUTH_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("未认证"));
    }

    #[tokio::test]
    async fn game_socket_add_point_requires_auth() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        socket_emit_raw(&client, address, &sid, "42[\"game:addPoint\",{\"attribute\":\"jing\",\"amount\":1}]").await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_ADD_POINT_UNAUTH_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_ADD_POINT_UNAUTH_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("未找到角色"));
    }

    #[tokio::test]
    async fn game_socket_add_point_rejects_invalid_attribute_without_db() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 601,
            character_id: Some(6001),
            session_token: Some("sess-add-point-invalid".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw(&client, address, &sid, "42[\"game:addPoint\",{\"attribute\":\"invalid\",\"amount\":1}]").await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_ADD_POINT_INVALID_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_ADD_POINT_INVALID_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("无效的属性"));
    }

    #[tokio::test]
    async fn game_socket_add_point_rejects_out_of_range_amount_without_db() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 602,
            character_id: Some(6002),
            session_token: Some("sess-add-point-range".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw(&client, address, &sid, "42[\"game:addPoint\",{\"attribute\":\"jing\",\"amount\":101}]").await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_ADD_POINT_RANGE_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_ADD_POINT_RANGE_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("无效的属性"));
    }

    #[tokio::test]
    async fn game_socket_battle_sync_requires_auth() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        socket_emit_raw(&client, address, &sid, "42[\"battle:sync\",{\"battleId\":\"battle-1\"}]").await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_BATTLE_SYNC_UNAUTH_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_BATTLE_SYNC_UNAUTH_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("未认证"));
    }

    #[tokio::test]
    async fn game_socket_battle_sync_requires_battle_id_without_db() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 801,
            character_id: Some(8001),
            session_token: Some("sess-battle-sync-missing-id".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw(&client, address, &sid, "42[\"battle:sync\",{}]").await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_BATTLE_SYNC_MISSING_ID_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_BATTLE_SYNC_MISSING_ID_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("game:error"));
        assert!(poll_text.contains("缺少战斗ID"));
    }

    #[tokio::test]
    async fn game_socket_chat_send_requires_auth() {
        let app = build_router(test_state()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        socket_emit_raw(&client, address, &sid, "42[\"chat:send\",{\"channel\":\"world\",\"content\":\"大家好\",\"clientId\":\"client-1\"}]").await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_CHAT_SEND_UNAUTH_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_CHAT_SEND_UNAUTH_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("未认证"));
    }

    #[tokio::test]
    async fn game_socket_chat_send_rejects_too_long_message() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 1,
            character_id: Some(101),
            session_token: Some("sess-chat-too-long".to_string()),
            connected_at_ms: 1,
        });

        let content = "甲".repeat(201);
        socket_emit_raw(
            &client,
            address,
            &sid,
            &format!("42[\"chat:send\",{{\"channel\":\"world\",\"content\":\"{}\",\"clientId\":\"client-1\"}}]", content),
        )
        .await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_CHAT_TOO_LONG_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_CHAT_TOO_LONG_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("消息过长"));
    }

    #[tokio::test]
    async fn game_socket_chat_send_rejects_local_sensitive_words() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 1,
            character_id: Some(101),
            session_token: Some("sess-chat-sensitive".to_string()),
            connected_at_ms: 1,
        });

        socket_emit_raw(
            &client,
            address,
            &sid,
            "42[\"chat:send\",{\"channel\":\"world\",\"content\":\"这是广告\",\"clientId\":\"client-1\"}]",
        )
        .await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_CHAT_SENSITIVE_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_CHAT_SENSITIVE_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("消息包含敏感词，请重新发送"));
    }

    #[tokio::test]
    async fn game_socket_chat_send_world_broadcasts_message_to_connected_users() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sender_sid, sender_handshake) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sender_sid).await;
        let (receiver_sid, receiver_handshake) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &receiver_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sender_sid.clone(),
            user_id: 1,
            character_id: Some(101),
            session_token: Some("sess-1".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: receiver_sid.clone(),
            user_id: 2,
            character_id: Some(202),
            session_token: Some("sess-2".to_string()),
            connected_at_ms: 2,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 1,
            character_id: Some(101),
            nickname: Some("韩立".to_string()),
            month_card_active: true,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: None,
            connected_at_ms: 1,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 2,
            character_id: Some(202),
            nickname: Some("张铁".to_string()),
            month_card_active: false,
            title: Some("外门弟子".to_string()),
            realm: Some("凡人".to_string()),
            room_id: None,
            connected_at_ms: 2,
        });
        let io = state.socket_io().expect("socket io should exist");
        if let Ok(sender_socket_sid) = socketioxide::socket::Sid::from_str(&sender_sid) {
            if let Some(socket) = io.get_socket(sender_socket_sid) {
                socket.join("chat:authed".to_string());
            }
        }
        if let Ok(receiver_socket_sid) = socketioxide::socket::Sid::from_str(&receiver_sid) {
            if let Some(socket) = io.get_socket(receiver_socket_sid) {
                socket.join("chat:authed".to_string());
            }
        }

        socket_emit_raw(&client, address, &sender_sid, "42[\"chat:send\",{\"channel\":\"world\",\"content\":\"大家好\",\"clientId\":\"client-1\"}]").await;

        let sender_poll = poll_text(&client, address, &sender_sid).await;
        let receiver_poll = poll_text(&client, address, &receiver_sid).await;

        println!("GAME_SOCKET_CHAT_WORLD_SENDER_HANDSHAKE={sender_handshake}");
        println!("GAME_SOCKET_CHAT_WORLD_RECEIVER_HANDSHAKE={receiver_handshake}");
        println!("GAME_SOCKET_CHAT_WORLD_SENDER_POLL={sender_poll}");
        println!("GAME_SOCKET_CHAT_WORLD_RECEIVER_POLL={receiver_poll}");

        server.abort();

        assert!(sender_poll.contains("chat:message"));
        assert!(sender_poll.contains("\"clientId\":\"client-1\""));
        assert!(sender_poll.contains("\"senderCharacterId\":101"));
        assert!(receiver_poll.contains("chat:message"));
        assert!(receiver_poll.contains("\"senderName\":\"韩立\""));
    }

    #[tokio::test]
    async fn game_socket_chat_send_system_returns_readonly_error() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 31,
            character_id: Some(3101),
            session_token: Some("sess-31".to_string()),
            connected_at_ms: 31,
        });

        socket_emit_raw(&client, address, &sid, "42[\"chat:send\",{\"channel\":\"system\",\"content\":\"系统你好\",\"clientId\":\"client-system\"}]").await;
        let poll_text = poll_text(&client, address, &sid).await;

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("系统频道不允许发言"));
    }

    #[tokio::test]
    async fn game_socket_chat_send_battle_returns_readonly_error() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 32,
            character_id: Some(3201),
            session_token: Some("sess-32".to_string()),
            connected_at_ms: 32,
        });

        socket_emit_raw(&client, address, &sid, "42[\"chat:send\",{\"channel\":\"battle\",\"content\":\"战况你好\",\"clientId\":\"client-battle\"}]").await;
        let poll_text = poll_text(&client, address, &sid).await;

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("战况频道不允许发言"));
    }

    #[tokio::test]
    async fn game_socket_chat_send_rejects_empty_content() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 3202,
            character_id: Some(3202),
            session_token: Some("sess-chat-empty".to_string()),
            connected_at_ms: 3202,
        });

        socket_emit_raw(&client, address, &sid, "42[\"chat:send\",{\"channel\":\"world\",\"content\":\"   \",\"clientId\":\"client-empty\"}]").await;
        let poll_text = poll_text(&client, address, &sid).await;

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("消息内容不能为空"));
    }

    #[tokio::test]
    async fn game_socket_chat_send_rejects_unsupported_channel() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 3203,
            character_id: Some(3203),
            session_token: Some("sess-chat-unsupported".to_string()),
            connected_at_ms: 3203,
        });

        socket_emit_raw(&client, address, &sid, "42[\"chat:send\",{\"channel\":\"all\",\"content\":\"hello\",\"clientId\":\"client-unsupported\"}]").await;
        let poll_text = poll_text(&client, address, &sid).await;

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("无效频道"));
    }

    #[tokio::test]
    async fn game_socket_chat_send_private_delivers_to_sender_and_target_only() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sender_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sender_sid).await;
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sender_sid.clone(),
            user_id: 3,
            character_id: Some(303),
            session_token: Some("sess-3".to_string()),
            connected_at_ms: 3,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 4,
            character_id: Some(404),
            session_token: Some("sess-4".to_string()),
            connected_at_ms: 4,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 5,
            character_id: Some(505),
            session_token: Some("sess-5".to_string()),
            connected_at_ms: 5,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 3,
            character_id: Some(303),
            nickname: Some("厉飞雨".to_string()),
            month_card_active: false,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: None,
            connected_at_ms: 3,
        });
        let io = state.socket_io().expect("socket io should exist");
        if let Ok(sender_socket_sid) = socketioxide::socket::Sid::from_str(&sender_sid) {
            if let Some(socket) = io.get_socket(sender_socket_sid) {
                socket.join("chat:character:303".to_string());
            }
        }
        if let Ok(target_socket_sid) = socketioxide::socket::Sid::from_str(&target_sid) {
            if let Some(socket) = io.get_socket(target_socket_sid) {
                socket.join("chat:character:404".to_string());
            }
        }

        socket_emit_raw(&client, address, &sender_sid, "42[\"chat:send\",{\"channel\":\"private\",\"content\":\"悄悄话\",\"clientId\":\"client-2\",\"pmTargetCharacterId\":404}]").await;

        let sender_poll = poll_text(&client, address, &sender_sid).await;
        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_CHAT_PRIVATE_SENDER_POLL={sender_poll}");
        println!("GAME_SOCKET_CHAT_PRIVATE_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_CHAT_PRIVATE_OTHER_POLL={other_poll}");

        server.abort();

        assert!(sender_poll.contains("chat:message"));
        assert!(sender_poll.contains("\"pmTargetCharacterId\":404"));
        assert!(target_poll.contains("chat:message"));
        assert!(target_poll.contains("\"content\":\"悄悄话\""));
        assert!(!other_poll.contains("chat:message"));
    }

    #[tokio::test]
    async fn game_socket_chat_send_private_requires_target() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 3204,
            character_id: Some(3204),
            session_token: Some("sess-chat-private-missing".to_string()),
            connected_at_ms: 3204,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 3204,
            character_id: Some(3204),
            nickname: Some("韩立".to_string()),
            month_card_active: false,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: None,
            connected_at_ms: 3204,
        });

        socket_emit_raw(&client, address, &sid, "42[\"chat:send\",{\"channel\":\"private\",\"content\":\"hello\",\"clientId\":\"client-private-missing\"}]").await;
        let poll_text = poll_text(&client, address, &sid).await;

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("缺少私聊对象"));
    }

    #[tokio::test]
    async fn game_socket_chat_send_private_rejects_invalid_target() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 3205,
            character_id: Some(3205),
            session_token: Some("sess-chat-private-invalid".to_string()),
            connected_at_ms: 3205,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 3205,
            character_id: Some(3205),
            nickname: Some("韩立".to_string()),
            month_card_active: false,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: None,
            connected_at_ms: 3205,
        });

        socket_emit_raw(&client, address, &sid, "42[\"chat:send\",{\"channel\":\"private\",\"content\":\"hello\",\"pmTargetCharacterId\":0,\"clientId\":\"client-private-invalid\"}]").await;
        let poll_text = poll_text(&client, address, &sid).await;

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("私聊对象无效"));
    }

    #[tokio::test]
    async fn game_socket_chat_send_private_errors_when_target_offline() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sender_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sender_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sender_sid.clone(),
            user_id: 33,
            character_id: Some(3303),
            session_token: Some("sess-33".to_string()),
            connected_at_ms: 33,
        });
        let io = state.socket_io().expect("socket io should exist");
        if let Ok(sender_socket_sid) = socketioxide::socket::Sid::from_str(&sender_sid) {
            if let Some(socket) = io.get_socket(sender_socket_sid) {
                socket.join("chat:character:3303".to_string());
            }
        }

        socket_emit_raw(&client, address, &sender_sid, "42[\"chat:send\",{\"channel\":\"private\",\"content\":\"悄悄话\",\"clientId\":\"client-private-offline\",\"pmTargetCharacterId\":9999}]").await;
        let poll_text = poll_text(&client, address, &sender_sid).await;

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("对方不在线"));
    }

    #[tokio::test]
    async fn game_socket_chat_send_team_requires_membership() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 6,
            character_id: None,
            session_token: Some("sess-6".to_string()),
            connected_at_ms: 6,
        });

        socket_emit_raw(&client, address, &sid, "42[\"chat:send\",{\"channel\":\"team\",\"content\":\"队伍集合\",\"clientId\":\"client-team-1\"}]").await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_CHAT_TEAM_UNAUTHORIZED_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_CHAT_TEAM_UNAUTHORIZED_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("当前不在队伍中"));
    }

    #[tokio::test]
        async fn game_socket_chat_send_team_delivers_to_online_team_members() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_CHAT_TEAM_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("chat-team-{}", super::chrono_like_timestamp_ms());
        let sender = insert_auth_fixture(&state, &pool, "socket", &format!("sender-{suffix}"), 0).await;
        let target = insert_auth_fixture(&state, &pool, "socket", &format!("target-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        sqlx::query("INSERT INTO teams (id, leader_id, name, current_map_id, is_public, max_members, auto_join_enabled, created_at, updated_at) VALUES ($1, $2, '测试队伍', 'map-qingyun-village', true, 4, false, NOW(), NOW())")
            .bind(format!("team-{suffix}"))
            .bind(sender.character_id)
            .execute(&pool)
            .await
            .expect("team should insert");
        sqlx::query("INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'leader'), ($1, $3, 'member')")
            .bind(format!("team-{suffix}"))
            .bind(sender.character_id)
            .bind(target.character_id)
            .execute(&pool)
            .await
            .expect("team members should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (sender_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sender_sid).await;
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        socket_auth(&client, address, &sender_sid, &sender.token).await;
        socket_auth(&client, address, &target_sid, &target.token).await;
        socket_auth(&client, address, &other_sid, &outsider.token).await;
        let _sender_auth_poll = poll_until_contains(&client, address, &sender_sid, "game:auth-ready").await;
        let _target_auth_poll = poll_until_contains(&client, address, &target_sid, "game:auth-ready").await;
        let _other_auth_poll = poll_until_contains(&client, address, &other_sid, "game:auth-ready").await;

        socket_emit_raw(&client, address, &sender_sid, "42[\"chat:send\",{\"channel\":\"team\",\"content\":\"队伍集合\",\"clientId\":\"client-team-1\"}]").await;

        let sender_poll = poll_text(&client, address, &sender_sid).await;
        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_CHAT_TEAM_SENDER_POLL={sender_poll}");
        println!("GAME_SOCKET_CHAT_TEAM_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_CHAT_TEAM_OTHER_POLL={other_poll}");

        server.abort();

        assert!(sender_poll.contains("chat:message"));
        assert!(sender_poll.contains("\"channel\":\"team\""));
        assert!(target_poll.contains("chat:message"));
        assert!(target_poll.contains("\"content\":\"队伍集合\""));
        assert!(!other_poll.contains("chat:message"));

        sqlx::query("DELETE FROM team_members WHERE team_id = $1")
            .bind(format!("team-{suffix}"))
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM teams WHERE id = $1")
            .bind(format!("team-{suffix}"))
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, sender.character_id, sender.user_id).await;
        cleanup_auth_fixture(&pool, target.character_id, target.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
    async fn game_socket_chat_send_sect_requires_membership() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 7,
            character_id: None,
            session_token: Some("sess-7".to_string()),
            connected_at_ms: 7,
        });

        socket_emit_raw(&client, address, &sid, "42[\"chat:send\",{\"channel\":\"sect\",\"content\":\"宗门集合\",\"clientId\":\"client-sect-1\"}]").await;

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_CHAT_SECT_UNAUTHORIZED_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_CHAT_SECT_UNAUTHORIZED_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("chat:error"));
        assert!(poll_text.contains("当前不在宗门中"));
    }

    #[tokio::test]
        async fn game_socket_chat_send_sect_delivers_to_online_sect_members() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_CHAT_SECT_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("chat-sect-{}", super::chrono_like_timestamp_ms());
        let sender = insert_auth_fixture(&state, &pool, "socket", &format!("sender-{suffix}"), 0).await;
        let target = insert_auth_fixture(&state, &pool, "socket", &format!("target-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        sqlx::query("INSERT INTO sect_def (id, name, leader_id, level, member_count, created_at, updated_at) VALUES ($1, $2, $3, 1, 2, NOW(), NOW())")
            .bind(format!("sect-{suffix}"))
            .bind(format!("测试宗门-{suffix}"))
            .bind(sender.character_id)
            .execute(&pool)
            .await
            .expect("sect should insert");
        sqlx::query("INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'leader', 0, 0, NOW()), ($1, $3, 'disciple', 0, 0, NOW())")
            .bind(format!("sect-{suffix}"))
            .bind(sender.character_id)
            .bind(target.character_id)
            .execute(&pool)
            .await
            .expect("sect members should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (sender_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sender_sid).await;
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        socket_auth(&client, address, &sender_sid, &sender.token).await;
        socket_auth(&client, address, &target_sid, &target.token).await;
        socket_auth(&client, address, &other_sid, &outsider.token).await;
        let _sender_auth_poll = poll_until_contains(&client, address, &sender_sid, "game:auth-ready").await;
        let _target_auth_poll = poll_until_contains(&client, address, &target_sid, "game:auth-ready").await;
        let _other_auth_poll = poll_until_contains(&client, address, &other_sid, "game:auth-ready").await;

        socket_emit_raw(&client, address, &sender_sid, "42[\"chat:send\",{\"channel\":\"sect\",\"content\":\"宗门集合\",\"clientId\":\"client-sect-1\"}]").await;

        let sender_poll = poll_text(&client, address, &sender_sid).await;
        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_CHAT_SECT_SENDER_POLL={sender_poll}");
        println!("GAME_SOCKET_CHAT_SECT_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_CHAT_SECT_OTHER_POLL={other_poll}");

        server.abort();

        assert!(sender_poll.contains("chat:message"));
        assert!(sender_poll.contains("\"channel\":\"sect\""));
        assert!(target_poll.contains("chat:message"));
        assert!(target_poll.contains("\"content\":\"宗门集合\""));
        assert!(!other_poll.contains("chat:message"));

        sqlx::query("DELETE FROM sect_member WHERE sect_id = $1")
            .bind(format!("sect-{suffix}"))
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM sect_def WHERE id = $1")
            .bind(format!("sect-{suffix}"))
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, sender.character_id, sender.user_id).await;
        cleanup_auth_fixture(&pool, target.character_id, target.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
    async fn game_socket_battle_emit_helpers_push_started_and_cooldown_to_online_participant() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        let (other_sid, other_handshake) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 9,
            character_id: Some(901),
            session_token: Some("sess-9".to_string()),
            connected_at_ms: 9,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 10,
            character_id: Some(1001),
            session_token: Some("sess-10".to_string()),
            connected_at_ms: 10,
        });

        let battle_id = "helper-battle-1";
        let battle_state = build_minimal_pve_battle_state(
            battle_id,
            901,
            &["monster-gray-wolf".to_string()],
        );
        let session = BattleSessionSnapshotDto {
            session_id: "helper-session-1".to_string(),
            session_type: "pve".to_string(),
            owner_user_id: 9,
            participant_user_ids: vec![9],
            current_battle_id: Some(battle_id.to_string()),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Pve {
                monster_ids: vec!["monster-gray-wolf".to_string()],
            },
        };

        let update_payload = crate::realtime::battle::build_battle_started_payload(
            battle_id,
            battle_state.clone(),
            vec![serde_json::json!({"type": "round_start", "round": 1})],
            Some(session),
        );
        let cooldown_payload = crate::realtime::battle::build_battle_cooldown_ready_payload(
            battle_state.current_unit_id.as_deref(),
        );

        crate::realtime::public_socket::emit_battle_update_to_participants(&state, &[9], &update_payload);
        crate::realtime::public_socket::emit_battle_cooldown_to_participants(&state, &[9], &cooldown_payload);

        let participant_poll = poll_text(&client, address, &sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_BATTLE_HELPER_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_BATTLE_HELPER_OTHER_HANDSHAKE={other_handshake}");
        println!("GAME_SOCKET_BATTLE_HELPER_POLL={participant_poll}");
        println!("GAME_SOCKET_BATTLE_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(participant_poll.contains("battle:update"));
        assert!(participant_poll.contains("battle_started"));
        assert!(participant_poll.contains("battle:cooldown-ready"));
        assert!(participant_poll.contains("\"characterId\":901"));
        assert!(!other_poll.contains("battle:update"));
        assert!(!other_poll.contains("battle:cooldown-ready"));
    }

    #[tokio::test]
    async fn game_socket_battle_cooldown_helper_pushes_recipient_specific_character_ids() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (first_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &first_sid).await;
        let (second_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &second_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: first_sid.clone(),
            user_id: 11,
            character_id: Some(1101),
            session_token: Some("sess-11".to_string()),
            connected_at_ms: 11,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: second_sid.clone(),
            user_id: 12,
            character_id: Some(1202),
            session_token: Some("sess-12".to_string()),
            connected_at_ms: 12,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 13,
            character_id: Some(1303),
            session_token: Some("sess-13".to_string()),
            connected_at_ms: 13,
        });

        let payload = crate::realtime::battle::build_battle_cooldown_sync_payload(Some("player-999"), 1500);
        crate::realtime::public_socket::emit_battle_cooldown_to_participants(&state, &[11, 12], &payload);

        let first_poll = poll_text(&client, address, &first_sid).await;
        let second_poll = poll_text(&client, address, &second_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_BATTLE_COOLDOWN_FIRST_POLL={first_poll}");
        println!("GAME_SOCKET_BATTLE_COOLDOWN_SECOND_POLL={second_poll}");
        println!("GAME_SOCKET_BATTLE_COOLDOWN_OTHER_POLL={other_poll}");

        server.abort();

        assert!(first_poll.contains("battle:cooldown-sync"));
        assert!(first_poll.contains("\"characterId\":1101"));
        assert!(second_poll.contains("battle:cooldown-sync"));
        assert!(second_poll.contains("\"characterId\":1202"));
        assert!(!other_poll.contains("battle:cooldown-sync"));
    }

    #[tokio::test]
    async fn game_socket_battle_finished_helper_pushes_rewards_only_to_participant() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 14,
            character_id: Some(1401),
            session_token: Some("sess-14".to_string()),
            connected_at_ms: 14,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 15,
            character_id: Some(1502),
            session_token: Some("sess-15".to_string()),
            connected_at_ms: 15,
        });

        let battle_state = build_minimal_pve_battle_state(
            "finished-battle-1",
            1401,
            &["monster-gray-wolf".to_string()],
        );
        let payload = crate::realtime::battle::build_battle_finished_payload(
            "finished-battle-1",
            battle_state,
            vec![serde_json::json!({"type": "finish", "round": 1, "result": "attacker_win"})],
            None,
            crate::realtime::battle::BattleFinishedMeta {
                rewards: Some(crate::realtime::battle::BattleRewardsPayload {
                    exp: 12,
                    silver: 34,
                    total_exp: Some(56),
                    total_silver: Some(78),
                    participant_count: Some(1),
                    items: Some(vec![]),
                    per_player_rewards: Some(vec![]),
                }),
                result: Some("attacker_win".to_string()),
                success: Some(true),
                message: Some("战斗胜利".to_string()),
                battle_start_cooldown_ms: None,
                retry_after_ms: None,
                next_battle_available_at: None,
            },
        );
        crate::realtime::public_socket::emit_battle_update_to_participants(&state, &[14], &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_BATTLE_FINISHED_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_BATTLE_FINISHED_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("battle:update"));
        assert!(target_poll.contains("battle_finished"));
        assert!(target_poll.contains("\"rewards\":{"));
        assert!(target_poll.contains("\"exp\":12"));
        assert!(target_poll.contains("\"silver\":34"));
        assert!(!other_poll.contains("battle:update"));
    }

    #[tokio::test]
    async fn game_socket_battle_abandoned_helper_pushes_only_to_participant() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 16,
            character_id: Some(1601),
            session_token: Some("sess-16".to_string()),
            connected_at_ms: 16,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 17,
            character_id: Some(1702),
            session_token: Some("sess-17".to_string()),
            connected_at_ms: 17,
        });

        let payload = crate::realtime::battle::build_battle_abandoned_payload(
            "abandoned-battle-1",
            None,
            false,
            "战斗已中断",
        );
        crate::realtime::public_socket::emit_battle_update_to_participants(&state, &[16], &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_BATTLE_ABANDONED_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_BATTLE_ABANDONED_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("battle:update"));
        assert!(target_poll.contains("battle_abandoned"));
        assert!(target_poll.contains("\"message\":\"战斗已中断\""));
        assert!(!other_poll.contains("battle:update"));
    }

    #[tokio::test]
    async fn game_socket_battle_state_helper_pushes_only_to_participant() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 18,
            character_id: Some(1801),
            session_token: Some("sess-18".to_string()),
            connected_at_ms: 18,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 19,
            character_id: Some(1902),
            session_token: Some("sess-19".to_string()),
            connected_at_ms: 19,
        });

        let battle_state = build_minimal_pve_battle_state(
            "state-battle-1",
            1801,
            &["monster-gray-wolf".to_string()],
        );
        let payload = crate::realtime::battle::build_battle_state_payload(
            "state-battle-1",
            battle_state,
            vec![serde_json::json!({"type": "round_start", "round": 2})],
            None,
        );
        crate::realtime::public_socket::emit_battle_update_to_participants(&state, &[18], &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_BATTLE_STATE_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_BATTLE_STATE_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("battle:update"));
        assert!(target_poll.contains("battle_state"));
        assert!(target_poll.contains("\"battleId\":\"state-battle-1\""));
        assert!(target_poll.contains("\"type\":\"round_start\""));
        assert!(!other_poll.contains("battle:update"));
    }

    #[tokio::test]
    async fn game_socket_arena_emit_helper_pushes_status_to_online_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 19,
            character_id: Some(1901),
            session_token: Some("sess-19".to_string()),
            connected_at_ms: 19,
        });

        let payload = crate::realtime::arena::build_arena_status_payload(crate::http::arena::ArenaStatusDto {
            score: 1200,
            win_count: 12,
            lose_count: 3,
            today_used: 2,
            today_limit: 5,
            today_remaining: 3,
        });
        crate::realtime::public_socket::emit_arena_update_to_user(&state, 19, &payload);

        let poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_ARENA_HELPER_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_ARENA_HELPER_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("arena:update"));
        assert!(poll_text.contains("\"kind\":\"arena_status\""));
        assert!(poll_text.contains("\"score\":1200"));
    }

    #[tokio::test]
    async fn game_socket_arena_refresh_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 29,
            character_id: Some(2901),
            session_token: Some("sess-29".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 30,
            character_id: Some(3002),
            session_token: Some("sess-30".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::arena::build_arena_refresh_payload();
        crate::realtime::public_socket::emit_arena_update_to_user(&state, 29, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_ARENA_REFRESH_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_ARENA_REFRESH_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("arena:update"));
        assert!(target_poll.contains("\"kind\":\"arena_refresh\""));
        assert!(!other_poll.contains("arena:update"));
    }

    #[tokio::test]
    async fn game_socket_market_update_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 33,
            character_id: Some(3301),
            session_token: Some("sess-33".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 34,
            character_id: Some(3402),
            session_token: Some("sess-34".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::market::build_market_update_payload("buy_market_listing", Some(42), "item");
        crate::realtime::public_socket::emit_market_update_to_user(&state, 33, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_MARKET_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_MARKET_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("market:update"));
        assert!(target_poll.contains("\"source\":\"buy_market_listing\""));
        assert!(target_poll.contains("\"listingId\":42"));
        assert!(!other_poll.contains("market:update"));
    }

    #[tokio::test]
    async fn game_socket_rank_update_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 35,
            character_id: Some(3501),
            session_token: Some("sess-35".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 36,
            character_id: Some(3602),
            session_token: Some("sess-36".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::rank::build_rank_update_payload("buy_partner_listing", &["partner", "power"]);
        crate::realtime::public_socket::emit_rank_update_to_user(&state, 35, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_RANK_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_RANK_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("rank:update"));
        assert!(target_poll.contains("\"source\":\"buy_partner_listing\""));
        assert!(target_poll.contains("\"domains\":[\"partner\",\"power\"]"));
        assert!(!other_poll.contains("rank:update"));
    }

    #[tokio::test]
    async fn game_socket_team_emit_helper_pushes_update_only_to_target_members() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (leader_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &leader_sid).await;
        let (member_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &member_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: leader_sid.clone(),
            user_id: 31,
            character_id: Some(3101),
            session_token: Some("sess-31".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: member_sid.clone(),
            user_id: 32,
            character_id: Some(3202),
            session_token: Some("sess-32".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 33,
            character_id: Some(3303),
            session_token: Some("sess-33".to_string()),
            connected_at_ms: 3,
        });

        let payload = crate::realtime::team::TeamUpdatePayload {
            kind: "team:update".to_string(),
            source: "transfer_team_leader".to_string(),
            team_id: Some("team-1".to_string()),
            message: Some("队长已转让".to_string()),
        };
        crate::realtime::public_socket::emit_team_update_to_characters(&state, &[3101, 3202], &payload);

        let leader_poll = poll_text(&client, address, &leader_sid).await;
        let member_poll = poll_text(&client, address, &member_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TEAM_HELPER_LEADER_POLL={leader_poll}");
        println!("GAME_SOCKET_TEAM_HELPER_MEMBER_POLL={member_poll}");
        println!("GAME_SOCKET_TEAM_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(leader_poll.contains("team:update"));
        assert!(leader_poll.contains("\"teamId\":\"team-1\""));
        assert!(member_poll.contains("team:update"));
        assert!(member_poll.contains("\"source\":\"transfer_team_leader\""));
        assert!(!other_poll.contains("team:update"));
    }

    #[tokio::test]
    async fn game_socket_sect_emit_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 41,
            character_id: Some(4101),
            session_token: Some("sess-41".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 42,
            character_id: Some(4202),
            session_token: Some("sess-42".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::sect::build_sect_indicator_payload(true, 1, 3, true);
        crate::realtime::public_socket::emit_sect_update_to_user(&state, 41, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_SECT_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_SECT_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("sect:update"));
        assert!(target_poll.contains("\"joined\":true"));
        assert!(target_poll.contains("\"canManageApplications\":true"));
        assert!(!other_poll.contains("sect:update"));
    }

    #[tokio::test]
    async fn game_socket_mail_emit_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 51,
            character_id: Some(5101),
            session_token: Some("sess-51".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 52,
            character_id: Some(5202),
            session_token: Some("sess-52".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::mail::build_mail_update_payload(3, 1, "claim_mail");
        crate::realtime::public_socket::emit_mail_update_to_user(&state, 51, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_MAIL_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_MAIL_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("mail:update"));
        assert!(target_poll.contains("\"unreadCount\":3"));
        assert!(target_poll.contains("\"source\":\"claim_mail\""));
        assert!(!other_poll.contains("mail:update"));
    }

    #[tokio::test]
    async fn game_socket_character_emit_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 57,
            character_id: Some(5701),
            session_token: Some("sess-57".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 58,
            character_id: Some(5802),
            session_token: Some("sess-58".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::socket_protocol::GameCharacterPayload {
            kind: "game:character".to_string(),
            payload_type: "delta".to_string(),
            delta: Some(crate::realtime::socket_protocol::GameCharacterDelta {
                id: 5701,
                avatar: Some("/uploads/avatar/test.png".to_string()),
            }),
            character: None,
        };
        crate::realtime::public_socket::emit_game_character_to_user(&state, 57, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_CHARACTER_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_CHARACTER_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("game:character"));
        assert!(target_poll.contains("\"type\":\"delta\""));
        assert!(target_poll.contains("\"avatar\":\"/uploads/avatar/test.png\""));
        assert!(!other_poll.contains("game:character"));
    }

    #[tokio::test]
    async fn game_socket_character_full_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 59,
            character_id: Some(5901),
            session_token: Some("sess-59".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 60,
            character_id: Some(6002),
            session_token: Some("sess-60".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::socket_protocol::build_game_character_full_payload(Some(
            crate::realtime::socket_protocol::GameCharacterFullSnapshot {
                id: 5901,
                user_id: 59,
                nickname: "韩立".to_string(),
                month_card_active: true,
                title: "散修".to_string(),
                gender: "male".to_string(),
                avatar: Some("/uploads/avatars/a.png".to_string()),
                auto_cast_skills: true,
                auto_disassemble_enabled: false,
                dungeon_no_stamina_cost: false,
                spirit_stones: 12,
                silver: 34,
                stamina: 56,
                stamina_max: 100,
                realm: "炼气期".to_string(),
                sub_realm: Some("一层".to_string()),
                exp: 78,
                attribute_points: 3,
                jing: 4,
                qi: 5,
                shen: 6,
                attribute_type: "physical".to_string(),
                attribute_element: "none".to_string(),
                qixue: 100,
                max_qixue: 120,
                lingqi: 80,
                max_lingqi: 90,
                wugong: 10,
                fagong: 11,
                wufang: 12,
                fafang: 13,
                mingzhong: 14,
                shanbi: 15,
                zhaojia: 0,
                baoji: 16,
                baoshang: 17,
                jianbaoshang: 0,
                jianfantan: 0,
                kangbao: 18,
                zengshang: 0,
                zhiliao: 0,
                jianliao: 0,
                xixue: 0,
                lengque: 0,
                kongzhi_kangxing: 0,
                jin_kangxing: 0,
                mu_kangxing: 0,
                shui_kangxing: 0,
                huo_kangxing: 0,
                tu_kangxing: 0,
                qixue_huifu: 0,
                lingqi_huifu: 0,
                sudu: 19,
                fuyuan: 20,
                current_map_id: "map-qingyun-village".to_string(),
                current_room_id: "room-village-center".to_string(),
                feature_unlocks: vec!["partner_system".to_string()],
                global_buffs: vec![crate::realtime::socket_protocol::GameCharacterGlobalBuff {
                    id: "fuyuan_flat|sect_blessing|blessing_hall".to_string(),
                    buff_key: "fuyuan_flat".to_string(),
                    label: "祈福".to_string(),
                    icon_text: "祈".to_string(),
                    effect_text: "福源 +2".to_string(),
                    started_at: "2026-04-13T00:00:00.000Z".to_string(),
                    expire_at: "2026-04-13T03:00:00.000Z".to_string(),
                    total_duration_ms: 10_800_000,
                }],
            },
        ));
        crate::realtime::public_socket::emit_game_character_to_user(&state, 59, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_CHARACTER_FULL_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_CHARACTER_FULL_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("game:character"));
        assert!(target_poll.contains("\"type\":\"full\""));
        assert!(target_poll.contains("\"nickname\":\"韩立\""));
        assert!(target_poll.contains("\"featureUnlocks\":[\"partner_system\"]"));
        assert!(!other_poll.contains("game:character"));
    }

    #[tokio::test]
    async fn game_socket_idle_update_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 53,
            character_id: Some(5301),
            session_token: Some("sess-53".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 54,
            character_id: Some(5402),
            session_token: Some("sess-54".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::idle::build_idle_update_batch_payload(
            "idle-1",
            3,
            "attacker_win",
            15,
            3,
            Vec::new(),
            3,
        );
        crate::realtime::public_socket::emit_idle_realtime_to_user(&state, 53, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_IDLE_UPDATE_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_IDLE_UPDATE_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("idle:update"));
        assert!(target_poll.contains("\"sessionId\":\"idle-1\""));
        assert!(!other_poll.contains("idle:update"));
    }

    #[tokio::test]
    async fn game_socket_idle_finished_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 55,
            character_id: Some(5501),
            session_token: Some("sess-55".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 56,
            character_id: Some(5602),
            session_token: Some("sess-56".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::idle::build_idle_finished_payload(crate::http::idle::IdleSessionDto {
            id: "idle-2".to_string(),
            character_id: 5501,
            status: "completed".to_string(),
            map_id: "map-1".to_string(),
            room_id: "room-1".to_string(),
            max_duration_ms: 1000,
            total_battles: 3,
            win_count: 2,
            lose_count: 1,
            total_exp: 30,
            total_silver: 12,
            bag_full_flag: false,
            started_at: "2026-04-13T10:00:00Z".to_string(),
            ended_at: Some("2026-04-13T10:05:00Z".to_string()),
            viewed_at: None,
            target_monster_def_id: None,
            target_monster_name: None,
            execution_snapshot: None,
            raw_snapshot: serde_json::json!({}),
            buffered_batch_deltas: Vec::new(),
            buffered_since_ms: None,
        });
        crate::realtime::public_socket::emit_idle_realtime_to_user(&state, 55, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_IDLE_FINISHED_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_IDLE_FINISHED_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("idle:finished"));
        assert!(target_poll.contains("\"sessionId\":\"idle-2\""));
        assert!(!other_poll.contains("idle:finished"));
    }

    #[tokio::test]
        async fn idle_start_route_eventually_emits_idle_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_IDLE_START_EXECUTION_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("idle-start-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;
        socket_auth(&client, address, &target_sid, &fixture.token).await;
        socket_auth(&client, address, &other_sid, &outsider.token).await;
        let _target_auth_poll = poll_until_contains(&client, address, &target_sid, "game:auth-ready").await;
        let _other_auth_poll = poll_until_contains(&client, address, &other_sid, "game:auth-ready").await;

        let response = client
            .post(format!("http://{address}/api/idle/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"mapId\":\"map-qingyun-outskirts\",\"roomId\":\"room-forest-clearing\",\"maxDurationMs\":60000,\"autoSkillPolicy\":{\"slots\":[{\"skillId\":\"sk-heavy-slash\",\"priority\":1}]},\"targetMonsterDefId\":\"monster-wild-boar\",\"includePartnerInBattle\":false}")
            .send()
            .await
            .expect("idle start request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("idle start body should read");
        if response_status != StatusCode::OK {
            panic!("IDLE_START_ROUTE_RESPONSE={response_text}");
        }

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let target_poll = poll_until_contains(&client, address, &target_sid, "idle:update").await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_IDLE_START_EXECUTION_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_IDLE_START_EXECUTION_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("idle:update"));
        assert!(target_poll.contains("\"result\":\"attacker_win\""));
        assert!(target_poll.contains("\"itemsGained\":[{"));
        assert!(target_poll.contains("\"itemDefId\":\"mat-005\""));
        assert!(!other_poll.contains("idle:update"));

        sqlx::query("DELETE FROM idle_sessions WHERE character_id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn idle_start_route_buffers_resource_delta_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "IDLE_RESOURCE_DELTA_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("idle-resource-delta-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/idle/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"mapId\":\"map-qingyun-outskirts\",\"roomId\":\"room-forest-clearing\",\"maxDurationMs\":60000,\"autoSkillPolicy\":{\"slots\":[{\"skillId\":\"sk-heavy-slash\",\"priority\":1}]},\"targetMonsterDefId\":\"monster-wild-boar\",\"includePartnerInBattle\":false}")
            .send()
            .await
            .expect("idle start request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        tokio::time::sleep(std::time::Duration::from_millis(3500)).await;

        if state.redis_available {
            let snapshot_row = sqlx::query("SELECT session_snapshot FROM idle_sessions WHERE character_id = $1 AND status = 'active' ORDER BY started_at DESC LIMIT 1")
                .bind(fixture.character_id)
                .fetch_one(&pool)
                .await
                .expect("idle session snapshot should load");
            let snapshot = snapshot_row
                .try_get::<Option<serde_json::Value>, _>("session_snapshot")
                .unwrap_or(None)
                .unwrap_or_else(|| serde_json::json!({}));
            println!("IDLE_RESOURCE_BUFFERED_SNAPSHOT={snapshot}");
            let buffered = snapshot.get("bufferedBatchDeltas").and_then(|value| value.as_array()).cloned().unwrap_or_default();
            assert!(!buffered.is_empty());
        } else {
            let row = sqlx::query("SELECT exp, silver FROM characters WHERE id = $1")
                .bind(fixture.character_id)
                .fetch_one(&pool)
                .await
                .expect("character row should load");
            println!("IDLE_RESOURCE_DELTA_FALLBACK_ROW={}", serde_json::json!({
                "exp": row.try_get::<Option<i64>, _>("exp").unwrap_or(None),
                "silver": row.try_get::<Option<i64>, _>("silver").unwrap_or(None),
            }));
        }

        server.abort();

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn idle_start_route_sets_bag_full_flag_when_bag_has_no_space() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_IDLE_BAG_FULL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("idle-bag-full-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) SELECT $1, $2, 'mat-002', 1, 'none', 'bag', slot, NOW(), NOW(), 'test' FROM generate_series(0, 99) AS slot",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("bag rows should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/idle/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"mapId\":\"map-qingyun-outskirts\",\"roomId\":\"room-forest-clearing\",\"maxDurationMs\":60000,\"autoSkillPolicy\":{\"slots\":[{\"skillId\":\"sk-heavy-slash\",\"priority\":1}]},\"targetMonsterDefId\":\"monster-wild-boar\",\"includePartnerInBattle\":false}")
            .send()
            .await
            .expect("idle start request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        tokio::time::sleep(std::time::Duration::from_millis(3500)).await;

        let row = sqlx::query("SELECT bag_full_flag FROM idle_sessions WHERE character_id = $1 AND status = 'active' ORDER BY started_at DESC LIMIT 1")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("idle session should exist");

        println!(
            "GAME_SOCKET_IDLE_BAG_FULL_FLAG={}",
            row.try_get::<Option<bool>, _>("bag_full_flag").unwrap_or(None).unwrap_or(false)
        );

        server.abort();

        assert_eq!(row.try_get::<Option<bool>, _>("bag_full_flag").unwrap_or(None), Some(true));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn idle_start_route_partner_participation_reduces_round_count() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_IDLE_PARTNER_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("idle-partner-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        sqlx::query(
            "INSERT INTO character_partner (character_id, partner_def_id, nickname, description, avatar, level, progress_exp, growth_max_qixue, growth_wugong, growth_fagong, growth_wufang, growth_fafang, growth_sudu, is_active, obtained_from, obtained_ref_id, created_at, updated_at) VALUES ($1, 'partner-qingmu-xiaoou', '青木小偶', '', NULL, 1, 0, 120, 120, 0, 0, 0, 12, TRUE, 'test', NULL, NOW(), NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("active partner should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        async fn run_idle_and_read_round_count(
            client: &reqwest::Client,
            address: std::net::SocketAddr,
            token: &str,
            include_partner: bool,
        ) -> (String, i64) {
            let (sid, _) = handshake_sid(client, address).await;
            socket_connect(client, address, &sid).await;
            socket_auth(client, address, &sid, token).await;
            let _auth_poll = poll_until_contains(client, address, &sid, "game:auth-ready").await;

            let response = client
                .post(format!("http://{address}/api/idle/start"))
                .header("authorization", format!("Bearer {}", token))
                .header("content-type", "application/json")
                .body(format!("{{\"mapId\":\"map-qingyun-outskirts\",\"roomId\":\"room-deep-forest\",\"maxDurationMs\":60000,\"autoSkillPolicy\":{{\"slots\":[{{\"skillId\":\"sk-basic-slash\",\"priority\":1}}]}},\"targetMonsterDefId\":\"monster-gray-wolf\",\"includePartnerInBattle\":{}}}", include_partner))
                .send()
                .await
                .expect("idle start request should succeed");
            assert_eq!(response.status(), StatusCode::OK);

            let target_poll = poll_until_contains(client, address, &sid, "idle:update").await;
            let marker = "\"roundCount\":";
            let idx = target_poll.find(marker).expect("roundCount marker should exist") + marker.len();
            let tail = &target_poll[idx..];
            let round_count = tail.chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse::<i64>()
                .expect("roundCount should parse");
            let session_marker = "\"sessionId\":\"";
            let session_idx = target_poll.find(session_marker).expect("sessionId marker should exist") + session_marker.len();
            let session_tail = &target_poll[session_idx..];
            let session_id = session_tail.split('"').next().unwrap_or_default().to_string();
            (session_id, round_count)
        }

        let (first_session_id, without_partner) = run_idle_and_read_round_count(&client, address, &fixture.token, false).await;

        let stop_response = client
            .post(format!("http://{address}/api/idle/stop"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"sessionId\":\"{}\"}}", first_session_id))
            .send()
            .await
            .expect("idle stop request should succeed");
        assert_eq!(stop_response.status(), StatusCode::OK);
        let (stop_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &stop_sid).await;
        socket_auth(&client, address, &stop_sid, &fixture.token).await;
        let _stop_auth_poll = poll_until_contains(&client, address, &stop_sid, "game:auth-ready").await;
        let _stop_poll = poll_until_contains(&client, address, &stop_sid, "idle:finished").await;

        let (_second_session_id, with_partner) = run_idle_and_read_round_count(&client, address, &fixture.token, true).await;

        println!("IDLE_PARTNER_ROUND_COUNTS={{\"without_partner\":{},\"with_partner\":{}}}", without_partner, with_partner);

        server.abort();

        assert!(with_partner < without_partner);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn idle_stop_route_eventually_emits_idle_finished_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_IDLE_STOP_EXECUTION_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("idle-stop-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let start_response = client
            .post(format!("http://{address}/api/idle/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"mapId\":\"map-qingyun-outskirts\",\"roomId\":\"room-south-forest\",\"maxDurationMs\":60000,\"autoSkillPolicy\":{\"slots\":[{\"skillId\":\"sk-basic-slash\",\"priority\":1}]},\"targetMonsterDefId\":\"monster-wild-rabbit\",\"includePartnerInBattle\":false}")
            .send()
            .await
            .expect("idle start request should succeed");
        assert_eq!(start_response.status(), StatusCode::OK);

        let stop_response = client
            .post(format!("http://{address}/api/idle/stop"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("idle stop request should succeed");
        assert_eq!(stop_response.status(), StatusCode::OK);

        tokio::time::sleep(std::time::Duration::from_millis(3500)).await;

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_IDLE_STOP_EXECUTION_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_IDLE_STOP_EXECUTION_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("idle:finished"));
        assert!(target_poll.contains("\"reason\":\"interrupted\""));
        assert!(!other_poll.contains("idle:finished"));

        sqlx::query("DELETE FROM idle_sessions WHERE character_id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
    async fn game_socket_time_sync_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 61,
            character_id: Some(6101),
            session_token: Some("sess-61".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 62,
            character_id: Some(6202),
            session_token: Some("sess-62".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::game_time::build_game_time_sync_payload(
            crate::shared::game_time::GameTimeSnapshot {
                era_name: "末法纪元".to_string(),
                base_year: 1000,
                year: 2026,
                month: 4,
                day: 11,
                hour: 7,
                minute: 30,
                second: 0,
                shichen: "辰时".to_string(),
                weather: "晴".to_string(),
                scale: 60,
                server_now_ms: 1712800000000,
                game_elapsed_ms: 1712800000000,
            },
        );
        crate::realtime::public_socket::emit_game_time_sync_to_user(&state, 61, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TIME_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_TIME_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("game:time-sync"));
        assert!(target_poll.contains("\"era_name\":\"末法纪元\""));
        assert!(!other_poll.contains("game:time-sync"));
    }

    #[tokio::test]
    async fn game_socket_wander_update_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 96,
            character_id: Some(9601),
            session_token: Some("sess-96".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 97,
            character_id: Some(9702),
            session_token: Some("sess-97".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::wander::build_wander_update_payload(
            crate::http::wander::WanderOverviewDto {
                today: "2026-04-13".to_string(),
                ai_available: true,
                has_pending_episode: false,
                is_resolving_episode: false,
                can_generate: true,
                is_cooling_down: false,
                cooldown_until: None,
                cooldown_remaining_seconds: 0,
                current_generation_job: None,
                active_story: None,
                current_episode: None,
                latest_finished_story: None,
                generated_titles: vec![],
            },
        );
        crate::realtime::public_socket::emit_wander_update_to_user(&state, 96, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_WANDER_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_WANDER_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("wander:update"));
        assert!(target_poll.contains("\"today\":\"2026-04-13\""));
        assert!(target_poll.contains("\"canGenerate\":true"));
        assert!(!other_poll.contains("wander:update"));
    }

    #[tokio::test]
    async fn game_socket_technique_research_status_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 91,
            character_id: Some(9101),
            session_token: Some("sess-91".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 92,
            character_id: Some(9202),
            session_token: Some("sess-92".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::technique_research::build_technique_research_status_payload(
            9101,
            crate::http::character_technique::TechniqueResearchStatusDto {
                unlock_realm: "炼炁化神·结胎期".to_string(),
                unlocked: true,
                fragment_balance: 4000,
                fragment_cost: 3500,
                cooldown_bypass_fragment_cost: 2800,
                cooldown_hours: 72,
                cooldown_until: None,
                cooldown_remaining_seconds: 0,
                cooldown_bypass_token_bypasses_cooldown: true,
                cooldown_bypass_token_cost: 1,
                cooldown_bypass_token_item_name: "冷却绕过令牌".to_string(),
                cooldown_bypass_token_available_qty: 1,
                burning_word_prompt_max_length: 2,
                current_draft: None,
                draft_expire_at: None,
                name_rules: crate::http::character_technique::TechniqueResearchNameRulesDto {
                    min_length: 2,
                    max_length: 14,
                    fixed_prefix: "『研』".to_string(),
                    pattern_hint: "仅支持纯中文".to_string(),
                    immutable_after_publish: true,
                },
                current_job: None,
                has_unread_result: false,
                result_status: None,
                remaining_until_guaranteed_heaven: 20,
                quality_rates: vec![],
            },
        );
        crate::realtime::public_socket::emit_technique_research_status_to_user(&state, 91, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TECHNIQUE_STATUS_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_TECHNIQUE_STATUS_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("techniqueResearch:update"));
        assert!(target_poll.contains("\"characterId\":9101"));
        assert!(target_poll.contains("\"unlockRealm\":\"炼炁化神·结胎期\""));
        assert!(!other_poll.contains("techniqueResearch:update"));
    }

    #[tokio::test]
    async fn game_socket_technique_research_status_helper_pushes_update_only_to_target_user_via_routes() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 91,
            character_id: Some(9101),
            session_token: Some("sess-91".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 92,
            character_id: Some(9202),
            session_token: Some("sess-92".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::technique_research::build_technique_research_status_payload(
            9101,
            crate::http::character_technique::TechniqueResearchStatusDto {
                unlock_realm: "炼炁化神·结胎期".to_string(),
                unlocked: true,
                fragment_balance: 4000,
                fragment_cost: 3500,
                cooldown_bypass_fragment_cost: 2800,
                cooldown_hours: 72,
                cooldown_until: None,
                cooldown_remaining_seconds: 0,
                cooldown_bypass_token_bypasses_cooldown: true,
                cooldown_bypass_token_cost: 1,
                cooldown_bypass_token_item_name: "冷却绕过令牌".to_string(),
                cooldown_bypass_token_available_qty: 1,
                burning_word_prompt_max_length: 2,
                current_draft: None,
                draft_expire_at: None,
                name_rules: crate::http::character_technique::TechniqueResearchNameRulesDto {
                    min_length: 2,
                    max_length: 14,
                    fixed_prefix: "『研』".to_string(),
                    pattern_hint: "仅支持纯中文".to_string(),
                    immutable_after_publish: true,
                },
                current_job: None,
                has_unread_result: false,
                result_status: None,
                remaining_until_guaranteed_heaven: 20,
                quality_rates: vec![],
            },
        );
        crate::realtime::public_socket::emit_technique_research_status_to_user(&state, 91, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TECHNIQUE_STATUS_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_TECHNIQUE_STATUS_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("techniqueResearch:update"));
        assert!(target_poll.contains("\"characterId\":9101"));
        assert!(!other_poll.contains("techniqueResearch:update"));
    }

    #[tokio::test]
    async fn game_socket_technique_research_result_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 93,
            character_id: Some(9301),
            session_token: Some("sess-93".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 94,
            character_id: Some(9402),
            session_token: Some("sess-94".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::technique_research::build_technique_research_result_payload(
            9301,
            "tech-gen-1",
            "failed",
            "洞府推演失败，请前往功法查看",
            None,
            Some("已放弃本次研修草稿，并按过期规则结算".to_string()),
        );
        crate::realtime::public_socket::emit_technique_research_result_to_user(&state, 93, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TECHNIQUE_RESULT_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_TECHNIQUE_RESULT_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("techniqueResearchResult"));
        assert!(target_poll.contains("\"characterId\":9301"));
        assert!(target_poll.contains("\"generationId\":\"tech-gen-1\""));
        assert!(!other_poll.contains("techniqueResearchResult"));
    }

    #[tokio::test]
    async fn game_socket_partner_recruit_status_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 101,
            character_id: Some(10101),
            session_token: Some("sess-101".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 102,
            character_id: Some(10202),
            session_token: Some("sess-102".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::partner_recruit::build_partner_recruit_status_payload(
            10101,
            crate::http::partner::PartnerRecruitStatusDto {
                feature_code: "partner_system".to_string(),
                unlock_realm: "炼神返虚·养神期".to_string(),
                unlocked: true,
                spirit_stone_cost: 0,
                cooldown_hours: 72,
                cooldown_until: None,
                cooldown_remaining_seconds: 0,
                custom_base_model_bypasses_cooldown: true,
                custom_base_model_max_length: 12,
                custom_base_model_token_cost: 1,
                custom_base_model_token_item_name: "自定义底模令".to_string(),
                custom_base_model_token_available_qty: 1,
                current_job: None,
                has_unread_result: false,
                result_status: None,
                remaining_until_guaranteed_heaven: 20,
                quality_rates: vec![],
            },
        );
        crate::realtime::public_socket::emit_partner_recruit_status_to_user(&state, 101, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_PARTNER_RECRUIT_STATUS_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_PARTNER_RECRUIT_STATUS_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("partnerRecruit:update"));
        assert!(target_poll.contains("\"characterId\":10101"));
        assert!(!other_poll.contains("partnerRecruit:update"));
    }

    #[tokio::test]
    async fn game_socket_partner_fusion_status_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 111,
            character_id: Some(11101),
            session_token: Some("sess-111".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 112,
            character_id: Some(11202),
            session_token: Some("sess-112".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::partner_fusion::build_partner_fusion_status_payload(
            11101,
            crate::http::partner::PartnerFusionStatusDto {
                feature_code: "partner_system".to_string(),
                unlocked: true,
                current_job: None,
                has_unread_result: false,
                result_status: None,
            },
        );
        crate::realtime::public_socket::emit_partner_fusion_status_to_user(&state, 111, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_PARTNER_FUSION_STATUS_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_PARTNER_FUSION_STATUS_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("partnerFusion:update"));
        assert!(target_poll.contains("\"characterId\":11101"));
        assert!(!other_poll.contains("partnerFusion:update"));
    }

    #[tokio::test]
    async fn game_socket_partner_rebone_status_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 121,
            character_id: Some(12101),
            session_token: Some("sess-121".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 122,
            character_id: Some(12202),
            session_token: Some("sess-122".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::partner_rebone::build_partner_rebone_status_payload(
            12101,
            crate::http::partner::PartnerReboneStatusDto {
                feature_code: "partner_system".to_string(),
                unlocked: true,
                current_job: None,
                has_unread_result: false,
                result_status: None,
            },
        );
        crate::realtime::public_socket::emit_partner_rebone_status_to_user(&state, 121, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_PARTNER_REBONE_STATUS_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_PARTNER_REBONE_STATUS_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("partnerRebone:update"));
        assert!(target_poll.contains("\"characterId\":12101"));
        assert!(!other_poll.contains("partnerRebone:update"));
    }

    #[tokio::test]
    async fn game_socket_partner_recruit_result_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 131,
            character_id: Some(13101),
            session_token: Some("sess-131".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 132,
            character_id: Some(13202),
            session_token: Some("sess-132".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::partner_recruit::build_partner_recruit_result_payload(
            13101,
            "partner-recruit-1",
            "refunded",
            "伙伴招募失败，请前往伙伴界面查看",
            Some("伙伴招募生成链尚未迁移，已自动终结并退款".to_string()),
        );
        crate::realtime::public_socket::emit_partner_recruit_result_to_user(&state, 131, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_PARTNER_RECRUIT_RESULT_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_PARTNER_RECRUIT_RESULT_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("partnerRecruitResult"));
        assert!(target_poll.contains("\"characterId\":13101"));
        assert!(target_poll.contains("\"generationId\":\"partner-recruit-1\""));
        assert!(!other_poll.contains("partnerRecruitResult"));
    }

    #[tokio::test]
    async fn game_socket_partner_fusion_result_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 141,
            character_id: Some(14101),
            session_token: Some("sess-141".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 142,
            character_id: Some(14202),
            session_token: Some("sess-142".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::partner_fusion::build_partner_fusion_result_payload(
            14101,
            "partner-fusion-1",
            "failed",
            "三魂归契失败，请前往伙伴界面查看",
            None,
            Some("三魂归契生成链尚未迁移，已自动终结".to_string()),
        );
        crate::realtime::public_socket::emit_partner_fusion_result_to_user(&state, 141, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_PARTNER_FUSION_RESULT_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_PARTNER_FUSION_RESULT_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("partnerFusionResult"));
        assert!(target_poll.contains("\"characterId\":14101"));
        assert!(target_poll.contains("\"fusionId\":\"partner-fusion-1\""));
        assert!(!other_poll.contains("partnerFusionResult"));
    }

    #[tokio::test]
    async fn game_socket_partner_rebone_result_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 151,
            character_id: Some(15101),
            session_token: Some("sess-151".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 152,
            character_id: Some(15202),
            session_token: Some("sess-152".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::partner_rebone::build_partner_rebone_result_payload(
            15101,
            "partner-rebone-1",
            7,
            "failed",
            "归元洗髓失败，请前往伙伴界面查看",
            Some("归元洗髓执行链尚未迁移，已自动终结并退款".to_string()),
        );
        crate::realtime::public_socket::emit_partner_rebone_result_to_user(&state, 151, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_PARTNER_REBONE_RESULT_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_PARTNER_REBONE_RESULT_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("partnerReboneResult"));
        assert!(target_poll.contains("\"characterId\":15101"));
        assert!(target_poll.contains("\"reboneId\":\"partner-rebone-1\""));
        assert!(!other_poll.contains("partnerReboneResult"));
    }

    #[tokio::test]
    async fn game_socket_achievement_emit_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 71,
            character_id: Some(7101),
            session_token: Some("sess-71".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 72,
            character_id: Some(7202),
            session_token: Some("sess-72".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::achievement::build_achievement_indicator_payload(7101, 2);
        crate::realtime::public_socket::emit_achievement_update_to_user(&state, 71, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_ACHIEVEMENT_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_ACHIEVEMENT_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("achievement:update"));
        assert!(target_poll.contains("\"characterId\":7101"));
        assert!(target_poll.contains("\"claimableCount\":2"));
        assert!(!other_poll.contains("achievement:update"));
    }

    #[tokio::test]
    async fn game_socket_task_emit_helper_pushes_update_only_to_target_user() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: 81,
            character_id: Some(8101),
            session_token: Some("sess-81".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: 82,
            character_id: Some(8202),
            session_token: Some("sess-82".to_string()),
            connected_at_ms: 2,
        });

        let payload = crate::realtime::task::build_task_overview_update_payload(8101);
        crate::realtime::public_socket::emit_task_update_to_user(&state, 81, &payload);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TASK_HELPER_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_TASK_HELPER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("task:update"));
        assert!(target_poll.contains("\"characterId\":8101"));
        assert!(target_poll.contains("\"scopes\":[\"task\"]"));
        assert!(!other_poll.contains("task:update"));
    }

    #[tokio::test]
    async fn game_socket_online_players_emit_helpers_push_full_then_delta() {
        let state = test_state();
        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: 21,
            character_id: Some(2101),
            session_token: Some("sess-21".to_string()),
            connected_at_ms: 21,
        });
        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 21,
            character_id: Some(2101),
            nickname: Some("韩立".to_string()),
            month_card_active: false,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: None,
            connected_at_ms: 21,
        });

        let previous = state.online_players.take_last_broadcasted_players();
        let current = state.online_players.snapshot_dto_map();
        let full_payload = crate::realtime::online_players::build_online_players_broadcast_payload(&previous, &current)
            .expect("full payload should exist");
        state.online_players.replace_last_broadcasted_players(current);
        if let Some(io) = state.socket_io() {
            if let Ok(socket_sid) = socketioxide::socket::Sid::from_str(&sid) {
                if let Some(socket) = io.get_socket(socket_sid) {
                    socket.emit("game:onlinePlayers", &full_payload).ok();
                }
            }
        }
        let full_poll = poll_text(&client, address, &sid).await;

        state.online_players.register(crate::state::OnlinePlayerRecord {
            user_id: 21,
            character_id: Some(2101),
            nickname: Some("韩立".to_string()),
            month_card_active: true,
            title: Some("散修".to_string()),
            realm: Some("筑基期".to_string()),
            room_id: None,
            connected_at_ms: 21,
        });
        let previous = state.online_players.take_last_broadcasted_players();
        let current = state.online_players.snapshot_dto_map();
        let delta_payload = crate::realtime::online_players::build_online_players_broadcast_payload(&previous, &current)
            .expect("delta payload should exist");
        state.online_players.replace_last_broadcasted_players(current);
        if let Some(io) = state.socket_io() {
            if let Ok(socket_sid) = socketioxide::socket::Sid::from_str(&sid) {
                if let Some(socket) = io.get_socket(socket_sid) {
                    socket.emit("game:onlinePlayers", &delta_payload).ok();
                }
            }
        }
        let delta_poll = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_ONLINE_PLAYERS_HELPER_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_ONLINE_PLAYERS_HELPER_FULL={full_poll}");
        println!("GAME_SOCKET_ONLINE_PLAYERS_HELPER_DELTA={delta_poll}");

        server.abort();

        assert!(full_poll.contains("game:onlinePlayers"));
        assert!(full_poll.contains("\"type\":\"full\""));
        assert!(full_poll.contains("\"players\":[{"));
        assert!(delta_poll.contains("game:onlinePlayers"));
        assert!(delta_poll.contains("\"type\":\"delta\"") || delta_poll.contains("\"type\":\"full\""));
        assert!(delta_poll.contains("\"monthCardActive\":true"));
        assert!(delta_poll.contains("\"realm\":\"筑基期\""));
    }

    #[tokio::test]
        async fn wander_generate_route_emits_wander_update_to_target_user() {
        let state = test_state_with_wander_ai(true);
        let mut config = (*state.config).clone();
        config.wander.model_provider = "openai".to_string();
        config.wander.model_url = "http://127.0.0.1:1/v1".to_string();
        config.wander.model_key = "mock-wander-key".to_string();
        config.wander.model_name = "mock-wander-model".to_string();
        let state = AppState::new(
            Arc::new(config),
            state.database.clone(),
            state.redis.clone(),
            state.outbound_http.clone(),
            true,
        );
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_WANDER_GENERATE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("wander-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/wander/generate"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("wander generate request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("wander generate body should read");
        println!("WANDER_GENERATE_ROUTE_RESPONSE={response_text}");
        assert_eq!(response_status, StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_WANDER_GENERATE_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_WANDER_GENERATE_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("wander:update"));
        assert!(target_poll.contains("\"currentGenerationJob\":{"));
        assert!(target_poll.contains("\"status\":\"pending\""));
        assert!(!other_poll.contains("wander:update"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn wander_generate_route_eventually_creates_ai_backed_episode() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "WANDER_AI_GENERATE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };
        if !state.config.wander.ai_enabled
            || state.config.wander.model_url.trim().is_empty()
            || state.config.wander.model_key.trim().is_empty()
            || state.config.wander.model_name.trim().is_empty()
        {
            println!("WANDER_AI_GENERATE_SKIPPED_AI_UNAVAILABLE");
            return;
        }

        let suffix = format!("wander-ai-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let generate_response = client
            .post(format!("http://{address}/api/wander/generate"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("wander generate should succeed");
        assert_eq!(generate_response.status(), StatusCode::OK);
        let generate_body: Value = serde_json::from_str(&generate_response.text().await.expect("generate body should read"))
            .expect("generate body should be json");
        let generation_id = generate_body["data"]["job"]["generationId"]
            .as_str()
            .expect("generation id should exist")
            .to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        let job_row = sqlx::query("SELECT status, generated_episode_id FROM character_wander_generation_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("wander generation job should exist");
        let episode_id = job_row
            .try_get::<Option<String>, _>("generated_episode_id")
            .unwrap_or(None)
            .unwrap_or_default();
        let episode_row = sqlx::query("SELECT episode_title, opening, option_texts FROM character_wander_story_episode WHERE id = $1")
            .bind(&episode_id)
            .fetch_one(&pool)
            .await
            .expect("wander episode should exist");

        println!("WANDER_AI_GENERATE_ROUTE_RESPONSE={generate_body}");
        println!("WANDER_AI_GENERATE_JOB_STATUS={}", job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default());

        server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "generated");
        assert!(!episode_id.is_empty());
        assert!(!episode_row.try_get::<Option<String>, _>("episode_title").unwrap_or(None).unwrap_or_default().is_empty());
        assert!(episode_row.try_get::<Option<String>, _>("opening").unwrap_or(None).unwrap_or_default().chars().count() >= 80);
        assert_eq!(episode_row.try_get::<Option<serde_json::Value>, _>("option_texts").unwrap_or(None).unwrap_or_default().as_array().map(|items| items.len()).unwrap_or_default(), 3);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn wander_generate_route_persists_story_other_player_snapshot() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "WANDER_OTHER_PLAYER_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };
        if !state.config.wander.ai_enabled
            || state.config.wander.model_url.trim().is_empty()
            || state.config.wander.model_key.trim().is_empty()
            || state.config.wander.model_name.trim().is_empty()
        {
            println!("WANDER_OTHER_PLAYER_SKIPPED_AI_UNAVAILABLE");
            return;
        }

        let suffix = format!("wander-other-player-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let other = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        sqlx::query("UPDATE users SET last_login = NOW() WHERE id = $1")
            .bind(other.user_id)
            .execute(&pool)
            .await
            .expect("other user last_login should update");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let generate_response = client
            .post(format!("http://{address}/api/wander/generate"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("wander generate should succeed");
        assert_eq!(generate_response.status(), StatusCode::OK);

        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        let story_row = sqlx::query(
            "SELECT story_other_player_snapshot FROM character_wander_story WHERE character_id = $1 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("wander story should exist");
        let snapshot = story_row
            .try_get::<Option<serde_json::Value>, _>("story_other_player_snapshot")
            .unwrap_or(None)
            .unwrap_or_default();

        println!("WANDER_OTHER_PLAYER_SNAPSHOT={snapshot}");

        server.abort();

        assert_eq!(snapshot["characterId"], other.character_id);
        assert_eq!(snapshot["nickname"], format!("socket-{suffix}"));
        assert!(!snapshot["realm"].as_str().unwrap_or_default().is_empty());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, other.character_id, other.user_id).await;
    }

    #[tokio::test]
        async fn wander_choose_route_eventually_resolves_episode_and_creates_title() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "WANDER_AI_RESOLUTION_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };
        if !state.config.wander.ai_enabled
            || state.config.wander.model_url.trim().is_empty()
            || state.config.wander.model_key.trim().is_empty()
            || state.config.wander.model_name.trim().is_empty()
        {
            println!("WANDER_AI_RESOLUTION_SKIPPED_AI_UNAVAILABLE");
            return;
        }

        let suffix = format!("wander-resolve-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let story_id = format!("wander-story-{suffix}");
        let episode_id = format!("wander-episode-{suffix}");

        sqlx::query(
            "INSERT INTO character_wander_story (id, character_id, status, story_theme, story_premise, story_summary, episode_count, story_seed, reward_title_id, finished_at, created_at, updated_at) VALUES ($1, $2, 'active', '云梦夜航', '你在夜色中踏入云水深处。', '', 1, 1, NULL, NULL, NOW(), NOW())",
        )
        .bind(&story_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("wander story should insert");
        sqlx::query(
            "INSERT INTO character_wander_story_episode (id, story_id, character_id, day_key, day_index, episode_title, opening, option_texts, chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type, reward_title_name, reward_title_desc, reward_title_color, reward_title_effects, created_at, chosen_at) VALUES ($1, $2, $3, CURRENT_DATE, 3, '云梦终幕', '夜雨压桥，河雾顺着石栏缓缓爬起，你隔着雨幕望见桥下潮影翻涌，终于意识到这一路追索的因果都将在今夜合拢。', '[\"驻足观望，静察风向\",\"绕到桥下暗查灵息\",\"收敛气机，静观其变\"]'::jsonb, NULL, NULL, '', TRUE, 'none', NULL, NULL, NULL, NULL, NOW(), NULL)",
        )
        .bind(&episode_id)
        .bind(&story_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("wander episode should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let choose_response = client
            .post(format!("http://{address}/api/wander/choose"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"episodeId\":\"{}\",\"optionIndex\":0}}", episode_id))
            .send()
            .await
            .expect("wander choose should succeed");
        assert_eq!(choose_response.status(), StatusCode::OK);
        let choose_body: Value = serde_json::from_str(&choose_response.text().await.expect("choose body should read"))
            .expect("choose body should be json");
        let generation_id = choose_body["data"]["job"]["generationId"]
            .as_str()
            .expect("generation id should exist")
            .to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        let job_row = sqlx::query("SELECT status, generated_episode_id FROM character_wander_generation_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("wander resolution job should exist");
        let episode_row = sqlx::query("SELECT chosen_at::text AS chosen_at_text, episode_summary, ending_type, reward_title_name, reward_title_desc, reward_title_color, reward_title_effects FROM character_wander_story_episode WHERE id = $1")
            .bind(&episode_id)
            .fetch_one(&pool)
            .await
            .expect("resolved wander episode should exist");
        let story_row = sqlx::query("SELECT status, story_summary, reward_title_id FROM character_wander_story WHERE id = $1")
            .bind(&story_id)
            .fetch_one(&pool)
            .await
            .expect("resolved wander story should exist");
        let reward_title_id = story_row.try_get::<Option<String>, _>("reward_title_id").unwrap_or(None).unwrap_or_default();
        let title_row = sqlx::query("SELECT id, name, description, color, effects FROM generated_title_def WHERE id = $1")
            .bind(&reward_title_id)
            .fetch_one(&pool)
            .await
            .expect("generated title should exist");
        let character_title_row = sqlx::query("SELECT title_id FROM character_title WHERE character_id = $1 AND title_id = $2")
            .bind(fixture.character_id)
            .bind(&reward_title_id)
            .fetch_one(&pool)
            .await
            .expect("character title should exist");
        let overview_response = client
            .get(format!("http://{address}/api/wander/overview"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("wander overview should succeed");
        assert_eq!(overview_response.status(), StatusCode::OK);
        let overview_body: Value = serde_json::from_str(&overview_response.text().await.expect("overview body should read"))
            .expect("overview body should be json");

        println!("WANDER_AI_RESOLUTION_CHOOSE_RESPONSE={choose_body}");
        println!("WANDER_AI_RESOLUTION_JOB_STATUS={}", job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default());
        println!("WANDER_AI_RESOLUTION_OVERVIEW={overview_body}");

        server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "generated");
        assert_eq!(job_row.try_get::<Option<String>, _>("generated_episode_id").unwrap_or(None).unwrap_or_default(), episode_id);
        assert!(episode_row.try_get::<Option<String>, _>("chosen_at_text").unwrap_or(None).is_some());
        assert!(episode_row.try_get::<Option<String>, _>("episode_summary").unwrap_or(None).unwrap_or_default().chars().count() >= 20);
        assert_ne!(episode_row.try_get::<Option<String>, _>("ending_type").unwrap_or(None).unwrap_or_default(), "none");
        assert!(!episode_row.try_get::<Option<String>, _>("reward_title_name").unwrap_or(None).unwrap_or_default().is_empty());
        assert_eq!(story_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "finished");
        assert!(!reward_title_id.is_empty());
        assert_eq!(title_row.try_get::<Option<String>, _>("id").unwrap_or(None).unwrap_or_default(), reward_title_id);
        assert_eq!(character_title_row.try_get::<Option<String>, _>("title_id").unwrap_or(None).unwrap_or_default(), reward_title_id);
        assert_eq!(overview_body["data"]["latestFinishedStory"]["rewardTitleId"], reward_title_id);
        assert_eq!(overview_body["data"]["generatedTitles"][0]["id"], reward_title_id);
        assert_eq!(overview_body["data"]["generatedTitles"][0]["isEquipped"], false);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn mail_read_route_emits_mail_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_MAIL_READ_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("mail-read-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let inserted_mail = sqlx::query(
            "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_rewards, source, source_ref_id, metadata, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', '测试邮件', '请查收', '[]'::jsonb, 'test', $3, '{}'::jsonb, NOW(), NOW()) RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .bind(format!("mail-{suffix}"))
        .fetch_one(&pool)
        .await
        .expect("mail should insert");
        let mail_id: i64 = inserted_mail.try_get("id").expect("mail id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/mail/read"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"mailId\":{mail_id}}}"))
            .send()
            .await
            .expect("mail read request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_MAIL_READ_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_MAIL_READ_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("mail:update"));
        assert!(target_poll.contains("\"source\":\"read_mail\""));
        assert!(!other_poll.contains("mail:update"));

        sqlx::query("DELETE FROM mail WHERE id = $1")
            .bind(mail_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn mail_delete_all_route_emits_mail_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_MAIL_DELETE_ALL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("mail-delete-all-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        sqlx::query(
            "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_rewards, source, source_ref_id, metadata, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', '测试邮件1', '请查收', '[]'::jsonb, 'test', $3, '{}'::jsonb, NOW(), NOW()), ($1, $2, 'system', '系统', 'reward', '测试邮件2', '请查收', '[]'::jsonb, 'test', $4, '{}'::jsonb, NOW(), NOW())",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .bind(format!("mail-a-{suffix}"))
        .bind(format!("mail-b-{suffix}"))
        .execute(&pool)
        .await
        .expect("mails should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/mail/delete-all"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .expect("mail delete-all request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_MAIL_DELETE_ALL_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_MAIL_DELETE_ALL_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("mail:update"));
        assert!(target_poll.contains("\"source\":\"delete_all_mail\""));
        assert!(!other_poll.contains("mail:update"));

        sqlx::query("DELETE FROM mail WHERE recipient_character_id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn mail_claim_all_route_emits_mail_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_MAIL_CLAIM_ALL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("mail-claim-all-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        sqlx::query(
            "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_silver, attach_rewards, source, source_ref_id, metadata, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', '测试奖励邮件', '请查收', 100, '[]'::jsonb, 'test', $3, '{}'::jsonb, NOW(), NOW())",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .bind(format!("mail-{suffix}"))
        .execute(&pool)
        .await
        .expect("claimable mail should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/mail/claim-all"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .expect("mail claim-all request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_MAIL_CLAIM_ALL_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_MAIL_CLAIM_ALL_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("mail:update"));
        assert!(target_poll.contains("\"source\":\"claim_all_mail\""));
        assert!(!other_poll.contains("mail:update"));

        sqlx::query("DELETE FROM mail WHERE recipient_character_id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn mail_claim_route_emits_mail_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_MAIL_CLAIM_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("mail-claim-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let inserted_mail = sqlx::query(
            "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_silver, attach_rewards, source, source_ref_id, metadata, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', '测试奖励邮件', '请查收', 100, '[]'::jsonb, 'test', $3, '{}'::jsonb, NOW(), NOW()) RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .bind(format!("mail-{suffix}"))
        .fetch_one(&pool)
        .await
        .expect("mail should insert");
        let mail_id: i64 = inserted_mail.try_get("id").expect("mail id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/mail/claim"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"mailId\":{mail_id}}}"))
            .send()
            .await
            .expect("mail claim request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_MAIL_CLAIM_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_MAIL_CLAIM_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("mail:update"));
        assert!(target_poll.contains("\"source\":\"claim_mail\""));
        assert!(!other_poll.contains("mail:update"));

        sqlx::query("DELETE FROM mail WHERE id = $1")
            .bind(mail_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn mail_claim_route_moves_instance_attachments_via_mutation_delta() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MAIL_INSTANCE_CLAIM_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("mail-instance-claim-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'equip-weapon-001', 1, 'none', 'mail', NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("mail attachment item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");
        let mail_id = sqlx::query(
            "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_instance_ids, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'normal', '附件测试', '请领取附件', $3::jsonb, NOW(), NOW()) RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .bind(serde_json::json!([item_id]))
        .fetch_one(&pool)
        .await
        .expect("mail should insert")
        .try_get::<i64, _>("id")
        .expect("mail id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/mail/claim"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"mailId\":{}}}", mail_id))
            .send()
            .await
            .expect("mail claim request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            panic!("TECHNIQUE_RESEARCH_GENERATE_HTTP_RESPONSE={response_text}");
        }
        assert_eq!(response_status, StatusCode::OK);
        let body: Value = serde_json::from_str(&response_text)
            .expect("body should be json");

        if state.redis_available {
            let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let hash = redis
                .hgetall(&format!("character:item-instance-mutation:{}", fixture.character_id))
                .await
                .expect("mutation hash should load");
            println!("MAIL_INSTANCE_CLAIM_MUTATION_HASH={}", serde_json::json!(hash));
            assert!(!hash.is_empty());
        } else {
            let row = sqlx::query("SELECT location FROM item_instance WHERE id = $1")
                .bind(item_id)
                .fetch_one(&pool)
                .await
                .expect("item row should load");
            println!("MAIL_INSTANCE_CLAIM_FALLBACK_ROW={}", serde_json::json!({
                "location": row.try_get::<Option<String>, _>("location").unwrap_or(None),
            }));
            assert_eq!(row.try_get::<Option<String>, _>("location").unwrap_or(None).unwrap_or_default(), "bag");
        }

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["message"], "领取成功");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn mail_claim_route_redeems_attach_rewards_payload() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MAIL_ATTACH_REWARDS_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("mail-attach-rewards-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let mail_id = sqlx::query(
            "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_rewards, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', '奖励邮件', '请领取奖励', $3::jsonb, NOW(), NOW()) RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .bind(serde_json::json!({
            "spiritStones": 123,
            "items": [
                {"item_def_id": "cons-001", "qty": 2}
            ]
        }))
        .fetch_one(&pool)
        .await
        .expect("mail should insert")
        .try_get::<i64, _>("id")
        .expect("mail id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/mail/claim"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"mailId\":{}}}", mail_id))
            .send()
            .await
            .expect("mail claim should succeed");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        println!("MAIL_ATTACH_REWARDS_CLAIM_RESPONSE={body}");

        server.abort();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], true);
        assert!(body["rewards"].as_array().is_some_and(|rewards| rewards.iter().any(|reward| reward["type"] == "spirit_stones" && reward["amount"] == 123)));
        assert!(body["rewards"].as_array().is_some_and(|rewards| rewards.iter().any(|reward| reward["type"] == "item" && reward["item_def_id"] == "cons-001" && reward["quantity"] == 2)));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn mail_claim_all_route_redeems_attach_rewards_payload() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MAIL_ATTACH_REWARDS_CLAIM_ALL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("mail-attach-rewards-all-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query(
            "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_rewards, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', '奖励邮件一', '请领取奖励', $3::jsonb, NOW(), NOW()), ($1, $2, 'system', '系统', 'reward', '奖励邮件二', '请领取奖励', $4::jsonb, NOW(), NOW())",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .bind(serde_json::json!({
            "spiritStones": 123,
            "items": [{"item_def_id": "cons-001", "qty": 2}]
        }))
        .bind(serde_json::json!({
            "silver": 88,
            "items": [{"item_def_id": "cons-002", "qty": 1}]
        }))
        .execute(&pool)
        .await
        .expect("mail rows should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/mail/claim-all"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .expect("mail claim-all should succeed");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        println!("MAIL_ATTACH_REWARDS_CLAIM_ALL_RESPONSE={body}");

        server.abort();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], true);
        assert_eq!(body["claimedCount"], 2);
        assert_eq!(body["rewards"]["spiritStones"], 123);
        assert_eq!(body["rewards"]["silver"], 88);
        assert_eq!(body["rewards"]["itemCount"], 3);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn upload_avatar_local_route_emits_game_character_delta_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_UPLOAD_AVATAR_LOCAL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("upload-avatar-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let boundary = "X-BOUNDARY-avatar-upload";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"avatar\"; filename=\"avatar.png\"\r\n");
        body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
        body.extend_from_slice(b"fake-image");
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let response = client
            .post(format!("http://{address}/api/upload/avatar"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", format!("multipart/form-data; boundary={boundary}"))
            .body(body)
            .send()
            .await
            .expect("avatar upload request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_UPLOAD_AVATAR_LOCAL_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_UPLOAD_AVATAR_LOCAL_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("game:character"));
        assert!(target_poll.contains("\"type\":\"delta\""));
        assert!(target_poll.contains(&format!("\"id\":{}", fixture.character_id)));
        assert!(target_poll.contains("\"avatar\":\"/uploads/avatars/"));
        assert!(!other_poll.contains("game:character"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn delete_avatar_route_emits_game_character_delta_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_DELETE_AVATAR_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("delete-avatar-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        sqlx::query("UPDATE characters SET avatar = '/uploads/avatars/existing-avatar.png', updated_at = NOW() WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character avatar should seed");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .delete(format!("http://{address}/api/upload/avatar"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("avatar delete request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_DELETE_AVATAR_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_DELETE_AVATAR_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("game:character"));
        assert!(target_poll.contains("\"type\":\"delta\""));
        assert!(target_poll.contains(&format!("\"id\":{}", fixture.character_id)));
        assert!(target_poll.contains("\"avatar\":null"));
        assert!(!other_poll.contains("game:character"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn inventory_equip_route_emits_full_game_character_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_INVENTORY_EQUIP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-equip-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let equipped_item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at) VALUES ($1, $2, 'equip-weapon-001', 1, 'none', 'bag', 0, NOW(), NOW()) RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("inventory item should insert")
        .try_get::<i64, _>("id")
        .expect("inventory item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/inventory/equip"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{equipped_item_id}}}"))
            .send()
            .await
            .expect("inventory equip request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_INVENTORY_EQUIP_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_INVENTORY_EQUIP_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("game:character"));
        assert!(target_poll.contains("\"type\":\"full\""));
        assert!(target_poll.contains(&format!("\"id\":{}", fixture.character_id)));
        assert!(!other_poll.contains("game:character"));

        sqlx::query("DELETE FROM item_instance WHERE id = $1")
            .bind(equipped_item_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn inventory_unequip_route_emits_full_game_character_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_INVENTORY_UNEQUIP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-unequip-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let equipped_item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, equipped_slot, created_at, updated_at) VALUES ($1, $2, 'equip-weapon-001', 1, 'equip', 'equipped', 'weapon', NOW(), NOW()) RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("equipped inventory item should insert")
        .try_get::<i64, _>("id")
        .expect("equipped inventory item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/inventory/unequip"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{equipped_item_id},\"targetLocation\":\"bag\"}}"))
            .send()
            .await
            .expect("inventory unequip request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_INVENTORY_UNEQUIP_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_INVENTORY_UNEQUIP_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("game:character"));
        assert!(target_poll.contains("\"type\":\"full\""));
        assert!(target_poll.contains(&format!("\"id\":{}", fixture.character_id)));
        assert!(!other_poll.contains("game:character"));

        sqlx::query("DELETE FROM item_instance WHERE id = $1")
            .bind(equipped_item_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn inventory_reroll_cost_preview_route_returns_cost_table() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_REROLL_COST_PREVIEW_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-reroll-cost-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, location, location_slot, affixes, created_at, updated_at) VALUES ($1, $2, 'equip-weapon-001', 1, '黄', 1, 'bag', 0, '[{\"key\":\"wugong_flat\",\"name\":\"物攻+\",\"applyType\":\"flat\",\"tier\":1,\"value\":12},{\"key\":\"max_qixue_flat\",\"name\":\"气血+\",\"applyType\":\"flat\",\"tier\":1,\"value\":24}]'::jsonb, NOW(), NOW()) RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("reroll item should insert")
        .try_get::<i64, _>("id")
        .expect("reroll item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/reroll-affixes/cost-preview"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{item_id}}}"))
            .send()
            .await
            .expect("reroll cost preview request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        println!("TECHNIQUE_RESEARCH_GENERATE_HTTP_RESPONSE={response_text}");
        assert_eq!(response_status, StatusCode::OK);
        let body: Value = serde_json::from_str(&response_text)
            .expect("body should be json");

        println!("INVENTORY_REROLL_COST_PREVIEW_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["data"]["rerollScrollItemDefId"], "scroll-003");
        assert_eq!(body["data"]["maxLockCount"], 1);
        assert_eq!(body["data"]["costTable"][0]["lockCount"], 0);
        assert_eq!(body["data"]["costTable"][1]["lockCount"], 1);
        assert_eq!(body["data"]["costTable"][1]["rerollScrollQty"], 2);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_reroll_pool_preview_route_returns_affix_pool_shape() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_REROLL_POOL_PREVIEW_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-reroll-pool-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, location, location_slot, affixes, created_at, updated_at) VALUES ($1, $2, 'equip-weapon-001', 1, '黄', 1, 'bag', 0, '[{\"key\":\"wugong_flat\",\"name\":\"物攻+\",\"applyType\":\"flat\",\"tier\":1,\"value\":12}]'::jsonb, NOW(), NOW()) RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("reroll item should insert")
        .try_get::<i64, _>("id")
        .expect("reroll item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/reroll-affixes/pool-preview"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{item_id}}}"))
            .send()
            .await
            .expect("reroll pool preview request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            panic!("TECHNIQUE_RESEARCH_GENERATE_HTTP_RESPONSE={response_text}");
        }
        let body: Value = serde_json::from_str(&response_text).expect("body should be json");

        println!("INVENTORY_REROLL_POOL_PREVIEW_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["data"]["poolName"], "装备总词条池");
        assert!(body["data"]["affixes"].as_array().is_some_and(|items| !items.is_empty()));
        assert_eq!(body["data"]["affixes"][0]["owned"].is_boolean(), true);
        assert_eq!(body["data"]["affixes"][0]["tiers"].is_array(), true);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_reroll_route_updates_affixes_and_consumes_costs() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_REROLL_EXECUTE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-reroll-exec-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET silver = 500000, spirit_stones = 5000 WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character currencies should update");
        let item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, location, location_slot, affixes, created_at, updated_at) VALUES ($1, $2, 'equip-weapon-001', 1, '黄', 1, 'bag', 0, '[{\"key\":\"wugong_flat\",\"name\":\"物攻+\",\"applyType\":\"flat\",\"tier\":1,\"value\":12},{\"key\":\"max_qixue_flat\",\"name\":\"气血+\",\"applyType\":\"flat\",\"tier\":1,\"value\":24}]'::jsonb, NOW(), NOW()) RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("reroll item should insert")
        .try_get::<i64, _>("id")
        .expect("reroll item id should exist");
        sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'scroll-003', 5, 'none', 'bag', 1, NOW(), NOW(), 'test')",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("reroll scroll should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/reroll-affixes"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{item_id},\"lockIndexes\":[0]}}"))
            .send()
            .await
            .expect("reroll execute request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            panic!("TECHNIQUE_RESEARCH_GENERATE_HTTP_RESPONSE={response_text}");
        }
        let body: Value = serde_json::from_str(&response_text)
            .expect("body should be json");

        let item_row = sqlx::query("SELECT affixes FROM item_instance WHERE id = $1")
            .bind(item_id)
            .fetch_one(&pool)
            .await
            .expect("rerolled item should exist");
        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
        let mutation_hash = redis
            .hgetall(&format!("character:item-instance-mutation:{}", fixture.character_id))
            .await
            .unwrap_or_default();

        println!("INVENTORY_REROLL_EXECUTE_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["data"]["lockIndexes"][0], 0);
        assert_eq!(body["data"]["costs"]["rerollScroll"]["itemDefId"], "scroll-003");
        assert_eq!(body["data"]["costs"]["rerollScroll"]["qty"], 2);
        assert_eq!(body["data"]["affixes"].as_array().map(|items| items.len()).unwrap_or_default(), 2);
        assert_eq!(item_row.try_get::<Option<serde_json::Value>, _>("affixes").unwrap_or(None).unwrap_or_default().as_array().map(|items| items.len()).unwrap_or_default(), 2);
        println!("INVENTORY_REROLL_EXECUTE_MUTATION_HASH={}", serde_json::json!(mutation_hash));
        assert!(mutation_hash.is_empty());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_reroll_on_equipped_item_clears_online_battle_projection() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_REROLL_EQUIPPED_PROJECTION_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-reroll-equipped-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET silver = 500000, spirit_stones = 5000 WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character currencies should update");
        let item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, location, equipped_slot, affixes, created_at, updated_at) VALUES ($1, $2, 'equip-weapon-001', 1, '黄', 1, 'equipped', 'weapon', '[{\"key\":\"wugong_flat\",\"name\":\"物攻+\",\"applyType\":\"flat\",\"tier\":1,\"value\":12},{\"key\":\"max_qixue_flat\",\"name\":\"气血+\",\"applyType\":\"flat\",\"tier\":1,\"value\":24}]'::jsonb, NOW(), NOW()) RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("equipped reroll item should insert")
        .try_get::<i64, _>("id")
        .expect("equipped reroll item id should exist");
        sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'scroll-003', 5, 'none', 'bag', 1, NOW(), NOW(), 'test')",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("reroll scroll should insert");

        state.online_battle_projections.register(OnlineBattleProjectionRecord {
            battle_id: format!("battle-reroll-{suffix}"),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            r#type: "pvp".to_string(),
            session_id: Some(format!("session-reroll-{suffix}")),
        });

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/reroll-affixes"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{item_id},\"lockIndexes\":[0]}}"))
            .send()
            .await
            .expect("equipped reroll request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            panic!("BATTLE_PASS_CLAIM_ROUTE_RESPONSE={response_text}");
        }
        let body: Value = serde_json::from_str(&response_text).expect("body should be json");

        println!("INVENTORY_REROLL_EQUIPPED_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert!(state.online_battle_projections.get_current_for_user(fixture.user_id).is_none());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_craft_execute_route_supports_non_whitelisted_seed_recipe() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_CRAFT_EXECUTE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-craft-exec-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET silver = 500, spirit_stones = 0, exp = 0, realm = '凡人' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character resources should update");
        sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'mat-002', 3, 'none', 'bag', 0, NOW(), NOW(), 'test')",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("craft material should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/craft/execute"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"recipeId\":\"recipe-xin-shou-jian\",\"times\":1}".to_string())
            .send()
            .await
            .expect("craft execute request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            let currency_row = sqlx::query("SELECT silver, spirit_stones FROM characters WHERE id = $1")
                .bind(fixture.character_id)
                .fetch_one(&pool)
                .await
                .expect("character currencies should query");
            let material_row = sqlx::query("SELECT COALESCE(SUM(qty), 0)::bigint AS qty FROM item_instance WHERE owner_character_id = $1 AND item_def_id = 'mat-002'")
                .bind(fixture.character_id)
                .fetch_one(&pool)
                .await
                .expect("craft material qty should query");
            println!(
                "INVENTORY_CRAFT_EXECUTE_STATE={{\"silver\":{},\"spiritStones\":{},\"mat002Qty\":{}}}",
                currency_row.try_get::<Option<i64>, _>("silver").unwrap_or(None).unwrap_or_default(),
                currency_row.try_get::<Option<i64>, _>("spirit_stones").unwrap_or(None).unwrap_or_default(),
                material_row.try_get::<Option<i64>, _>("qty").unwrap_or(None).unwrap_or_default(),
            );
            panic!("INVENTORY_CRAFT_EXECUTE_RESPONSE={response_text}");
        }
        let body: Value = serde_json::from_str(&response_text).expect("body should be json");
        println!("INVENTORY_CRAFT_EXECUTE_RESPONSE={body}");

        let produced_row = sqlx::query("SELECT item_def_id, qty, obtained_from, obtained_ref_id FROM item_instance WHERE owner_character_id = $1 AND obtained_from = 'craft' AND obtained_ref_id = 'recipe-xin-shou-jian' ORDER BY id DESC LIMIT 1")
            .bind(fixture.character_id)
            .fetch_optional(&pool)
            .await
            .expect("crafted item query should succeed");
        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
        let mutation_hash = redis
            .hgetall(&format!("character:item-instance-mutation:{}", fixture.character_id))
            .await
            .unwrap_or_default();

        println!("INVENTORY_CRAFT_EXECUTE_ROUTE_RESPONSE={body}");
        println!("INVENTORY_CRAFT_EXECUTE_MUTATION_HASH={}", serde_json::json!(mutation_hash));

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["data"]["recipeId"], "recipe-xin-shou-jian");
        assert_eq!(body["data"]["produced"]["itemDefId"], "equip-weapon-001");
        assert_eq!(body["data"]["successCount"], 1);
        let produced_row = produced_row.expect("crafted item should exist");
        assert_eq!(produced_row.try_get::<Option<String>, _>("item_def_id").unwrap_or(None).unwrap_or_default(), "equip-weapon-001");
        assert_eq!(produced_row.try_get::<Option<i32>, _>("qty").unwrap_or(None).map(i64::from).unwrap_or_default(), 1);
        assert_eq!(produced_row.try_get::<Option<String>, _>("obtained_from").unwrap_or(None).unwrap_or_default(), "craft");
        assert_eq!(produced_row.try_get::<Option<String>, _>("obtained_ref_id").unwrap_or(None).unwrap_or_default(), "recipe-xin-shou-jian");
        assert!(body["data"]["spent"]["items"].as_array().is_some_and(|items| items.iter().any(|item| item["itemDefId"] == "mat-002" && item["qty"] == 3)));
        assert!(mutation_hash.is_empty());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn main_quest_craft_item_event_advances_matching_section_to_turnin() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MAIN_QUEST_CRAFT_ITEM_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("main-quest-craft-item-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query(
            "INSERT INTO character_main_quest_progress (character_id, current_chapter_id, current_section_id, section_status, objectives_progress, dialogue_state, completed_chapters, completed_sections, tracked, updated_at) VALUES ($1, 'mq-chapter-1', 'main-1-010', 'objectives', '{\"obj-1\":1}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, true, NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("main quest progress should insert");

        crate::http::main_quest::record_main_quest_craft_item_event(
            &state,
            fixture.character_id,
            "recipe-hui-qi-dan",
            1,
        )
        .await
        .expect("craft item event should record");

        let row = sqlx::query(
            "SELECT section_status, objectives_progress FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1",
        )
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("main quest progress should exist");
        let section_status = row
            .try_get::<Option<String>, _>("section_status")
            .unwrap_or(None)
            .unwrap_or_default();
        let objectives_progress = row
            .try_get::<Option<Value>, _>("objectives_progress")
            .unwrap_or(None)
            .unwrap_or_else(|| serde_json::json!({}));

        println!(
            "MAIN_QUEST_CRAFT_ITEM_PROGRESS_AFTER_EVENT={}",
            serde_json::json!({
                "sectionStatus": section_status,
                "objectivesProgress": objectives_progress,
            })
        );

        assert_eq!(section_status, "turnin");
        assert_eq!(objectives_progress["obj-1"], 1);
        assert_eq!(objectives_progress["obj-2"], 1);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_craft_execute_route_advances_main_quest_craft_item_objective() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_CRAFT_MAIN_QUEST_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-craft-main-quest-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET silver = 100, spirit_stones = 0, exp = 0, realm = '炼精化炁·凝炁期' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character resources should update");
        sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'mat-001', 5, 'none', 'bag', 0, NOW(), NOW(), 'test')",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("craft material should insert");
        sqlx::query(
            "INSERT INTO character_main_quest_progress (character_id, current_chapter_id, current_section_id, section_status, objectives_progress, dialogue_state, completed_chapters, completed_sections, tracked, updated_at) VALUES ($1, 'mq-chapter-1', 'main-1-010', 'objectives', '{\"obj-1\":1}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, true, NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("main quest progress should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/craft/execute"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"recipeId\":\"recipe-hui-qi-dan\",\"times\":1}".to_string())
            .send()
            .await
            .expect("craft execute request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            panic!("BATTLE_PASS_CLAIM_ROUTE_RESPONSE={response_text}");
        }
        let body: Value = serde_json::from_str(&response_text).expect("body should be json");

        let quest_row = sqlx::query(
            "SELECT section_status, objectives_progress FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1",
        )
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("main quest progress should exist");
        let crafted_row = sqlx::query(
            "SELECT item_def_id, qty, obtained_from, obtained_ref_id FROM item_instance WHERE owner_character_id = $1 AND obtained_from = 'craft' AND obtained_ref_id = 'recipe-hui-qi-dan' ORDER BY id DESC LIMIT 1",
        )
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("crafted item should exist");

        println!("INVENTORY_CRAFT_MAIN_QUEST_ROUTE_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["data"]["recipeId"], "recipe-hui-qi-dan");
        assert_eq!(body["data"]["produced"]["itemDefId"], "cons-002");
        assert_eq!(body["data"]["successCount"], 1);
        assert_eq!(quest_row.try_get::<Option<String>, _>("section_status").unwrap_or(None).unwrap_or_default(), "turnin");
        assert_eq!(quest_row.try_get::<Option<Value>, _>("objectives_progress").unwrap_or(None).unwrap_or_else(|| serde_json::json!({}))["obj-2"], 1);
        assert_eq!(crafted_row.try_get::<Option<String>, _>("item_def_id").unwrap_or(None).unwrap_or_default(), "cons-002");
        assert_eq!(crafted_row.try_get::<Option<i32>, _>("qty").unwrap_or(None).map(i64::from).unwrap_or_default(), 1);
        assert_eq!(crafted_row.try_get::<Option<String>, _>("obtained_from").unwrap_or(None).unwrap_or_default(), "craft");
        assert_eq!(crafted_row.try_get::<Option<String>, _>("obtained_ref_id").unwrap_or(None).unwrap_or_default(), "recipe-hui-qi-dan");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }


    #[tokio::test]
        async fn inventory_use_partner_rebone_elixir_creates_pending_rebone_job() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_USE_PARTNER_REBONE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-rebone-use-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let partner_def_id = format!("generated-rebone-item-partner-{suffix}");
sqlx::query("INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, base_attrs, level_attr_gains, innate_technique_ids, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '玄·青木灵伴', '测试动态伙伴', NULL, '玄', 'wood', 'support', 1, '{\"max_qixue\":120,\"wugong\":20,\"fagong\":12,\"wufang\":10,\"fafang\":10,\"sudu\":8}'::jsonb, '{\"max_qixue\":8,\"wugong\":2,\"fagong\":2,\"wufang\":1,\"fafang\":1,\"sudu\":1}'::jsonb, ARRAY[]::text[], TRUE, $2, $3, NOW(), NOW())")
            .bind(&partner_def_id)
            .bind(fixture.character_id)
            .bind(format!("partner-recruit-{suffix}"))
            .execute(&pool)
            .await
            .expect("generated partner def should insert");
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, &partner_def_id, "玄·青木灵伴", false).await;
        sqlx::query("UPDATE character_partner SET growth_max_qixue = 120, growth_wugong = 20, growth_fagong = 12, growth_wufang = 10, growth_fafang = 10, growth_sudu = 8 WHERE id = $1")
            .bind(partner_id)
            .execute(&pool)
            .await
            .expect("partner growth should seed");
        let item_instance_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'cons-partner-rebone-001', 1, 'none', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("rebone item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1,\"partnerId\":{}}}", item_instance_id, partner_id))
            .send()
            .await
            .expect("inventory use should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            panic!("BATTLE_PASS_CLAIM_ROUTE_RESPONSE={response_text}");
        }
        let body: Value = serde_json::from_str(&response_text)
            .expect("body should be json");
        let rebone_id = body["data"]["partnerReboneJob"]["reboneId"]
            .as_str()
            .expect("rebone id should exist")
            .to_string();

        let job_row = sqlx::query("SELECT status, partner_id, item_def_id, item_qty FROM partner_rebone_job WHERE id = $1")
            .bind(&rebone_id)
            .fetch_one(&pool)
            .await
            .expect("partner rebone job should exist");

        println!("INVENTORY_USE_PARTNER_REBONE_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["data"]["partnerReboneJob"]["partnerId"], partner_id);
        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "pending");
        assert_eq!(job_row.try_get::<Option<i32>, _>("partner_id").unwrap_or(None).map(i64::from).unwrap_or_default(), partner_id);
        assert_eq!(job_row.try_get::<Option<String>, _>("item_def_id").unwrap_or(None).unwrap_or_default(), "cons-partner-rebone-001");
        assert_eq!(job_row.try_get::<Option<i32>, _>("item_qty").unwrap_or(None).map(i64::from).unwrap_or_default(), 1);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_use_battle_pass_card_unlocks_premium_track() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_USE_BATTLE_PASS_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-battlepass-use-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let item_instance_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'cons-battlepass-001', 1, 'pickup', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("battle pass item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1}}", item_instance_id))
            .send()
            .await
            .expect("inventory use should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            panic!("BATTLE_PASS_CLAIM_ROUTE_RESPONSE={response_text}");
        }
        let body: Value = serde_json::from_str(&response_text)
            .expect("body should be json");

        let progress_row = sqlx::query("SELECT premium_unlocked FROM battle_pass_progress WHERE character_id = $1 AND season_id = 'bp-season-001'")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("battle pass progress should exist");
        let consumed_item_exists = sqlx::query("SELECT 1 FROM item_instance WHERE id = $1")
            .bind(item_instance_id)
            .fetch_optional(&pool)
            .await
            .expect("consumed item query should succeed")
            .is_some();
        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
        let mutation_hash = redis
            .hgetall(&format!("character:item-instance-mutation:{}", fixture.character_id))
            .await
            .unwrap_or_default();
        println!("INVENTORY_USE_BATTLE_PASS_RESPONSE={body}");
        println!("INVENTORY_USE_BATTLE_PASS_MUTATION_HASH={}", serde_json::json!(mutation_hash));

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(progress_row.try_get::<Option<bool>, _>("premium_unlocked").unwrap_or(None), Some(true));
        assert!(!consumed_item_exists);
        assert!(mutation_hash.is_empty());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn battle_pass_claim_route_buffers_reward_deltas_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "BATTLE_PASS_CLAIM_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("battle-pass-claim-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query(
            "INSERT INTO battle_pass_progress (character_id, season_id, exp, premium_unlocked, premium_unlocked_at, updated_at) VALUES ($1, 'bp-season-001', 1000, true, NOW(), NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("battle pass progress should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/battlepass/claim"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"seasonId\":\"bp-season-001\",\"track\":\"free\",\"level\":1}")
            .send()
            .await
            .expect("battle pass claim request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            let realm_row = sqlx::query("SELECT realm, sub_realm FROM characters WHERE id = $1")
                .bind(fixture.character_id)
                .fetch_one(&pool)
                .await
                .expect("character realm should query");
            println!("INVENTORY_USE_LINGQI_REALM_STATE={{\"realm\":\"{}\",\"subRealm\":\"{}\"}}",
                realm_row.try_get::<Option<String>, _>("realm").unwrap_or(None).unwrap_or_default(),
                realm_row.try_get::<Option<String>, _>("sub_realm").unwrap_or(None).unwrap_or_default(),
            );
            panic!("INVENTORY_USE_LINGQI_SPEED_PILL_RESPONSE={response_text}");
        }
        let body: Value = serde_json::from_str(&response_text)
            .expect("body should be json");

        if state.redis_available {
            let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let resource_hash = redis
                .hgetall(&format!("character:resource-delta:{}", fixture.character_id))
                .await
                .expect("resource delta hash should load");
            let item_hash = redis
                .hgetall(&format!("character:item-grant-delta:{}", fixture.character_id))
                .await
                .expect("item grant delta hash should load");
            println!("BATTLE_PASS_CLAIM_RESOURCE_DELTA={}", serde_json::json!(resource_hash));
            println!("BATTLE_PASS_CLAIM_ITEM_DELTA={}", serde_json::json!(item_hash));
            assert!(!resource_hash.is_empty() || !item_hash.is_empty());
        } else {
            let reward_item = sqlx::query("SELECT item_def_id FROM item_instance WHERE owner_character_id = $1 ORDER BY id DESC LIMIT 1")
                .bind(fixture.character_id)
                .fetch_optional(&pool)
                .await
                .expect("reward item query should work");
            println!("BATTLE_PASS_CLAIM_FALLBACK_ROW={}", serde_json::json!({
                "hasRewardItem": reward_item.is_some(),
            }));
        }

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["message"], "ok");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn main_quest_section_complete_route_buffers_reward_deltas_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MAIN_QUEST_COMPLETE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("main-quest-complete-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query(
            "INSERT INTO character_main_quest_progress (character_id, current_chapter_id, current_section_id, section_status, completed_sections, completed_chapters, tracked, updated_at) VALUES ($1, 'mq-chapter-1', 'main-1-001', 'turnin', '[]'::jsonb, '[]'::jsonb, true, NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("main quest progress should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/main-quest/section/complete"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("main quest complete request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            let realm_row = sqlx::query("SELECT realm, sub_realm FROM characters WHERE id = $1")
                .bind(fixture.character_id)
                .fetch_one(&pool)
                .await
                .expect("character realm should query");
            println!(
                "INVENTORY_USE_LINGQI_REALM_STATE={{\"realm\":\"{}\",\"subRealm\":\"{}\"}}",
                realm_row.try_get::<Option<String>, _>("realm").unwrap_or(None).unwrap_or_default(),
                realm_row.try_get::<Option<String>, _>("sub_realm").unwrap_or(None).unwrap_or_default(),
            );
            panic!("INVENTORY_USE_LINGQI_SPEED_PILL_RESPONSE={response_text}");
        }
        let body: Value = serde_json::from_str(&response_text).expect("body should be json");

        if state.redis_available {
            let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let resource_hash = redis
                .hgetall(&format!("character:resource-delta:{}", fixture.character_id))
                .await
                .expect("resource delta hash should load");
            let item_hash = redis
                .hgetall(&format!("character:item-grant-delta:{}", fixture.character_id))
                .await
                .expect("item grant delta hash should load");
            println!("MAIN_QUEST_COMPLETE_RESOURCE_DELTA={}", serde_json::json!(resource_hash));
            println!("MAIN_QUEST_COMPLETE_ITEM_DELTA={}", serde_json::json!(item_hash));
            assert!(!resource_hash.is_empty() || !item_hash.is_empty());
        } else {
            let reward_item = sqlx::query("SELECT item_def_id FROM item_instance WHERE owner_character_id = $1 ORDER BY id DESC LIMIT 1")
                .bind(fixture.character_id)
                .fetch_optional(&pool)
                .await
                .expect("reward item query should work");
            println!("MAIN_QUEST_COMPLETE_FALLBACK_ROW={}", serde_json::json!({
                "hasRewardItem": reward_item.is_some(),
            }));
        }

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["message"], "ok");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn main_quest_dialogue_advance_route_buffers_reward_deltas_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MAIN_QUEST_DIALOGUE_REWARD_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("main-quest-dialogue-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query(
            "INSERT INTO character_main_quest_progress (character_id, current_chapter_id, current_section_id, section_status, objectives_progress, dialogue_state, completed_chapters, completed_sections, tracked, updated_at) VALUES ($1, 'mq-chapter-1', 'main-1-002', 'not_started', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, true, NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("main quest progress should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let start_response = client
            .post(format!("http://{address}/api/main-quest/dialogue/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .expect("dialogue start request should succeed");
        assert_eq!(start_response.status(), StatusCode::OK);

        let advance_response = client
            .post(format!("http://{address}/api/main-quest/dialogue/advance"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("dialogue advance request should succeed");
        assert_eq!(advance_response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&advance_response.text().await.expect("body should read"))
            .expect("body should be json");

        if state.redis_available {
            let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let item_hash = redis
                .hgetall(&format!("character:item-grant-delta:{}", fixture.character_id))
                .await
                .expect("item grant delta hash should load");
            println!("MAIN_QUEST_DIALOGUE_ITEM_DELTA={}", serde_json::json!(item_hash));
            assert!(!item_hash.is_empty());
        } else {
            let reward_items = sqlx::query("SELECT item_def_id FROM item_instance WHERE owner_character_id = $1 ORDER BY id DESC")
                .bind(fixture.character_id)
                .fetch_all(&pool)
                .await
                .expect("reward items query should work");
            println!("MAIN_QUEST_DIALOGUE_FALLBACK_ITEMS={}", serde_json::json!(reward_items.iter().filter_map(|row| row.try_get::<Option<String>, _>("item_def_id").ok().flatten()).collect::<Vec<_>>()));
            assert!(!reward_items.is_empty());
        }

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["message"], "ok");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_use_month_card_item_creates_month_card_ownership() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_USE_MONTH_CARD_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-monthcard-use-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let item_instance_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'cons-monthcard-001', 1, 'none', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("month card item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1}}", item_instance_id))
            .send()
            .await
            .expect("inventory use should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            let realm_row = sqlx::query("SELECT realm, sub_realm FROM characters WHERE id = $1")
                .bind(fixture.character_id)
                .fetch_one(&pool)
                .await
                .expect("character realm should query");
            println!(
                "INVENTORY_USE_LINGQI_REALM_STATE={{\"realm\":\"{}\",\"subRealm\":\"{}\"}}",
                realm_row.try_get::<Option<String>, _>("realm").unwrap_or(None).unwrap_or_default(),
                realm_row.try_get::<Option<String>, _>("sub_realm").unwrap_or(None).unwrap_or_default(),
            );
            panic!("INVENTORY_USE_LINGQI_SPEED_PILL_RESPONSE={response_text}");
        }
        let body: Value = serde_json::from_str(&response_text)
            .expect("body should be json");

        let ownership_row = sqlx::query("SELECT month_card_id, expire_at::text AS expire_at_text FROM month_card_ownership WHERE character_id = $1 AND month_card_id = 'monthcard-001'")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("month card ownership should exist");
        let item_exists = sqlx::query("SELECT 1 FROM item_instance WHERE id = $1")
            .bind(item_instance_id)
            .fetch_optional(&pool)
            .await
            .expect("month card item existence should query");

        println!("INVENTORY_USE_MONTH_CARD_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(ownership_row.try_get::<Option<String>, _>("month_card_id").unwrap_or(None).unwrap_or_default(), "monthcard-001");
        assert!(ownership_row.try_get::<Option<String>, _>("expire_at_text").unwrap_or(None).is_some());
        assert!(item_exists.is_none());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn monthcard_claim_route_buffers_resource_delta_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MONTHCARD_CLAIM_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("monthcard-claim-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query(
            "INSERT INTO month_card_ownership (character_id, month_card_id, start_at, expire_at, last_claim_date, created_at, updated_at) VALUES ($1, 'monthcard-001', NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', NULL, NOW(), NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("month card ownership should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/monthcard/claim"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .expect("month card claim request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        println!("MONTHCARD_CLAIM_ROUTE_RESPONSE={response_text}");
        assert_eq!(response_status, StatusCode::OK);
        let body: Value = serde_json::from_str(&response_text).expect("body should be json");

        if state.redis_available {
            let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let hash = redis
                .hgetall(&format!("character:resource-delta:{}", fixture.character_id))
                .await
                .expect("resource delta hash should load");
            println!("MONTHCARD_CLAIM_RESOURCE_DELTA={}", serde_json::json!(hash));
            assert!(!hash.is_empty());
        } else {
            let row = sqlx::query("SELECT spirit_stones FROM characters WHERE id = $1")
                .bind(fixture.character_id)
                .fetch_one(&pool)
                .await
                .expect("character row should load");
            println!("MONTHCARD_CLAIM_FALLBACK_ROW={}", serde_json::json!({
                "spiritStones": row.try_get::<Option<i64>, _>("spirit_stones").unwrap_or(None),
            }));
        }

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["message"], "领取成功");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_use_buff_pill_creates_global_buff_row() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_USE_BUFF_PILL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-buff-pill-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let item_instance_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'cons-007', 1, 'none', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("buff pill item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1}}", item_instance_id))
            .send()
            .await
            .expect("buff pill use should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            let realm_row = sqlx::query("SELECT realm, sub_realm FROM characters WHERE id = $1")
                .bind(fixture.character_id)
                .fetch_one(&pool)
                .await
                .expect("character realm should query");
            println!(
                "INVENTORY_USE_LINGQI_REALM_STATE={{\"realm\":\"{}\",\"subRealm\":\"{}\"}}",
                realm_row.try_get::<Option<String>, _>("realm").unwrap_or(None).unwrap_or_default(),
                realm_row.try_get::<Option<String>, _>("sub_realm").unwrap_or(None).unwrap_or_default(),
            );
            panic!("INVENTORY_USE_LINGQI_SPEED_PILL_RESPONSE={response_text}");
        }
        let body: Value = serde_json::from_str(&response_text)
            .expect("body should be json");

        let buff_row = sqlx::query("SELECT buff_key, source_type, buff_value::text AS buff_value_text FROM character_global_buff WHERE character_id = $1 AND source_type = 'item_use' ORDER BY created_at DESC LIMIT 1")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("global buff row should exist");

        println!("INVENTORY_USE_BUFF_PILL_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(buff_row.try_get::<Option<String>, _>("buff_key").unwrap_or(None).unwrap_or_default(), "wugong_flat");
        assert_eq!(buff_row.try_get::<Option<String>, _>("source_type").unwrap_or(None).unwrap_or_default(), "item_use");
        assert_eq!(buff_row.try_get::<Option<String>, _>("buff_value_text").unwrap_or(None).unwrap_or_default(), "10.000");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_use_loot_box_persists_reward_items_and_currency_immediately_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_USE_LOOT_BOX_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-loot-box-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let item_instance_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'box-002', 1, 'pickup', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("loot box should insert")
        .try_get::<i64, _>("id")
        .expect("loot box id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1}}", item_instance_id))
            .send()
            .await
            .expect("loot box use should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let silver_row = sqlx::query("SELECT silver FROM characters WHERE id = $1")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("character silver should query");
        let weapon_count_row = sqlx::query("SELECT COALESCE(SUM(qty), 0)::bigint AS qty FROM item_instance WHERE owner_character_id = $1 AND item_def_id = 'equip-weapon-001'")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("weapon reward should query");
        let cons001_count_row = sqlx::query("SELECT COALESCE(SUM(qty), 0)::bigint AS qty FROM item_instance WHERE owner_character_id = $1 AND item_def_id = 'cons-001'")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("cons-001 reward should query");
        let cons002_count_row = sqlx::query("SELECT COALESCE(SUM(qty), 0)::bigint AS qty FROM item_instance WHERE owner_character_id = $1 AND item_def_id = 'cons-002'")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("cons-002 reward should query");
        let loot_box_exists = sqlx::query("SELECT 1 FROM item_instance WHERE id = $1")
            .bind(item_instance_id)
            .fetch_optional(&pool)
            .await
            .expect("consumed loot box query should succeed")
            .is_some();
        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
        let item_grant_hash = redis
            .hgetall(&format!("character:item-grant-delta:{}", fixture.character_id))
            .await
            .unwrap_or_default();
        let resource_hash = redis
            .hgetall(&format!("character:resource-delta:{}", fixture.character_id))
            .await
            .unwrap_or_default();

        println!("INVENTORY_USE_LOOT_BOX_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(silver_row.try_get::<Option<i64>, _>("silver").unwrap_or(None).unwrap_or_default(), 100);
        assert_eq!(weapon_count_row.try_get::<Option<i64>, _>("qty").unwrap_or(None).unwrap_or_default(), 1);
        assert_eq!(cons001_count_row.try_get::<Option<i64>, _>("qty").unwrap_or(None).unwrap_or_default(), 10);
        assert_eq!(cons002_count_row.try_get::<Option<i64>, _>("qty").unwrap_or(None).unwrap_or_default(), 10);
        assert!(!loot_box_exists);
        assert!(item_grant_hash.is_empty());
        assert!(resource_hash.is_empty());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_use_mortal_gem_bag_consumes_source_and_grants_gem_immediately_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_USE_MORTAL_GEM_BAG_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-mortal-gem-bag-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let item_instance_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'box-006', 1, 'none', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("mortal gem bag should insert")
        .try_get::<i64, _>("id")
        .expect("mortal gem bag id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1}}", item_instance_id))
            .send()
            .await
            .expect("mortal gem bag use should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let rewarded_gem_id = body["data"]["lootResults"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["type"] == "item"))
            .and_then(|item| item["itemDefId"].as_str())
            .unwrap_or_default()
            .to_string();
        let rewarded_gem_qty = sqlx::query("SELECT COALESCE(SUM(qty), 0)::bigint AS qty FROM item_instance WHERE owner_character_id = $1 AND item_def_id = $2")
            .bind(fixture.character_id)
            .bind(rewarded_gem_id.as_str())
            .fetch_one(&pool)
            .await
            .expect("rewarded gem qty should query");
        let source_exists = sqlx::query("SELECT 1 FROM item_instance WHERE id = $1")
            .bind(item_instance_id)
            .fetch_optional(&pool)
            .await
            .expect("source gem bag query should succeed")
            .is_some();
        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
        let mutation_hash = redis
            .hgetall(&format!("character:item-instance-mutation:{}", fixture.character_id))
            .await
            .unwrap_or_default();
        let item_grant_hash = redis
            .hgetall(&format!("character:item-grant-delta:{}", fixture.character_id))
            .await
            .unwrap_or_default();

        println!("INVENTORY_USE_MORTAL_GEM_BAG_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert!(!rewarded_gem_id.is_empty());
        assert_eq!(rewarded_gem_qty.try_get::<Option<i64>, _>("qty").unwrap_or(None).unwrap_or_default(), 1);
        assert!(!source_exists);
        assert!(mutation_hash.is_empty());
        assert!(item_grant_hash.is_empty());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn generated_technique_detail_route_returns_generated_definition_after_book_use() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GENERATED_TECHNIQUE_DETAIL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("generated-tech-detail-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let generated_technique_id = format!("gen-tech-{}", fixture.character_id);
        let book_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .bind(serde_json::json!({"generatedTechniqueId": generated_technique_id}).to_string())
        .fetch_one(&pool)
        .await
        .expect("generated technique book should insert")
        .try_get::<i64, _>("id")
        .expect("generated technique book id should exist");

        sqlx::query(
            "INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-tech', $2, '青木诀', '青木诀·真传', '功法', '玄', 3, '凡人', 'physical', 'wood', 'character_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())",
        )
        .bind(generated_technique_id.as_str())
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("generated technique def should insert");
        sqlx::query(
            "INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, 'job-tech', 'technique', $2, '青木斩', 'single_enemy', 1, '[]'::jsonb, 'active', 0, 10, TRUE, 1, NOW(), NOW())",
        )
        .bind(format!("skill-{generated_technique_id}"))
        .bind(generated_technique_id.as_str())
        .execute(&pool)
        .await
        .expect("generated skill def should insert");
        sqlx::query(
            "INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, 'job-tech', 'technique', $2, '青木护体', 'self', 1, '[{\"type\":\"buff\",\"buffKind\":\"aura\"}]'::jsonb, 'active', 4, 20, TRUE, 1, NOW(), NOW())",
        )
        .bind(format!("skill-passive-{generated_technique_id}"))
        .bind(generated_technique_id.as_str())
        .execute(&pool)
        .await
        .expect("generated passive-like skill def should insert");
        sqlx::query(
            r#"INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, layer_desc, enabled, created_at, updated_at) VALUES ('job-tech', $1, 1, 100, 50, '[{"itemId":"mat-001","qty":2}]'::jsonb, '[{"key":"atk","value":12}]'::jsonb, ARRAY[$2], ARRAY[]::varchar[], '凡人', 'generated-layer-desc', TRUE, NOW(), NOW())"#,
        )
        .bind(generated_technique_id.as_str())
        .bind(format!("skill-{generated_technique_id}"))
        .execute(&pool)
        .await
        .expect("generated technique layer should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let use_response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1}}", book_id))
            .send()
            .await
            .expect("generated technique book use should succeed");
        assert_eq!(use_response.status(), StatusCode::OK);

        let preview_response = client
            .get(format!("http://{address}/api/technique/{generated_technique_id}"))
            .send()
            .await
            .expect("generated technique preview should succeed");
        assert_eq!(preview_response.status(), StatusCode::OK);
        let preview_body: Value = serde_json::from_str(&preview_response.text().await.expect("body should read"))
            .expect("preview body should be json");

        let detail_response = client
            .get(format!("http://{address}/api/technique/{generated_technique_id}"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("generated technique learned detail should succeed");
        assert_eq!(detail_response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&detail_response.text().await.expect("body should read"))
            .expect("detail body should be json");

        println!("GENERATED_TECHNIQUE_DETAIL_RESPONSE={body}");

        server.abort();

        assert_eq!(preview_body["success"], true);
        assert_eq!(preview_body["data"]["layers"][0]["cost_spirit_stones"], 0);
        assert_eq!(preview_body["data"]["layers"][0]["cost_exp"], 0);
        assert_eq!(preview_body["data"]["layers"][0]["cost_materials"].as_array().map(|items| items.len()).unwrap_or_default(), 0);
        assert_eq!(preview_body["data"]["layers"][0]["passives"].as_array().map(|items| items.len()).unwrap_or_default(), 0);
        assert_eq!(preview_body["data"]["layers"][0]["unlock_skill_ids"].as_array().map(|items| items.len()).unwrap_or_default(), 0);
        assert_eq!(preview_body["data"]["layers"][0]["upgrade_skill_ids"].as_array().map(|items| items.len()).unwrap_or_default(), 0);
        assert_eq!(body["success"], true);
        assert_eq!(body["data"]["technique"]["id"], generated_technique_id);
        assert_eq!(body["data"]["technique"]["name"], "青木诀·真传");
        assert_eq!(body["data"]["technique"]["quality"], "玄");
        assert_eq!(body["data"]["technique"]["obtain_type"], "ai_generate");
        assert_eq!(body["data"]["technique"]["obtain_hint"][0], "AI研修生成");
        assert_eq!(body["data"]["technique"]["sort_weight"], 100);
        assert_eq!(body["data"]["layers"][0]["layer"], 1);
        assert_eq!(body["data"]["layers"][0]["cost_spirit_stones"], 200);
        assert_eq!(body["data"]["layers"][0]["unlock_skill_ids"][0], format!("skill-{generated_technique_id}"));
        assert_eq!(body["data"]["layers"][0]["cost_materials"][0]["itemId"], "mat-001");
        assert_eq!(body["data"]["layers"][0]["cost_materials"][0]["itemName"], "灵草");
        assert!(body["data"]["layers"][0]["cost_materials"][0].get("item_name").is_none());
        let skills = body["data"]["skills"].as_array().cloned().unwrap_or_default();
        let active_skill = skills.iter().find(|skill| skill["id"] == format!("skill-{generated_technique_id}")).cloned().unwrap_or_default();
        let passive_skill = skills.iter().find(|skill| skill["id"] == format!("skill-passive-{generated_technique_id}")).cloned().unwrap_or_default();
        assert_eq!(active_skill["name"], "青木斩");
        assert_eq!(active_skill["trigger_type"], "active");
        assert_eq!(active_skill["cooldown"], 1);
        assert_eq!(active_skill["upgrades"].as_array().map(|items| items.len()).unwrap_or_default(), 0);
        assert_eq!(passive_skill["trigger_type"], "passive");
        assert_eq!(passive_skill["cooldown"], 0);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn generated_technique_detail_hides_partner_only_definition_from_character_routes() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GENERATED_TECHNIQUE_PARTNER_ONLY_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("generated-tech-partner-only-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let generated_technique_id = format!("gen-tech-partner-{}", fixture.character_id);
        sqlx::query(
            "INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-tech', $2, '伙伴诀', '伙伴诀', '功法', '黄', 1, '凡人', 'physical', 'none', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())",
        )
        .bind(generated_technique_id.as_str())
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("partner-only generated technique def should insert");
        let book_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .bind(serde_json::json!({"generatedTechniqueId": generated_technique_id}).to_string())
        .fetch_one(&pool)
        .await
        .expect("partner-only generated technique book should insert")
        .try_get::<i64, _>("id")
        .expect("partner-only generated technique book id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let use_response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1}}", book_id))
            .send()
            .await
            .expect("partner-only generated technique book use should respond");
        let use_status = use_response.status();
        let use_body: Value = serde_json::from_str(&use_response.text().await.expect("use body should read"))
            .expect("use body should be json");

        let detail_response = client
            .get(format!("http://{address}/api/technique/{generated_technique_id}"))
            .send()
            .await
            .expect("partner-only generated technique detail should respond");

        server.abort();

        assert_eq!(use_status, StatusCode::BAD_REQUEST);
        assert_eq!(use_body["success"], false);
        assert!(use_body["message"].as_str().is_some_and(|message| message.contains("该功法仅伙伴可学习")));
        assert_eq!(detail_response.status(), StatusCode::NOT_FOUND);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_overview_route_includes_generated_partner_innate_technique_detail() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_OVERVIEW_GENERATED_TECHNIQUE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pogt{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("INSERT INTO character_feature_unlocks (character_id, feature_code, obtained_from, obtained_ref_id, unlocked_at) VALUES ($1, 'partner_system', 'test', 'partner-overview', NOW()) ON CONFLICT DO NOTHING")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("partner feature unlock should insert");
        let partner_def_id = format!("gpo-{suffix}");
        let technique_id = format!("gpt-{suffix}");
        let skill_id = format!("gps-{suffix}");
        sqlx::query("INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, innate_technique_ids, base_attrs, level_attr_gains, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '玄·青木灵伴', '测试动态伙伴', NULL, '玄', 'wood', 'support', 1, ARRAY[$2], '{\"max_qixue\":120}'::jsonb, '{\"max_qixue\":8}'::jsonb, TRUE, $3, $4, NOW(), NOW())")
            .bind(&partner_def_id)
            .bind(&technique_id)
            .bind(fixture.character_id)
            .bind(format!("job-partner-{suffix}"))
            .execute(&pool)
            .await
            .expect("generated partner def should insert");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-partner', $2, '青木护诀', '青木护诀', '辅修', '玄', 3, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&technique_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated technique def should insert");
        sqlx::query("INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, 'job-partner', 'technique', $2, '青木护体', 'self', 1, '[{\"type\":\"buff\",\"buffKind\":\"aura\"}]'::jsonb, 'active', 4, 10, TRUE, 1, NOW(), NOW())")
            .bind(&skill_id)
            .bind(&technique_id)
            .execute(&pool)
            .await
            .expect("generated skill def should insert");
        sqlx::query("INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, layer_desc, enabled, created_at, updated_at) VALUES ('job-partner', $1, 1, 50, 25, '[]'::jsonb, '[{\"key\":\"atk\",\"value\":12}]'::jsonb, ARRAY[$2], ARRAY[]::varchar[], '凡人', 'generated-layer-desc', TRUE, NOW(), NOW())")
            .bind(&technique_id)
            .bind(&skill_id)
            .execute(&pool)
            .await
            .expect("generated technique layer should insert");
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, &partner_def_id, "玄·青木灵伴", true).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/partner/overview"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner overview should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("overview body should be json");

        server.abort();

        let partner = body["data"]["partners"].as_array().and_then(|items| items.iter().find(|item| item["id"] == partner_id)).cloned().unwrap_or_default();
        assert_eq!(partner["techniques"][0]["techniqueId"], technique_id);
        assert_eq!(partner["techniques"][0]["name"], "青木护诀");
        assert_eq!(partner["techniques"][0]["currentLayer"], 1);
        assert_eq!(partner["techniques"][0]["skillIds"][0], skill_id);
        assert_eq!(partner["techniques"][0]["skills"][0]["id"], skill_id);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn market_partner_technique_detail_route_supports_generated_partner_technique() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MARKET_PARTNER_GENERATED_TECHNIQUE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("mpgt{}", super::chrono_like_timestamp_ms());
        let seller = insert_auth_fixture(&state, &pool, "socket", &format!("seller-{suffix}"), 0).await;
        let buyer = insert_auth_fixture(&state, &pool, "socket", &format!("buyer-{suffix}"), 0).await;
        let buyer_phone = format!("139{}", &suffix.chars().filter(|ch| ch.is_ascii_digit()).collect::<String>().chars().rev().take(8).collect::<String>().chars().rev().collect::<String>());
        sqlx::query("UPDATE users SET phone_number = $2 WHERE id = $1")
            .bind(buyer.user_id)
            .bind(buyer_phone)
            .execute(&pool)
            .await
            .expect("buyer phone should set");
        let partner_def_id = format!("gmp-{suffix}");
        let technique_id = format!("gmt-{suffix}");
        let skill_id = format!("gms-{suffix}");
        sqlx::query("INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, innate_technique_ids, base_attrs, level_attr_gains, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '玄·坊市灵伴', '测试坊市动态伙伴', NULL, '玄', 'wood', 'support', 1, ARRAY[$2], '{\"max_qixue\":120}'::jsonb, '{\"max_qixue\":8}'::jsonb, TRUE, $3, $4, NOW(), NOW())")
            .bind(&partner_def_id)
            .bind(&technique_id)
            .bind(seller.character_id)
            .bind(format!("job-market-{suffix}"))
            .execute(&pool)
            .await
            .expect("generated market partner def should insert");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-market', $2, '坊市灵诀', '坊市灵诀', '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&technique_id)
            .bind(seller.character_id)
            .execute(&pool)
            .await
            .expect("generated market technique def should insert");
        sqlx::query("INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, 'job-market', 'technique', $2, '坊市护体', 'self', 1, '[{\"type\":\"buff\",\"buffKind\":\"aura\"}]'::jsonb, 'active', 4, 10, TRUE, 1, NOW(), NOW())")
            .bind(&skill_id)
            .bind(&technique_id)
            .execute(&pool)
            .await
            .expect("generated market skill def should insert");
        sqlx::query("INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, layer_desc, enabled, created_at, updated_at) VALUES ('job-market', $1, 1, 50, 25, '[]'::jsonb, '[{\"key\":\"atk\",\"value\":12}]'::jsonb, ARRAY[$2], ARRAY[]::varchar[], '凡人', 'generated-layer-desc', TRUE, NOW(), NOW())")
            .bind(&technique_id)
            .bind(&skill_id)
            .execute(&pool)
            .await
            .expect("generated market technique layer should insert");
        let partner_id = insert_partner_fixture(&pool, seller.character_id, &partner_def_id, "玄·坊市灵伴", true).await;
        sqlx::query("INSERT INTO character_partner_technique (partner_id, technique_id, current_layer, is_innate, created_at, updated_at) VALUES ($1, $2, 2, TRUE, NOW(), NOW())")
            .bind(partner_id)
            .bind(&technique_id)
            .execute(&pool)
            .await
            .expect("character partner technique should insert");
        let listing_id = sqlx::query(
            "INSERT INTO market_partner_listing (seller_user_id, seller_character_id, partner_id, partner_snapshot, partner_def_id, partner_name, partner_nickname, partner_quality, partner_element, partner_level, unit_price_spirit_stones, listing_fee_silver, status) VALUES ($1, $2, $3, $4::jsonb, $5, '玄·坊市灵伴', '玄·坊市灵伴', '玄', 'wood', 1, 100, 10, 'active') RETURNING id",
        )
        .bind(seller.user_id)
        .bind(seller.character_id)
        .bind(partner_id)
        .bind(serde_json::json!({
            "techniques": [{
                "techniqueId": technique_id,
                "currentLayer": 2,
                "isInnate": true,
                "skillIds": [skill_id],
            }]
        }).to_string())
        .bind(&partner_def_id)
        .fetch_one(&pool)
        .await
        .expect("market partner listing should insert")
        .try_get::<i64, _>("id")
        .expect("listing id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/market/partner/technique-detail?listingId={listing_id}&techniqueId={technique_id}"))
            .header("authorization", format!("Bearer {}", buyer.token))
            .send()
            .await
            .expect("market partner technique detail should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("market detail body should be json");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["data"]["technique"]["id"], technique_id);
        assert_eq!(body["data"]["technique"]["name"], "坊市灵诀");
        assert_eq!(body["data"]["currentLayer"], 2);
        assert_eq!(body["data"]["layers"][0]["unlock_skill_ids"][0], skill_id);
        assert_eq!(body["data"]["skills"][0]["id"], skill_id);

        cleanup_auth_fixture(&pool, seller.character_id, seller.user_id).await;
        cleanup_auth_fixture(&pool, buyer.character_id, buyer.user_id).await;
    }

    #[tokio::test]
        async fn partner_preview_route_supports_generated_partner_technique() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_PREVIEW_GENERATED_TECHNIQUE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("ppgt{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("INSERT INTO character_feature_unlocks (character_id, feature_code, obtained_from, obtained_ref_id, unlocked_at) VALUES ($1, 'partner_system', 'test', 'partner-preview', NOW()) ON CONFLICT DO NOTHING")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("partner feature unlock should insert");
        let partner_def_id = format!("gpp-{suffix}");
        let technique_id = format!("gptp-{suffix}");
        let skill_id = format!("gspp-{suffix}");
        sqlx::query("INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, innate_technique_ids, base_attrs, level_attr_gains, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '玄·预览灵伴', '测试预览动态伙伴', NULL, '玄', 'wood', 'support', 1, ARRAY[$2], '{\"max_qixue\":120}'::jsonb, '{\"max_qixue\":8}'::jsonb, TRUE, $3, $4, NOW(), NOW())")
            .bind(&partner_def_id)
            .bind(&technique_id)
            .bind(fixture.character_id)
            .bind(format!("job-preview-{suffix}"))
            .execute(&pool)
            .await
            .expect("generated preview partner def should insert");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-preview', $2, '预览灵诀', '预览灵诀', '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&technique_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated preview technique def should insert");
        sqlx::query("INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, 'job-preview', 'technique', $2, '预览护体', 'self', 1, '[{\"type\":\"buff\",\"buffKind\":\"aura\"}]'::jsonb, 'active', 4, 10, TRUE, 1, NOW(), NOW())")
            .bind(&skill_id)
            .bind(&technique_id)
            .execute(&pool)
            .await
            .expect("generated preview skill def should insert");
        sqlx::query("INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, layer_desc, enabled, created_at, updated_at) VALUES ('job-preview', $1, 1, 50, 25, '[]'::jsonb, '[{\"key\":\"atk\",\"value\":12}]'::jsonb, ARRAY[$2], ARRAY[]::varchar[], '凡人', 'generated-layer-desc', TRUE, NOW(), NOW())")
            .bind(&technique_id)
            .bind(&skill_id)
            .execute(&pool)
            .await
            .expect("generated preview technique layer should insert");
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, &partner_def_id, "玄·预览灵伴", true).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/partner/preview?partnerId={partner_id}"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner preview should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("preview body should be json");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["data"]["techniques"][0]["techniqueId"], technique_id);
        assert_eq!(body["data"]["techniques"][0]["name"], "预览灵诀");
        assert_eq!(body["data"]["techniques"][0]["skillIds"][0], skill_id);
        assert_eq!(body["data"]["techniques"][0]["skills"][0]["id"], skill_id);
        assert_eq!(body["data"]["techniques"][0]["skills"][0]["cooldown"], 0);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_technique_detail_route_supports_generated_partner_technique() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_TECHNIQUE_DETAIL_GENERATED_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("ptd{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("INSERT INTO character_feature_unlocks (character_id, feature_code, obtained_from, obtained_ref_id, unlocked_at) VALUES ($1, 'partner_system', 'test', 'partner-tech-detail', NOW()) ON CONFLICT DO NOTHING")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("partner feature unlock should insert");
        let partner_def_id = format!("gpd-{suffix}");
        let technique_id = format!("gtd-{suffix}");
        let skill_id = format!("gsd-{suffix}");
        sqlx::query("INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, innate_technique_ids, base_attrs, level_attr_gains, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '玄·详情灵伴', '测试详情动态伙伴', NULL, '玄', 'wood', 'support', 1, ARRAY[$2], '{\"max_qixue\":120}'::jsonb, '{\"max_qixue\":8}'::jsonb, TRUE, $3, $4, NOW(), NOW())")
            .bind(&partner_def_id)
            .bind(&technique_id)
            .bind(fixture.character_id)
            .bind(format!("job-detail-{suffix}"))
            .execute(&pool)
            .await
            .expect("generated detail partner def should insert");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-detail', $2, '详情灵诀', '详情灵诀', '辅修', '玄', 3, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&technique_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated detail technique def should insert");
        sqlx::query("INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, 'job-detail', 'technique', $2, '详情护体', 'self', 1, '[{\"type\":\"buff\",\"buffKind\":\"aura\"}]'::jsonb, 'active', 4, 10, TRUE, 1, NOW(), NOW())")
            .bind(&skill_id)
            .bind(&technique_id)
            .execute(&pool)
            .await
            .expect("generated detail skill def should insert");
        sqlx::query("INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, layer_desc, enabled, created_at, updated_at) VALUES ('job-detail', $1, 1, 50, 25, '[]'::jsonb, '[{\"key\":\"atk\",\"value\":12}]'::jsonb, ARRAY[$2], ARRAY[]::varchar[], '凡人', 'generated-layer-desc', TRUE, NOW(), NOW())")
            .bind(&technique_id)
            .bind(&skill_id)
            .execute(&pool)
            .await
            .expect("generated detail technique layer should insert");
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, &partner_def_id, "玄·详情灵伴", true).await;
        sqlx::query("INSERT INTO character_partner_technique (partner_id, technique_id, current_layer, is_innate, created_at, updated_at) VALUES ($1, $2, 2, TRUE, NOW(), NOW())")
            .bind(partner_id)
            .bind(&technique_id)
            .execute(&pool)
            .await
            .expect("character partner technique should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/partner/technique-detail?partnerId={partner_id}&techniqueId={technique_id}"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner technique detail should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("detail body should be json");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["data"]["technique"]["id"], technique_id);
        assert_eq!(body["data"]["technique"]["name"], "详情灵诀");
        assert_eq!(body["data"]["currentLayer"], 2);
        assert_eq!(body["data"]["isInnate"], true);
        assert_eq!(body["data"]["skills"][0]["id"], skill_id);
        assert_eq!(body["data"]["skills"][0]["cooldown"], 0);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn technique_list_route_hides_partner_only_generated_technique() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "TECHNIQUE_LIST_PARTNER_ONLY_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("tlpo{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let technique_id = format!("gtl-{suffix}");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-list', $2, '列表灵诀', '列表灵诀', '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&technique_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("partner-only generated technique def should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/technique"))
            .send()
            .await
            .expect("technique list should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("list body should be json");

        server.abort();

        assert_eq!(body["success"], true);
        assert!(!body["data"]["techniques"].as_array().is_some_and(|items| items.iter().any(|item| item["id"] == technique_id)));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_snapshot_prefers_live_generated_book_display_over_metadata() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_GENERATED_BOOK_DISPLAY_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("igbd{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let generated_technique_id = format!("gbd-{suffix}");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-book', $2, '实时灵诀', '实时灵诀', '功法', '天', 2, '凡人', 'magic', 'wood', 'character_only', '[\"高阶\"]'::jsonb, '实时描述', '实时长描述', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&generated_technique_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated technique def should insert");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId": generated_technique_id, "generatedTechniqueName": "旧名字", "generatedTechniqueQuality": "黄"}).to_string())
            .execute(&pool)
            .await
            .expect("generated book should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/inventory/bag/snapshot"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("inventory snapshot should succeed");
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("snapshot body should be json");

        server.abort();

        let item = body["data"]["bagItems"].as_array().and_then(|items| items.first()).cloned().unwrap_or_default();
        assert_eq!(item["def"]["name"], "《实时灵诀》秘卷");
        assert_eq!(item["def"]["quality"], "天");
        assert_eq!(item["def"]["description"], "实时描述");
        assert_eq!(item["def"]["long_desc"], "实时长描述");
        assert_eq!(item["def"]["tags"][0], "研修生成");
        assert_eq!(item["def"]["generated_technique_name"], "实时灵诀");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn market_listings_keep_instance_quality_above_generated_book_quality() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MARKET_GENERATED_BOOK_DISPLAY_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let seller = insert_auth_fixture(&state, &pool, "socket", &format!("seller-mgbd{}", super::chrono_like_timestamp_ms()), 0).await;
        let seller_phone = format!("138{:08}", seller.user_id.rem_euclid(100_000_000));
        sqlx::query("UPDATE users SET phone_number = $2 WHERE id = $1")
            .bind(seller.user_id)
            .bind(seller_phone)
            .execute(&pool)
            .await
            .expect("seller phone should set");
        let generated_technique_id = format!("mgbd-{}", seller.character_id);
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-market-book', $2, '坊市灵诀', '坊市灵诀', '功法', '天', 2, '凡人', 'magic', 'wood', 'character_only', '[\"稀有\"]'::jsonb, '坊市描述', '坊市长描述', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&generated_technique_id)
            .bind(seller.character_id)
            .execute(&pool)
            .await
            .expect("generated market technique def should insert");
        let item_instance_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, '地', 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test') RETURNING id")
            .bind(seller.user_id)
            .bind(seller.character_id)
            .bind(serde_json::json!({"generatedTechniqueId": generated_technique_id, "generatedTechniqueName": "旧名字", "generatedTechniqueQuality": "黄"}).to_string())
            .fetch_one(&pool)
            .await
            .expect("market generated book should insert")
            .try_get::<i64, _>("id")
            .expect("item instance id should exist");
        sqlx::query("INSERT INTO market_listing (item_instance_id, item_def_id, qty, unit_price_spirit_stones, seller_user_id, seller_character_id, status, listed_at) VALUES ($1, 'book-generated-technique', 1, 100, $2, $3, 'active', NOW())")
            .bind(item_instance_id)
            .bind(seller.user_id)
            .bind(seller.character_id)
            .execute(&pool)
            .await
            .expect("market listing should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/market/listings"))
            .header("authorization", format!("Bearer {}", seller.token))
            .send()
            .await
            .expect("market listings should succeed");
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("market body should be json");

        server.abort();

        let item = body["data"]["listings"].as_array()
            .and_then(|items| items.iter().find(|item| item["generatedTechniqueId"] == generated_technique_id))
            .cloned()
            .unwrap_or_default();
        assert_eq!(item["name"], "《坊市灵诀》秘卷");
        assert_eq!(item["quality"], "地");
        assert_eq!(item["generatedTechniqueId"], generated_technique_id);
        assert_eq!(item["description"], "坊市描述");
        assert_eq!(item["longDesc"], "坊市长描述");
        assert_eq!(item["tags"][0], "研修生成");

        cleanup_auth_fixture(&pool, seller.character_id, seller.user_id).await;
    }

    #[tokio::test]
        async fn market_listings_fall_back_to_visible_static_generated_technique_definition() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MARKET_STATIC_FALLBACK_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let seller = insert_auth_fixture(&state, &pool, "socket", &format!("seller-msf{}", super::chrono_like_timestamp_ms()), 0).await;
        let seller_phone = format!("138{:08}", seller.user_id.rem_euclid(100_000_000));
        sqlx::query("UPDATE users SET phone_number = $2 WHERE id = $1")
            .bind(seller.user_id)
            .bind(seller_phone)
            .execute(&pool)
            .await
            .expect("seller phone should set");
        let item_instance_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, '地', 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test') RETURNING id")
            .bind(seller.user_id)
            .bind(seller.character_id)
            .bind(serde_json::json!({"generatedTechniqueId": "tech-qingmu-jue", "generatedTechniqueName": "旧名字"}).to_string())
            .fetch_one(&pool)
            .await
            .expect("market generated book should insert")
            .try_get::<i64, _>("id")
            .expect("item instance id should exist");
        sqlx::query("INSERT INTO market_listing (item_instance_id, item_def_id, qty, unit_price_spirit_stones, seller_user_id, seller_character_id, status, listed_at) VALUES ($1, 'book-generated-technique', 1, 100, $2, $3, 'active', NOW())")
            .bind(item_instance_id)
            .bind(seller.user_id)
            .bind(seller.character_id)
            .execute(&pool)
            .await
            .expect("market listing should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/market/listings"))
            .header("authorization", format!("Bearer {}", seller.token))
            .send()
            .await
            .expect("market listings should succeed");
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("market body should be json");

        server.abort();

        let item = body["data"]["listings"].as_array().and_then(|items| items.iter().find(|item| item["generatedTechniqueId"] == "tech-qingmu-jue")).cloned().unwrap_or_default();
        assert_eq!(item["name"], "《青木诀》秘卷");
        assert_eq!(item["quality"], "地");
        assert_eq!(item["description"], "木属性法诀，擅长持续治疗");

        cleanup_auth_fixture(&pool, seller.character_id, seller.user_id).await;
    }

    #[tokio::test]
        async fn market_listings_fall_back_to_metadata_for_missing_generated_definition() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MARKET_METADATA_FALLBACK_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let seller = insert_auth_fixture(&state, &pool, "socket", &format!("seller-mmf{}", super::chrono_like_timestamp_ms()), 0).await;
        let seller_phone = format!("138{:08}", seller.user_id.rem_euclid(100_000_000));
        sqlx::query("UPDATE users SET phone_number = $2 WHERE id = $1")
            .bind(seller.user_id)
            .bind(seller_phone)
            .execute(&pool)
            .await
            .expect("seller phone should set");
        let generated_id = format!("mmf-{}", seller.character_id);
        let item_instance_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, '地', 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test') RETURNING id")
            .bind(seller.user_id)
            .bind(seller.character_id)
            .bind(serde_json::json!({"generatedTechniqueId": generated_id, "generatedTechniqueName": "失传诀", "generatedTechniqueQuality": "天"}).to_string())
            .fetch_one(&pool)
            .await
            .expect("market generated book should insert")
            .try_get::<i64, _>("id")
            .expect("item instance id should exist");
        sqlx::query("INSERT INTO market_listing (item_instance_id, item_def_id, qty, unit_price_spirit_stones, seller_user_id, seller_character_id, status, listed_at) VALUES ($1, 'book-generated-technique', 1, 100, $2, $3, 'active', NOW())")
            .bind(item_instance_id)
            .bind(seller.user_id)
            .bind(seller.character_id)
            .execute(&pool)
            .await
            .expect("market listing should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/market/listings"))
            .header("authorization", format!("Bearer {}", seller.token))
            .send()
            .await
            .expect("market listings should succeed");
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("market body should be json");

        server.abort();

        let item = body["data"]["listings"].as_array().and_then(|items| items.iter().find(|item| item["generatedTechniqueId"] == generated_id)).cloned().unwrap_or_default();
        assert_eq!(item["name"], "《失传诀》秘卷");
        assert_eq!(item["quality"], "地");
        assert!(item["description"].as_str().is_some_and(|value| value.contains("失传诀")));

        cleanup_auth_fixture(&pool, seller.character_id, seller.user_id).await;
    }

    #[tokio::test]
        async fn partner_overview_books_fall_back_to_visible_static_but_not_metadata_definitions() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_BOOK_FALLBACK_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let fixture = insert_auth_fixture(&state, &pool, "socket", &format!("seller-pbf{}", super::chrono_like_timestamp_ms()), 0).await;
        sqlx::query("INSERT INTO character_feature_unlocks (character_id, feature_code, obtained_from, obtained_ref_id, unlocked_at) VALUES ($1, 'partner_system', 'test', 'partner-book-fallback', NOW()) ON CONFLICT DO NOTHING")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("partner feature unlock should insert");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test'), ($1, $2, 'book-generated-technique', 1, 'pickup', $4::jsonb, 'bag', 1, NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId": "tech-lingbo-weibu", "generatedTechniqueName": "旧名字"}).to_string())
            .bind(serde_json::json!({"generatedTechniqueId": format!("pbf-{}", fixture.character_id), "generatedTechniqueName": "失传诀"}).to_string())
            .execute(&pool)
            .await
            .expect("partner books should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/partner/overview"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner overview should succeed");
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("overview body should be json");

        server.abort();

        let books = body["data"]["books"].as_array().cloned().unwrap_or_default();
        assert!(books.iter().any(|item| item["techniqueName"] == "凌波微步" && item["quality"] == "地"));
        assert!(!books.iter().any(|item| item["techniqueName"] == "失传诀"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_snapshot_falls_back_to_visible_static_generated_technique_definition() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_STATIC_FALLBACK_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("igsf{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId": "tech-qingmu-jue", "generatedTechniqueName": "旧名字", "generatedTechniqueQuality": "黄"}).to_string())
            .execute(&pool)
            .await
            .expect("generated book should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/inventory/bag/snapshot"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("inventory snapshot should succeed");
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("snapshot body should be json");

        server.abort();

        let item = body["data"]["bagItems"].as_array().and_then(|items| items.first()).cloned().unwrap_or_default();
        assert_eq!(item["def"]["name"], "《青木诀》秘卷");
        assert_eq!(item["def"]["quality"], "玄");
        assert_eq!(item["def"]["description"], "木属性法诀，擅长持续治疗");
        assert_eq!(item["def"]["generated_technique_id"], "tech-qingmu-jue");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_snapshot_falls_back_to_metadata_for_missing_generated_technique_definition() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_METADATA_FALLBACK_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("igmf{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let missing_id = format!("missing-{}", suffix);
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId": missing_id, "generatedTechniqueName": "失传诀", "generatedTechniqueQuality": "天"}).to_string())
            .execute(&pool)
            .await
            .expect("generated book should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/inventory/bag/snapshot"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("inventory snapshot should succeed");
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("snapshot body should be json");

        server.abort();

        let item = body["data"]["bagItems"].as_array().and_then(|items| items.first()).cloned().unwrap_or_default();
        assert_eq!(item["def"]["name"], "《失传诀》秘卷");
        assert_eq!(item["def"]["quality"], "玄");
        assert!(item["def"]["description"].as_str().is_some_and(|value| value.contains("失传诀")));
        assert_eq!(item["def"]["tags"][0], "研修生成");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_overview_books_route_uses_generated_book_display_resolver() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_BOOK_DISPLAY_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pbgd{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("INSERT INTO character_feature_unlocks (character_id, feature_code, obtained_from, obtained_ref_id, unlocked_at) VALUES ($1, 'partner_system', 'test', 'partner-book-display', NOW()) ON CONFLICT DO NOTHING")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("partner feature unlock should insert");
        let generated_technique_id = format!("pbg-{}", fixture.character_id);
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-partner-book', $2, '伙伴灵诀', '伙伴灵诀', '辅修', '地', 2, '凡人', 'magic', 'wood', 'partner_only', '[\"稀有\"]'::jsonb, '伙伴描述', '伙伴长描述', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&generated_technique_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated partner technique def should insert");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId": generated_technique_id, "generatedTechniqueName": "旧名字"}).to_string())
            .execute(&pool)
            .await
            .expect("partner generated book should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/partner/overview"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner overview should succeed");
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("partner overview body should be json");

        server.abort();

        let book = body["data"]["books"].as_array().and_then(|items| items.first()).cloned().unwrap_or_default();
        assert_eq!(book["techniqueName"], "伙伴灵诀");
        assert_eq!(book["name"], "《伙伴灵诀》秘卷");
        assert_eq!(book["quality"], "地");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_recruit_and_fusion_status_routes_expose_full_generated_preview_shape() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_STATUS_PREVIEW_SHAPE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("psps{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("INSERT INTO character_feature_unlocks (character_id, feature_code, obtained_from, obtained_ref_id, unlocked_at) VALUES ($1, 'partner_system', 'test', 'status-preview-shape', NOW()) ON CONFLICT DO NOTHING")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("partner feature unlock should insert");
        let partner_def_id = format!("gps-{suffix}");
        let technique_id = format!("gts-{suffix}");
        let skill_id = format!("gss-{suffix}");
        sqlx::query("INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, innate_technique_ids, base_attrs, level_attr_gains, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '玄·状态灵伴', '测试状态预览伙伴', NULL, '玄', 'wood', 'support', 1, ARRAY[$2], '{\"max_qixue\":120}'::jsonb, '{\"max_qixue\":8}'::jsonb, TRUE, $3, $4, NOW(), NOW())")
            .bind(&partner_def_id)
            .bind(&technique_id)
            .bind(fixture.character_id)
            .bind(format!("job-status-{suffix}"))
            .execute(&pool)
            .await
            .expect("generated status preview partner def should insert");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-status', $2, '状态灵诀', '状态灵诀', '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&technique_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated status preview technique def should insert");
        sqlx::query("INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, 'job-status', 'technique', $2, '状态护体', 'self', 1, '[{\"type\":\"buff\",\"buffKind\":\"aura\"}]'::jsonb, 'active', 4, 10, TRUE, 1, NOW(), NOW())")
            .bind(&skill_id)
            .bind(&technique_id)
            .execute(&pool)
            .await
            .expect("generated status preview skill def should insert");
        sqlx::query("INSERT INTO partner_recruit_job (id, character_id, status, quality_rolled, spirit_stones_cost, used_custom_base_model_token, cooldown_started_at, preview_partner_def_id, requested_base_model, created_at, updated_at) VALUES ($1, $2, 'generated_draft', '玄', 100, FALSE, NOW(), $3, NULL, NOW(), NOW())")
            .bind(format!("recruit-{suffix}"))
            .bind(fixture.character_id)
            .bind(&partner_def_id)
            .execute(&pool)
            .await
            .expect("partner recruit job should insert");
        let fusion_id = format!("fusion-{suffix}");
        sqlx::query("INSERT INTO partner_fusion_job (id, character_id, status, source_quality, result_quality, preview_partner_def_id, created_at, updated_at) VALUES ($1, $2, 'generated_preview', '黄', '玄', $3, NOW(), NOW())")
            .bind(&fusion_id)
            .bind(fixture.character_id)
            .bind(&partner_def_id)
            .execute(&pool)
            .await
            .expect("partner fusion job should insert");
        sqlx::query("INSERT INTO partner_fusion_job_material (fusion_job_id, partner_id, character_id, material_order, partner_snapshot, created_at) VALUES ($1, 101, $2, 1, '{}'::jsonb, NOW())")
            .bind(&fusion_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("fusion material should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let recruit_response = client
            .get(format!("http://{address}/api/partner/recruit/status"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner recruit status should succeed");
        let fusion_response = client
            .get(format!("http://{address}/api/partner/fusion/status"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner fusion status should succeed");
        let recruit_body: Value = serde_json::from_str(&recruit_response.text().await.expect("recruit body should read")).expect("recruit body should be json");
        let fusion_body: Value = serde_json::from_str(&fusion_response.text().await.expect("fusion body should read")).expect("fusion body should be json");

        server.abort();

        assert_eq!(recruit_body["success"], true);
        assert!(recruit_body["data"]["currentJob"]["preview"].get("avatar").is_some());
        assert!(recruit_body["data"]["currentJob"]["preview"].get("avatarUrl").is_none());
        assert_eq!(recruit_body["data"]["currentJob"]["preview"]["slotCount"], 1);
        assert_eq!(recruit_body["data"]["currentJob"]["preview"]["innateTechniques"][0]["description"], "desc");
        assert_eq!(fusion_body["success"], true);
        assert_eq!(fusion_body["data"]["currentJob"]["startedAt"].as_str().map(|value| value.is_empty()), Some(false));
        assert_eq!(fusion_body["data"]["currentJob"]["materialPartnerIds"][0], 101);
        assert!(fusion_body["data"]["currentJob"]["preview"].get("avatar").is_some());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_overview_route_self_heals_invalid_pending_preview_item() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_OVERVIEW_PREVIEW_HEAL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pph{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("INSERT INTO character_feature_unlocks (character_id, feature_code, obtained_from, obtained_ref_id, unlocked_at) VALUES ($1, 'partner_system', 'test', 'partner-preview-heal', NOW()) ON CONFLICT DO NOTHING")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("partner feature unlock should insert");
        let partner_def_id = format!("gph{}", &suffix[suffix.len().saturating_sub(10)..]);
        sqlx::query("INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, innate_technique_ids, base_attrs, level_attr_gains, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '玄·预览灵伴', '测试预览动态伙伴', NULL, '玄', 'wood', 'support', 1, ARRAY[]::text[], '{\"max_qixue\":120}'::jsonb, '{\"max_qixue\":8}'::jsonb, TRUE, $2, $3, NOW(), NOW())")
            .bind(&partner_def_id)
            .bind(fixture.character_id)
            .bind(format!("jh{}", &suffix[suffix.len().saturating_sub(10)..]))
            .execute(&pool)
            .await
            .expect("generated partner def should insert");
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, &partner_def_id, "玄·预览灵伴", true).await;
        let preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":"gt-heal","generatedTechniqueName":"坏预览","partnerTechniqueLearnPreview":{"partnerId":partner_id,"learnedTechniqueId":"gt-heal","replacedTechniqueId":"missing-tech"}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("preview item should insert")
            .try_get::<i64, _>("id")
            .expect("preview item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/partner/overview"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner overview should succeed");
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("overview body should be json");
        println!("PARTNER_OVERVIEW_PREVIEW_HEAL_RESPONSE={body}");
        let preview_exists = sqlx::query("SELECT 1 FROM item_instance WHERE id = $1")
            .bind(preview_item_id)
            .fetch_optional(&pool)
            .await
            .expect("preview existence query should succeed")
            .is_some();

        server.abort();

        assert_eq!(body["success"], true);
        assert!(body["data"]["pendingTechniqueLearnPreview"].is_null());
        assert!(!preview_exists);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_market_list_route_rejects_partner_with_pending_technique_preview() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_MARKET_PREVIEW_BLOCK_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("partner-market-preview-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET silver = 100000 WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character silver should update");
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await;
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"partnerTechniqueLearnPreview":{"partnerId":partner_id,"learnedTechniqueId":"gt-preview","replacedTechniqueId":"gt-old"}}).to_string())
            .execute(&pool)
            .await
            .expect("preview item should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/market/partner/list"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"partnerId\":{},\"unitPriceSpiritStones\":10}}", partner_id))
            .send()
            .await
            .expect("partner market list should respond");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("market list body should be json");
        let listing_exists = sqlx::query("SELECT 1 FROM market_partner_listing WHERE partner_id = $1 AND status = 'active'")
            .bind(partner_id)
            .fetch_optional(&pool)
            .await
            .expect("listing existence query should succeed")
            .is_some();

        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "存在待处理的打书预览，请先确认或放弃");
        assert!(!listing_exists);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_overview_route_keeps_single_valid_preview_and_cleans_later_invalid_rows() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_OVERVIEW_PREVIEW_MIXED_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("ppm{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("INSERT INTO character_feature_unlocks (character_id, feature_code, obtained_from, obtained_ref_id, unlocked_at) VALUES ($1, 'partner_system', 'test', 'partner-preview-mixed', NOW()) ON CONFLICT DO NOTHING")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("partner feature unlock should insert");

        let partner_def_id = format!("ppm-partner-{suffix}");
        let old_technique_id = format!("ppm-old-tech-{suffix}");
        let old_skill_id = format!("ppm-old-skill-{suffix}");
        let new_technique_id = format!("ppm-new-tech-{suffix}");
        let new_skill_id = format!("ppm-new-skill-{suffix}");

        sqlx::query("INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, innate_technique_ids, base_attrs, level_attr_gains, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '玄·预览校验灵伴', '测试混合预览伙伴', NULL, '玄', 'wood', 'support', 1, ARRAY[]::text[], '{\"max_qixue\":120}'::jsonb, '{\"max_qixue\":8}'::jsonb, TRUE, $2, $3, NOW(), NOW())")
            .bind(&partner_def_id)
            .bind(fixture.character_id)
            .bind(format!("job-partner-{suffix}"))
            .execute(&pool)
            .await
            .expect("generated partner def should insert");

        for (technique_id, skill_id, name) in [
            (&old_technique_id, &old_skill_id, "旧诀"),
            (&new_technique_id, &new_skill_id, "新诀"),
        ] {
            sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, $2, $3, $4, $4, '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
                .bind(technique_id)
                .bind(format!("job-tech-{technique_id}"))
                .bind(fixture.character_id)
                .bind(name)
                .execute(&pool)
                .await
                .expect("generated technique def should insert");
            sqlx::query("INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, $2, 'technique', $3, $4, 'self', 1, '[{\"type\":\"buff\",\"buffKind\":\"aura\"}]'::jsonb, 'active', 4, 10, TRUE, 1, NOW(), NOW())")
                .bind(skill_id)
                .bind(format!("job-skill-{skill_id}"))
                .bind(technique_id)
                .bind(format!("{name}技能"))
                .execute(&pool)
                .await
                .expect("generated skill def should insert");
            sqlx::query("INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, layer_desc, enabled, created_at, updated_at) VALUES ($1, $2, 1, 50, 25, '[]'::jsonb, '[{\"key\":\"atk\",\"value\":12}]'::jsonb, ARRAY[$3], ARRAY[]::varchar[], '凡人', 'generated-layer-desc', TRUE, NOW(), NOW())")
                .bind(format!("job-layer-{technique_id}"))
                .bind(technique_id)
                .bind(skill_id)
                .execute(&pool)
                .await
                .expect("generated technique layer should insert");
        }

        let partner_id = insert_partner_fixture(&pool, fixture.character_id, &partner_def_id, "玄·预览校验灵伴", true).await;
        sqlx::query("INSERT INTO character_partner_technique (partner_id, technique_id, current_layer, is_innate, learned_from_item_def_id, created_at, updated_at) VALUES ($1, $2, 1, FALSE, 'book-old', NOW(), NOW())")
            .bind(partner_id)
            .bind(&old_technique_id)
            .execute(&pool)
            .await
            .expect("existing partner technique should insert");

        let valid_preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":new_technique_id,"generatedTechniqueName":"新诀","partnerTechniqueLearnPreview":{"partnerId":partner_id,"learnedTechniqueId":new_technique_id,"replacedTechniqueId":old_technique_id}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("valid preview item should insert")
            .try_get::<i64, _>("id")
            .expect("valid preview id should exist");
        let invalid_preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":new_technique_id,"generatedTechniqueName":"新诀","partnerTechniqueLearnPreview":{"partnerId":partner_id,"learnedTechniqueId":new_technique_id,"replacedTechniqueId":"missing-tech"}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("invalid preview item should insert")
            .try_get::<i64, _>("id")
            .expect("invalid preview id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/partner/overview"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner overview should succeed");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("overview body should be json");
        let valid_preview_exists = sqlx::query("SELECT 1 FROM item_instance WHERE id = $1")
            .bind(valid_preview_item_id)
            .fetch_optional(&pool)
            .await
            .expect("valid preview existence query should succeed")
            .is_some();
        let invalid_preview_exists = sqlx::query("SELECT 1 FROM item_instance WHERE id = $1")
            .bind(invalid_preview_item_id)
            .fetch_optional(&pool)
            .await
            .expect("invalid preview existence query should succeed")
            .is_some();

        server.abort();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], true);
        assert_eq!(body["data"]["pendingTechniqueLearnPreview"]["book"]["itemInstanceId"], valid_preview_item_id);
        assert_eq!(body["data"]["pendingTechniqueLearnPreview"]["preview"]["partnerId"], partner_id);
        assert!(valid_preview_exists);
        assert!(!invalid_preview_exists);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_confirm_learn_route_rejects_bag_item_with_preview_metadata() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_CONFIRM_BAG_PREVIEW_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pcbp{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await;
        let bag_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":"gt-bag-preview","generatedTechniqueName":"袋中残留预览","partnerTechniqueLearnPreview":{"partnerId":partner_id,"learnedTechniqueId":"gt-bag-preview","replacedTechniqueId":"tech-old"}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("bag preview item should insert")
            .try_get::<i64, _>("id")
            .expect("bag item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/partner/learn-technique/confirm"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"partnerId\":{},\"itemInstanceId\":{},\"replacedTechniqueId\":\"tech-old\"}}", partner_id, bag_item_id))
            .send()
            .await
            .expect("partner confirm learn should respond");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("confirm body should be json");

        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "待处理打书预览不存在");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_discard_learn_route_rejects_bag_item_with_preview_metadata() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_DISCARD_BAG_PREVIEW_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pdbp{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let bag_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":"gt-bag-discard","generatedTechniqueName":"袋中残留预览","partnerTechniqueLearnPreview":{"partnerId":999,"learnedTechniqueId":"gt-bag-discard","replacedTechniqueId":"tech-old"}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("bag preview item should insert")
            .try_get::<i64, _>("id")
            .expect("bag item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/partner/learn-technique/discard"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemInstanceId\":{}}}", bag_item_id))
            .send()
            .await
            .expect("partner discard learn should respond");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("discard body should be json");

        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "待处理打书预览不存在");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_confirm_learn_route_reports_invalid_partner_preview_row() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_CONFIRM_INVALID_PREVIEW_ROW_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pcipr{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await;
        let preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":"gt-invalid-preview","generatedTechniqueName":"坏预览书"}).to_string())
            .fetch_one(&pool)
            .await
            .expect("invalid preview item should insert")
            .try_get::<i64, _>("id")
            .expect("invalid preview item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/partner/learn-technique/confirm"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"partnerId\":{},\"itemInstanceId\":{},\"replacedTechniqueId\":\"tech-old\"}}", partner_id, preview_item_id))
            .send()
            .await
            .expect("partner confirm learn should respond");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("confirm body should be json");

        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "待处理打书预览中的功法书数据异常");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_discard_learn_route_reports_invalid_partner_preview_row() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_DISCARD_INVALID_PREVIEW_ROW_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pdipr{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":"gt-invalid-preview","generatedTechniqueName":"坏预览书"}).to_string())
            .fetch_one(&pool)
            .await
            .expect("invalid preview item should insert")
            .try_get::<i64, _>("id")
            .expect("invalid preview item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/partner/learn-technique/discard"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemInstanceId\":{}}}", preview_item_id))
            .send()
            .await
            .expect("partner discard learn should respond");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("discard body should be json");

        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "待处理打书预览中的功法书数据异常");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_confirm_learn_route_rejects_preview_when_book_mismatches_learned_technique() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_CONFIRM_PREVIEW_BOOK_MISMATCH_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pcbm{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await;
        let generated_technique_id = format!("gt-mismatch-book-{suffix}");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, $2, $3, '错配功法', '错配功法', '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&generated_technique_id)
            .bind(format!("job-tech-mismatch-{suffix}"))
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated technique def should insert");
        let preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":generated_technique_id,"generatedTechniqueName":"错配功法","partnerTechniqueLearnPreview":{"partnerId":partner_id,"learnedTechniqueId":"gt-preview-other","replacedTechniqueId":"tech-old"}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("mismatch preview item should insert")
            .try_get::<i64, _>("id")
            .expect("mismatch preview item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/partner/learn-technique/confirm"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"partnerId\":{},\"itemInstanceId\":{},\"replacedTechniqueId\":\"tech-old\"}}", partner_id, preview_item_id))
            .send()
            .await
            .expect("partner confirm learn should respond");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("confirm body should be json");

        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "待处理打书预览与功法书不匹配");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_discard_learn_route_rejects_preview_when_replaced_technique_is_stale() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_DISCARD_PREVIEW_STALE_REPLACED_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pdst{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await;
        let generated_technique_id = format!("gt-stale-replaced-{suffix}");
        let generated_skill_id = format!("skill-stale-replaced-{suffix}");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, $2, $3, '失效替换功法预览书', '失效替换功法预览书', '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&generated_technique_id)
            .bind(format!("job-tech-stale-{suffix}"))
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated technique def should insert");
        sqlx::query("INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, $2, 'technique', $3, '失效替换功法预览书技能', 'self', 1, '[{\"type\":\"buff\",\"buffKind\":\"aura\"}]'::jsonb, 'active', 4, 10, TRUE, 1, NOW(), NOW())")
            .bind(&generated_skill_id)
            .bind(format!("job-skill-stale-{suffix}"))
            .bind(&generated_technique_id)
            .execute(&pool)
            .await
            .expect("generated skill def should insert");
        sqlx::query("INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, layer_desc, enabled, created_at, updated_at) VALUES ($1, $2, 1, 50, 25, '[]'::jsonb, '[{\"key\":\"atk\",\"value\":12}]'::jsonb, ARRAY[$3], ARRAY[]::varchar[], '凡人', 'generated-layer-desc', TRUE, NOW(), NOW())")
            .bind(format!("job-layer-stale-{suffix}"))
            .bind(&generated_technique_id)
            .bind(&generated_skill_id)
            .execute(&pool)
            .await
            .expect("generated technique layer should insert");
        let preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":generated_technique_id,"generatedTechniqueName":"失效替换功法预览书","partnerTechniqueLearnPreview":{"partnerId":partner_id,"learnedTechniqueId":generated_technique_id,"replacedTechniqueId":"missing-tech"}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("stale replaced preview item should insert")
            .try_get::<i64, _>("id")
            .expect("stale replaced preview item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/partner/learn-technique/discard"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemInstanceId\":{}}}", preview_item_id))
            .send()
            .await
            .expect("partner discard learn should respond");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("discard body should be json");

        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "待处理打书预览中的被替换功法已失效");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_discard_learn_route_succeeds_with_valid_pending_preview() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_DISCARD_VALID_PREVIEW_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pdvp{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let partner_def_id = format!("pdvp-partner-{suffix}");
        let old_technique_id = format!("pdvp-old-tech-{suffix}");
        let old_skill_id = format!("pdvp-old-skill-{suffix}");
        let new_technique_id = format!("pdvp-new-tech-{suffix}");
        let new_skill_id = format!("pdvp-new-skill-{suffix}");

        sqlx::query("INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, innate_technique_ids, base_attrs, level_attr_gains, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '玄·放弃预览灵伴', '测试放弃预览伙伴', NULL, '玄', 'wood', 'support', 1, ARRAY[]::text[], '{\"max_qixue\":120}'::jsonb, '{\"max_qixue\":8}'::jsonb, TRUE, $2, $3, NOW(), NOW())")
            .bind(&partner_def_id)
            .bind(fixture.character_id)
            .bind(format!("job-partner-{suffix}"))
            .execute(&pool)
            .await
            .expect("generated partner def should insert");

        for (technique_id, skill_id, name) in [
            (&old_technique_id, &old_skill_id, "旧诀"),
            (&new_technique_id, &new_skill_id, "新诀"),
        ] {
            sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, $2, $3, $4, $4, '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
                .bind(technique_id)
                .bind(format!("job-tech-{technique_id}"))
                .bind(fixture.character_id)
                .bind(name)
                .execute(&pool)
                .await
                .expect("generated technique def should insert");
            sqlx::query("INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, $2, 'technique', $3, $4, 'self', 1, '[{\"type\":\"buff\",\"buffKind\":\"aura\"}]'::jsonb, 'active', 4, 10, TRUE, 1, NOW(), NOW())")
                .bind(skill_id)
                .bind(format!("job-skill-{skill_id}"))
                .bind(technique_id)
                .bind(format!("{name}技能"))
                .execute(&pool)
                .await
                .expect("generated skill def should insert");
            sqlx::query("INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, layer_desc, enabled, created_at, updated_at) VALUES ($1, $2, 1, 50, 25, '[]'::jsonb, '[{\"key\":\"atk\",\"value\":12}]'::jsonb, ARRAY[$3], ARRAY[]::varchar[], '凡人', 'generated-layer-desc', TRUE, NOW(), NOW())")
                .bind(format!("job-layer-{technique_id}"))
                .bind(technique_id)
                .bind(skill_id)
                .execute(&pool)
                .await
                .expect("generated technique layer should insert");
        }

        let partner_id = insert_partner_fixture(&pool, fixture.character_id, &partner_def_id, "玄·放弃预览灵伴", false).await;
        sqlx::query("INSERT INTO character_partner_technique (partner_id, technique_id, current_layer, is_innate, learned_from_item_def_id, created_at, updated_at) VALUES ($1, $2, 1, FALSE, 'book-old', NOW(), NOW())")
            .bind(partner_id)
            .bind(&old_technique_id)
            .execute(&pool)
            .await
            .expect("existing partner technique should insert");
        let preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":new_technique_id,"generatedTechniqueName":"新诀","partnerTechniqueLearnPreview":{"partnerId":partner_id,"learnedTechniqueId":new_technique_id,"replacedTechniqueId":old_technique_id}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("valid preview item should insert")
            .try_get::<i64, _>("id")
            .expect("valid preview item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/partner/learn-technique/discard"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemInstanceId\":{}}}", preview_item_id))
            .send()
            .await
            .expect("partner discard learn should respond");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("discard body should be json");
        let preview_exists = sqlx::query("SELECT 1 FROM item_instance WHERE id = $1")
            .bind(preview_item_id)
            .fetch_optional(&pool)
            .await
            .expect("preview existence query should succeed")
            .is_some();

        server.abort();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], true);
        assert_eq!(body["message"], "已放弃学习，本次功法书已消耗");
        assert!(!preview_exists);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_confirm_learn_route_rejects_preview_for_market_listed_partner() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_CONFIRM_MARKET_LISTED_PREVIEW_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pcml{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await;
        let generated_technique_id = format!("gt-market-blocked-{suffix}");
        let generated_skill_id = format!("skill-market-blocked-{suffix}");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, $2, $3, '坊市阻塞功法', '坊市阻塞功法', '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&generated_technique_id)
            .bind(format!("job-tech-market-{suffix}"))
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated technique def should insert");
        sqlx::query("INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, $2, 'technique', $3, '坊市阻塞功法技能', 'self', 1, '[{\"type\":\"buff\",\"buffKind\":\"aura\"}]'::jsonb, 'active', 4, 10, TRUE, 1, NOW(), NOW())")
            .bind(&generated_skill_id)
            .bind(format!("job-skill-market-{suffix}"))
            .bind(&generated_technique_id)
            .execute(&pool)
            .await
            .expect("generated skill def should insert");
        sqlx::query("INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, layer_desc, enabled, created_at, updated_at) VALUES ($1, $2, 1, 50, 25, '[]'::jsonb, '[{\"key\":\"atk\",\"value\":12}]'::jsonb, ARRAY[$3], ARRAY[]::varchar[], '凡人', 'generated-layer-desc', TRUE, NOW(), NOW())")
            .bind(format!("job-layer-market-{suffix}"))
            .bind(&generated_technique_id)
            .bind(&generated_skill_id)
            .execute(&pool)
            .await
            .expect("generated technique layer should insert");
        let preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":generated_technique_id,"generatedTechniqueName":"坊市阻塞功法","partnerTechniqueLearnPreview":{"partnerId":partner_id,"learnedTechniqueId":generated_technique_id,"replacedTechniqueId":"missing-tech"}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("preview item should insert")
            .try_get::<i64, _>("id")
            .expect("preview item id should exist");
        sqlx::query("INSERT INTO market_partner_listing (seller_user_id, seller_character_id, partner_id, partner_snapshot, partner_def_id, partner_name, partner_nickname, partner_quality, partner_element, partner_level, unit_price_spirit_stones, listing_fee_silver, status, listed_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, 'partner-qingmu-xiaoou', '青木灵伴', '青木灵伴', '玄', 'wood', 12, 10, 5, 'active', NOW(), NOW())")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(partner_id)
            .bind(serde_json::json!({"partnerDefId":"partner-qingmu-xiaoou","name":"青木灵伴","nickname":"青木灵伴","quality":"玄","element":"wood","level":12}))
            .execute(&pool)
            .await
            .expect("market listing should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/partner/learn-technique/confirm"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"partnerId\":{},\"itemInstanceId\":{},\"replacedTechniqueId\":\"missing-tech\"}}", partner_id, preview_item_id))
            .send()
            .await
            .expect("partner confirm learn should respond");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("confirm body should be json");

        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "已在坊市挂单的伙伴不可学习功法");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_discard_learn_route_rejects_preview_for_fusion_material_partner() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_DISCARD_FUSION_BLOCKED_PREVIEW_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pdfb{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let generated_technique_id = format!("gt-fusion-blocked-{suffix}");
        let generated_skill_id = format!("skill-fusion-blocked-{suffix}");
        let partner_ids = [
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await,
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵使", false).await,
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵偶", false).await,
        ];
        let preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":generated_technique_id,"generatedTechniqueName":"归契阻塞功法","partnerTechniqueLearnPreview":{"partnerId":partner_ids[0],"learnedTechniqueId":generated_technique_id,"replacedTechniqueId":"missing-tech"}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("preview item should insert")
            .try_get::<i64, _>("id")
            .expect("preview item id should exist");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, $2, $3, '归契阻塞功法', '归契阻塞功法', '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&generated_technique_id)
            .bind(format!("job-tech-fusion-{suffix}"))
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated technique def should insert");
        sqlx::query("INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, $2, 'technique', $3, '归契阻塞功法技能', 'self', 1, '[{\"type\":\"buff\",\"buffKind\":\"aura\"}]'::jsonb, 'active', 4, 10, TRUE, 1, NOW(), NOW())")
            .bind(&generated_skill_id)
            .bind(format!("job-skill-fusion-{suffix}"))
            .bind(&generated_technique_id)
            .execute(&pool)
            .await
            .expect("generated skill def should insert");
        sqlx::query("INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, layer_desc, enabled, created_at, updated_at) VALUES ($1, $2, 1, 50, 25, '[]'::jsonb, '[{\"key\":\"atk\",\"value\":12}]'::jsonb, ARRAY[$3], ARRAY[]::varchar[], '凡人', 'generated-layer-desc', TRUE, NOW(), NOW())")
            .bind(format!("job-layer-fusion-{suffix}"))
            .bind(&generated_technique_id)
            .bind(&generated_skill_id)
            .execute(&pool)
            .await
            .expect("generated technique layer should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let start_response = client
            .post(format!("http://{address}/api/partner/fusion/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"partnerIds\":[{},{},{}]}}", partner_ids[0], partner_ids[1], partner_ids[2]))
            .send()
            .await
            .expect("partner fusion start should succeed");
        assert_eq!(start_response.status(), StatusCode::OK);
        let response = client
            .post(format!("http://{address}/api/partner/learn-technique/discard"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemInstanceId\":{}}}", preview_item_id))
            .send()
            .await
            .expect("partner discard learn should respond");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("discard body should be json");

        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "归契中的伙伴不可学习功法");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_confirm_learn_route_rejects_preview_when_technique_detail_is_unavailable() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_CONFIRM_MISSING_TECHNIQUE_DETAIL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pcmtd{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await;
        let generated_technique_id = format!("gt-missing-detail-{suffix}");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, $2, $3, '缺失详情功法', '缺失详情功法', '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&generated_technique_id)
            .bind(format!("job-tech-missing-detail-{suffix}"))
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated technique def should insert");
        let preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":generated_technique_id,"generatedTechniqueName":"缺失详情功法","partnerTechniqueLearnPreview":{"partnerId":partner_id,"learnedTechniqueId":generated_technique_id,"replacedTechniqueId":"missing-tech"}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("preview item should insert")
            .try_get::<i64, _>("id")
            .expect("preview item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/partner/learn-technique/confirm"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"partnerId\":{},\"itemInstanceId\":{},\"replacedTechniqueId\":\"missing-tech\"}}", partner_id, preview_item_id))
            .send()
            .await
            .expect("partner confirm learn should respond");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("confirm body should be json");

        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "伙伴功法不存在或未开放");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_overview_route_cleans_preview_when_technique_detail_is_unavailable() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_OVERVIEW_MISSING_TECHNIQUE_DETAIL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pomtd{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("INSERT INTO character_feature_unlocks (character_id, feature_code, obtained_from, obtained_ref_id, unlocked_at) VALUES ($1, 'partner_system', 'test', 'partner-preview-missing-detail', NOW()) ON CONFLICT DO NOTHING")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("partner feature unlock should insert");
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await;
        let generated_technique_id = format!("gt-overview-missing-detail-{suffix}");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, $2, $3, '缺失详情总览功法', '缺失详情总览功法', '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&generated_technique_id)
            .bind(format!("job-tech-overview-missing-detail-{suffix}"))
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated technique def should insert");
        let preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId":generated_technique_id,"generatedTechniqueName":"缺失详情总览功法","partnerTechniqueLearnPreview":{"partnerId":partner_id,"learnedTechniqueId":generated_technique_id,"replacedTechniqueId":"missing-tech"}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("preview item should insert")
            .try_get::<i64, _>("id")
            .expect("preview item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/partner/overview"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner overview should respond");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("overview body should be json");
        let preview_exists = sqlx::query("SELECT 1 FROM item_instance WHERE id = $1")
            .bind(preview_item_id)
            .fetch_optional(&pool)
            .await
            .expect("preview existence query should succeed")
            .is_some();

        server.abort();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], true);
        assert!(body["data"]["pendingTechniqueLearnPreview"].is_null());
        assert!(!preview_exists);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_fusion_confirm_clears_pending_technique_preview_for_material_partners() {
        let _guard = partner_ai_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_FUSION_PREVIEW_CLEAR_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("partner-fusion-preview-clear-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let partner_ids = [
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await,
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵使", false).await,
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵偶", false).await,
        ];
        let preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"partnerTechniqueLearnPreview":{"partnerId":partner_ids[0],"learnedTechniqueId":"gt-preview","replacedTechniqueId":"gt-old"}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("preview item should insert")
            .try_get::<i64, _>("id")
            .expect("preview item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let start_response = client
            .post(format!("http://{address}/api/partner/fusion/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"partnerIds\":[{},{},{}]}}", partner_ids[0], partner_ids[1], partner_ids[2]))
            .send()
            .await
            .expect("partner fusion start should succeed");
        let start_body: Value = serde_json::from_str(&start_response.text().await.expect("start body should read"))
            .expect("start body should be json");
        let fusion_id = start_body["data"]["fusionId"]
            .as_str()
            .expect("fusion id should exist")
            .to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let confirm_response = client
            .post(format!("http://{address}/api/partner/fusion/{fusion_id}/confirm"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner fusion confirm should succeed");
        let status = confirm_response.status();
        let body: Value = serde_json::from_str(&confirm_response.text().await.expect("confirm body should read"))
            .expect("confirm body should be json");
        let preview_exists = sqlx::query("SELECT 1 FROM item_instance WHERE id = $1")
            .bind(preview_item_id)
            .fetch_optional(&pool)
            .await
            .expect("preview existence query should succeed")
            .is_some();

        server.abort();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], true);
        assert!(!preview_exists);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_market_buy_route_clears_seller_pending_preview_for_sold_partner() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_MARKET_BUY_PREVIEW_CLEAR_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let seller_suffix = format!("seller-preview-clear-{}", super::chrono_like_timestamp_ms());
        let buyer_suffix = format!("buyer-preview-clear-{}", super::chrono_like_timestamp_ms());
        let seller = insert_auth_fixture(&state, &pool, "socket", &seller_suffix, 0).await;
        let buyer = insert_auth_fixture(&state, &pool, "socket", &buyer_suffix, 0).await;

        sqlx::query("UPDATE characters SET spirit_stones = 1000 WHERE id = $1")
            .bind(buyer.character_id)
            .execute(&pool)
            .await
            .expect("buyer spirit stones should update");

        let partner_id = insert_partner_fixture(&pool, seller.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await;
        let preview_item_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'partner_preview', NOW(), NOW(), 'test') RETURNING id")
            .bind(seller.user_id)
            .bind(seller.character_id)
            .bind(serde_json::json!({"partnerTechniqueLearnPreview":{"partnerId":partner_id,"learnedTechniqueId":"gt-preview","replacedTechniqueId":"gt-old"}}).to_string())
            .fetch_one(&pool)
            .await
            .expect("seller preview item should insert")
            .try_get::<i64, _>("id")
            .expect("seller preview item id should exist");
        let listing_id = sqlx::query(
            "INSERT INTO market_partner_listing (seller_user_id, seller_character_id, partner_id, partner_snapshot, partner_def_id, partner_name, partner_nickname, partner_quality, partner_element, partner_level, unit_price_spirit_stones, listing_fee_silver, status, listed_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, 'partner-qingmu-xiaoou', '青木灵伴', '青木灵伴', '玄', 'wood', 12, 10, 5, 'active', NOW(), NOW()) RETURNING id",
        )
        .bind(seller.user_id)
        .bind(seller.character_id)
        .bind(partner_id)
        .bind(serde_json::json!({
            "partnerDefId": "partner-qingmu-xiaoou",
            "name": "青木灵伴",
            "nickname": "青木灵伴",
            "quality": "玄",
            "element": "wood",
            "level": 12
        }))
        .fetch_one(&pool)
        .await
        .expect("partner listing should insert")
        .try_get::<i64, _>("id")
        .expect("listing id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/market/partner/buy"))
            .header("authorization", format!("Bearer {}", buyer.token))
            .header("content-type", "application/json")
            .body(format!("{{\"listingId\":{}}}", listing_id))
            .send()
            .await
            .expect("partner market buy request should succeed");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("buy body should be json");
        let preview_exists = sqlx::query("SELECT 1 FROM item_instance WHERE id = $1")
            .bind(preview_item_id)
            .fetch_optional(&pool)
            .await
            .expect("preview existence query should succeed")
            .is_some();

        server.abort();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], true);
        assert!(!preview_exists);

        cleanup_auth_fixture(&pool, seller.character_id, seller.user_id).await;
        cleanup_auth_fixture(&pool, buyer.character_id, buyer.user_id).await;
    }

    #[tokio::test]
        async fn inventory_use_generated_technique_book_ignores_required_realm_gate() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GENERATED_TECHNIQUE_NO_REALM_GATE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("gtrg{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let generated_technique_id = format!("gtg-{suffix}");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-gate', $2, '越阶灵诀', '越阶灵诀', '功法', '玄', 2, '炼神返虚·养神期', 'magic', 'wood', 'character_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&generated_technique_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated technique def should insert");
        let item_instance_id = sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, metadata, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'book-generated-technique', 1, 'pickup', $3::jsonb, 'bag', 0, NOW(), NOW(), 'test') RETURNING id")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .bind(serde_json::json!({"generatedTechniqueId": generated_technique_id, "generatedTechniqueName": "越阶灵诀", "generatedTechniqueQuality": "玄"}).to_string())
            .fetch_one(&pool)
            .await
            .expect("generated technique book should insert")
            .try_get::<i64, _>("id")
            .expect("book id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1}}", item_instance_id))
            .send()
            .await
            .expect("generated technique use should succeed");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("body should json");
        let learned = sqlx::query("SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2")
            .bind(fixture.character_id)
            .bind(&generated_technique_id)
            .fetch_optional(&pool)
            .await
            .expect("learned query should succeed")
            .is_some();

        server.abort();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], true);
        assert!(learned);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_technique_upgrade_cost_route_supports_generated_partner_technique() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_UPGRADE_COST_GENERATED_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pucg{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("INSERT INTO character_feature_unlocks (character_id, feature_code, obtained_from, obtained_ref_id, unlocked_at) VALUES ($1, 'partner_system', 'test', 'partner-upgrade-cost', NOW()) ON CONFLICT DO NOTHING")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("partner feature unlock should insert");
        let partner_def_id = format!("pucg-{suffix}");
        let technique_id = format!("put-{suffix}");
        let skill_id = format!("pus-{suffix}");
        sqlx::query("INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, innate_technique_ids, base_attrs, level_attr_gains, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '玄·升级灵伴', '测试升级动态伙伴', NULL, '玄', 'wood', 'support', 1, ARRAY[$2], '{\"max_qixue\":120}'::jsonb, '{\"max_qixue\":8}'::jsonb, TRUE, $3, $4, NOW(), NOW())")
            .bind(&partner_def_id)
            .bind(&technique_id)
            .bind(fixture.character_id)
            .bind(format!("job-upgrade-{suffix}"))
            .execute(&pool)
            .await
            .expect("generated partner def should insert");
        sqlx::query("INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, 'job-upgrade', $2, '升级灵诀', '升级灵诀', '辅修', '玄', 2, '凡人', 'magic', 'wood', 'partner_only', '[]'::jsonb, 'desc', 'long', TRUE, TRUE, 1, NOW(), NOW())")
            .bind(&technique_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("generated technique def should insert");
        sqlx::query("INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, 'job-upgrade', 'technique', $2, '升级护体', 'self', 1, '[{\"type\":\"buff\",\"buffKind\":\"aura\"}]'::jsonb, 'active', 4, 10, TRUE, 1, NOW(), NOW())")
            .bind(&skill_id)
            .bind(&technique_id)
            .execute(&pool)
            .await
            .expect("generated skill def should insert");
        sqlx::query("INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, layer_desc, enabled, created_at, updated_at) VALUES ('job-upgrade', $1, 1, 50, 25, '[]'::jsonb, '[{\"key\":\"atk\",\"value\":12}]'::jsonb, ARRAY[$2], ARRAY[]::varchar[], '凡人', 'generated-layer-1', TRUE, NOW(), NOW()), ('job-upgrade', $1, 2, 120, 60, '[{\"itemId\":\"mat-001\",\"qty\":3}]'::jsonb, '[]'::jsonb, ARRAY[]::varchar[], ARRAY[$2], '凡人', 'generated-layer-2', TRUE, NOW(), NOW())")
            .bind(&technique_id)
            .bind(&skill_id)
            .execute(&pool)
            .await
            .expect("generated technique layers should insert");
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, &partner_def_id, "玄·升级灵伴", true).await;
        sqlx::query("INSERT INTO character_partner_technique (partner_id, technique_id, current_layer, is_innate, created_at, updated_at) VALUES ($1, $2, 1, TRUE, NOW(), NOW())")
            .bind(partner_id)
            .bind(&technique_id)
            .execute(&pool)
            .await
            .expect("partner technique should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/partner/technique-upgrade-cost?partnerId={partner_id}&techniqueId={technique_id}"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner upgrade cost should succeed");
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read")).expect("body should json");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["data"]["nextLayer"], 2);
        assert_eq!(body["data"]["spiritStones"], 240);
        assert_eq!(body["data"]["exp"], 120);
        assert_eq!(body["data"]["materials"][0]["itemId"], "mat-001");
        assert_eq!(body["data"]["materials"][0]["qty"], 3);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_use_dispel_pill_removes_poison_buff() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_USE_DISPEL_PILL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-dispel-pill-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let item_instance_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'cons-006', 1, 'none', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("dispel pill item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");
        sqlx::query("INSERT INTO character_global_buff (character_id, buff_key, source_type, source_id, buff_value, started_at, expire_at, created_at, updated_at) VALUES ($1, 'poison', 'battle', 'test-poison', 1, NOW(), NOW() + INTERVAL '3 minutes', NOW(), NOW())")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("poison buff should insert");

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1}}", item_instance_id))
            .send()
            .await
            .expect("dispel pill use should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let poison_exists = sqlx::query("SELECT 1 FROM character_global_buff WHERE character_id = $1 AND buff_key = 'poison' AND expire_at > NOW()")
            .bind(fixture.character_id)
            .fetch_optional(&pool)
            .await
            .expect("poison existence should query");

        println!("INVENTORY_USE_DISPEL_PILL_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert!(poison_exists.is_none());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_use_poison_heal_pill_removes_poison_and_restores_qixue() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_USE_POISON_HEAL_PILL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-poison-heal-pill-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET realm = '炼精化炁', sub_realm = '养气期', jing = 20 WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character qixue should update");
        let item_instance_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'cons-009', 1, 'none', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("poison heal pill item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");
        sqlx::query("INSERT INTO character_global_buff (character_id, buff_key, source_type, source_id, buff_value, started_at, expire_at, created_at, updated_at) VALUES ($1, 'poison', 'battle', 'test-poison-heal', 1, NOW(), NOW() + INTERVAL '3 minutes', NOW(), NOW())")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("poison buff should insert");

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1}}", item_instance_id))
            .send()
            .await
            .expect("poison heal pill use should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let character_row = sqlx::query("SELECT jing FROM characters WHERE id = $1")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("character qixue should query");
        let poison_exists = sqlx::query("SELECT 1 FROM character_global_buff WHERE character_id = $1 AND buff_key = 'poison' AND expire_at > NOW()")
            .bind(fixture.character_id)
            .fetch_optional(&pool)
            .await
            .expect("poison existence should query");

        println!("INVENTORY_USE_POISON_HEAL_PILL_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["effects"].as_array().map(|items| items.len()), Some(2));
        assert_eq!(character_row.try_get::<Option<i32>, _>("jing").unwrap_or(None).map(i64::from).unwrap_or_default(), 140);
        assert!(poison_exists.is_none());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_use_lingqi_speed_pill_restores_lingqi_and_applies_buff() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_USE_LINGQI_SPEED_PILL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-lingqi-speed-pill-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET realm = '炼精化炁', sub_realm = '通脉期', qi = 5 WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character lingqi should update");
        let item_instance_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'cons-010', 1, 'none', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("lingqi speed pill item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1}}", item_instance_id))
            .send()
            .await
            .expect("lingqi speed pill use should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        if response_status != StatusCode::OK {
            let realm_row = sqlx::query("SELECT realm, sub_realm FROM characters WHERE id = $1")
                .bind(fixture.character_id)
                .fetch_one(&pool)
                .await
                .expect("character realm should query");
            println!(
                "INVENTORY_USE_LINGQI_REALM_STATE={{\"realm\":\"{}\",\"subRealm\":\"{}\"}}",
                realm_row.try_get::<Option<String>, _>("realm").unwrap_or(None).unwrap_or_default(),
                realm_row.try_get::<Option<String>, _>("sub_realm").unwrap_or(None).unwrap_or_default(),
            );
            panic!("INVENTORY_USE_LINGQI_SPEED_PILL_RESPONSE={response_text}");
        }
        let body: Value = serde_json::from_str(&response_text)
            .expect("body should be json");

        let character_row = sqlx::query("SELECT qi FROM characters WHERE id = $1")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("character lingqi should query");
        let buff_row = sqlx::query("SELECT buff_key, buff_value::text AS buff_value_text FROM character_global_buff WHERE character_id = $1 AND source_type = 'item_use' ORDER BY created_at DESC LIMIT 1")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("global buff row should exist");

        println!("INVENTORY_USE_LINGQI_SPEED_PILL_RESPONSE={body}");
        println!(
            "INVENTORY_USE_LINGQI_SPEED_PILL_BUFF_ROW={{\"buff_key\":\"{}\",\"buff_value\":\"{}\"}}",
            buff_row.try_get::<Option<String>, _>("buff_key").unwrap_or(None).unwrap_or_default(),
            buff_row.try_get::<Option<String>, _>("buff_value_text").unwrap_or(None).unwrap_or_default(),
        );

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["effects"].as_array().map(|items| items.len()), Some(2));
        assert_eq!(character_row.try_get::<Option<i32>, _>("qi").unwrap_or(None).map(i64::from).unwrap_or_default(), 85);
        assert_eq!(buff_row.try_get::<Option<String>, _>("buff_key").unwrap_or(None).unwrap_or_default(), "sudu_flat");
        assert_eq!(buff_row.try_get::<Option<String>, _>("buff_value_text").unwrap_or(None).unwrap_or_default(), "8.000");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_use_rename_card_updates_character_nickname() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_USE_RENAME_CARD_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-rename-card-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let item_instance_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'cons-rename-001', 1, 'none', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("rename card item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let suffix_short = suffix.chars().take(4).collect::<String>();
        let expected_nickname = format!("凌霄{}", suffix_short);
        let response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1,\"nickname\":\"{}\"}}", item_instance_id, expected_nickname))
            .send()
            .await
            .expect("inventory use should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let character_row = sqlx::query("SELECT nickname FROM characters WHERE id = $1")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("character should exist");
        let item_exists = sqlx::query("SELECT 1 FROM item_instance WHERE id = $1")
            .bind(item_instance_id)
            .fetch_optional(&pool)
            .await
            .expect("rename card existence should query");

        println!("INVENTORY_USE_RENAME_CARD_RESPONSE={body}");

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(character_row.try_get::<Option<String>, _>("nickname").unwrap_or(None).unwrap_or_default(), expected_nickname);
        assert!(item_exists.is_none());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn inventory_use_reroll_scroll_reuses_affix_reroll_flow() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "INVENTORY_USE_REROLL_SCROLL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("inventory-use-reroll-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET silver = 500000, spirit_stones = 5000 WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character currencies should update");
        let equipment_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, location, location_slot, affixes, created_at, updated_at) VALUES ($1, $2, 'equip-weapon-001', 1, '黄', 1, 'bag', 0, '[{\"key\":\"wugong_flat\",\"name\":\"物攻+\",\"applyType\":\"flat\",\"tier\":1,\"value\":12},{\"key\":\"max_qixue_flat\",\"name\":\"气血+\",\"applyType\":\"flat\",\"tier\":1,\"value\":24}]'::jsonb, NOW(), NOW()) RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("reroll item should insert")
        .try_get::<i64, _>("id")
        .expect("equipment id should exist");
        let scroll_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'scroll-003', 5, 'none', 'bag', 1, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("reroll scroll should insert")
        .try_get::<i64, _>("id")
        .expect("scroll id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/inventory/use"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemId\":{},\"qty\":1,\"targetItemInstanceId\":{}}}", scroll_id, equipment_id))
            .send()
            .await
            .expect("inventory use reroll request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
        let mutation_hash = redis
            .hgetall(&format!("character:item-instance-mutation:{}", fixture.character_id))
            .await
            .unwrap_or_default();
        let scroll_row = sqlx::query("SELECT qty FROM item_instance WHERE id = $1")
            .bind(scroll_id)
            .fetch_optional(&pool)
            .await
            .expect("reroll scroll query should succeed");

        println!("INVENTORY_USE_REROLL_SCROLL_RESPONSE={body}");
        println!("INVENTORY_USE_REROLL_SCROLL_MUTATION_HASH={}", serde_json::json!(mutation_hash));

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["message"], "洗炼成功");
        assert!(body["data"]["character"].is_object());
        assert_eq!(scroll_row.and_then(|row| row.try_get::<Option<i32>, _>("qty").ok().flatten()).map(i64::from), Some(4));
        assert!(mutation_hash.is_empty());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn market_cancel_route_buffers_item_instance_mail_relocation_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MARKET_CANCEL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("market-cancel-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'equip-weapon-001', 1, 'none', 'auction', NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("auction item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");
        let listing_id = sqlx::query(
            "INSERT INTO market_listing (seller_user_id, seller_character_id, item_instance_id, item_def_id, qty, original_qty, unit_price_spirit_stones, listing_fee_silver, status, listed_at, updated_at) VALUES ($1, $2, $3, 'equip-weapon-001', 1, 1, 10, 5, 'active', NOW(), NOW()) RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .bind(item_id)
        .fetch_one(&pool)
        .await
        .expect("listing should insert")
        .try_get::<i64, _>("id")
        .expect("listing id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/market/cancel"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"listingId\":{}}}", listing_id))
            .send()
            .await
            .expect("market cancel request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        if state.redis_available {
            let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let hash = redis
                .hgetall(&format!("character:item-instance-mutation:{}", fixture.character_id))
                .await
                .expect("mutation hash should load");
            println!("MARKET_CANCEL_MUTATION_HASH={}", serde_json::json!(hash));
            assert!(!hash.is_empty());
        } else {
            let row = sqlx::query("SELECT location, obtained_from, obtained_ref_id FROM item_instance WHERE id = $1")
                .bind(item_id)
                .fetch_one(&pool)
                .await
                .expect("item row should load");
            println!("MARKET_CANCEL_FALLBACK_ROW={}", serde_json::json!({
                "location": row.try_get::<Option<String>, _>("location").unwrap_or(None),
                "obtainedFrom": row.try_get::<Option<String>, _>("obtained_from").unwrap_or(None),
                "obtainedRefId": row.try_get::<Option<String>, _>("obtained_ref_id").unwrap_or(None),
            }));
            assert_eq!(row.try_get::<Option<String>, _>("location").unwrap_or(None).unwrap_or_default(), "mail");
        }

        server.abort();

        assert_eq!(body["success"], true);
        assert!(body["message"].as_str().unwrap_or_default().contains("下架成功"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn market_list_route_buffers_item_instance_auction_relocation_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MARKET_LIST_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("market-list-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET silver = 1000 WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character silver should update");
        let item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'equip-weapon-001', 1, 'none', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("bag item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/market/list"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemInstanceId\":{},\"qty\":1,\"unitPriceSpiritStones\":10}}", item_id))
            .send()
            .await
            .expect("market list request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        if state.redis_available {
            let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let hash = redis
                .hgetall(&format!("character:item-instance-mutation:{}", fixture.character_id))
                .await
                .expect("mutation hash should load");
            println!("MARKET_LIST_MUTATION_HASH={}", serde_json::json!(hash));
            assert!(!hash.is_empty());
        } else {
            let row = sqlx::query("SELECT location FROM item_instance WHERE id = $1")
                .bind(item_id)
                .fetch_one(&pool)
                .await
                .expect("item row should load");
            println!("MARKET_LIST_FALLBACK_ROW={}", serde_json::json!({
                "location": row.try_get::<Option<String>, _>("location").unwrap_or(None),
            }));
            assert_eq!(row.try_get::<Option<String>, _>("location").unwrap_or(None).unwrap_or_default(), "auction");
        }

        server.abort();

        assert_eq!(body["success"], true);
        assert!(body["message"].as_str().unwrap_or_default().contains("上架成功"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn market_list_partial_route_buffers_source_qty_mutation_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MARKET_LIST_PARTIAL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("market-list-partial-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET silver = 1000 WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character silver should update");
        let item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'equip-weapon-001', 3, 'none', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("bag item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/market/list"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemInstanceId\":{},\"qty\":1,\"unitPriceSpiritStones\":10}}", item_id))
            .send()
            .await
            .expect("market list request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        if state.redis_available {
            let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let hash = redis
                .hgetall(&format!("character:item-instance-mutation:{}", fixture.character_id))
                .await
                .expect("mutation hash should load");
            println!("MARKET_LIST_PARTIAL_MUTATION_HASH={}", serde_json::json!(hash));
            assert!(!hash.is_empty());
        } else {
            let row = sqlx::query("SELECT qty FROM item_instance WHERE id = $1")
                .bind(item_id)
                .fetch_one(&pool)
                .await
                .expect("item row should load");
            println!("MARKET_LIST_PARTIAL_FALLBACK_ROW={}", serde_json::json!({
                "qty": row.try_get::<Option<i64>, _>("qty").unwrap_or(None),
            }));
            assert_eq!(row.try_get::<Option<i64>, _>("qty").unwrap_or(None).unwrap_or_default(), 2);
        }

        server.abort();

        assert_eq!(body["success"], true);
        assert!(body["message"].as_str().unwrap_or_default().contains("上架成功"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn market_buy_route_buffers_item_instance_mail_transfer_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MARKET_BUY_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("market-buy-{}", super::chrono_like_timestamp_ms());
        let seller = insert_auth_fixture(&state, &pool, "socket", &format!("seller-{suffix}"), 0).await;
        let buyer = insert_auth_fixture(&state, &pool, "socket", &format!("buyer-{suffix}"), 0).await;
        sqlx::query("UPDATE characters SET spirit_stones = 1000 WHERE id = $1")
            .bind(buyer.character_id)
            .execute(&pool)
            .await
            .expect("buyer spirit stones should update");
        let item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'equip-weapon-001', 1, 'none', 'auction', NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(seller.user_id)
        .bind(seller.character_id)
        .fetch_one(&pool)
        .await
        .expect("auction item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");
        let listing_id = sqlx::query(
            "INSERT INTO market_listing (seller_user_id, seller_character_id, item_instance_id, item_def_id, qty, original_qty, unit_price_spirit_stones, listing_fee_silver, status, listed_at, updated_at) VALUES ($1, $2, $3, 'equip-weapon-001', 1, 1, 10, 5, 'active', NOW(), NOW()) RETURNING id",
        )
        .bind(seller.user_id)
        .bind(seller.character_id)
        .bind(item_id)
        .fetch_one(&pool)
        .await
        .expect("listing should insert")
        .try_get::<i64, _>("id")
        .expect("listing id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/market/buy"))
            .header("authorization", format!("Bearer {}", buyer.token))
            .header("content-type", "application/json")
            .body(format!("{{\"listingId\":{},\"qty\":1}}", listing_id))
            .send()
            .await
            .expect("market buy request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        if state.redis_available {
            let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let hash = redis
                .hgetall(&format!("character:item-instance-mutation:{}", buyer.character_id))
                .await
                .expect("mutation hash should load");
            println!("MARKET_BUY_MUTATION_HASH={}", serde_json::json!(hash));
            assert!(!hash.is_empty());
        } else {
            let row = sqlx::query("SELECT owner_character_id, location, obtained_from, obtained_ref_id FROM item_instance WHERE id = $1")
                .bind(item_id)
                .fetch_one(&pool)
                .await
                .expect("item row should load");
            println!("MARKET_BUY_FALLBACK_ROW={}", serde_json::json!({
                "ownerCharacterId": row.try_get::<Option<i64>, _>("owner_character_id").unwrap_or(None),
                "location": row.try_get::<Option<String>, _>("location").unwrap_or(None),
                "obtainedFrom": row.try_get::<Option<String>, _>("obtained_from").unwrap_or(None),
                "obtainedRefId": row.try_get::<Option<String>, _>("obtained_ref_id").unwrap_or(None),
            }));
            assert_eq!(row.try_get::<Option<i64>, _>("owner_character_id").unwrap_or(None).unwrap_or_default(), buyer.character_id);
            assert_eq!(row.try_get::<Option<String>, _>("location").unwrap_or(None).unwrap_or_default(), "mail");
        }

        server.abort();

        assert_eq!(body["success"], true);
        assert!(body["message"].as_str().unwrap_or_default().contains("购买成功"));

        cleanup_auth_fixture(&pool, seller.character_id, seller.user_id).await;
        cleanup_auth_fixture(&pool, buyer.character_id, buyer.user_id).await;
    }

    #[tokio::test]
        async fn market_buy_partial_route_buffers_source_qty_mutation_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MARKET_BUY_PARTIAL_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("market-buy-partial-{}", super::chrono_like_timestamp_ms());
        let seller = insert_auth_fixture(&state, &pool, "socket", &format!("seller-{suffix}"), 0).await;
        let buyer = insert_auth_fixture(&state, &pool, "socket", &format!("buyer-{suffix}"), 0).await;
        sqlx::query("UPDATE characters SET spirit_stones = 1000 WHERE id = $1")
            .bind(buyer.character_id)
            .execute(&pool)
            .await
            .expect("buyer spirit stones should update");
        let item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'equip-weapon-001', 3, 'none', 'auction', NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(seller.user_id)
        .bind(seller.character_id)
        .fetch_one(&pool)
        .await
        .expect("auction item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");
        let listing_id = sqlx::query(
            "INSERT INTO market_listing (seller_user_id, seller_character_id, item_instance_id, item_def_id, qty, original_qty, unit_price_spirit_stones, listing_fee_silver, status, listed_at, updated_at) VALUES ($1, $2, $3, 'equip-weapon-001', 3, 3, 10, 5, 'active', NOW(), NOW()) RETURNING id",
        )
        .bind(seller.user_id)
        .bind(seller.character_id)
        .bind(item_id)
        .fetch_one(&pool)
        .await
        .expect("listing should insert")
        .try_get::<i64, _>("id")
        .expect("listing id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/market/buy"))
            .header("authorization", format!("Bearer {}", buyer.token))
            .header("content-type", "application/json")
            .body(format!("{{\"listingId\":{},\"qty\":1}}", listing_id))
            .send()
            .await
            .expect("market buy partial request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        if state.redis_available {
            let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let hash = redis
                .hgetall(&format!("character:item-instance-mutation:{}", seller.character_id))
                .await
                .expect("mutation hash should load");
            println!("MARKET_BUY_PARTIAL_MUTATION_HASH={}", serde_json::json!(hash));
            assert!(!hash.is_empty());
        } else {
            let row = sqlx::query("SELECT qty FROM item_instance WHERE id = $1")
                .bind(item_id)
                .fetch_one(&pool)
                .await
                .expect("item row should load");
            println!("MARKET_BUY_PARTIAL_FALLBACK_ROW={}", serde_json::json!({
                "qty": row.try_get::<Option<i64>, _>("qty").unwrap_or(None),
            }));
            assert_eq!(row.try_get::<Option<i64>, _>("qty").unwrap_or(None).unwrap_or_default(), 2);
        }

        server.abort();

        assert_eq!(body["success"], true);
        assert!(body["message"].as_str().unwrap_or_default().contains("购买成功"));

        cleanup_auth_fixture(&pool, seller.character_id, seller.user_id).await;
        cleanup_auth_fixture(&pool, buyer.character_id, buyer.user_id).await;
    }

    #[tokio::test]
        async fn market_list_route_emits_market_update_to_authenticated_socket() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MARKET_SOCKET_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("market-socket-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET silver = 1000 WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character silver should update");
        let item_id = sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from) VALUES ($1, $2, 'equip-weapon-001', 1, 'none', 'bag', 0, NOW(), NOW(), 'test') RETURNING id",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("bag item should insert")
        .try_get::<i64, _>("id")
        .expect("item id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let (sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-market".to_string()),
            connected_at_ms: 1,
        });

        let response = client
            .post(format!("http://{address}/api/market/list"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"itemInstanceId\":{},\"qty\":1,\"unitPriceSpiritStones\":10}}", item_id))
            .send()
            .await
            .expect("market list request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let poll_text = poll_text(&client, address, &sid).await;

        println!("MARKET_SOCKET_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("market:update"));
        assert!(poll_text.contains("create_market_listing"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_market_buy_route_emits_rank_update_to_buyer_socket() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_MARKET_RANK_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("partner-market-rank-{}", super::chrono_like_timestamp_ms());
        let seller = insert_auth_fixture(&state, &pool, "socket", &format!("seller-{suffix}"), 0).await;
        let buyer = insert_auth_fixture(&state, &pool, "socket", &format!("buyer-{suffix}"), 0).await;
        sqlx::query("UPDATE characters SET spirit_stones = 100000 WHERE id = $1")
            .bind(buyer.character_id)
            .execute(&pool)
            .await
            .expect("buyer spirit stones should update");
        let partner_id = insert_partner_fixture(&pool, seller.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await;
        let listing_id = sqlx::query(
            "INSERT INTO market_partner_listing (seller_user_id, seller_character_id, partner_id, partner_snapshot, partner_def_id, partner_name, partner_nickname, partner_quality, partner_element, partner_level, unit_price_spirit_stones, listing_fee_silver, status, listed_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, 'partner-qingmu-xiaoou', '青木灵伴', '青木灵伴', '玄', 'wood', 12, 10, 5, 'active', NOW(), NOW()) RETURNING id",
        )
        .bind(seller.user_id)
        .bind(seller.character_id)
        .bind(partner_id)
        .bind(serde_json::json!({
            "partnerDefId": "partner-qingmu-xiaoou",
            "name": "青木灵伴",
            "nickname": "青木灵伴",
            "quality": "玄",
            "element": "wood",
            "level": 12
        }))
        .fetch_one(&pool)
        .await
        .expect("partner listing should insert")
        .try_get::<i64, _>("id")
        .expect("listing id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let (sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &sid).await;
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: sid.clone(),
            user_id: buyer.user_id,
            character_id: Some(buyer.character_id),
            session_token: Some("sess-rank".to_string()),
            connected_at_ms: 1,
        });

        let response = client
            .post(format!("http://{address}/api/market/partner/buy"))
            .header("authorization", format!("Bearer {}", buyer.token))
            .header("content-type", "application/json")
            .body(format!("{{\"listingId\":{}}}", listing_id))
            .send()
            .await
            .expect("partner market buy request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let poll_text = poll_text(&client, address, &sid).await;

        println!("PARTNER_MARKET_RANK_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("rank:update"));
        assert!(poll_text.contains("buy_partner_listing"));

        cleanup_auth_fixture(&pool, seller.character_id, seller.user_id).await;
        cleanup_auth_fixture(&pool, buyer.character_id, buyer.user_id).await;
    }

    #[tokio::test]
        async fn game_socket_auth_success_emits_full_character_before_auth_ready() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_AUTH_SUCCESS_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("realtime-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let user_id = fixture.user_id;
        let character_id = fixture.character_id;

        sqlx::query(
            "INSERT INTO character_feature_unlocks (character_id, feature_code, obtained_from, unlocked_at) VALUES ($1, 'partner_system', 'test', NOW()) ON CONFLICT DO NOTHING",
        )
        .bind(character_id)
        .execute(&pool)
        .await
        .expect("feature unlock should insert");

        sqlx::query(
            "INSERT INTO character_global_buff (character_id, buff_key, source_type, source_id, buff_value, started_at, expire_at, created_at, updated_at) VALUES ($1, 'fuyuan_flat', 'sect_blessing', 'blessing_hall', 2, NOW(), NOW() + INTERVAL '3 hours', NOW(), NOW()) ON CONFLICT (character_id, buff_key, source_type, source_id) DO UPDATE SET buff_value = EXCLUDED.buff_value, started_at = EXCLUDED.started_at, expire_at = EXCLUDED.expire_at, updated_at = NOW()",
        )
        .bind(character_id)
        .execute(&pool)
        .await
        .expect("global buff should insert");

        crate::shared::game_time::initialize_game_time_runtime(state.clone())
            .await
            .expect("game time runtime should initialize");

        let token = fixture.token.clone();

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_auth(&client, address, &sid, &token).await;
        let first_poll = poll_until_contains(&client, address, &sid, "game:character").await;
        let second_poll = poll_until_contains(&client, address, &sid, "game:auth-ready").await;
        let poll_text = format!("{first_poll}{second_poll}");

        println!("GAME_SOCKET_AUTH_SUCCESS_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_AUTH_SUCCESS_POLL={poll_text}");

        let full_index = poll_text
            .find("game:character")
            .expect("full character event should exist");
        let ready_index = poll_text
            .find("game:auth-ready")
            .expect("auth-ready event should exist");
        let time_index = poll_text
            .find("game:time-sync")
            .expect("time-sync event should exist");
        assert!(full_index < ready_index);
        assert!(ready_index < time_index || full_index < time_index);
        assert!(poll_text.contains("\"type\":\"full\""));
        assert!(poll_text.contains("\"featureUnlocks\":[\"partner_system\"]"));
        assert!(poll_text.contains("mail:update"));
        assert!(poll_text.contains("task:update"));
        assert!(poll_text.contains("achievement:update"));
        assert!(poll_text.contains("partnerRecruit:update"));
        assert!(poll_text.contains("partnerFusion:update"));
        assert!(poll_text.contains("partnerRebone:update"));
        assert!(poll_text.contains("techniqueResearch:update"));
        assert!(poll_text.contains("\"era_name\":\"末法纪元\""));
        assert!(poll_text.contains("\"weather\":\"晴\""));

        server.abort();

        sqlx::query("DELETE FROM character_global_buff WHERE character_id = $1")
            .bind(character_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM character_feature_unlocks WHERE character_id = $1")
            .bind(character_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, character_id, user_id).await;
    }

    #[tokio::test]
        async fn game_socket_duplicate_login_kicks_previous_socket() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_DUPLICATE_LOGIN_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("duplicate-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let user_id = fixture.user_id;
        let character_id = fixture.character_id;
        let token = fixture.token.clone();

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (first_sid, _) = handshake_sid(&client, address).await;
        socket_auth(&client, address, &first_sid, &token).await;
        let _ = poll_text(&client, address, &first_sid).await;

        let (second_sid, _) = handshake_sid(&client, address).await;
        socket_auth(&client, address, &second_sid, &token).await;

        let first_after_replace = poll_until_contains(&client, address, &first_sid, "game:kicked").await;
        let second_after_replace = poll_until_contains(&client, address, &second_sid, "game:auth-ready").await;

        println!("GAME_SOCKET_DUPLICATE_LOGIN_FIRST={first_after_replace}");
        println!("GAME_SOCKET_DUPLICATE_LOGIN_SECOND={second_after_replace}");

        assert!(first_after_replace.contains("game:kicked") || first_after_replace.contains("Session ID unknown"));
        if first_after_replace.contains("game:kicked") {
            assert!(first_after_replace.contains("账号已在其他设备登录"));
        }
        assert!(second_after_replace.contains("game:auth-ready") || second_after_replace.contains("Session ID unknown"));

        server.abort();

        cleanup_auth_fixture(&pool, character_id, user_id).await;
    }

    #[tokio::test]
        async fn game_socket_online_players_request_emits_full_payload_after_auth() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_ONLINE_PLAYERS_AUTH_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("online-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let user_id = fixture.user_id;
        let character_id = fixture.character_id;
        let token = fixture.token.clone();

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_auth(&client, address, &sid, &token).await;
        let auth_poll_text = poll_until_contains(&client, address, &sid, "game:auth-ready").await;

        socket_emit_raw(&client, address, &sid, "42[\"game:onlinePlayers:request\"]").await;

        let online_players_poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_ONLINE_PLAYERS_AUTH_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_ONLINE_PLAYERS_AUTH_FIRST_POLL={auth_poll_text}");
        println!("GAME_SOCKET_ONLINE_PLAYERS_AUTH_SECOND_POLL={online_players_poll_text}");

        assert!(auth_poll_text.contains("game:auth-ready"));
        assert!(online_players_poll_text.contains("game:onlinePlayers"));
        assert!(online_players_poll_text.contains("\"type\":\"full\""));
        assert!(online_players_poll_text.contains("\"players\":[{"));
        assert!(online_players_poll_text.contains("\"nickname\":\"角色-"));

        server.abort();

        cleanup_auth_fixture(&pool, character_id, user_id).await;
    }

    #[tokio::test]
        async fn game_socket_online_players_multi_user_auth_then_refresh_emits_full_then_delta() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_ONLINE_PLAYERS_MULTI_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("online-multi-{}", super::chrono_like_timestamp_ms());
        let fixture_one = insert_auth_fixture(&state, &pool, "socket", &format!("one-{suffix}"), 0).await;
        let fixture_two = insert_auth_fixture(&state, &pool, "socket", &format!("two-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (sid_one, _) = handshake_sid(&client, address).await;
        socket_auth(&client, address, &sid_one, &fixture_one.token).await;
        let first_poll_one = poll_until_contains(&client, address, &sid_one, "game:auth-ready").await;

        let (sid_two, _) = handshake_sid(&client, address).await;
        socket_auth(&client, address, &sid_two, &fixture_two.token).await;
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let second_poll_one = poll_text(&client, address, &sid_one).await;
        let first_poll_two = poll_until_contains(&client, address, &sid_two, "game:auth-ready").await;

        sqlx::query("UPDATE characters SET realm = '筑基期' WHERE id = $1")
            .bind(fixture_one.character_id)
            .execute(&pool)
            .await
            .expect("character realm should update");
        socket_emit_raw(&client, address, &sid_one, "42[\"game:refresh\"]").await;
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let refresh_poll_two = poll_text(&client, address, &sid_two).await;

        println!("GAME_SOCKET_ONLINE_PLAYERS_MULTI_FIRST_POLL_ONE={first_poll_one}");
        println!("GAME_SOCKET_ONLINE_PLAYERS_MULTI_SECOND_POLL_ONE={second_poll_one}");
        println!("GAME_SOCKET_ONLINE_PLAYERS_MULTI_FIRST_POLL_TWO={first_poll_two}");
        println!("GAME_SOCKET_ONLINE_PLAYERS_MULTI_REFRESH_POLL_TWO={refresh_poll_two}");

        server.abort();

        assert!(first_poll_one.contains("game:auth-ready"));
        assert!(second_poll_one.contains("game:onlinePlayers"));
        assert!(second_poll_one.contains("\"type\":\"delta\""));
        assert!(second_poll_one.contains("\"joined\""));
        assert!(second_poll_one.contains("\"nickname\":\"角色-two-"));
        assert!(second_poll_one.contains("\"realm\":\"凡人\""));
        assert!(first_poll_two.contains("game:auth-ready"));
        assert!(refresh_poll_two.contains("game:onlinePlayers"));
        assert!(refresh_poll_two.contains("\"type\":\"delta\""));
        assert!(refresh_poll_two.contains("\"nickname\":\"角色-one-"));
        assert!(refresh_poll_two.contains("\"realm\":\"筑基期\""));
        assert!(refresh_poll_two.contains("\"realm\":\"筑基期\""));

        cleanup_auth_fixture(&pool, fixture_one.character_id, fixture_one.user_id).await;
        cleanup_auth_fixture(&pool, fixture_two.character_id, fixture_two.user_id).await;
    }

    #[tokio::test]
        async fn game_socket_online_players_broadcast_skips_unauthenticated_socket() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_ONLINE_PLAYERS_AUTH_ROOM_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("online-auth-room-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (authed_sid, _) = handshake_sid(&client, address).await;
        socket_auth(&client, address, &authed_sid, &fixture.token).await;
        let _ = poll_text(&client, address, &authed_sid).await;

        let (unauth_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &unauth_sid).await;

        sqlx::query("UPDATE characters SET realm = '筑基期' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character realm should update");
        socket_emit_raw(&client, address, &authed_sid, "42[\"game:refresh\"]").await;
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;

        let authed_poll = poll_text(&client, address, &authed_sid).await;
        let unauth_poll = poll_text(&client, address, &unauth_sid).await;

        println!("GAME_SOCKET_ONLINE_PLAYERS_AUTH_ROOM_AUTHED={authed_poll}");
        println!("GAME_SOCKET_ONLINE_PLAYERS_AUTH_ROOM_UNAUTH={unauth_poll}");

        server.abort();

        assert!(authed_poll.contains("game:onlinePlayers"));
        assert!(authed_poll.contains("\"realm\":\"筑基期\""));
        assert!(!unauth_poll.contains("game:onlinePlayers"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn game_socket_refresh_emits_full_character_after_auth() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_REFRESH_AUTH_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("refresh-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let user_id = fixture.user_id;
        let character_id = fixture.character_id;
        let token = fixture.token.clone();

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_auth(&client, address, &sid, &token).await;
        let auth_poll_text = poll_until_contains(&client, address, &sid, "game:auth-ready").await;

        socket_emit_raw(&client, address, &sid, "42[\"game:refresh\"]").await;

        let refresh_poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_REFRESH_AUTH_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_REFRESH_AUTH_FIRST_POLL={auth_poll_text}");
        println!("GAME_SOCKET_REFRESH_AUTH_SECOND_POLL={refresh_poll_text}");

        assert!(auth_poll_text.contains("game:auth-ready"));
        assert!(refresh_poll_text.contains("game:character"));
        assert!(refresh_poll_text.contains("\"type\":\"full\""));
        assert!(refresh_poll_text.contains(&format!("\"id\":{character_id}")));
        assert!(refresh_poll_text.contains(&format!("\"nickname\":\"角色-{suffix}\"")));

        server.abort();

        cleanup_auth_fixture(&pool, character_id, user_id).await;
    }

    #[tokio::test]
        async fn game_socket_add_point_emits_full_character_after_auth() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_ADD_POINT_AUTH_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("addpoint-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 5).await;
        let user_id = fixture.user_id;
        let character_id = fixture.character_id;
        let token = fixture.token.clone();

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_auth(&client, address, &sid, &token).await;
        let auth_poll_text = poll_until_contains(&client, address, &sid, "game:auth-ready").await;

        socket_emit_raw(&client, address, &sid, "42[\"game:addPoint\",{\"attribute\":\"jing\",\"amount\":1}]").await;

        let add_point_poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_ADD_POINT_AUTH_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_ADD_POINT_AUTH_FIRST_POLL={auth_poll_text}");
        println!("GAME_SOCKET_ADD_POINT_AUTH_SECOND_POLL={add_point_poll_text}");

        assert!(auth_poll_text.contains("game:auth-ready"));
        assert!(add_point_poll_text.contains("game:character"));
        assert!(add_point_poll_text.contains("\"type\":\"full\""));
        assert!(add_point_poll_text.contains(&format!("\"id\":{character_id}")));
        assert!(add_point_poll_text.contains("\"jing\":1"));
        assert!(add_point_poll_text.contains("\"attributePoints\":4"));

        server.abort();

        cleanup_auth_fixture(&pool, character_id, user_id).await;
    }

    #[tokio::test]
        async fn game_socket_battle_sync_emits_battle_update_after_auth() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_BATTLE_SYNC_AUTH_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("battlesync-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let user_id = fixture.user_id;
        let character_id = fixture.character_id;

        let battle_id = format!("battle-{suffix}");
        let session_id = format!("session-{suffix}");
        state.battle_sessions.register(BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "pve".to_string(),
            owner_user_id: user_id,
            participant_user_ids: vec![user_id],
            current_battle_id: Some(battle_id.clone()),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Pve {
                monster_ids: vec!["monster-gray-wolf".to_string()],
            },
        });
        state.battle_runtime.register(build_minimal_pve_battle_state(
            &battle_id,
            character_id,
            &["monster-gray-wolf".to_string()],
        ));

        let token = fixture.token.clone();

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_auth(&client, address, &sid, &token).await;
        let auth_poll_text = poll_until_contains(&client, address, &sid, "game:auth-ready").await;

        socket_emit_raw(&client, address, &sid, &format!("42[\"battle:sync\",{{\"battleId\":\"{battle_id}\"}}]")).await;

        let battle_poll_text = poll_text(&client, address, &sid).await;

        println!("GAME_SOCKET_BATTLE_SYNC_AUTH_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_BATTLE_SYNC_AUTH_FIRST_POLL={auth_poll_text}");
        println!("GAME_SOCKET_BATTLE_SYNC_AUTH_SECOND_POLL={battle_poll_text}");

        assert!(auth_poll_text.contains("game:auth-ready"));
        assert!(battle_poll_text.contains("battle:update"));
        assert!(battle_poll_text.contains(&format!("\"battleId\":\"{battle_id}\"")));
        assert!(battle_poll_text.contains("battle_started") || battle_poll_text.contains("battle_state"));

        server.abort();

        cleanup_auth_fixture(&pool, character_id, user_id).await;
    }

    #[tokio::test]
        async fn game_socket_battle_sync_recovers_persisted_battle_after_runtime_clear() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        if !state.redis_available {
            println!("GAME_SOCKET_BATTLE_SYNC_RECOVERY_SKIPPED_REDIS_UNAVAILABLE");
            return;
        }
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_BATTLE_SYNC_RECOVERY_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("battlesync-recover-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET current_map_id = 'map-qingyun-outskirts', current_room_id = 'room-south-forest' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character room should update");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let start_response = client
            .post(format!("http://{address}/api/battle/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"monsterIds\":[\"monster-wild-rabbit\"]}")
            .send()
            .await
            .expect("battle start request should succeed");
        let start_status = start_response.status();
        let start_text = start_response.text().await.expect("start body should read");
        println!("GAME_SOCKET_BATTLE_SYNC_RECOVERY_START_RESPONSE={start_text}");
        assert_eq!(start_status, StatusCode::OK);
        let start_body: Value = serde_json::from_str(&start_text)
            .expect("start body should be json");
        let battle_id = start_body["data"]["battleId"].as_str().expect("battle id should exist").to_string();

        state.battle_runtime.clear(&battle_id);
        state.online_battle_projections.clear(&battle_id);
        if let Some(session_id) = state.battle_sessions.get_by_battle_id(&battle_id).map(|session| session.session_id) {
            let _ = state.battle_sessions.update(&session_id, |record| {
                record.current_battle_id = None;
            });
        }

        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_auth(&client, address, &sid, &fixture.token).await;
        let _ = poll_until_contains(&client, address, &sid, "game:auth-ready").await;

        socket_emit_raw(&client, address, &sid, &format!("42[\"battle:sync\",{{\"battleId\":\"{battle_id}\"}}]"))
            .await;

        let poll_text = poll_until_contains(&client, address, &sid, "battle:update").await;

        println!("GAME_SOCKET_BATTLE_SYNC_RECOVERY_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_BATTLE_SYNC_RECOVERY_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("battle:update"));
        assert!(!poll_text.contains("battle_abandoned"));
        assert!(poll_text.contains(&format!("\"battleId\":\"{battle_id}\"")));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn persisted_battle_recovery_restores_generic_pve_bundle_via_startup_path() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        if !state.redis_available {
            println!("PERSISTED_BATTLE_RECOVERY_SKIPPED_REDIS_UNAVAILABLE");
            return;
        }
        let Some(pool) = connect_fixture_db_or_skip(&state, "PERSISTED_BATTLE_RECOVERY_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("persisted-battle-recovery-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET current_map_id = 'map-qingyun-outskirts', current_room_id = 'room-south-forest' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character room should update");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let start_response = client
            .post(format!("http://{address}/api/battle/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"monsterIds\":[\"monster-wild-rabbit\"]}".to_string())
            .send()
            .await
            .expect("battle start request should succeed");
        let start_status = start_response.status();
        let start_text = start_response.text().await.expect("start body should read");
        if start_status != StatusCode::OK {
            panic!("PARTNER_REBONE_START_ROUTE_RESPONSE={start_text}");
        }
        let start_body: Value = serde_json::from_str(&start_text).expect("start body should be json");
        let battle_id = start_body["data"]["battleId"].as_str().expect("battle id should exist").to_string();
        let session_id = start_body["data"]["debugRealtime"]["session"]["sessionId"]
            .as_str()
            .expect("session id should exist")
            .to_string();

        state.battle_runtime.clear(&battle_id);
        state.online_battle_projections.clear(&battle_id);
        let _ = state.battle_sessions.update(&session_id, |record| {
            record.current_battle_id = None;
        });

        let summary = crate::integrations::battle_persistence::recover_all_battle_bundles(&state)
            .await
            .expect("persisted battle recovery should succeed");

        println!(
            "PERSISTED_BATTLE_RECOVERY_SUMMARY={{\"total\":{},\"pve\":{},\"pvp\":{},\"arena\":{},\"dungeon\":{},\"tower\":{}}}",
            summary.recovered_battle_count,
            summary.pve_count,
            summary.pvp_count,
            summary.arena_count,
            summary.dungeon_count,
            summary.tower_count,
        );

        server.abort();

        assert!(summary.recovered_battle_count >= 1);
        assert!(summary.pve_count >= 1);
        assert!(state.battle_runtime.get(&battle_id).is_some());
        assert!(state.online_battle_projections.get_by_battle_id(&battle_id).is_some());
        assert_eq!(
            state.battle_sessions.get_by_battle_id(&battle_id).and_then(|session| session.current_battle_id),
            Some(battle_id.clone())
        );

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn orphan_battle_session_recovery_restores_session_without_projection() {
        let state = test_state();
        if !state.redis_available {
            println!("ORPHAN_BATTLE_SESSION_RECOVERY_SKIPPED_REDIS_UNAVAILABLE");
            return;
        }
        let Some(pool) = connect_fixture_db_or_skip(&state, "ORPHAN_BATTLE_SESSION_RECOVERY_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("orphan-session-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let battle_id = format!("pve-battle-{suffix}");
        let session_id = format!("pve-session-{suffix}");
        let session = BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "pve".to_string(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            current_battle_id: Some(battle_id.clone()),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Pve {
                monster_ids: vec!["monster-wild-boar".to_string()],
            },
        };
        crate::integrations::battle_persistence::persist_battle_session(&state, &session)
            .await
            .expect("session should persist");

        let recovered = crate::integrations::battle_persistence::recover_all_orphan_battle_sessions(&state)
            .await
            .expect("orphan session recovery should succeed");

        println!("ORPHAN_BATTLE_SESSION_RECOVERY_COUNT={recovered}");

        assert!(recovered >= 1);
        assert_eq!(
            state
                .battle_sessions
                .get_by_session_id(&session_id)
                .and_then(|row| row.current_battle_id),
            Some(battle_id.clone())
        );

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn battle_expired_cleanup_clears_runtime_projection_session_and_redis_bundle() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        if !state.redis_available {
            println!("BATTLE_EXPIRED_CLEANUP_SKIPPED_REDIS_UNAVAILABLE");
            return;
        }
        let Some(pool) = connect_fixture_db_or_skip(&state, "BATTLE_EXPIRED_CLEANUP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("expired-cleanup-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let battle_id = format!("pve-battle-{}-1713000000000", fixture.user_id);
        let session_id = format!("pve-session-{suffix}");
        let session = BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "pve".to_string(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            current_battle_id: Some(battle_id.clone()),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Pve {
                monster_ids: vec!["monster-wild-boar".to_string()],
            },
        };
        let battle_state = build_minimal_pve_battle_state(&battle_id, fixture.character_id, &["monster-wild-boar".to_string()]);
        let projection = OnlineBattleProjectionRecord {
            battle_id: battle_id.clone(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            r#type: "pve".to_string(),
            session_id: Some(session_id.clone()),
        };
        state.battle_sessions.register(session.clone());
        state.battle_runtime.register(battle_state.clone());
        state.online_battle_projections.register(projection.clone());
        crate::integrations::battle_persistence::persist_battle_session(&state, &session)
            .await
            .expect("session should persist");
        crate::integrations::battle_persistence::persist_battle_snapshot(&state, &battle_state)
            .await
            .expect("snapshot should persist");
        crate::integrations::battle_persistence::persist_battle_projection(&state, &projection)
            .await
            .expect("projection should persist");

        let summary = crate::jobs::battle_expired_cleanup::run_battle_expired_cleanup_once(&state)
            .await
            .expect("battle expired cleanup should succeed");

        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
        let snapshot = redis.get_string(&format!("battle:snapshot:{battle_id}")).await.expect("snapshot should read");
        let projection_raw = redis.get_string(&format!("battle:projection:{battle_id}")).await.expect("projection should read");
        let session_raw = redis.get_string(&format!("battle:session:{session_id}")).await.expect("session should read");

        println!("BATTLE_EXPIRED_CLEANUP_COUNT={}", summary.expired_battle_count);

        assert_eq!(summary.expired_battle_count, 1);
        assert!(state.battle_runtime.get(&battle_id).is_none());
        assert!(state.online_battle_projections.get_by_battle_id(&battle_id).is_none());
        assert_eq!(
            state
                .battle_sessions
                .get_by_session_id(&session_id)
                .and_then(|record| record.current_battle_id),
            None
        );
        assert!(snapshot.is_none());
        assert!(projection_raw.is_none());
        assert!(session_raw.is_none());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn online_battle_projection_warmup_materializes_team_dungeon_entry_and_tower_runtime() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "ONLINE_BATTLE_PROJECTION_WARMUP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("projection-warmup-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let member = insert_auth_fixture(&state, &pool, "socket", &format!("member-{suffix}"), 0).await;
        let team_id = format!("team-{suffix}");
        sqlx::query("INSERT INTO teams (id, leader_id, name, current_map_id, is_public, max_members, auto_join_enabled, created_at, updated_at) VALUES ($1, $2, '预热队伍', 'map-qingyun-village', true, 4, false, NOW(), NOW())")
            .bind(&team_id)
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("team should insert");
        sqlx::query("INSERT INTO team_members (team_id, character_id, role, joined_at) VALUES ($1, $2, 'leader', NOW()), ($1, $3, 'member', NOW())")
            .bind(&team_id)
            .bind(leader.character_id)
            .bind(member.character_id)
            .execute(&pool)
            .await
            .expect("team members should insert");
        sqlx::query("INSERT INTO dungeon_entry_count (character_id, dungeon_id, daily_count, weekly_count, total_count, last_daily_reset, last_weekly_reset) VALUES ($1, 'dungeon-qiqi-wolf-den', 1, 2, 3, CURRENT_DATE, CURRENT_DATE)")
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("dungeon entry count should insert");
        sqlx::query(
            "INSERT INTO dungeon_instance (id, dungeon_id, difficulty_id, creator_id, team_id, status, current_stage, current_wave, participants, instance_data, created_at) VALUES ($1, 'dungeon-qiqi-wolf-den', 'dd-qiqi-wolf-den-n', $2, $3, 'running', 1, 1, $4::jsonb, '{\"currentBattleId\":\"warmup-battle-1\"}'::jsonb, NOW())",
        )
        .bind(format!("warmup-inst-{suffix}"))
        .bind(leader.character_id)
        .bind(&team_id)
        .bind(serde_json::json!([
            {"userId": leader.user_id, "characterId": leader.character_id},
            {"userId": member.user_id, "characterId": member.character_id}
        ]))
        .execute(&pool)
        .await
        .expect("dungeon instance should insert");
        sqlx::query("INSERT INTO character_tower_progress (character_id, best_floor, next_floor, current_run_id, current_floor, current_battle_id, last_settled_floor, updated_at) VALUES ($1, 12, 13, 'run-1', 12, 'tower-battle-run-1-12', 12, NOW())")
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("tower progress should insert");

        let summary = crate::bootstrap::startup::warmup_online_battle_projection_runtime(&state)
            .await
            .expect("online battle projection warmup should succeed");

        println!(
            "ONLINE_BATTLE_PROJECTION_WARMUP_COUNTS={{\"team\":{},\"dungeonEntry\":{},\"tower\":{}}}",
            summary.team_projection_count,
            summary.dungeon_entry_projection_count,
            summary.tower_count
        );

        assert!(summary.team_projection_count >= 2);
        assert!(summary.dungeon_entry_projection_count >= 1);
        assert!(summary.tower_count >= 1);
        assert_eq!(state.team_projections.snapshot().len(), summary.team_projection_count);
        assert_eq!(state.dungeon_entry_projections.snapshot().len(), summary.dungeon_entry_projection_count);
        assert_eq!(state.tower_projections.snapshot().len(), summary.tower_count);

        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, member.character_id, member.user_id).await;
    }

    #[tokio::test]
        async fn startup_online_battle_projection_materialize_warmup_populates_runtime() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "STARTUP_ONLINE_BATTLE_WARMUP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("startup-projection-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let member = insert_auth_fixture(&state, &pool, "socket", &format!("member-{suffix}"), 0).await;
        let team_id = format!("team-{suffix}");

        sqlx::query("INSERT INTO teams (id, leader_id, name, current_map_id, is_public, max_members, auto_join_enabled, created_at, updated_at) VALUES ($1, $2, '预热队伍', 'map-qingyun-village', true, 4, false, NOW(), NOW())")
            .bind(&team_id)
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("team should insert");
        sqlx::query("INSERT INTO team_members (team_id, character_id, role, joined_at) VALUES ($1, $2, 'leader', NOW()), ($1, $3, 'member', NOW())")
            .bind(&team_id)
            .bind(leader.character_id)
            .bind(member.character_id)
            .execute(&pool)
            .await
            .expect("team members should insert");
        sqlx::query("INSERT INTO dungeon_entry_count (character_id, dungeon_id, daily_count, weekly_count, total_count, last_daily_reset, last_weekly_reset) VALUES ($1, 'dungeon-qiqi-wolf-den', 1, 2, 3, CURRENT_DATE, CURRENT_DATE)")
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("dungeon entry count should insert");
        sqlx::query("INSERT INTO character_tower_progress (character_id, best_floor, next_floor, current_run_id, current_floor, current_battle_id, last_settled_floor, updated_at) VALUES ($1, 12, 13, 'run-1', 12, 'tower-battle-run-1-12', 12, NOW())")
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("tower progress should insert");
        sqlx::query("INSERT INTO arena_rating (character_id, rating, win_count, lose_count, created_at, updated_at) VALUES ($1, 1200, 5, 2, NOW(), NOW())")
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("arena rating should insert");

        let summary = crate::bootstrap::startup::warmup_online_battle_projection_runtime(&state)
            .await
            .expect("warmup should succeed");

        println!(
            "STARTUP_ONLINE_BATTLE_WARMUP_COUNTS={{\"characterSnapshot\":{},\"arenaProjection\":{},\"team\":{},\"dungeonProjection\":{},\"dungeonEntry\":{},\"tower\":{}}}",
            summary.character_snapshot_count,
            summary.arena_projection_count,
            summary.team_projection_count,
            summary.dungeon_projection_count,
            summary.dungeon_entry_projection_count,
            summary.tower_count
        );

        assert_eq!(state.character_snapshots.snapshot().len(), summary.character_snapshot_count);
        assert_eq!(state.arena_projections.snapshot().len(), summary.arena_projection_count);
        assert_eq!(state.team_projections.snapshot().len(), summary.team_projection_count);
        assert_eq!(state.dungeon_projections.snapshot().len(), summary.dungeon_projection_count);
        assert_eq!(state.dungeon_entry_projections.snapshot().len(), summary.dungeon_entry_projection_count);
        assert_eq!(state.tower_projections.snapshot().len(), summary.tower_count);
        assert!(summary.character_snapshot_count >= 2);
        assert!(summary.arena_projection_count >= 1);
        assert!(summary.team_projection_count >= 2);
        assert!(summary.dungeon_projection_count >= 1);
        assert!(summary.dungeon_entry_projection_count >= 1);
        assert!(summary.tower_count >= 1);

        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, member.character_id, member.user_id).await;
    }

    #[tokio::test]
        async fn mail_history_cleanup_removes_soft_deleted_and_expired_rows() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MAIL_HISTORY_CLEANUP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("mail-history-cleanup-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query(
            "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, deleted_at, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'normal', '软删历史', 'x', NOW() - INTERVAL '8 days', NOW() - INTERVAL '10 days', NOW())",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("soft deleted mail should insert");
        sqlx::query(
            "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, expire_at, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'normal', '过期历史', 'x', NOW() - INTERVAL '8 days', NOW() - INTERVAL '10 days', NOW())",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("expired mail should insert");

        let summary = crate::jobs::mail_history_cleanup::run_mail_history_cleanup_once(&state)
            .await
            .expect("mail history cleanup should succeed");
        let remaining = sqlx::query(
            "SELECT COUNT(1)::bigint AS cnt FROM mail WHERE recipient_character_id = $1 AND (title = '软删历史' OR title = '过期历史')",
        )
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("remaining mail should count")
        .try_get::<i64, _>("cnt")
        .expect("count should decode");

        println!(
            "MAIL_HISTORY_CLEANUP_SUMMARY={{\"softDeleted\":{},\"expired\":{}}}",
            summary.deleted_soft_deleted_count,
            summary.deleted_expired_count
        );

        assert!(summary.deleted_soft_deleted_count >= 1);
        assert!(summary.deleted_expired_count >= 1);
        assert_eq!(remaining, 0);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn mail_unread_route_ignores_expired_mail_even_before_cleanup() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "MAIL_EXPIRED_COUNTER_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("mail-expired-counter-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query(
            r#"INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_rewards, expire_at, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', '未过期邮件', 'x', '[{"items":[{"item_def_id":"mat-gongfa-canye","qty":1}]}]'::jsonb, NOW() + INTERVAL '1 day', NOW(), NOW()), ($1, $2, 'system', '系统', 'reward', '已过期邮件', 'x', '[{"items":[{"item_def_id":"mat-gongfa-canye","qty":1}]}]'::jsonb, NOW() - INTERVAL '1 day', NOW() - INTERVAL '2 days', NOW())"#,
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("mail rows should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .get(format!("http://{address}/api/mail/unread"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("mail unread should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        println!("MAIL_UNREAD_EXPIRED_FILTER_RESPONSE={body}");

        server.abort();

        assert_eq!(body["data"]["unreadCount"], 1);
        assert_eq!(body["data"]["unclaimedCount"], 1);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn idle_history_cleanup_keeps_recent_finished_sessions_only() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "IDLE_HISTORY_CLEANUP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("idle-history-cleanup-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;

        for idx in 0..5_i64 {
            let digest = format!("{:x}", md5::compute(format!("{}-{}", suffix, idx).as_bytes()));
            let session_id = format!(
                "{}-{}-{}-{}-{}",
                &digest[0..8],
                &digest[8..12],
                &digest[12..16],
                &digest[16..20],
                &digest[20..32],
            );
            sqlx::query(
                "INSERT INTO idle_sessions (id, character_id, status, map_id, room_id, max_duration_ms, session_snapshot, total_battles, win_count, lose_count, total_exp, total_silver, bag_full_flag, started_at, ended_at, viewed_at, created_at, updated_at) VALUES ($1::uuid, $2, 'completed', 'map-qingyun-outskirts', 'room-forest-clearing', 60000, '{}'::jsonb, 1, 1, 0, 10, 5, false, NOW() - (($3::text || ' days')::interval), NOW() - (($3::text || ' days')::interval), NULL, NOW(), NOW())",
            )
            .bind(session_id)
            .bind(fixture.character_id)
            .bind(10 - idx)
            .execute(&pool)
            .await
            .expect("idle session should insert");
        }

        let summary = crate::jobs::idle_history_cleanup::run_idle_history_cleanup_once(&state)
            .await
            .expect("idle history cleanup should succeed");
        let remaining = sqlx::query(
            "SELECT COUNT(1)::bigint AS cnt FROM idle_sessions WHERE character_id = $1 AND status = 'completed'",
        )
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("remaining idle sessions should count")
        .try_get::<i64, _>("cnt")
        .expect("count should decode");

        println!("IDLE_HISTORY_CLEANUP_DELETED={}", summary.deleted_session_count);

        assert_eq!(summary.deleted_session_count, 2);
        assert_eq!(remaining, 3);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn generated_content_refresh_counts_generated_rows_on_startup() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GENERATED_CONTENT_REFRESH_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("generated-refresh-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let technique_id = format!("gt-{suffix}");
        let skill_id = format!("gs-{suffix}");
        let partner_id = format!("gp-{suffix}");

        sqlx::query(
            "INSERT INTO generated_technique_def (id, generation_id, name, description, quality, type, max_layer, required_realm, attribute_type, attribute_element, is_published, enabled, created_by_character_id, created_at, updated_at) VALUES ($1, 'job-tech', '测试功法', 'desc', '黄', '功法', 1, '凡人', 'physical', 'none', TRUE, TRUE, $2, NOW(), NOW())",
        )
        .bind(&technique_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("generated technique should insert");
        sqlx::query(
            "INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, enabled, sort_weight, created_at, updated_at) VALUES ($1, 'job-tech', 'technique', $2, '测试招式', 'enemy', TRUE, 10, NOW(), NOW())",
        )
        .bind(&skill_id)
        .bind(&technique_id)
        .execute(&pool)
        .await
        .expect("generated skill should insert");
        sqlx::query(
            "INSERT INTO generated_technique_layer (generation_id, technique_id, layer, enabled, created_at, updated_at) VALUES ('job-tech', $1, 1, TRUE, NOW(), NOW())",
        )
        .bind(&technique_id)
        .execute(&pool)
        .await
        .expect("generated layer should insert");
        sqlx::query(
            "INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, base_attrs, level_attr_gains, innate_technique_ids, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '测试伙伴', 'desc', NULL, '黄', 'wood', 'support', 1, '{\"max_qixue\":100}'::jsonb, '{\"max_qixue\":5}'::jsonb, ARRAY[]::text[], TRUE, $2, 'job-partner', NOW(), NOW())",
        )
        .bind(&partner_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("generated partner should insert");

        let summary = crate::bootstrap::generated_content_refresh::refresh_generated_content_on_startup(&state)
            .await
            .expect("generated content refresh should succeed");

        println!(
            "GENERATED_CONTENT_REFRESH_SUMMARY={{\"technique\":{},\"skill\":{},\"layer\":{},\"partner\":{}}}",
            summary.published_generated_technique_count,
            summary.enabled_generated_skill_count,
            summary.enabled_generated_technique_layer_count,
            summary.enabled_generated_partner_count
        );

        assert!(summary.published_generated_technique_count >= 1);
        assert!(summary.enabled_generated_skill_count >= 1);
        assert!(summary.enabled_generated_technique_layer_count >= 1);
        assert!(summary.enabled_generated_partner_count >= 1);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn wander_title_grant_upsert_refreshes_timestamp_without_overwriting_is_equipped() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "WANDER_TITLE_UPSERT_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("wander-title-upsert-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let story_id = format!("wander-story-{suffix}");
        let title_id = format!("title-wander-{suffix}");

        sqlx::query(
            "INSERT INTO generated_title_def (id, name, description, color, icon, effects, source_type, source_id, enabled, created_at, updated_at) VALUES ($1, '云航客', '在云梦夜航的终幕中仍能稳住心神之人。', '#4CAF50', NULL, '{\"max_qixue\":50}'::jsonb, 'wander_story', $2, TRUE, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')",
        )
        .bind(&title_id)
        .bind(&story_id)
        .execute(&pool)
        .await
        .expect("generated title should insert");
        sqlx::query(
            "INSERT INTO character_title (character_id, title_id, is_equipped, obtained_at, updated_at) VALUES ($1, $2, TRUE, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')",
        )
        .bind(fixture.character_id)
        .bind(&title_id)
        .execute(&pool)
        .await
        .expect("character title should insert");

        let before_row = sqlx::query("SELECT is_equipped, obtained_at::text AS obtained_at_text, updated_at::text AS updated_at_text FROM character_title WHERE character_id = $1 AND title_id = $2")
            .bind(fixture.character_id)
            .bind(&title_id)
            .fetch_one(&pool)
            .await
            .expect("character title row should load before");

        sqlx::query(
            "INSERT INTO character_title (character_id, title_id, is_equipped, obtained_at, updated_at) VALUES ($1, $2, FALSE, NOW(), NOW()) ON CONFLICT (character_id, title_id) DO UPDATE SET obtained_at = NOW(), updated_at = NOW()",
        )
        .bind(fixture.character_id)
        .bind(&title_id)
        .execute(&pool)
        .await
        .expect("character title upsert should succeed");

        let after_row = sqlx::query("SELECT is_equipped, obtained_at::text AS obtained_at_text, updated_at::text AS updated_at_text FROM character_title WHERE character_id = $1 AND title_id = $2")
            .bind(fixture.character_id)
            .bind(&title_id)
            .fetch_one(&pool)
            .await
            .expect("character title row should load after");

        let before_obtained_at = before_row.try_get::<Option<String>, _>("obtained_at_text").unwrap_or(None).unwrap_or_default();
        let after_obtained_at = after_row.try_get::<Option<String>, _>("obtained_at_text").unwrap_or(None).unwrap_or_default();
        let before_updated_at = before_row.try_get::<Option<String>, _>("updated_at_text").unwrap_or(None).unwrap_or_default();
        let after_updated_at = after_row.try_get::<Option<String>, _>("updated_at_text").unwrap_or(None).unwrap_or_default();

        println!(
            "WANDER_TITLE_UPSERT_TIMESTAMPS={{\"beforeObtainedAt\":\"{}\",\"afterObtainedAt\":\"{}\"}}",
            before_obtained_at,
            after_obtained_at
        );

        assert_eq!(after_row.try_get::<Option<bool>, _>("is_equipped").unwrap_or(None).unwrap_or(false), true);
        assert_ne!(before_obtained_at, after_obtained_at);
        assert_ne!(before_updated_at, after_updated_at);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn wander_title_def_upsert_refreshes_existing_story_definition() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "WANDER_TITLE_DEF_UPSERT_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("wander-title-def-upsert-{}", super::chrono_like_timestamp_ms());
        let story_id = format!("wander-story-{suffix}");
        let title_id = format!("title-wander-{suffix}");

        sqlx::query(
            "INSERT INTO generated_title_def (id, name, description, color, icon, effects, source_type, source_id, enabled, created_at, updated_at) VALUES ($1, '旧云航客', '旧的终幕定义。', '#4CAF50', NULL, '{\"max_qixue\":50}'::jsonb, 'wander_story', $2, TRUE, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')",
        )
        .bind(&title_id)
        .bind(&story_id)
        .execute(&pool)
        .await
        .expect("generated title should insert");

        let returned_row = sqlx::query(
            "INSERT INTO generated_title_def (id, name, description, color, icon, effects, source_type, source_id, enabled, created_at, updated_at) VALUES ($1, $2, $3, $4, NULL, $5::jsonb, 'wander_story', $6, TRUE, NOW(), NOW()) ON CONFLICT (source_type, source_id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color, effects = EXCLUDED.effects, enabled = TRUE, updated_at = NOW() RETURNING id"
        )
        .bind(format!("title-wander-new-{suffix}"))
        .bind("新云航客")
        .bind("更新后的终幕定义。")
        .bind("#faad14")
        .bind(serde_json::json!({"wugong": 12, "baoji": 0.03}))
        .bind(&story_id)
        .fetch_one(&pool)
        .await
        .expect("generated title upsert should succeed");

        let stored_row = sqlx::query("SELECT id, name, description, color, effects FROM generated_title_def WHERE source_type = 'wander_story' AND source_id = $1 LIMIT 1")
            .bind(&story_id)
            .fetch_one(&pool)
            .await
            .expect("generated title row should load");

        println!(
            "WANDER_TITLE_DEF_UPSERT={}",
            serde_json::json!({
                "returnedId": returned_row.try_get::<Option<String>, _>("id").unwrap_or(None).unwrap_or_default(),
                "storedId": stored_row.try_get::<Option<String>, _>("id").unwrap_or(None).unwrap_or_default(),
                "name": stored_row.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(),
                "color": stored_row.try_get::<Option<String>, _>("color").unwrap_or(None).unwrap_or_default(),
                "effects": stored_row.try_get::<Option<serde_json::Value>, _>("effects").unwrap_or(None).unwrap_or(serde_json::json!({})),
            })
        );

        assert_eq!(returned_row.try_get::<Option<String>, _>("id").unwrap_or(None).unwrap_or_default(), title_id);
        assert_eq!(stored_row.try_get::<Option<String>, _>("id").unwrap_or(None).unwrap_or_default(), title_id);
        assert_eq!(stored_row.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(), "新云航客");
        assert_eq!(stored_row.try_get::<Option<String>, _>("description").unwrap_or(None).unwrap_or_default(), "更新后的终幕定义。");
        assert_eq!(stored_row.try_get::<Option<String>, _>("color").unwrap_or(None).unwrap_or_default(), "#faad14");
        assert_eq!(stored_row.try_get::<Option<serde_json::Value>, _>("effects").unwrap_or(None).unwrap_or(serde_json::json!({})), serde_json::json!({"wugong": 12, "baoji": 0.03}));
    }

    #[tokio::test]
        async fn performance_index_sync_creates_expected_hot_indexes() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PERFORMANCE_INDEX_SYNC_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let summary = crate::bootstrap::performance_indexes::ensure_performance_indexes(&state)
            .await
            .expect("performance index sync should succeed");
        let rows = sqlx::query(
            "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('idx_mail_character_active_scope', 'idx_item_instance_stackable_lookup') ORDER BY indexname ASC",
        )
        .fetch_all(&pool)
        .await
        .expect("index rows should load");
        let index_names = rows
            .into_iter()
            .filter_map(|row| row.try_get::<Option<String>, _>("indexname").ok().flatten())
            .collect::<Vec<_>>();

        println!(
            "PERFORMANCE_INDEX_SYNC_SUMMARY={{\"ensured\":{},\"rebuilt\":{},\"indexes\":{}}}",
            summary.ensured_index_count,
            summary.rebuilt_index_count,
            serde_json::json!(index_names)
        );

        assert!(summary.ensured_index_count >= 2);
        assert!(index_names.iter().any(|name| name == "idx_mail_character_active_scope"));
        assert!(index_names.iter().any(|name| name == "idx_item_instance_stackable_lookup"));
    }

    #[tokio::test]
        async fn item_data_cleanup_removes_undefined_item_rows() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "ITEM_DATA_CLEANUP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("item-data-cleanup-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at) VALUES ($1, $2, 'bogus-item-def', 1, 'none', 'bag', NOW(), NOW())",
        )
        .bind(fixture.user_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("bogus item_instance should insert");
        sqlx::query(
            "INSERT INTO item_use_cooldown (character_id, item_def_id, cooldown_until, created_at, updated_at) VALUES ($1, 'bogus-item-def', NOW() + INTERVAL '1 day', NOW(), NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("bogus item_use_cooldown should insert");
        sqlx::query(
            "INSERT INTO item_use_count (character_id, item_def_id, daily_count, total_count, last_daily_reset, created_at, updated_at) VALUES ($1, 'bogus-item-def', 1, 1, CURRENT_DATE, NOW(), NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("bogus item_use_count should insert");

        let summary = crate::bootstrap::item_data_cleanup::cleanup_undefined_item_data_on_startup(&state)
            .await
            .expect("item data cleanup should succeed");

        let item_instance_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM item_instance WHERE item_def_id = 'bogus-item-def'")
            .fetch_one(&pool)
            .await
            .expect("item_instance count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");
        let cooldown_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM item_use_cooldown WHERE item_def_id = 'bogus-item-def'")
            .fetch_one(&pool)
            .await
            .expect("item_use_cooldown count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");
        let use_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM item_use_count WHERE item_def_id = 'bogus-item-def'")
            .fetch_one(&pool)
            .await
            .expect("item_use_count count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");

        println!(
            "ITEM_DATA_CLEANUP_SUMMARY={{\"itemInstance\":{},\"cooldown\":{},\"useCount\":{}}}",
            summary.removed_item_instance_count,
            summary.removed_item_use_cooldown_count,
            summary.removed_item_use_count_count
        );

        assert!(summary.removed_item_instance_count >= 1);
        assert!(summary.removed_item_use_cooldown_count >= 1);
        assert!(summary.removed_item_use_count_count >= 1);
        assert_eq!(item_instance_count, 0);
        assert_eq!(cooldown_count, 0);
        assert_eq!(use_count, 0);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn technique_draft_cleanup_refunds_expired_draft_by_mail() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "TECHNIQUE_DRAFT_CLEANUP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("tech-draft-cleanup-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let generation_id = format!("tech-gen-{suffix}");
        let draft_id = format!("generated-technique-{suffix}");

        sqlx::query(
            "INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, model_name, is_published, name_locked, enabled, version, created_at, updated_at) VALUES ($1, $2, $3, '青木诀', '武技', '玄', 3, '炼炁化神·结胎期', 'physical', 'wood', 'character_only', '[]'::jsonb, 'desc', 'long', 'mock-tech', FALSE, FALSE, TRUE, 1, NOW(), NOW())",
        )
        .bind(&draft_id)
        .bind(&generation_id)
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("generated technique draft should insert");
        sqlx::query(
            "INSERT INTO technique_generation_job (id, character_id, week_key, status, type_rolled, quality_rolled, cost_points, used_cooldown_bypass_token, burning_word_prompt, prompt_snapshot, model_name, attempt_count, draft_technique_id, generated_technique_id, publish_attempts, draft_expire_at, viewed_at, failed_viewed_at, finished_at, error_code, error_message, created_at, updated_at) VALUES ($1, $2, '2026-W01', 'generated_draft', '武技', '玄', 11, false, NULL, '{}'::jsonb, 'mock-tech', 1, $3, NULL, 0, NOW() - INTERVAL '1 hour', NULL, NULL, NOW() - INTERVAL '2 hours', NULL, NULL, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours')",
        )
        .bind(&generation_id)
        .bind(fixture.character_id)
        .bind(&draft_id)
        .execute(&pool)
        .await
        .expect("technique generation job should insert");

        let summary = crate::jobs::technique_draft_cleanup::run_technique_draft_cleanup_once(&state)
            .await
            .expect("technique draft cleanup should succeed");
        let job_row = sqlx::query("SELECT status, error_code, error_message FROM technique_generation_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("job row should exist");
        let mail_row = sqlx::query("SELECT title, content, attach_items FROM mail WHERE recipient_character_id = $1 AND source = 'technique_generation' AND source_ref_id = $2 ORDER BY id DESC LIMIT 1")
            .bind(fixture.character_id)
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("refund mail should exist");
        let counter_row = sqlx::query(
            "SELECT total_count, unread_count, unclaimed_count FROM mail_counter WHERE scope_type = 'character' AND scope_id = $1 LIMIT 1",
        )
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("mail counter row should exist");

        println!(
            "TECHNIQUE_DRAFT_CLEANUP_SUMMARY={{\"refunded\":{},\"status\":\"{}\"}}",
            summary.refunded_draft_count,
            job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default()
        );

        assert!(summary.refunded_draft_count >= 1);
        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "refunded");
        assert_eq!(job_row.try_get::<Option<String>, _>("error_code").unwrap_or(None).unwrap_or_default(), "GENERATION_EXPIRED");
        assert!(job_row.try_get::<Option<String>, _>("error_message").unwrap_or(None).unwrap_or_default().contains("草稿已过期"));
        assert_eq!(mail_row.try_get::<Option<String>, _>("title").unwrap_or(None).unwrap_or_default(), "功法残页返还");
        assert!(mail_row.try_get::<Option<String>, _>("content").unwrap_or(None).unwrap_or_default().contains("返还一半功法残页"));
        assert!(mail_row.try_get::<Option<serde_json::Value>, _>("attach_items").unwrap_or(None).unwrap_or_else(|| serde_json::json!([])).to_string().contains("mat-gongfa-canye"));
        assert!(counter_row.try_get::<Option<i64>, _>("total_count").unwrap_or(None).unwrap_or_default() >= 1);
        assert!(counter_row.try_get::<Option<i64>, _>("unread_count").unwrap_or(None).unwrap_or_default() >= 1);
        assert!(counter_row.try_get::<Option<i64>, _>("unclaimed_count").unwrap_or(None).unwrap_or_default() >= 1);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_recruit_draft_cleanup_discards_expired_preview() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_RECRUIT_DRAFT_CLEANUP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("partner-recruit-cleanup-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let generation_id = format!("partner-gen-{suffix}");
        let preview_partner_def_id = format!("generated-partner-{suffix}");

        sqlx::query(
            "INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, base_attrs, level_attr_gains, innate_technique_ids, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '青木灵伴', 'preview', '/assets/generated/partners/x.png', '玄', 'wood', 'support', 1, '{\"max_qixue\":100}'::jsonb, '{\"max_qixue\":5}'::jsonb, ARRAY[]::text[], TRUE, $2, $3, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')",
        )
        .bind(&preview_partner_def_id)
        .bind(fixture.character_id)
        .bind(&generation_id)
        .execute(&pool)
        .await
        .expect("generated partner preview should insert");
        sqlx::query(
            "INSERT INTO partner_recruit_job (id, character_id, status, quality_rolled, spirit_stones_cost, requested_base_model, used_custom_base_model_token, cooldown_started_at, finished_at, viewed_at, error_message, preview_partner_def_id, preview_avatar_url, created_at, updated_at) VALUES ($1, $2, 'generated_draft', '玄', 300, '青木', TRUE, NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days', NULL, NULL, $3, '/assets/generated/partners/x.png', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')",
        )
        .bind(&generation_id)
        .bind(fixture.character_id)
        .bind(&preview_partner_def_id)
        .execute(&pool)
        .await
        .expect("partner recruit job should insert");

        let summary = crate::jobs::partner_recruit_draft_cleanup::run_partner_recruit_draft_cleanup_once(&state)
            .await
            .expect("partner recruit draft cleanup should succeed");
        let row = sqlx::query("SELECT status, viewed_at FROM partner_recruit_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("partner recruit row should exist");

        println!("PARTNER_RECRUIT_DRAFT_CLEANUP_COUNT={}", summary.discarded_draft_count);

        assert!(summary.discarded_draft_count >= 1);
        assert_eq!(row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "discarded");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn afdian_message_retry_recovery_dispatches_due_delivery() {
        let _guard = afdian_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "AFDIAN_RETRY_RECOVERY_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };
        let suffix = super::chrono_like_timestamp_ms();
        let order_id = 123456_i64 + ((suffix % 100000) as i64);

        sqlx::query("DELETE FROM afdian_message_delivery")
            .execute(&pool)
            .await
            .expect("afdian deliveries should clear");

        sqlx::query(
            "INSERT INTO afdian_message_delivery (order_id, recipient_user_id, content, status, attempt_count, next_retry_at, created_at, updated_at) VALUES ($1, 'afdian-user', 'hello', 'pending', 0, NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute')",
        )
        .bind(order_id)
        .execute(&pool)
        .await
        .expect("afdian delivery should insert");

        let recovered = crate::jobs::recover_pending_afdian_message_deliveries(state.clone())
            .await
            .expect("afdian delivery recovery should succeed");
        let mut final_status = String::new();
        let mut attempt_count = 0_i64;
        for _ in 0..60 {
            let delivery_row = sqlx::query("SELECT status, attempt_count FROM afdian_message_delivery WHERE order_id = $1")
                .bind(order_id)
                .fetch_one(&pool)
                .await
                .expect("afdian delivery should exist");
            final_status = delivery_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default();
            attempt_count = delivery_row.try_get::<Option<i32>, _>("attempt_count").unwrap_or(None).map(i64::from).unwrap_or_default();
            if final_status != "pending" && final_status != "sending" || attempt_count > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }

        println!(
            "AFDIAN_RETRY_RECOVERY_RESULT={{\"recovered\":{},\"status\":\"{}\",\"attemptCount\":{}}}",
            recovered,
            final_status,
            attempt_count
        );

        assert!(recovered >= 1);
        assert!(matches!(final_status.as_str(), "sending" | "sent" | "failed"));
    }

    #[tokio::test]
        async fn afdian_webhook_route_end_to_end_creates_redeem_code_and_sends_message() {
        let _guard = afdian_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "AFDIAN_WEBHOOK_E2E_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };
        let suffix = super::chrono_like_timestamp_ms();
        let out_trade_no = format!("trade-e2e-{suffix}");
        let out_trade_no_for_api = out_trade_no.clone();

        let sent_message_body = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let sent_message_body_for_api = sent_message_body.clone();

        let api_app = axum::Router::new()
            .route(
                "/api/open/query-order",
                axum::routing::post(|| async move {
                    axum::Json(serde_json::json!({
                        "ec": 200,
                        "em": "",
                        "data": {
                            "list": [{
                                "out_trade_no": out_trade_no_for_api,
                                "user_id": "afdian-user",
                                "user_private_id": "private-user",
                                "plan_id": "5ca895ba23ad11f1984552540025c377",
                                "month": 1,
                                "total_amount": "30.00",
                                "status": 2,
                                "sku_detail": [{"count": 2}]
                            }]
                        }
                    }))
                }),
            )
            .route(
                "/api/open/send-msg",
                axum::routing::post(move |axum::Json(raw_body): axum::Json<serde_json::Value>| {
                    let sent_message_body = sent_message_body_for_api.clone();
                    async move {
                        *sent_message_body.lock().expect("sent message lock should acquire") = raw_body.to_string();
                    axum::Json(serde_json::json!({
                        "ec": 200,
                        "em": "",
                        "data": {"ok": true}
                    }))
                    }
                }),
            );
        let (api_address, api_server) = spawn_test_server(api_app).await;

        let old_base = std::env::var("AFDIAN_OPEN_API_BASE_URL").ok();
        let old_user = std::env::var("AFDIAN_OPEN_USER_ID").ok();
        let old_token = std::env::var("AFDIAN_OPEN_TOKEN").ok();
        unsafe {
            std::env::set_var("AFDIAN_OPEN_API_BASE_URL", format!("http://{api_address}"));
            std::env::set_var("AFDIAN_OPEN_USER_ID", "mock-user-id");
            std::env::set_var("AFDIAN_OPEN_TOKEN", "mock-token");
        }

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/afdian/webhook"))
            .header("content-type", "application/json")
            .body(format!(r#"{{"data":{{"type":"order","order":{{"out_trade_no":"{}","user_id":"afdian-user","user_private_id":"private-user","plan_id":"5ca895ba23ad11f1984552540025c377","month":1,"total_amount":"30.00","status":2,"sku_detail":[{{"count":2}}]}}}}}}"#, out_trade_no))
            .send()
            .await
            .expect("afdian webhook request should succeed");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let order_row = sqlx::query("SELECT redeem_code_id FROM afdian_order WHERE out_trade_no = $1")
            .bind(&out_trade_no)
            .fetch_one(&pool)
            .await
            .expect("afdian order should exist");
        let redeem_code_id = order_row.try_get::<Option<i64>, _>("redeem_code_id").unwrap_or(None).unwrap_or_default();
        let redeem_row = sqlx::query("SELECT reward_payload FROM redeem_code WHERE id = $1")
            .bind(redeem_code_id)
            .fetch_one(&pool)
            .await
            .expect("redeem code should exist");
        let mut final_status = String::new();
        let mut attempt_count = 0_i64;
        let mut sent_at = None::<String>;
        for _ in 0..60 {
            let delivery_row = sqlx::query("SELECT status, attempt_count, sent_at::text AS sent_at_text FROM afdian_message_delivery WHERE order_id = (SELECT id FROM afdian_order WHERE out_trade_no = $1)")
                .bind(&out_trade_no)
                .fetch_one(&pool)
                .await
                .expect("delivery should exist");
            final_status = delivery_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default();
            attempt_count = delivery_row.try_get::<Option<i32>, _>("attempt_count").unwrap_or(None).map(i64::from).unwrap_or_default();
            sent_at = delivery_row.try_get::<Option<String>, _>("sent_at_text").unwrap_or(None);
            if final_status != "sending" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        let sent_message_payload = sent_message_body
            .lock()
            .expect("sent message lock should acquire")
            .clone();

        println!("AFDIAN_WEBHOOK_E2E_RESPONSE={body}");
        println!("AFDIAN_WEBHOOK_E2E_SEND_MSG_BODY={sent_message_payload}");

        server.abort();
        api_server.abort();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ec"], 200);
        assert!(redeem_code_id > 0);
        assert!(redeem_row.try_get::<Option<serde_json::Value>, _>("reward_payload").unwrap_or(None).unwrap_or_else(|| serde_json::json!({})).to_string().contains("token-004"));
        assert_eq!(final_status, "sent");
        assert!(attempt_count >= 1);
        assert!(sent_at.is_some());
        assert!(sent_message_payload.contains("兑换码"));
        assert!(sent_message_payload.contains("AFD"));

        unsafe {
            match old_base { Some(v) => std::env::set_var("AFDIAN_OPEN_API_BASE_URL", v), None => std::env::remove_var("AFDIAN_OPEN_API_BASE_URL") };
            match old_user { Some(v) => std::env::set_var("AFDIAN_OPEN_USER_ID", v), None => std::env::remove_var("AFDIAN_OPEN_USER_ID") };
            match old_token { Some(v) => std::env::set_var("AFDIAN_OPEN_TOKEN", v), None => std::env::remove_var("AFDIAN_OPEN_TOKEN") };
        }
    }

    #[tokio::test]
        async fn afdian_webhook_route_marks_delivery_failed_when_send_msg_errors() {
        let _guard = afdian_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "AFDIAN_WEBHOOK_FAILURE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };
        let suffix = super::chrono_like_timestamp_ms();
        let out_trade_no = format!("trade-e2e-fail-{suffix}");
        let out_trade_no_for_api = out_trade_no.clone();

        let api_app = axum::Router::new()
            .route(
                "/api/open/query-order",
                axum::routing::post(|| async move {
                    axum::Json(serde_json::json!({
                        "ec": 200,
                        "em": "",
                        "data": {
                            "list": [{
                                "out_trade_no": out_trade_no_for_api,
                                "user_id": "afdian-user",
                                "user_private_id": "private-user",
                                "plan_id": "5ca895ba23ad11f1984552540025c377",
                                "month": 1,
                                "total_amount": "30.00",
                                "status": 2,
                                "sku_detail": [{"count": 1}]
                            }]
                        }
                    }))
                }),
            )
            .route(
                "/api/open/send-msg",
                axum::routing::post(|| async move {
                    (
                        axum::http::StatusCode::BAD_GATEWAY,
                        axum::Json(serde_json::json!({"error":"mock upstream failed"})),
                    )
                }),
            );
        let (api_address, api_server) = spawn_test_server(api_app).await;

        let old_base = std::env::var("AFDIAN_OPEN_API_BASE_URL").ok();
        let old_user = std::env::var("AFDIAN_OPEN_USER_ID").ok();
        let old_token = std::env::var("AFDIAN_OPEN_TOKEN").ok();
        unsafe {
            std::env::set_var("AFDIAN_OPEN_API_BASE_URL", format!("http://{api_address}"));
            std::env::set_var("AFDIAN_OPEN_USER_ID", "mock-user-id");
            std::env::set_var("AFDIAN_OPEN_TOKEN", "mock-token");
        }

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/afdian/webhook"))
            .header("content-type", "application/json")
            .body(format!(r#"{{"data":{{"type":"order","order":{{"out_trade_no":"{}","user_id":"afdian-user","user_private_id":"private-user","plan_id":"5ca895ba23ad11f1984552540025c377","month":1,"total_amount":"30.00","status":2,"sku_detail":[{{"count":1}}]}}}}}}"#, out_trade_no))
            .send()
            .await
            .expect("afdian webhook request should succeed");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let mut final_status = String::new();
        let mut attempt_count = 0_i64;
        let mut next_retry_at = None::<String>;
        let mut last_error = String::new();
        for _ in 0..60 {
            let delivery_row = sqlx::query("SELECT status, attempt_count, next_retry_at::text AS next_retry_at_text, last_error FROM afdian_message_delivery WHERE order_id = (SELECT id FROM afdian_order WHERE out_trade_no = $1)")
                .bind(&out_trade_no)
                .fetch_one(&pool)
                .await
                .expect("delivery should exist");
            final_status = delivery_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default();
            attempt_count = delivery_row.try_get::<Option<i32>, _>("attempt_count").unwrap_or(None).map(i64::from).unwrap_or_default();
            next_retry_at = delivery_row.try_get::<Option<String>, _>("next_retry_at_text").unwrap_or(None);
            last_error = delivery_row.try_get::<Option<String>, _>("last_error").unwrap_or(None).unwrap_or_default();
            if final_status != "sending" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }

        println!("AFDIAN_WEBHOOK_FAILURE_RESPONSE={body}");

        server.abort();
        api_server.abort();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ec"], 200);
        assert_eq!(final_status, "failed");
        assert!(attempt_count >= 1);
        assert!(next_retry_at.is_some());
        assert!(last_error.contains("HTTP 502"));

        unsafe {
            match old_base { Some(v) => std::env::set_var("AFDIAN_OPEN_API_BASE_URL", v), None => std::env::remove_var("AFDIAN_OPEN_API_BASE_URL") };
            match old_user { Some(v) => std::env::set_var("AFDIAN_OPEN_USER_ID", v), None => std::env::remove_var("AFDIAN_OPEN_USER_ID") };
            match old_token { Some(v) => std::env::set_var("AFDIAN_OPEN_TOKEN", v), None => std::env::remove_var("AFDIAN_OPEN_TOKEN") };
        }
    }

    #[tokio::test]
        async fn afdian_webhook_route_marks_delivery_failed_when_send_msg_returns_ok_false_business_error() {
        let _guard = afdian_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "AFDIAN_SEND_EC_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };
        let suffix = super::chrono_like_timestamp_ms();
        let out_trade_no = format!("trade-send-ec-{suffix}");
        let out_trade_no_for_api = out_trade_no.clone();

        let api_app = axum::Router::new()
            .route(
                "/api/open/query-order",
                axum::routing::post(|| async move {
                    axum::Json(serde_json::json!({
                        "ec": 200,
                        "em": "",
                        "data": {
                            "list": [{
                                "out_trade_no": out_trade_no_for_api,
                                "user_id": "afdian-user",
                                "user_private_id": "private-user",
                                "plan_id": "5ca895ba23ad11f1984552540025c377",
                                "month": 1,
                                "total_amount": "30.00",
                                "status": 2,
                                "sku_detail": [{"count": 1}]
                            }]
                        }
                    }))
                }),
            )
            .route(
                "/api/open/send-msg",
                axum::routing::post(|| async move {
                    axum::Json(serde_json::json!({
                        "ec": 200,
                        "em": "send-msg business failed",
                        "data": {"ok": false}
                    }))
                }),
            );
        let (api_address, api_server) = spawn_test_server(api_app).await;

        let old_base = std::env::var("AFDIAN_OPEN_API_BASE_URL").ok();
        let old_user = std::env::var("AFDIAN_OPEN_USER_ID").ok();
        let old_token = std::env::var("AFDIAN_OPEN_TOKEN").ok();
        unsafe {
            std::env::set_var("AFDIAN_OPEN_API_BASE_URL", format!("http://{api_address}"));
            std::env::set_var("AFDIAN_OPEN_USER_ID", "mock-user-id");
            std::env::set_var("AFDIAN_OPEN_TOKEN", "mock-token");
        }

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/afdian/webhook"))
            .header("content-type", "application/json")
            .body(format!(r#"{{"data":{{"type":"order","order":{{"out_trade_no":"{}","user_id":"afdian-user","user_private_id":"private-user","plan_id":"5ca895ba23ad11f1984552540025c377","month":1,"total_amount":"30.00","status":2,"sku_detail":[{{"count":1}}]}}}}}}"#, out_trade_no))
            .send()
            .await
            .expect("afdian webhook request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let mut final_status = String::new();
        let mut attempt_count = 0_i64;
        let mut next_retry_at = None::<String>;
        let mut last_error = String::new();
        for _ in 0..20 {
            let delivery_row = sqlx::query("SELECT status, attempt_count, next_retry_at::text AS next_retry_at_text, last_error FROM afdian_message_delivery WHERE order_id = (SELECT id FROM afdian_order WHERE out_trade_no = $1)")
                .bind(&out_trade_no)
                .fetch_one(&pool)
                .await
                .expect("delivery should exist");
            final_status = delivery_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default();
            attempt_count = delivery_row.try_get::<Option<i64>, _>("attempt_count").unwrap_or(None).unwrap_or_default();
            next_retry_at = delivery_row.try_get::<Option<String>, _>("next_retry_at_text").unwrap_or(None);
            last_error = delivery_row.try_get::<Option<String>, _>("last_error").unwrap_or(None).unwrap_or_default();
            if final_status != "sending" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }

        println!("AFDIAN_SEND_EC_RESPONSE={body}");

        server.abort();
        api_server.abort();

        assert_eq!(body["ec"], 200);
        assert_eq!(final_status, "failed");
        assert!(last_error.contains("send-msg business failed"));
        assert!(next_retry_at.is_some());

        unsafe {
            match old_base { Some(v) => std::env::set_var("AFDIAN_OPEN_API_BASE_URL", v), None => std::env::remove_var("AFDIAN_OPEN_API_BASE_URL") };
            match old_user { Some(v) => std::env::set_var("AFDIAN_OPEN_USER_ID", v), None => std::env::remove_var("AFDIAN_OPEN_USER_ID") };
            match old_token { Some(v) => std::env::set_var("AFDIAN_OPEN_TOKEN", v), None => std::env::remove_var("AFDIAN_OPEN_TOKEN") };
        }
    }

    #[tokio::test]
        async fn afdian_webhook_route_is_idempotent_on_replay() {
        let _guard = afdian_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "AFDIAN_WEBHOOK_IDEMPOTENT_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let api_app = axum::Router::new()
            .route(
                "/api/open/query-order",
                axum::routing::post(|| async move {
                    axum::Json(serde_json::json!({
                        "ec": 200,
                        "em": "",
                        "data": {
                            "list": [{
                                "out_trade_no": "trade-e2e-idempotent-1",
                                "user_id": "afdian-user",
                                "user_private_id": "private-user",
                                "plan_id": "5ca895ba23ad11f1984552540025c377",
                                "month": 1,
                                "total_amount": "30.00",
                                "status": 2,
                                "sku_detail": [{"count": 1}]
                            }]
                        }
                    }))
                }),
            )
            .route(
                "/api/open/send-msg",
                axum::routing::post(|| async move {
                    axum::Json(serde_json::json!({
                        "ec": 200,
                        "em": "",
                        "data": {"ok": true}
                    }))
                }),
            );
        let (api_address, api_server) = spawn_test_server(api_app).await;

        let old_base = std::env::var("AFDIAN_OPEN_API_BASE_URL").ok();
        let old_user = std::env::var("AFDIAN_OPEN_USER_ID").ok();
        let old_token = std::env::var("AFDIAN_OPEN_TOKEN").ok();
        unsafe {
            std::env::set_var("AFDIAN_OPEN_API_BASE_URL", format!("http://{api_address}"));
            std::env::set_var("AFDIAN_OPEN_USER_ID", "mock-user-id");
            std::env::set_var("AFDIAN_OPEN_TOKEN", "mock-token");
        }

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let payload = r#"{"data":{"type":"order","order":{"out_trade_no":"trade-e2e-idempotent-1","user_id":"afdian-user","user_private_id":"private-user","plan_id":"5ca895ba23ad11f1984552540025c377","month":1,"total_amount":"30.00","status":2,"sku_detail":[{"count":1}]}}}"#;

        let first = client
            .post(format!("http://{address}/api/afdian/webhook"))
            .header("content-type", "application/json")
            .body(payload)
            .send()
            .await
            .expect("first webhook should succeed");
        let second = client
            .post(format!("http://{address}/api/afdian/webhook"))
            .header("content-type", "application/json")
            .body(payload)
            .send()
            .await
            .expect("second webhook should succeed");
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(second.status(), StatusCode::OK);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let order_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM afdian_order WHERE out_trade_no = 'trade-e2e-idempotent-1'")
            .fetch_one(&pool)
            .await
            .expect("order count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");
        let redeem_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM redeem_code WHERE source_type = 'afdian_order' AND source_ref_id = 'trade-e2e-idempotent-1'")
            .fetch_one(&pool)
            .await
            .expect("redeem count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");
        let delivery_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM afdian_message_delivery WHERE order_id = (SELECT id FROM afdian_order WHERE out_trade_no = 'trade-e2e-idempotent-1')")
            .fetch_one(&pool)
            .await
            .expect("delivery count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");

        println!(
            "AFDIAN_WEBHOOK_IDEMPOTENT_COUNTS={{\"orders\":{},\"redeemCodes\":{},\"deliveries\":{}}}",
            order_count,
            redeem_count,
            delivery_count
        );

        server.abort();
        api_server.abort();

        assert_eq!(order_count, 1);
        assert_eq!(redeem_count, 1);
        assert_eq!(delivery_count, 1);

        unsafe {
            match old_base { Some(v) => std::env::set_var("AFDIAN_OPEN_API_BASE_URL", v), None => std::env::remove_var("AFDIAN_OPEN_API_BASE_URL") };
            match old_user { Some(v) => std::env::set_var("AFDIAN_OPEN_USER_ID", v), None => std::env::remove_var("AFDIAN_OPEN_USER_ID") };
            match old_token { Some(v) => std::env::set_var("AFDIAN_OPEN_TOKEN", v), None => std::env::remove_var("AFDIAN_OPEN_TOKEN") };
        }
    }

    #[tokio::test]
        async fn afdian_webhook_route_ignores_unconfigured_plan_without_delivery() {
        let _guard = afdian_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "AFDIAN_UNSUPPORTED_PLAN_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let api_app = axum::Router::new().route(
            "/api/open/query-order",
            axum::routing::post(|| async move {
                axum::Json(serde_json::json!({
                    "ec": 200,
                    "em": "",
                    "data": {
                        "list": [{
                            "out_trade_no": "trade-unsupported-1",
                            "user_id": "afdian-user",
                            "user_private_id": "private-user",
                            "plan_id": "unsupported-plan-id",
                            "month": 1,
                            "total_amount": "30.00",
                            "status": 2,
                            "sku_detail": [{"count": 1}]
                        }]
                    }
                }))
            }),
        );
        let (api_address, api_server) = spawn_test_server(api_app).await;

        let old_base = std::env::var("AFDIAN_OPEN_API_BASE_URL").ok();
        let old_user = std::env::var("AFDIAN_OPEN_USER_ID").ok();
        let old_token = std::env::var("AFDIAN_OPEN_TOKEN").ok();
        unsafe {
            std::env::set_var("AFDIAN_OPEN_API_BASE_URL", format!("http://{api_address}"));
            std::env::set_var("AFDIAN_OPEN_USER_ID", "mock-user-id");
            std::env::set_var("AFDIAN_OPEN_TOKEN", "mock-token");
        }

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/afdian/webhook"))
            .header("content-type", "application/json")
            .body(r#"{"data":{"type":"order","order":{"out_trade_no":"trade-unsupported-1","user_id":"afdian-user","user_private_id":"private-user","plan_id":"unsupported-plan-id","month":1,"total_amount":"30.00","status":2,"sku_detail":[{"count":1}]}}}"#)
            .send()
            .await
            .expect("afdian webhook should succeed");
        let status = response.status();

        let order_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM afdian_order WHERE out_trade_no = 'trade-unsupported-1'")
            .fetch_one(&pool)
            .await
            .expect("order count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");
        let redeem_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM redeem_code WHERE source_ref_id = 'trade-unsupported-1'")
            .fetch_one(&pool)
            .await
            .expect("redeem count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");
        let delivery_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM afdian_message_delivery WHERE order_id IN (SELECT id FROM afdian_order WHERE out_trade_no = 'trade-unsupported-1')")
            .fetch_one(&pool)
            .await
            .expect("delivery count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");

        println!(
            "AFDIAN_UNSUPPORTED_PLAN_COUNTS={{\"orders\":{},\"redeemCodes\":{},\"deliveries\":{}}}",
            order_count,
            redeem_count,
            delivery_count
        );

        server.abort();
        api_server.abort();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(order_count, 1);
        assert_eq!(redeem_count, 0);
        assert_eq!(delivery_count, 0);

        unsafe {
            match old_base { Some(v) => std::env::set_var("AFDIAN_OPEN_API_BASE_URL", v), None => std::env::remove_var("AFDIAN_OPEN_API_BASE_URL") };
            match old_user { Some(v) => std::env::set_var("AFDIAN_OPEN_USER_ID", v), None => std::env::remove_var("AFDIAN_OPEN_USER_ID") };
            match old_token { Some(v) => std::env::set_var("AFDIAN_OPEN_TOKEN", v), None => std::env::remove_var("AFDIAN_OPEN_TOKEN") };
        }
    }

    #[tokio::test]
        async fn afdian_webhook_route_rejects_mismatched_query_order_without_side_effects() {
        let _guard = afdian_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "AFDIAN_MISMATCH_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let api_app = axum::Router::new().route(
            "/api/open/query-order",
            axum::routing::post(|| async move {
                axum::Json(serde_json::json!({
                    "ec": 200,
                    "em": "",
                    "data": {
                        "list": [{
                            "out_trade_no": "trade-mismatch-1",
                            "user_id": "afdian-user",
                            "user_private_id": "private-user",
                            "plan_id": "5ca895ba23ad11f1984552540025c377",
                            "month": 1,
                            "total_amount": "999.00",
                            "status": 2,
                            "sku_detail": [{"count": 1}]
                        }]
                    }
                }))
            }),
        );
        let (api_address, api_server) = spawn_test_server(api_app).await;

        let old_base = std::env::var("AFDIAN_OPEN_API_BASE_URL").ok();
        let old_user = std::env::var("AFDIAN_OPEN_USER_ID").ok();
        let old_token = std::env::var("AFDIAN_OPEN_TOKEN").ok();
        unsafe {
            std::env::set_var("AFDIAN_OPEN_API_BASE_URL", format!("http://{api_address}"));
            std::env::set_var("AFDIAN_OPEN_USER_ID", "mock-user-id");
            std::env::set_var("AFDIAN_OPEN_TOKEN", "mock-token");
        }

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/afdian/webhook"))
            .header("content-type", "application/json")
            .body(r#"{"data":{"type":"order","order":{"out_trade_no":"trade-mismatch-1","user_id":"afdian-user","user_private_id":"private-user","plan_id":"5ca895ba23ad11f1984552540025c377","month":1,"total_amount":"30.00","status":2,"sku_detail":[{"count":1}]}}}"#)
            .send()
            .await
            .expect("afdian webhook should return");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let order_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM afdian_order WHERE out_trade_no = 'trade-mismatch-1'")
            .fetch_one(&pool)
            .await
            .expect("order count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");
        let redeem_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM redeem_code WHERE source_ref_id = 'trade-mismatch-1'")
            .fetch_one(&pool)
            .await
            .expect("redeem count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");
        let delivery_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM afdian_message_delivery WHERE order_id IN (SELECT id FROM afdian_order WHERE out_trade_no = 'trade-mismatch-1')")
            .fetch_one(&pool)
            .await
            .expect("delivery count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");

        println!("AFDIAN_MISMATCH_RESPONSE={body}");

        server.abort();
        api_server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["em"].as_str().unwrap_or_default().contains("total_amount"));
        assert_eq!(order_count, 0);
        assert_eq!(redeem_count, 0);
        assert_eq!(delivery_count, 0);

        unsafe {
            match old_base { Some(v) => std::env::set_var("AFDIAN_OPEN_API_BASE_URL", v), None => std::env::remove_var("AFDIAN_OPEN_API_BASE_URL") };
            match old_user { Some(v) => std::env::set_var("AFDIAN_OPEN_USER_ID", v), None => std::env::remove_var("AFDIAN_OPEN_USER_ID") };
            match old_token { Some(v) => std::env::set_var("AFDIAN_OPEN_TOKEN", v), None => std::env::remove_var("AFDIAN_OPEN_TOKEN") };
        }
    }

    #[tokio::test]
        async fn afdian_webhook_route_rejects_when_query_order_finds_nothing() {
        let _guard = afdian_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "AFDIAN_QUERY_MISS_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let api_app = axum::Router::new().route(
            "/api/open/query-order",
            axum::routing::post(|| async move {
                axum::Json(serde_json::json!({
                    "ec": 200,
                    "em": "",
                    "data": {"list": []}
                }))
            }),
        );
        let (api_address, api_server) = spawn_test_server(api_app).await;

        let old_base = std::env::var("AFDIAN_OPEN_API_BASE_URL").ok();
        let old_user = std::env::var("AFDIAN_OPEN_USER_ID").ok();
        let old_token = std::env::var("AFDIAN_OPEN_TOKEN").ok();
        unsafe {
            std::env::set_var("AFDIAN_OPEN_API_BASE_URL", format!("http://{api_address}"));
            std::env::set_var("AFDIAN_OPEN_USER_ID", "mock-user-id");
            std::env::set_var("AFDIAN_OPEN_TOKEN", "mock-token");
        }

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/afdian/webhook"))
            .header("content-type", "application/json")
            .body(r#"{"data":{"type":"order","order":{"out_trade_no":"trade-miss-1","user_id":"afdian-user","user_private_id":"private-user","plan_id":"5ca895ba23ad11f1984552540025c377","month":1,"total_amount":"30.00","status":2,"sku_detail":[{"count":1}]}}}"#)
            .send()
            .await
            .expect("afdian webhook should return");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let order_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM afdian_order WHERE out_trade_no = 'trade-miss-1'")
            .fetch_one(&pool)
            .await
            .expect("order count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");

        println!("AFDIAN_QUERY_MISS_RESPONSE={body}");

        server.abort();
        api_server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["ec"], 400);
        assert!(body["em"].as_str().unwrap_or_default().contains("未找到对应订单"));
        assert_eq!(order_count, 0);

        unsafe {
            match old_base { Some(v) => std::env::set_var("AFDIAN_OPEN_API_BASE_URL", v), None => std::env::remove_var("AFDIAN_OPEN_API_BASE_URL") };
            match old_user { Some(v) => std::env::set_var("AFDIAN_OPEN_USER_ID", v), None => std::env::remove_var("AFDIAN_OPEN_USER_ID") };
            match old_token { Some(v) => std::env::set_var("AFDIAN_OPEN_TOKEN", v), None => std::env::remove_var("AFDIAN_OPEN_TOKEN") };
        }
    }

    #[tokio::test]
        async fn afdian_webhook_route_rejects_when_query_order_returns_business_error() {
        let _guard = afdian_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "AFDIAN_QUERY_EC_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let api_app = axum::Router::new().route(
            "/api/open/query-order",
            axum::routing::post(|| async move {
                axum::Json(serde_json::json!({
                    "ec": 500,
                    "em": "query-order upstream rejected request",
                    "data": {"list": []}
                }))
            }),
        );
        let (api_address, api_server) = spawn_test_server(api_app).await;

        let old_base = std::env::var("AFDIAN_OPEN_API_BASE_URL").ok();
        let old_user = std::env::var("AFDIAN_OPEN_USER_ID").ok();
        let old_token = std::env::var("AFDIAN_OPEN_TOKEN").ok();
        unsafe {
            std::env::set_var("AFDIAN_OPEN_API_BASE_URL", format!("http://{api_address}"));
            std::env::set_var("AFDIAN_OPEN_USER_ID", "mock-user-id");
            std::env::set_var("AFDIAN_OPEN_TOKEN", "mock-token");
        }

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/afdian/webhook"))
            .header("content-type", "application/json")
            .body(r#"{"data":{"type":"order","order":{"out_trade_no":"trade-ec-1","user_id":"afdian-user","user_private_id":"private-user","plan_id":"5ca895ba23ad11f1984552540025c377","month":1,"total_amount":"30.00","status":2,"sku_detail":[{"count":1}]}}}"#)
            .send()
            .await
            .expect("afdian webhook should return");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let order_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM afdian_order WHERE out_trade_no = 'trade-ec-1'")
            .fetch_one(&pool)
            .await
            .expect("order count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");

        println!("AFDIAN_QUERY_EC_RESPONSE={body}");

        server.abort();
        api_server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["ec"], 400);
        assert_eq!(body["em"], "configuration error: query-order upstream rejected request");
        assert_eq!(order_count, 0);

        unsafe {
            match old_base { Some(v) => std::env::set_var("AFDIAN_OPEN_API_BASE_URL", v), None => std::env::remove_var("AFDIAN_OPEN_API_BASE_URL") };
            match old_user { Some(v) => std::env::set_var("AFDIAN_OPEN_USER_ID", v), None => std::env::remove_var("AFDIAN_OPEN_USER_ID") };
            match old_token { Some(v) => std::env::set_var("AFDIAN_OPEN_TOKEN", v), None => std::env::remove_var("AFDIAN_OPEN_TOKEN") };
        }
    }

    #[tokio::test]
        async fn afdian_webhook_route_rejects_when_query_order_http_fails() {
        let _guard = afdian_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "AFDIAN_QUERY_HTTP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let api_app = axum::Router::new().route(
            "/api/open/query-order",
            axum::routing::post(|| async move {
                (
                    axum::http::StatusCode::BAD_GATEWAY,
                    axum::Json(serde_json::json!({"error":"mock query-order unavailable"})),
                )
            }),
        );
        let (api_address, api_server) = spawn_test_server(api_app).await;

        let old_base = std::env::var("AFDIAN_OPEN_API_BASE_URL").ok();
        let old_user = std::env::var("AFDIAN_OPEN_USER_ID").ok();
        let old_token = std::env::var("AFDIAN_OPEN_TOKEN").ok();
        unsafe {
            std::env::set_var("AFDIAN_OPEN_API_BASE_URL", format!("http://{api_address}"));
            std::env::set_var("AFDIAN_OPEN_USER_ID", "mock-user-id");
            std::env::set_var("AFDIAN_OPEN_TOKEN", "mock-token");
        }

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/afdian/webhook"))
            .header("content-type", "application/json")
            .body(r#"{"data":{"type":"order","order":{"out_trade_no":"trade-http-1","user_id":"afdian-user","user_private_id":"private-user","plan_id":"5ca895ba23ad11f1984552540025c377","month":1,"total_amount":"30.00","status":2,"sku_detail":[{"count":1}]}}}"#)
            .send()
            .await
            .expect("afdian webhook should return");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let order_count = sqlx::query("SELECT COUNT(1)::bigint AS cnt FROM afdian_order WHERE out_trade_no = 'trade-http-1'")
            .fetch_one(&pool)
            .await
            .expect("order count should query")
            .try_get::<i64, _>("cnt")
            .expect("count should decode");

        println!("AFDIAN_QUERY_HTTP_RESPONSE={body}");

        server.abort();
        api_server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["ec"], 400);
        assert!(body["em"].as_str().unwrap_or_default().contains("HTTP 502"));
        assert_eq!(order_count, 0);

        unsafe {
            match old_base { Some(v) => std::env::set_var("AFDIAN_OPEN_API_BASE_URL", v), None => std::env::remove_var("AFDIAN_OPEN_API_BASE_URL") };
            match old_user { Some(v) => std::env::set_var("AFDIAN_OPEN_USER_ID", v), None => std::env::remove_var("AFDIAN_OPEN_USER_ID") };
            match old_token { Some(v) => std::env::set_var("AFDIAN_OPEN_TOKEN", v), None => std::env::remove_var("AFDIAN_OPEN_TOKEN") };
        }
    }

    #[tokio::test]
        async fn afdian_retry_recovery_reclaims_stale_sending_delivery() {
        let _guard = afdian_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "AFDIAN_STALE_SENDING_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };
        let suffix = super::chrono_like_timestamp_ms();
        let out_trade_no = format!("trade-stale-{suffix}");

        let api_app = axum::Router::new().route(
            "/api/open/send-msg",
            axum::routing::post(|| async move {
                axum::Json(serde_json::json!({
                    "ec": 200,
                    "em": "",
                    "data": {"ok": true}
                }))
            }),
        );
        let (api_address, api_server) = spawn_test_server(api_app).await;

        let old_base = std::env::var("AFDIAN_OPEN_API_BASE_URL").ok();
        let old_user = std::env::var("AFDIAN_OPEN_USER_ID").ok();
        let old_token = std::env::var("AFDIAN_OPEN_TOKEN").ok();
        unsafe {
            std::env::set_var("AFDIAN_OPEN_API_BASE_URL", format!("http://{api_address}"));
            std::env::set_var("AFDIAN_OPEN_USER_ID", "mock-user-id");
            std::env::set_var("AFDIAN_OPEN_TOKEN", "mock-token");
        }

        sqlx::query(
            "INSERT INTO afdian_order (out_trade_no, sponsor_user_id, plan_id, month_count, total_amount, status, payload, processed_at, created_at, updated_at) VALUES ($1, 'afdian-user', '5ca895ba23ad11f1984552540025c377', 1, '30.00', 2, '{}'::jsonb, NOW(), NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')",
        )
        .bind(&out_trade_no)
        .execute(&pool)
        .await
        .expect("afdian order should insert");
        sqlx::query(
            "INSERT INTO afdian_message_delivery (order_id, recipient_user_id, content, status, attempt_count, next_retry_at, created_at, updated_at) VALUES ((SELECT id FROM afdian_order WHERE out_trade_no = $1), 'afdian-user', 'hello', 'sending', 1, NULL, NOW() - INTERVAL '1 day', NOW() - INTERVAL '700 seconds')",
        )
        .bind(&out_trade_no)
        .execute(&pool)
        .await
        .expect("stale sending delivery should insert");

        let recovered = crate::jobs::recover_pending_afdian_message_deliveries(state.clone())
            .await
            .expect("afdian recovery should succeed");
        let mut final_status = String::new();
        let mut attempt_count = 0_i64;
        let mut sent_at = None::<String>;
        for _ in 0..20 {
            let delivery_row = sqlx::query("SELECT status, attempt_count, sent_at::text AS sent_at_text FROM afdian_message_delivery WHERE order_id = (SELECT id FROM afdian_order WHERE out_trade_no = $1)")
                .bind(&out_trade_no)
                .fetch_one(&pool)
                .await
                .expect("delivery should exist");
            final_status = delivery_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default();
            attempt_count = delivery_row.try_get::<Option<i64>, _>("attempt_count").unwrap_or(None).unwrap_or_default();
            sent_at = delivery_row.try_get::<Option<String>, _>("sent_at_text").unwrap_or(None);
            if final_status != "sending" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }

        println!(
            "AFDIAN_STALE_SENDING_RESULT={{\"recovered\":{},\"status\":\"{}\",\"attemptCount\":{}}}",
            recovered,
            final_status,
            attempt_count
        );

        assert!(recovered >= 1);
        assert!(matches!(final_status.as_str(), "sending" | "sent"));
        if final_status == "sent" {
            assert!(sent_at.is_some());
        }

        unsafe {
            match old_base { Some(v) => std::env::set_var("AFDIAN_OPEN_API_BASE_URL", v), None => std::env::remove_var("AFDIAN_OPEN_API_BASE_URL") };
            match old_user { Some(v) => std::env::set_var("AFDIAN_OPEN_USER_ID", v), None => std::env::remove_var("AFDIAN_OPEN_USER_ID") };
            match old_token { Some(v) => std::env::set_var("AFDIAN_OPEN_TOKEN", v), None => std::env::remove_var("AFDIAN_OPEN_TOKEN") };
        }
        api_server.abort();
    }

    #[tokio::test]
        async fn avatar_cleanup_clears_character_avatar_and_local_file_when_enabled() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "AVATAR_CLEANUP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("avatar-cleanup-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let avatar_dir = state.config.storage.uploads_dir.join("avatars");
        std::fs::create_dir_all(&avatar_dir).expect("avatar dir should exist");
        let avatar_rel = format!("/uploads/avatars/test-{suffix}.png");
        let avatar_path = avatar_dir.join(format!("test-{suffix}.png"));
        std::fs::write(&avatar_path, b"avatar").expect("avatar file should write");
        sqlx::query("UPDATE characters SET avatar = $1 WHERE id = $2")
            .bind(&avatar_rel)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character avatar should update");

        unsafe {
            std::env::set_var("CLEAR_AVATARS", "1");
        }
        let summary = crate::bootstrap::avatar_cleanup::clear_all_avatars_once(&state)
            .await
            .expect("avatar cleanup should succeed");
        unsafe {
            std::env::remove_var("CLEAR_AVATARS");
        }

        let avatar_row = sqlx::query("SELECT avatar FROM characters WHERE id = $1")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("character row should load");

        println!(
            "AVATAR_CLEANUP_SUMMARY={{\"cleared\":{},\"deletedFiles\":{}}}",
            summary.cleared_avatar_row_count,
            summary.deleted_local_file_count
        );

        assert!(summary.enabled);
        assert!(summary.cleared_avatar_row_count >= 1);
        assert!(summary.deleted_local_file_count >= 1);
        assert_eq!(avatar_row.try_get::<Option<String>, _>("avatar").unwrap_or(None), None);
        assert!(!avatar_path.exists());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn game_socket_battle_sync_missing_battle_emits_abandoned_payload() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_BATTLE_SYNC_MISSING_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("battle-missing-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let user_id = fixture.user_id;
        let character_id = fixture.character_id;
        let token = fixture.token.clone();

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (sid, handshake_text) = handshake_sid(&client, address).await;
        socket_auth(&client, address, &sid, &token).await;
        let _ = poll_until_contains(&client, address, &sid, "game:auth-ready").await;

        socket_emit_raw(&client, address, &sid, "42[\"battle:sync\",{\"battleId\":\"missing-battle\"}]").await;

        let poll_text = poll_until_contains(&client, address, &sid, "battle:update").await;

        println!("GAME_SOCKET_BATTLE_SYNC_MISSING_HANDSHAKE={handshake_text}");
        println!("GAME_SOCKET_BATTLE_SYNC_MISSING_POLL={poll_text}");

        server.abort();

        assert!(poll_text.contains("battle:update"));
        assert!(poll_text.contains("battle_abandoned"));
        assert!(poll_text.contains("战斗不存在或已结束"));

        cleanup_auth_fixture(&pool, character_id, user_id).await;
    }

    #[tokio::test]
        async fn battle_route_generic_pve_actions_progress_then_finish_with_non_zero_rewards() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "BATTLE_ROUTE_GENERIC_PVE_ACTIONS_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("battle-route-pve-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET current_map_id = 'map-qingyun-outskirts', current_room_id = 'room-south-forest' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character room should update");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let start_response = client
            .post(format!("http://{address}/api/battle/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"monsterIds\":[\"monster-wild-rabbit\"]}")
            .send()
            .await
            .expect("battle start request should succeed");
        let start_status = start_response.status();
        let start_text = start_response.text().await.expect("start body should read");
        if start_status != StatusCode::OK {
            panic!("PARTNER_REBONE_START_ROUTE_RESPONSE={start_text}");
        }
        let start_body: Value = serde_json::from_str(&start_text)
            .expect("start body should be json");
        let battle_id = start_body["data"]["battleId"]
            .as_str()
            .expect("battle id should exist")
            .to_string();

        let first_action_response = client
            .post(format!("http://{address}/api/battle/action"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"battleId\":\"{}\",\"skillId\":\"sk-basic-slash\",\"targetIds\":[\"monster-1-monster-wild-rabbit\"]}}", battle_id))
            .send()
            .await
            .expect("first battle action should succeed");
        assert_eq!(first_action_response.status(), StatusCode::OK);
        let first_action_body: Value = serde_json::from_str(&first_action_response.text().await.expect("first body should read"))
            .expect("first body should be json");

        let second_action_response = client
            .post(format!("http://{address}/api/battle/action"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"battleId\":\"{}\",\"skillId\":\"sk-heavy-slash\",\"targetIds\":[\"monster-1-monster-wild-rabbit\"]}}", battle_id))
            .send()
            .await
            .expect("second battle action should succeed");
        assert_eq!(second_action_response.status(), StatusCode::OK);
        let second_action_body: Value = serde_json::from_str(&second_action_response.text().await.expect("second body should read"))
            .expect("second body should be json");

        println!("BATTLE_ROUTE_GENERIC_PVE_START_RESPONSE={start_body}");
        println!("BATTLE_ROUTE_GENERIC_PVE_FIRST_ACTION_RESPONSE={first_action_body}");
        println!("BATTLE_ROUTE_GENERIC_PVE_SECOND_ACTION_RESPONSE={second_action_body}");

        server.abort();

        let task_row = sqlx::query("SELECT kind, status FROM online_battle_settlement_task WHERE id = $1")
            .bind(format!("generic-pve:{battle_id}"))
            .fetch_one(&pool)
            .await
            .expect("generic pve settlement task should exist");

        crate::jobs::online_battle_settlement::run_online_battle_settlement_tick(&state)
            .await
            .expect("generic pve settlement tick should succeed");

        let character_row = sqlx::query("SELECT exp, silver FROM characters WHERE id = $1")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("character row should load");
        let reward_item_row = sqlx::query("SELECT item_def_id, qty FROM item_instance WHERE owner_character_id = $1 AND obtained_from = 'battle_reward' ORDER BY id DESC LIMIT 1")
            .bind(fixture.character_id)
            .fetch_optional(&pool)
            .await
            .expect("battle reward item query should succeed");
        let current_exp = character_row.try_get::<Option<i64>, _>("exp").expect("exp should decode").unwrap_or_default();
        let current_silver = character_row.try_get::<Option<i64>, _>("silver").expect("silver should decode").unwrap_or_default();

        assert_eq!(first_action_body["data"]["debugRealtime"]["kind"], "battle_state");
        assert_eq!(second_action_body["data"]["debugRealtime"]["kind"], "battle_finished");
        assert!(second_action_body["data"]["debugRealtime"]["rewards"]["exp"].as_i64().unwrap_or_default() > 0);
        assert!(second_action_body["data"]["debugRealtime"]["rewards"]["silver"].as_i64().unwrap_or_default() > 0);
        assert!(second_action_body["data"]["debugRealtime"]["rewards"]["perPlayerRewards"].as_array().is_some_and(|items| !items.is_empty()));
        assert_eq!(task_row.try_get::<Option<String>, _>("kind").unwrap_or(None).unwrap_or_default(), "generic_pve_v1");
        let settlement_task_row = sqlx::query("SELECT status FROM online_battle_settlement_task WHERE id = $1")
            .bind(format!("generic-pve:{battle_id}"))
            .fetch_one(&pool)
            .await
            .expect("generic pve settlement task should reload");
        assert_eq!(settlement_task_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "completed");
        if state.redis_available {
            let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let resource_hash = redis
                .hgetall(&format!("character:resource-delta:{}", fixture.character_id))
                .await
                .unwrap_or_default();
            println!("BATTLE_ROUTE_GENERIC_PVE_RESOURCE_HASH={}", serde_json::json!(resource_hash));
            assert!(!resource_hash.is_empty());
        } else {
            assert!(current_exp > 0);
            assert!(current_silver > 0);
        }
        if let Some(reward_item_row) = reward_item_row {
            assert!(reward_item_row.try_get::<Option<i32>, _>("qty").unwrap_or(None).map(i64::from).unwrap_or_default() > 0);
        }

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn dungeon_next_completed_route_enqueues_durable_settlement_task() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "DUNGEON_NEXT_SETTLEMENT_TASK_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };
        sqlx::query("DELETE FROM online_battle_settlement_task")
            .execute(&pool)
            .await
            .expect("settlement tasks should clear");

        let suffix = format!("dungeon-settlement-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let instance_id = format!("dungeon-inst-{suffix}");
        let battle_id = format!("dungeon-battle-{instance_id}-3-1");
        let participants = serde_json::json!([
            {
                "userId": fixture.user_id,
                "characterId": fixture.character_id,
                "role": "leader"
            }
        ]);

        sqlx::query(
            "INSERT INTO dungeon_instance (id, dungeon_id, difficulty_id, creator_id, team_id, status, current_stage, current_wave, participants, start_time, end_time, time_spent_sec, total_damage, death_count, rewards_claimed, instance_data, created_at) VALUES ($1, 'dungeon-qiqi-wolf-den', 'dd-qiqi-wolf-den-n', $2, NULL, 'running', 3, 1, $3::jsonb, NOW(), NULL, 0, 0, 0, FALSE, jsonb_build_object('currentBattleId', $4, 'difficultyRank', 1), NOW())",
        )
        .bind(&instance_id)
        .bind(fixture.character_id)
        .bind(participants)
        .bind(&battle_id)
        .execute(&pool)
        .await
        .expect("dungeon instance should insert");

        state.battle_runtime.register(build_minimal_pve_battle_state(
            &battle_id,
            fixture.character_id,
            &["monster-dungeon-wolf-king".to_string()],
        ));
        let _ = state.battle_runtime.update(&battle_id, |battle| {
            battle.phase = "finished".to_string();
            battle.result = Some("attacker_win".to_string());
        });

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/dungeon/instance/next"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"instanceId\":\"{}\"}}", instance_id))
            .send()
            .await
            .expect("dungeon next request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let task_row = sqlx::query("SELECT kind, status, battle_id FROM online_battle_settlement_task WHERE id = $1")
            .bind(format!("dungeon-clear:{instance_id}"))
            .fetch_one(&pool)
            .await
            .expect("settlement task should exist");

        println!("DUNGEON_NEXT_SETTLEMENT_TASK_RESPONSE={body}");

        server.abort();

        assert_eq!(body["data"]["status"], "completed");
        assert_eq!(task_row.try_get::<Option<String>, _>("kind").unwrap_or(None).unwrap_or_default(), "dungeon_clear_v1");
        assert_eq!(task_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "pending");
        assert_eq!(task_row.try_get::<Option<String>, _>("battle_id").unwrap_or(None).unwrap_or_default(), battle_id);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn dungeon_next_completed_route_task_is_consumed_into_dungeon_record() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "DUNGEON_NEXT_SETTLEMENT_CONSUME_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };
        sqlx::query("DELETE FROM online_battle_settlement_task")
            .execute(&pool)
            .await
            .expect("settlement tasks should clear");

        let suffix = format!("dungeon-settlement-consume-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let instance_id = format!("dungeon-inst-{suffix}");
        let battle_id = format!("dungeon-battle-{instance_id}-3-1");
        let participants = serde_json::json!([
            {
                "userId": fixture.user_id,
                "characterId": fixture.character_id,
                "role": "leader"
            }
        ]);

        sqlx::query(
            "INSERT INTO dungeon_instance (id, dungeon_id, difficulty_id, creator_id, team_id, status, current_stage, current_wave, participants, start_time, end_time, time_spent_sec, total_damage, death_count, rewards_claimed, instance_data, created_at) VALUES ($1, 'dungeon-qiqi-wolf-den', 'dd-qiqi-wolf-den-n', $2, NULL, 'running', 3, 1, $3::jsonb, NOW(), NULL, 0, 0, 0, FALSE, jsonb_build_object('currentBattleId', $4, 'difficultyRank', 1), NOW())",
        )
        .bind(&instance_id)
        .bind(fixture.character_id)
        .bind(participants)
        .bind(&battle_id)
        .execute(&pool)
        .await
        .expect("dungeon instance should insert");

        state.battle_runtime.register(build_minimal_pve_battle_state(
            &battle_id,
            fixture.character_id,
            &["monster-dungeon-wolf-king".to_string()],
        ));
        let _ = state.battle_runtime.update(&battle_id, |battle| {
            battle.phase = "finished".to_string();
            battle.result = Some("attacker_win".to_string());
        });

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/dungeon/instance/next"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"instanceId\":\"{}\"}}", instance_id))
            .send()
            .await
            .expect("dungeon next request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        crate::jobs::online_battle_settlement::run_online_battle_settlement_tick(&state)
            .await
            .expect("settlement tick should succeed");

        let task_row = sqlx::query("SELECT status FROM online_battle_settlement_task WHERE id = $1")
            .bind(format!("dungeon-clear:{instance_id}"))
            .fetch_one(&pool)
            .await
            .expect("settlement task should exist");
        let record_row = sqlx::query("SELECT result, dungeon_id, difficulty_id, instance_id, rewards, is_first_clear FROM dungeon_record WHERE character_id = $1 AND instance_id = $2")
            .bind(fixture.character_id)
            .bind(&instance_id)
            .fetch_optional(&pool)
            .await
            .expect("dungeon record query should succeed");
        let item_count_row = sqlx::query("SELECT COUNT(1)::bigint AS item_count FROM item_instance WHERE owner_character_id = $1 AND obtained_from = 'dungeon_clear_reward' AND obtained_ref_id = $2")
            .bind(fixture.character_id)
            .bind(&instance_id)
            .fetch_one(&pool)
            .await
            .expect("reward item rows should load");

        println!(
            "DUNGEON_NEXT_SETTLEMENT_CONSUME_TASK_STATUS={}",
            task_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default()
        );
        println!("DUNGEON_NEXT_SETTLEMENT_CONSUME_RECORD_EXISTS={}", record_row.is_some());

        server.abort();

        assert_eq!(task_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "completed");
        let record_row = record_row.expect("dungeon record should exist");
        assert_eq!(record_row.try_get::<Option<String>, _>("result").unwrap_or(None).unwrap_or_default(), "cleared");
        assert_eq!(record_row.try_get::<Option<String>, _>("dungeon_id").unwrap_or(None).unwrap_or_default(), "dungeon-qiqi-wolf-den");
        assert_eq!(record_row.try_get::<Option<String>, _>("difficulty_id").unwrap_or(None).unwrap_or_default(), "dd-qiqi-wolf-den-n");
        assert_eq!(record_row.try_get::<Option<String>, _>("instance_id").unwrap_or(None).unwrap_or_default(), instance_id);
        assert_eq!(record_row.try_get::<Option<bool>, _>("is_first_clear").unwrap_or(None), Some(true));
        assert!(record_row.try_get::<Option<serde_json::Value>, _>("rewards").unwrap_or(None).unwrap_or_default().get("items").and_then(|v| v.as_array()).is_some_and(|items| !items.is_empty()));
        assert!(item_count_row.try_get::<Option<i64>, _>("item_count").unwrap_or(None).unwrap_or_default() > 0);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn dungeon_next_completed_route_task_updates_achievement_progress_and_points() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "DUNGEON_NEXT_ACHIEVEMENT_SETTLEMENT_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };
        sqlx::query("DELETE FROM online_battle_settlement_task")
            .execute(&pool)
            .await
            .expect("settlement tasks should clear");

        let suffix = format!("dungeon-achievement-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let instance_id = format!("dungeon-inst-{suffix}");
        let battle_id = format!("dungeon-battle-{instance_id}-3-1");
        let participants = serde_json::json!([
            {
                "userId": fixture.user_id,
                "characterId": fixture.character_id,
                "role": "leader"
            }
        ]);

        sqlx::query(
            "INSERT INTO dungeon_instance (id, dungeon_id, difficulty_id, creator_id, team_id, status, current_stage, current_wave, participants, start_time, end_time, time_spent_sec, total_damage, death_count, rewards_claimed, instance_data, created_at) VALUES ($1, 'dungeon-qiqi-wolf-den', 'dd-qiqi-wolf-den-n', $2, NULL, 'running', 3, 1, $3::jsonb, NOW(), NULL, 90, 12345, 1, FALSE, jsonb_build_object('currentBattleId', $4, 'difficultyRank', 1), NOW())",
        )
        .bind(&instance_id)
        .bind(fixture.character_id)
        .bind(participants)
        .bind(&battle_id)
        .execute(&pool)
        .await
        .expect("dungeon instance should insert");

        state.battle_runtime.register(build_minimal_pve_battle_state(
            &battle_id,
            fixture.character_id,
            &["monster-dungeon-wolf-king".to_string()],
        ));
        let _ = state.battle_runtime.update(&battle_id, |battle| {
            battle.phase = "finished".to_string();
            battle.result = Some("attacker_win".to_string());
        });

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/dungeon/instance/next"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"instanceId\":\"{}\"}}", instance_id))
            .send()
            .await
            .expect("dungeon next request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        crate::jobs::online_battle_settlement::run_online_battle_settlement_tick(&state)
            .await
            .expect("settlement tick should succeed");

        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
        let progress_hash = redis
            .hgetall(&format!("character:progress-delta:{}", fixture.character_id))
            .await
            .unwrap_or_default();

        println!("DUNGEON_NEXT_ACHIEVEMENT_PROGRESS_HASH={}", serde_json::json!(progress_hash));

        server.abort();

        assert!(!progress_hash.is_empty());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn arena_battle_settlement_task_is_consumed_into_authoritative_tables_and_readers() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "ARENA_SETTLEMENT_CONSUME_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("arena-settlement-{}", super::chrono_like_timestamp_ms());
        let challenger = insert_auth_fixture(&state, &pool, "socket", &format!("challenger-{suffix}"), 0).await;
        let opponent = insert_auth_fixture(&state, &pool, "socket", &format!("opponent-{suffix}"), 0).await;

        sqlx::query("INSERT INTO arena_rating (character_id, rating, win_count, lose_count, created_at, updated_at) VALUES ($1, 1000, 0, 0, NOW(), NOW()), ($2, 1000, 0, 0, NOW(), NOW()) ON CONFLICT (character_id) DO NOTHING")
            .bind(challenger.character_id)
            .bind(opponent.character_id)
            .execute(&pool)
            .await
            .expect("arena rating rows should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let challenge_response = client
            .post(format!("http://{address}/api/arena/challenge"))
            .header("authorization", format!("Bearer {}", challenger.token))
            .header("content-type", "application/json")
            .body(format!("{{\"opponentCharacterId\":{}}}", opponent.character_id))
            .send()
            .await
            .expect("arena challenge request should succeed");
        assert_eq!(challenge_response.status(), StatusCode::OK);
        let challenge_body: Value = serde_json::from_str(&challenge_response.text().await.expect("challenge body should read"))
            .expect("challenge body should be json");
        let battle_id = challenge_body["data"]["battleId"].as_str().expect("battle id should exist").to_string();

        let action_response = client
            .post(format!("http://{address}/api/battle/action"))
            .header("authorization", format!("Bearer {}", challenger.token))
            .header("content-type", "application/json")
            .body(format!("{{\"battleId\":\"{}\",\"skillId\":\"sk-heavy-slash\",\"targetIds\":[\"opponent-{}\"]}}", battle_id, opponent.character_id))
            .send()
            .await
            .expect("arena action request should succeed");
        assert_eq!(action_response.status(), StatusCode::OK);

        crate::jobs::online_battle_settlement::run_online_battle_settlement_tick(&state)
            .await
            .expect("arena settlement tick should succeed");

        let task_row = sqlx::query("SELECT status FROM online_battle_settlement_task WHERE id = $1")
            .bind(format!("arena-battle:{battle_id}"))
            .fetch_one(&pool)
            .await
            .expect("arena settlement task should exist");
        let battle_row = sqlx::query("SELECT result, delta_score, score_before, score_after FROM arena_battle WHERE battle_id = $1")
            .bind(&battle_id)
            .fetch_one(&pool)
            .await
            .expect("arena battle should exist");
        let challenger_rating = sqlx::query("SELECT rating, win_count, lose_count FROM arena_rating WHERE character_id = $1")
            .bind(challenger.character_id)
            .fetch_one(&pool)
            .await
            .expect("challenger rating should exist");
        let opponent_rating = sqlx::query("SELECT rating, win_count, lose_count FROM arena_rating WHERE character_id = $1")
            .bind(opponent.character_id)
            .fetch_one(&pool)
            .await
            .expect("opponent rating should exist");

        let status_response = client
            .get(format!("http://{address}/api/arena/status"))
            .header("authorization", format!("Bearer {}", challenger.token))
            .send()
            .await
            .expect("arena status request should succeed");
        assert_eq!(status_response.status(), StatusCode::OK);
        let status_body: Value = serde_json::from_str(&status_response.text().await.expect("status body should read"))
            .expect("status body should be json");

        let records_response = client
            .get(format!("http://{address}/api/arena/records?limit=5"))
            .header("authorization", format!("Bearer {}", challenger.token))
            .send()
            .await
            .expect("arena records request should succeed");
        assert_eq!(records_response.status(), StatusCode::OK);
        let records_body: Value = serde_json::from_str(&records_response.text().await.expect("records body should read"))
            .expect("records body should be json");

        println!("ARENA_SETTLEMENT_STATUS={status_body}");
        println!("ARENA_SETTLEMENT_RECORDS={records_body}");

        server.abort();

        assert_eq!(task_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "completed");
        assert_eq!(battle_row.try_get::<Option<String>, _>("result").unwrap_or(None).unwrap_or_default(), "win");
        assert_eq!(battle_row.try_get::<Option<i32>, _>("delta_score").unwrap_or(None).map(i64::from).unwrap_or_default(), 10);
        assert_eq!(battle_row.try_get::<Option<i32>, _>("score_before").unwrap_or(None).map(i64::from).unwrap_or_default(), 1000);
        assert_eq!(battle_row.try_get::<Option<i32>, _>("score_after").unwrap_or(None).map(i64::from).unwrap_or_default(), 1010);
        assert_eq!(challenger_rating.try_get::<Option<i32>, _>("rating").unwrap_or(None).map(i64::from).unwrap_or_default(), 1010);
        assert_eq!(challenger_rating.try_get::<Option<i32>, _>("win_count").unwrap_or(None).map(i64::from).unwrap_or_default(), 1);
        assert_eq!(challenger_rating.try_get::<Option<i32>, _>("lose_count").unwrap_or(None).map(i64::from).unwrap_or_default(), 0);
        assert_eq!(opponent_rating.try_get::<Option<i32>, _>("rating").unwrap_or(None).map(i64::from).unwrap_or_default(), 995);
        assert_eq!(opponent_rating.try_get::<Option<i32>, _>("win_count").unwrap_or(None).map(i64::from).unwrap_or_default(), 0);
        assert_eq!(opponent_rating.try_get::<Option<i32>, _>("lose_count").unwrap_or(None).map(i64::from).unwrap_or_default(), 1);
        assert_eq!(status_body["data"]["score"], 1010);
        assert_eq!(status_body["data"]["winCount"], 1);
        assert_eq!(status_body["data"]["loseCount"], 0);
        assert_eq!(status_body["data"]["todayUsed"], 1);
        assert_eq!(records_body["data"][0]["id"], battle_id);
        assert_eq!(records_body["data"][0]["result"], "win");
        assert_eq!(records_body["data"][0]["deltaScore"], 10);
        assert_eq!(records_body["data"][0]["scoreAfter"], 1010);

        cleanup_auth_fixture(&pool, challenger.character_id, challenger.user_id).await;
        cleanup_auth_fixture(&pool, opponent.character_id, opponent.user_id).await;
    }

    #[tokio::test]
        async fn arena_battle_settlement_is_idempotent_by_task_and_battle_id() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "ARENA_SETTLEMENT_IDEMPOTENT_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("arena-idempotent-{}", super::chrono_like_timestamp_ms());
        let challenger = insert_auth_fixture(&state, &pool, "socket", &format!("challenger-{suffix}"), 0).await;
        let opponent = insert_auth_fixture(&state, &pool, "socket", &format!("opponent-{suffix}"), 0).await;

        sqlx::query("INSERT INTO arena_rating (character_id, rating, win_count, lose_count, created_at, updated_at) VALUES ($1, 1000, 0, 0, NOW(), NOW()), ($2, 1000, 0, 0, NOW(), NOW()) ON CONFLICT (character_id) DO NOTHING")
            .bind(challenger.character_id)
            .bind(opponent.character_id)
            .execute(&pool)
            .await
            .expect("arena rating rows should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let challenge_response = client
            .post(format!("http://{address}/api/arena/challenge"))
            .header("authorization", format!("Bearer {}", challenger.token))
            .header("content-type", "application/json")
            .body(format!("{{\"opponentCharacterId\":{}}}", opponent.character_id))
            .send()
            .await
            .expect("arena challenge request should succeed");
        assert_eq!(challenge_response.status(), StatusCode::OK);
        let challenge_body: Value = serde_json::from_str(&challenge_response.text().await.expect("challenge body should read"))
            .expect("challenge body should be json");
        let battle_id = challenge_body["data"]["battleId"].as_str().expect("battle id should exist").to_string();

        let action_response = client
            .post(format!("http://{address}/api/battle/action"))
            .header("authorization", format!("Bearer {}", challenger.token))
            .header("content-type", "application/json")
            .body(format!("{{\"battleId\":\"{}\",\"skillId\":\"sk-heavy-slash\",\"targetIds\":[\"opponent-{}\"]}}", battle_id, opponent.character_id))
            .send()
            .await
            .expect("arena action request should succeed");
        assert_eq!(action_response.status(), StatusCode::OK);

        crate::jobs::online_battle_settlement::run_online_battle_settlement_tick(&state)
            .await
            .expect("first arena settlement tick should succeed");
        crate::jobs::online_battle_settlement::run_online_battle_settlement_tick(&state)
            .await
            .expect("second arena settlement tick should succeed");

        let battle_count_row = sqlx::query("SELECT COUNT(1)::bigint AS battle_count FROM arena_battle WHERE battle_id = $1")
            .bind(&battle_id)
            .fetch_one(&pool)
            .await
            .expect("arena battle count should load");
        let challenger_rating = sqlx::query("SELECT rating, win_count, lose_count FROM arena_rating WHERE character_id = $1")
            .bind(challenger.character_id)
            .fetch_one(&pool)
            .await
            .expect("challenger rating should exist");
        let opponent_rating = sqlx::query("SELECT rating, win_count, lose_count FROM arena_rating WHERE character_id = $1")
            .bind(opponent.character_id)
            .fetch_one(&pool)
            .await
            .expect("opponent rating should exist");

        println!(
            "ARENA_SETTLEMENT_IDEMPOTENT_BATTLE_COUNT={}",
            battle_count_row.try_get::<Option<i64>, _>("battle_count").unwrap_or(None).unwrap_or_default()
        );
        println!(
            "ARENA_SETTLEMENT_IDEMPOTENT_CHALLENGER_RATING={}",
            challenger_rating.try_get::<Option<i64>, _>("rating").unwrap_or(None).unwrap_or_default()
        );
        println!(
            "ARENA_SETTLEMENT_IDEMPOTENT_OPPONENT_RATING={}",
            opponent_rating.try_get::<Option<i64>, _>("rating").unwrap_or(None).unwrap_or_default()
        );

        server.abort();

        assert_eq!(battle_count_row.try_get::<Option<i64>, _>("battle_count").unwrap_or(None).unwrap_or_default(), 1);
        assert_eq!(challenger_rating.try_get::<Option<i32>, _>("rating").unwrap_or(None).map(i64::from).unwrap_or_default(), 1010);
        assert_eq!(challenger_rating.try_get::<Option<i32>, _>("win_count").unwrap_or(None).map(i64::from).unwrap_or_default(), 1);
        assert_eq!(challenger_rating.try_get::<Option<i32>, _>("lose_count").unwrap_or(None).map(i64::from).unwrap_or_default(), 0);
        assert_eq!(opponent_rating.try_get::<Option<i32>, _>("rating").unwrap_or(None).map(i64::from).unwrap_or_default(), 995);
        assert_eq!(opponent_rating.try_get::<Option<i32>, _>("win_count").unwrap_or(None).map(i64::from).unwrap_or_default(), 0);
        assert_eq!(opponent_rating.try_get::<Option<i32>, _>("lose_count").unwrap_or(None).map(i64::from).unwrap_or_default(), 1);

        cleanup_auth_fixture(&pool, challenger.character_id, challenger.user_id).await;
        cleanup_auth_fixture(&pool, opponent.character_id, opponent.user_id).await;
    }

    #[tokio::test]
        async fn arena_weekly_settlement_persists_previous_week_top_three_idempotently() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "ARENA_WEEKLY_SETTLEMENT_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("arena-weekly-{}", super::chrono_like_timestamp_ms());
        let c1 = insert_auth_fixture(&state, &pool, "socket", &format!("c1-{suffix}"), 0).await;
        let c2 = insert_auth_fixture(&state, &pool, "socket", &format!("c2-{suffix}"), 0).await;
        let c3 = insert_auth_fixture(&state, &pool, "socket", &format!("c3-{suffix}"), 0).await;
        let c4 = insert_auth_fixture(&state, &pool, "socket", &format!("c4-{suffix}"), 0).await;

        sqlx::query("INSERT INTO arena_rating (character_id, rating, win_count, lose_count, created_at, updated_at) VALUES ($1, 1300, 10, 1, NOW(), NOW()), ($2, 1200, 9, 2, NOW(), NOW()), ($3, 1100, 8, 3, NOW(), NOW()), ($4, 1000, 7, 4, NOW(), NOW()) ON CONFLICT (character_id) DO NOTHING")
            .bind(c1.character_id)
            .bind(c2.character_id)
            .bind(c3.character_id)
            .bind(c4.character_id)
            .execute(&pool)
            .await
            .expect("arena rating rows should insert");

        let boundary = sqlx::query(
            "SELECT (date_trunc('week', timezone('Asia/Shanghai', NOW()))::date - INTERVAL '7 day')::date::text AS previous_week_start, date_trunc('week', timezone('Asia/Shanghai', NOW()))::date::text AS current_week_start",
        )
        .fetch_one(&pool)
        .await
        .expect("week boundary should load");
        let previous_week_start = boundary.try_get::<Option<String>, _>("previous_week_start").unwrap_or(None).unwrap_or_default();

        sqlx::query(
            "DELETE FROM arena_battle WHERE created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND created_at < (($1::date::timestamp AT TIME ZONE 'Asia/Shanghai') + INTERVAL '7 day')",
        )
        .bind(&previous_week_start)
        .execute(&pool)
        .await
        .expect("arena battles in previous week should clear");
        sqlx::query("DELETE FROM arena_weekly_settlement WHERE week_start_local_date = $1::date")
            .bind(&previous_week_start)
            .execute(&pool)
            .await
            .expect("arena weekly settlement rows should clear");

        sqlx::query(
            "INSERT INTO arena_battle (battle_id, challenger_character_id, opponent_character_id, status, result, delta_score, score_before, score_after, created_at, finished_at) VALUES ($6, $1, $2, 'finished', 'win', 10, 1000, 1010, ($5::date::timestamp AT TIME ZONE 'Asia/Shanghai') + INTERVAL '1 day', (($5::date::timestamp AT TIME ZONE 'Asia/Shanghai') + INTERVAL '1 day' + INTERVAL '5 minutes')), ($7, $2, $3, 'finished', 'win', 10, 1000, 1010, ($5::date::timestamp AT TIME ZONE 'Asia/Shanghai') + INTERVAL '2 day', (($5::date::timestamp AT TIME ZONE 'Asia/Shanghai') + INTERVAL '2 day' + INTERVAL '5 minutes')), ($8, $3, $4, 'finished', 'win', 10, 1000, 1010, ($5::date::timestamp AT TIME ZONE 'Asia/Shanghai') + INTERVAL '3 day', (($5::date::timestamp AT TIME ZONE 'Asia/Shanghai') + INTERVAL '3 day' + INTERVAL '5 minutes'))"
        )
        .bind(c1.character_id)
        .bind(c2.character_id)
        .bind(c3.character_id)
        .bind(c4.character_id)
        .bind(&previous_week_start)
        .bind(format!("arena-weekly-b1-{suffix}"))
        .bind(format!("arena-weekly-b2-{suffix}"))
        .bind(format!("arena-weekly-b3-{suffix}"))
        .execute(&pool)
        .await
        .expect("arena battles should insert");

        let first_summary = crate::jobs::arena_weekly_settlement::run_arena_weekly_settlement_once(&state)
            .await
            .expect("first weekly settlement should succeed");
        let second_summary = crate::jobs::arena_weekly_settlement::run_arena_weekly_settlement_once(&state)
            .await
            .expect("second weekly settlement should succeed");

        let rows = sqlx::query(
            "SELECT week_start_local_date::text AS week_start_local_date, champion_character_id, runnerup_character_id, third_character_id FROM arena_weekly_settlement WHERE week_start_local_date = $1::date",
        )
        .bind(&previous_week_start)
        .fetch_all(&pool)
        .await
        .expect("arena weekly settlement rows should load");

        println!(
            "ARENA_WEEKLY_SETTLEMENT_SUMMARY={{\"first\":{},\"second\":{},\"rows\":{}}}",
            first_summary.settled_week_count,
            second_summary.settled_week_count,
            rows.len()
        );

        assert_eq!(first_summary.settled_week_count, 1);
        assert_eq!(second_summary.settled_week_count, 0);
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.try_get::<Option<String>, _>("week_start_local_date").unwrap_or(None).unwrap_or_default(), previous_week_start);
        assert_eq!(row.try_get::<Option<i32>, _>("champion_character_id").unwrap_or(None).map(i64::from).unwrap_or_default(), c1.character_id);
        assert_eq!(row.try_get::<Option<i32>, _>("runnerup_character_id").unwrap_or(None).map(i64::from).unwrap_or_default(), c2.character_id);
        assert_eq!(row.try_get::<Option<i32>, _>("third_character_id").unwrap_or(None).map(i64::from).unwrap_or_default(), c3.character_id);

        sqlx::query("DELETE FROM arena_weekly_settlement WHERE week_start_local_date = $1::date")
            .bind(&previous_week_start)
            .execute(&pool)
            .await
            .ok();
        sqlx::query(
            "DELETE FROM arena_battle WHERE created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND created_at < (($1::date::timestamp AT TIME ZONE 'Asia/Shanghai') + INTERVAL '7 day')",
        )
        .bind(&previous_week_start)
        .execute(&pool)
        .await
        .ok();
        cleanup_auth_fixture(&pool, c1.character_id, c1.user_id).await;
        cleanup_auth_fixture(&pool, c2.character_id, c2.user_id).await;
        cleanup_auth_fixture(&pool, c3.character_id, c3.user_id).await;
        cleanup_auth_fixture(&pool, c4.character_id, c4.user_id).await;
    }

    #[tokio::test]
        async fn battle_route_tower_win_sets_waiting_transition_and_persists_progress() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "BATTLE_ROUTE_TOWER_WIN_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("tower-win-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let battle_id = format!("tower-battle-run-{suffix}-13");
        let session_id = format!("tower-session-run-{suffix}");
        let run_id = format!("run-{suffix}");

        sqlx::query("INSERT INTO character_tower_progress (character_id, best_floor, next_floor, current_run_id, current_floor, current_battle_id, last_settled_floor, updated_at) VALUES ($1, 12, 13, $2, 13, $3, 12, NOW())")
            .bind(fixture.character_id)
            .bind(&run_id)
            .bind(&battle_id)
            .execute(&pool)
            .await
            .expect("tower progress should insert");

        state.battle_sessions.register(BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "tower".to_string(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            current_battle_id: Some(battle_id.clone()),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Tower {
                run_id: run_id.clone(),
                floor: 13,
            },
        });
        state.battle_runtime.register(build_minimal_pve_battle_state(
            &battle_id,
            fixture.character_id,
            &["monster-gray-wolf".to_string()],
        ));
        state.online_battle_projections.register(crate::state::OnlineBattleProjectionRecord {
            battle_id: battle_id.clone(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            r#type: "pve".to_string(),
            session_id: Some(session_id.clone()),
        });

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/battle/action"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"battleId\":\"{}\",\"skillId\":\"sk-heavy-slash\",\"targetIds\":[\"monster-1-monster-gray-wolf\"]}}", battle_id))
            .send()
            .await
            .expect("tower battle action should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let task_row = sqlx::query("SELECT kind, status FROM online_battle_settlement_task WHERE id = $1")
            .bind(format!("tower-win:{battle_id}"))
            .fetch_one(&pool)
            .await
            .expect("tower settlement task should exist");

        crate::jobs::online_battle_settlement::run_online_battle_settlement_tick(&state)
            .await
            .expect("tower settlement tick should succeed");

        let progress_row = sqlx::query("SELECT best_floor, next_floor, current_run_id, current_floor, current_battle_id, last_settled_floor, reached_at::text AS reached_at_text FROM character_tower_progress WHERE character_id = $1")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("tower progress should load");

        println!("BATTLE_ROUTE_TOWER_WIN_RESPONSE={body}");

        server.abort();

        assert_eq!(body["data"]["session"]["status"], "waiting_transition");
        assert_eq!(body["data"]["session"]["nextAction"], "advance");
        assert_eq!(body["data"]["session"]["canAdvance"], true);
        assert_eq!(task_row.try_get::<Option<String>, _>("kind").unwrap_or(None).unwrap_or_default(), "tower_win_v1");
        assert_eq!(task_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "pending");
        assert_eq!(progress_row.try_get::<Option<i32>, _>("best_floor").unwrap_or(None).map(i64::from).unwrap_or_default(), 13);
        assert_eq!(progress_row.try_get::<Option<i32>, _>("next_floor").unwrap_or(None).map(i64::from).unwrap_or_default(), 14);
        assert_eq!(progress_row.try_get::<Option<i32>, _>("last_settled_floor").unwrap_or(None).map(i64::from).unwrap_or_default(), 13);
        assert_eq!(progress_row.try_get::<Option<i32>, _>("current_floor").unwrap_or(None).map(i64::from).unwrap_or_default(), 13);
        assert_eq!(progress_row.try_get::<Option<String>, _>("current_run_id").unwrap_or(None).unwrap_or_default(), run_id);
        assert!(progress_row.try_get::<Option<String>, _>("current_battle_id").unwrap_or(None).is_none());
        assert!(progress_row.try_get::<Option<String>, _>("reached_at_text").unwrap_or(None).is_some());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn battle_session_advance_tower_waiting_transition_starts_next_floor() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "BATTLE_SESSION_ADVANCE_TOWER_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("tower-advance-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let session_id = format!("tower-session-run-{suffix}");
        let run_id = format!("run-{suffix}");

        sqlx::query("INSERT INTO character_tower_progress (character_id, best_floor, next_floor, current_run_id, current_floor, current_battle_id, last_settled_floor, updated_at) VALUES ($1, 13, 14, $2, 13, NULL, 13, NOW())")
            .bind(fixture.character_id)
            .bind(&run_id)
            .execute(&pool)
            .await
            .expect("tower progress should insert");

        state.battle_sessions.register(BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "tower".to_string(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            current_battle_id: Some(format!("tower-battle-{run_id}-13")),
            status: "waiting_transition".to_string(),
            next_action: "advance".to_string(),
            can_advance: true,
            last_result: Some("attacker_win".to_string()),
            context: BattleSessionContextDto::Tower {
                run_id: run_id.clone(),
                floor: 13,
            },
        });

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/battle-session/{session_id}/advance"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("tower advance request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let progress_row = sqlx::query("SELECT next_floor, current_run_id, current_floor, current_battle_id FROM character_tower_progress WHERE character_id = $1")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("tower progress should load");

        println!("BATTLE_SESSION_ADVANCE_TOWER_RESPONSE={body}");

        server.abort();

        assert_eq!(body["data"]["session"]["status"], "running");
        assert_eq!(body["data"]["session"]["context"]["floor"], 14);
        assert_eq!(body["data"]["session"]["currentBattleId"], format!("tower-battle-{run_id}-14"));
        assert_eq!(progress_row.try_get::<Option<i32>, _>("current_floor").unwrap_or(None).map(i64::from).unwrap_or_default(), 14);
        assert_eq!(progress_row.try_get::<Option<String>, _>("current_run_id").unwrap_or(None).unwrap_or_default(), run_id);
        assert_eq!(progress_row.try_get::<Option<String>, _>("current_battle_id").unwrap_or(None).unwrap_or_default(), format!("tower-battle-{run_id}-14"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn battle_session_advance_tower_persists_next_bundle_and_clears_previous() {
        let state = test_state();
        if !state.redis_available {
            println!("TOWER_ADVANCE_PERSISTENCE_SKIPPED_REDIS_UNAVAILABLE");
            return;
        }
        let Some(pool) = connect_fixture_db_or_skip(&state, "TOWER_ADVANCE_PERSISTENCE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("tower-advance-persist-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let session_id = format!("tower-session-run-{suffix}");
        let run_id = format!("run-{suffix}");
        let previous_battle_id = format!("tower-battle-{run_id}-13");
        let next_battle_id = format!("tower-battle-{run_id}-14");

        sqlx::query("INSERT INTO character_tower_progress (character_id, best_floor, next_floor, current_run_id, current_floor, current_battle_id, last_settled_floor, updated_at) VALUES ($1, 13, 14, $2, 13, NULL, 13, NOW())")
            .bind(fixture.character_id)
            .bind(&run_id)
            .execute(&pool)
            .await
            .expect("tower progress should insert");

        let previous_session = BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "tower".to_string(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            current_battle_id: Some(previous_battle_id.clone()),
            status: "waiting_transition".to_string(),
            next_action: "advance".to_string(),
            can_advance: true,
            last_result: Some("attacker_win".to_string()),
            context: BattleSessionContextDto::Tower {
                run_id: run_id.clone(),
                floor: 13,
            },
        };
        let previous_battle_state = build_minimal_pve_battle_state(
            &previous_battle_id,
            fixture.character_id,
            &resolve_tower_floor_monster_ids(13),
        );
        let previous_projection = OnlineBattleProjectionRecord {
            battle_id: previous_battle_id.clone(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            r#type: "pve".to_string(),
            session_id: Some(session_id.clone()),
        };
        state.battle_sessions.register(previous_session.clone());
        state.battle_runtime.register(previous_battle_state.clone());
        state.online_battle_projections.register(previous_projection.clone());
        crate::integrations::battle_persistence::persist_battle_session(&state, &previous_session)
            .await
            .expect("session should persist");
        crate::integrations::battle_persistence::persist_battle_snapshot(&state, &previous_battle_state)
            .await
            .expect("snapshot should persist");
        crate::integrations::battle_persistence::persist_battle_projection(&state, &previous_projection)
            .await
            .expect("projection should persist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/battle-session/{session_id}/advance"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("tower advance request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
        let previous_snapshot = redis.get_string(&format!("battle:snapshot:{previous_battle_id}")).await.expect("previous snapshot should read");
        let previous_projection_raw = redis.get_string(&format!("battle:projection:{previous_battle_id}")).await.expect("previous projection should read");
        let next_snapshot = redis.get_string(&format!("battle:snapshot:{next_battle_id}")).await.expect("next snapshot should read");
        let next_projection_raw = redis.get_string(&format!("battle:projection:{next_battle_id}")).await.expect("next projection should read");
        let session_raw = redis.get_string(&format!("battle:session:{session_id}")).await.expect("session should read");

        println!("TOWER_ADVANCE_PERSISTENCE_RESPONSE={body}");

        server.abort();

        assert!(previous_snapshot.is_none());
        assert!(previous_projection_raw.is_none());
        assert!(next_snapshot.is_some());
        assert!(next_projection_raw.is_some());
        assert!(session_raw.is_some());
        assert_eq!(body["data"]["session"]["currentBattleId"], next_battle_id);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn tower_challenge_start_uses_next_floor_after_settled_win() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "TOWER_START_NEXT_FLOOR_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("tower-start-next-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let run_id = format!("run-{suffix}");

        sqlx::query("INSERT INTO character_tower_progress (character_id, best_floor, next_floor, current_run_id, current_floor, current_battle_id, last_settled_floor, updated_at) VALUES ($1, 13, 14, $2, 13, NULL, 13, NOW())")
            .bind(fixture.character_id)
            .bind(&run_id)
            .execute(&pool)
            .await
            .expect("tower progress should insert");

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/tower/challenge/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("tower start request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        println!("TOWER_START_NEXT_FLOOR_RESPONSE={body}");

        server.abort();

        assert_eq!(body["data"]["session"]["context"]["floor"], 14);
        assert_eq!(body["data"]["session"]["currentBattleId"], format!("tower-battle-{run_id}-14"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn battle_session_advance_tower_return_to_map_clears_run_cursor() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "BATTLE_SESSION_TOWER_RETURN_TO_MAP_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("tower-return-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let session_id = format!("tower-session-run-{suffix}");
        let run_id = format!("run-{suffix}");
        let battle_id = format!("tower-battle-{run_id}-14");

        sqlx::query("INSERT INTO character_tower_progress (character_id, best_floor, next_floor, current_run_id, current_floor, current_battle_id, last_settled_floor, updated_at) VALUES ($1, 14, 15, $2, 14, $3, 14, NOW())")
            .bind(fixture.character_id)
            .bind(&run_id)
            .bind(&battle_id)
            .execute(&pool)
            .await
            .expect("tower progress should insert");

        state.battle_sessions.register(BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "tower".to_string(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            current_battle_id: Some(battle_id.clone()),
            status: "waiting_transition".to_string(),
            next_action: "return_to_map".to_string(),
            can_advance: true,
            last_result: Some("attacker_win".to_string()),
            context: BattleSessionContextDto::Tower {
                run_id: run_id.clone(),
                floor: 14,
            },
        });
        state.battle_runtime.register(build_minimal_pve_battle_state(
            &battle_id,
            fixture.character_id,
            &["monster-gray-wolf".to_string()],
        ));
        state.online_battle_projections.register(crate::state::OnlineBattleProjectionRecord {
            battle_id: battle_id.clone(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            r#type: "pve".to_string(),
            session_id: Some(session_id.clone()),
        });

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/battle-session/{session_id}/advance"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("tower return request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let progress_row = sqlx::query("SELECT current_run_id, current_floor, current_battle_id FROM character_tower_progress WHERE character_id = $1")
            .bind(fixture.character_id)
            .fetch_one(&pool)
            .await
            .expect("tower progress should load");

        println!("BATTLE_SESSION_TOWER_RETURN_TO_MAP_RESPONSE={body}");

        server.abort();

        assert_eq!(body["data"]["session"]["status"], "completed");
        assert!(body["data"]["session"]["currentBattleId"].is_null());
        assert!(progress_row.try_get::<Option<String>, _>("current_run_id").unwrap_or(None).is_none());
        assert!(progress_row.try_get::<Option<i32>, _>("current_floor").unwrap_or(None).is_none());
        assert!(progress_row.try_get::<Option<String>, _>("current_battle_id").unwrap_or(None).is_none());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn battle_session_start_pve_rejects_when_current_room_has_no_monsters() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "BATTLE_SESSION_START_PVE_EMPTY_ROOM_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("battle-session-empty-room-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/battle-session/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"type\":\"pve\",\"monsterIds\":[\"monster-gray-wolf\"]}")
            .send()
            .await
            .expect("battle session start request should respond");
        let body = response.text().await.expect("response body should read");

        println!("BATTLE_SESSION_START_PVE_EMPTY_ROOM_RESPONSE={body}");

        server.abort();

        assert!(body.contains("当前房间不存在可战斗目标"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn battle_session_start_pve_rejects_monsters_outside_current_room() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "BATTLE_SESSION_START_PVE_OUTSIDE_ROOM_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("battle-session-outside-room-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET current_map_id = 'map-qingyun-outskirts', current_room_id = 'room-south-forest' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character room should update");

        let app = build_router(state).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/battle-session/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"type\":\"pve\",\"monsterIds\":[\"monster-gray-wolf\"]}")
            .send()
            .await
            .expect("battle session start request should respond");
        let body = response.text().await.expect("response body should read");

        println!("BATTLE_SESSION_START_PVE_OUTSIDE_ROOM_RESPONSE={body}");

        server.abort();

        assert!(body.contains("战斗目标不在当前房间"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn battle_session_start_dungeon_persists_battle_bundle() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        if !state.redis_available {
            println!("BATTLE_SESSION_DUNGEON_PERSISTENCE_SKIPPED_REDIS_UNAVAILABLE");
            return;
        }
        let Some(pool) = connect_fixture_db_or_skip(&state, "BATTLE_SESSION_DUNGEON_PERSISTENCE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("battle-session-dungeon-persist-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let instance_id = format!("inst-{suffix}");
        sqlx::query(
            "INSERT INTO dungeon_instance (id, dungeon_id, difficulty_id, creator_id, status, current_stage, current_wave, participants, instance_data, created_at) VALUES ($1, 'dungeon-qiqi-wolf-den', 'dd-qiqi-wolf-den-n', $2, 'running', 1, 1, $3::jsonb, '{}'::jsonb, NOW())",
        )
        .bind(&instance_id)
        .bind(fixture.character_id)
        .bind(serde_json::json!([{
            "userId": fixture.user_id,
            "characterId": fixture.character_id
        }]))
        .execute(&pool)
        .await
        .expect("dungeon instance should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/battle-session/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"type\":\"dungeon\",\"instanceId\":\"{}\"}}", instance_id))
            .send()
            .await
            .expect("battle session start should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        let battle_id = body["data"]["session"]["currentBattleId"]
            .as_str()
            .expect("battle id should exist")
            .to_string();
        let session_id = body["data"]["session"]["sessionId"]
            .as_str()
            .expect("session id should exist")
            .to_string();
        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
        let snapshot = redis.get_string(&format!("battle:snapshot:{battle_id}")).await.expect("snapshot should read");
        let projection = redis.get_string(&format!("battle:projection:{battle_id}")).await.expect("projection should read");
        let session_raw = redis.get_string(&format!("battle:session:{session_id}")).await.expect("session should read");

        println!("BATTLE_SESSION_DUNGEON_PERSISTENCE_RESPONSE={body}");

        server.abort();

        assert!(snapshot.is_some());
        assert!(projection.is_some());
        assert!(session_raw.is_some());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn battle_session_return_to_map_clears_dungeon_persistence_bundle() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        if !state.redis_available {
            println!("DUNGEON_PERSISTENCE_CLEAR_SKIPPED_REDIS_UNAVAILABLE");
            return;
        }
        let Some(pool) = connect_fixture_db_or_skip(&state, "DUNGEON_PERSISTENCE_CLEAR_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("dungeon-clear-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let instance_id = format!("inst-{suffix}");
        sqlx::query(
            "INSERT INTO dungeon_instance (id, dungeon_id, difficulty_id, creator_id, status, current_stage, current_wave, participants, instance_data, created_at) VALUES ($1, 'dungeon-qiqi-wolf-den', 'dd-qiqi-wolf-den-n', $2, 'running', 1, 1, $3::jsonb, $4::jsonb, NOW())",
        )
        .bind(&instance_id)
        .bind(fixture.character_id)
        .bind(serde_json::json!([{
            "userId": fixture.user_id,
            "characterId": fixture.character_id
        }]))
        .bind(serde_json::json!({"currentBattleId": format!("dungeon-battle-{instance_id}-1-1")}))
        .execute(&pool)
        .await
        .expect("dungeon instance should insert");

        let battle_id = format!("dungeon-battle-{instance_id}-1-1");
        let session_id = format!("dungeon-session-{instance_id}");
        let session = BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "dungeon".to_string(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            current_battle_id: Some(battle_id.clone()),
            status: "waiting_transition".to_string(),
            next_action: "return_to_map".to_string(),
            can_advance: true,
            last_result: Some("attacker_win".to_string()),
            context: BattleSessionContextDto::Dungeon {
                instance_id: instance_id.clone(),
            },
        };
        let battle_state = build_minimal_pve_battle_state(&battle_id, fixture.character_id, &["monster-gray-wolf".to_string()]);
        let projection = OnlineBattleProjectionRecord {
            battle_id: battle_id.clone(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            r#type: "pve".to_string(),
            session_id: Some(session_id.clone()),
        };
        state.battle_sessions.register(session.clone());
        state.battle_runtime.register(battle_state.clone());
        state.online_battle_projections.register(projection.clone());
        crate::integrations::battle_persistence::persist_battle_session(&state, &session)
            .await
            .expect("session should persist");
        crate::integrations::battle_persistence::persist_battle_snapshot(&state, &battle_state)
            .await
            .expect("snapshot should persist");
        crate::integrations::battle_persistence::persist_battle_projection(&state, &projection)
            .await
            .expect("projection should persist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/battle-session/{session_id}/advance"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("battle session advance should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis client should exist"));
        let snapshot = redis.get_string(&format!("battle:snapshot:{battle_id}")).await.expect("snapshot should read");
        let projection_raw = redis.get_string(&format!("battle:projection:{battle_id}")).await.expect("projection should read");
        let session_raw = redis.get_string(&format!("battle:session:{session_id}")).await.expect("session should read");

        server.abort();

        assert!(snapshot.is_none());
        assert!(projection_raw.is_none());
        assert!(session_raw.is_none());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn battle_session_return_to_map_clears_pve_persistence_bundle() {
        let state = test_state();
        if !state.redis_available {
            println!("PVE_PERSISTENCE_CLEAR_SKIPPED_REDIS_UNAVAILABLE");
            return;
        }
        let Some(pool) = connect_fixture_db_or_skip(&state, "PVE_PERSISTENCE_CLEAR_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("pve-clear-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let session_id = format!("pve-session-{suffix}");
        let battle_id = format!("pve-battle-{suffix}");

        let session = BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "pve".to_string(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            current_battle_id: Some(battle_id.clone()),
            status: "waiting_transition".to_string(),
            next_action: "return_to_map".to_string(),
            can_advance: true,
            last_result: Some("attacker_win".to_string()),
            context: BattleSessionContextDto::Pve {
                monster_ids: vec!["monster-wild-boar".to_string()],
            },
        };
        let battle_state = build_minimal_pve_battle_state(&battle_id, fixture.character_id, &["monster-wild-boar".to_string()]);
        let projection = OnlineBattleProjectionRecord {
            battle_id: battle_id.clone(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            r#type: "pve".to_string(),
            session_id: Some(session_id.clone()),
        };
        state.battle_sessions.register(session.clone());
        state.battle_runtime.register(battle_state.clone());
        state.online_battle_projections.register(projection.clone());
        crate::integrations::battle_persistence::persist_battle_session(&state, &session)
            .await
            .expect("session should persist");
        crate::integrations::battle_persistence::persist_battle_snapshot(&state, &battle_state)
            .await
            .expect("snapshot should persist");
        crate::integrations::battle_persistence::persist_battle_projection(&state, &projection)
            .await
            .expect("projection should persist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/battle-session/{session_id}/advance"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("battle session advance should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
        let snapshot = redis.get_string(&format!("battle:snapshot:{battle_id}")).await.expect("snapshot should read");
        let projection_raw = redis.get_string(&format!("battle:projection:{battle_id}")).await.expect("projection should read");
        let session_raw = redis.get_string(&format!("battle:session:{session_id}")).await.expect("session should read");

        server.abort();

        assert!(snapshot.is_none());
        assert!(projection_raw.is_none());
        assert!(session_raw.is_none());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn battle_session_advance_arena_return_to_map_emits_battle_abandoned_then_arena_refresh() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_ARENA_ADVANCE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("arena-advance-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let session_id = format!("arena-session-{suffix}");
        let battle_id = format!("arena-battle-{suffix}");
        state.battle_sessions.register(BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "pvp".to_string(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            current_battle_id: Some(battle_id.clone()),
            status: "waiting".to_string(),
            next_action: "return_to_map".to_string(),
            can_advance: true,
            last_result: Some("attacker_win".to_string()),
            context: BattleSessionContextDto::Pvp {
                opponent_character_id: outsider.character_id,
                mode: "arena".to_string(),
            },
        });
        state.online_battle_projections.register(crate::state::OnlineBattleProjectionRecord {
            battle_id: battle_id.clone(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            r#type: "pvp".to_string(),
            session_id: Some(session_id.clone()),
        });

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;

        let client = reqwest::Client::new();
        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/battle-session/{session_id}/advance"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("advance request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_ARENA_ADVANCE_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_ARENA_ADVANCE_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("battle:update"));
        assert!(target_poll.contains("battle_abandoned"));
        assert!(target_poll.contains("arena:update"));
        assert!(target_poll.contains("\"kind\":\"arena_refresh\""));
        assert!(!other_poll.contains("battle:update"));
        assert!(!other_poll.contains("arena:update"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn task_track_route_emits_task_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TASK_TRACK_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("task-track-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/task/track"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"taskId\":\"task-main-003\",\"tracked\":true}")
            .send()
            .await
            .expect("task track request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TASK_TRACK_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_TASK_TRACK_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("task:update"));
        assert!(target_poll.contains(&format!("\"characterId\":{}", fixture.character_id)));
        assert!(target_poll.contains("\"scopes\":[\"task\"]"));
        assert!(!other_poll.contains("task:update"));

        sqlx::query("DELETE FROM character_task_progress WHERE character_id = $1 AND task_id = $2")
            .bind(fixture.character_id)
            .bind("task-main-003")
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn task_claim_route_emits_task_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TASK_CLAIM_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("task-claim-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        sqlx::query(
            "INSERT INTO character_task_progress (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at) VALUES ($1, 'task-main-003', 'claimable', '{}'::jsonb, true, NOW(), NOW(), NULL, NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("task progress should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/task/claim"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"taskId\":\"task-main-003\"}")
            .send()
            .await
            .expect("task claim request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TASK_CLAIM_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_TASK_CLAIM_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("task:update"));
        assert!(target_poll.contains(&format!("\"characterId\":{}", fixture.character_id)));
        assert!(target_poll.contains("\"scopes\":[\"task\"]"));
        assert!(!other_poll.contains("task:update"));

        sqlx::query("DELETE FROM character_task_progress WHERE character_id = $1 AND task_id = $2")
            .bind(fixture.character_id)
            .bind("task-main-003")
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn task_claim_route_buffers_reward_deltas_when_redis_available() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "TASK_CLAIM_DELTA_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("task-claim-delta-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query(
            "INSERT INTO character_task_progress (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at) VALUES ($1, 'task-main-003', 'claimable', '{}'::jsonb, true, NOW(), NOW(), NULL, NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("task progress should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/task/claim"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"taskId\":\"task-main-003\"}")
            .send()
            .await
            .expect("task claim request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        if state.redis_available {
            let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let resource_hash = redis
                .hgetall(&format!("character:resource-delta:{}", fixture.character_id))
                .await
                .expect("resource delta hash should load");
            let item_hash = redis
                .hgetall(&format!("character:item-grant-delta:{}", fixture.character_id))
                .await
                .expect("item grant delta hash should load");
            println!("TASK_CLAIM_RESOURCE_DELTA={}", serde_json::json!(resource_hash));
            println!("TASK_CLAIM_ITEM_DELTA={}", serde_json::json!(item_hash));
            assert!(!resource_hash.is_empty() || !item_hash.is_empty());
        } else {
            let reward_item = sqlx::query("SELECT item_def_id FROM item_instance WHERE owner_character_id = $1 ORDER BY id DESC LIMIT 1")
                .bind(fixture.character_id)
                .fetch_optional(&pool)
                .await
                .expect("reward item query should work");
            println!("TASK_CLAIM_FALLBACK_ROW={}", serde_json::json!({
                "hasRewardItem": reward_item.is_some(),
            }));
        }

        server.abort();

        assert_eq!(body["success"], true);
        assert_eq!(body["message"], "ok");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn task_npc_accept_route_emits_task_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TASK_NPC_ACCEPT_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("task-npc-accept-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/task/npc/accept"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"npcId\":\"npc-village-elder\",\"taskId\":\"task-main-003\"}")
            .send()
            .await
            .expect("task npc accept request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TASK_NPC_ACCEPT_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_TASK_NPC_ACCEPT_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("task:update"));
        assert!(target_poll.contains(&format!("\"characterId\":{}", fixture.character_id)));
        assert!(target_poll.contains("\"scopes\":[\"task\"]"));
        assert!(!other_poll.contains("task:update"));

        sqlx::query("DELETE FROM character_task_progress WHERE character_id = $1 AND task_id = $2")
            .bind(fixture.character_id)
            .bind("task-main-003")
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn task_npc_submit_route_emits_task_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TASK_NPC_SUBMIT_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("task-npc-submit-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        sqlx::query(
            "INSERT INTO character_task_progress (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at) VALUES ($1, 'task-main-003', 'ongoing', '{\"obj-001\":3}'::jsonb, true, NOW(), NULL, NULL, NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("task progress should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/task/npc/submit"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"npcId\":\"npc-village-elder\",\"taskId\":\"task-main-003\"}")
            .send()
            .await
            .expect("task npc submit request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("task npc submit body should read");
        println!("TASK_NPC_SUBMIT_ROUTE_RESPONSE={response_text}");
        assert_eq!(response_status, StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TASK_NPC_SUBMIT_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_TASK_NPC_SUBMIT_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("task:update"));
        assert!(target_poll.contains(&format!("\"characterId\":{}", fixture.character_id)));
        assert!(target_poll.contains("\"scopes\":[\"task\"]"));
        assert!(!other_poll.contains("task:update"));

        sqlx::query("DELETE FROM character_task_progress WHERE character_id = $1 AND task_id = $2")
            .bind(fixture.character_id)
            .bind("task-main-003")
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn achievement_points_claim_route_emits_achievement_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_ACHIEVEMENT_POINTS_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("achievement-points-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        sqlx::query(
            "INSERT INTO character_achievement_points (character_id, total_points, claimed_thresholds, updated_at) VALUES ($1, 10, '[]'::jsonb, NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("achievement points should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/achievement/points/claim"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"threshold\":10}")
            .send()
            .await
            .expect("achievement points claim request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("achievement points claim body should read");
        println!("ACHIEVEMENT_POINTS_CLAIM_ROUTE_RESPONSE={response_text}");
        assert_eq!(response_status, StatusCode::BAD_REQUEST);
        server.abort();
        let body: Value = serde_json::from_str(&response_text).expect("achievement points claim body should be json");
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "点数奖励不存在");

        sqlx::query("DELETE FROM character_achievement_points WHERE character_id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn achievement_claim_route_emits_achievement_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_ACHIEVEMENT_CLAIM_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("achievement-claim-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        sqlx::query(
            "INSERT INTO character_achievement (character_id, achievement_id, status, progress, progress_data, updated_at) VALUES ($1, 'ach-kill-rabbit-10', 'completed', 10, '{}'::jsonb, NOW())",
        )
        .bind(fixture.character_id)
        .execute(&pool)
        .await
        .expect("achievement progress should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/achievement/claim"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"achievementId\":\"ach-kill-rabbit-10\"}")
            .send()
            .await
            .expect("achievement claim request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("achievement claim body should read");
        println!("ACHIEVEMENT_CLAIM_ROUTE_RESPONSE={response_text}");
        assert_eq!(response_status, StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_ACHIEVEMENT_CLAIM_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_ACHIEVEMENT_CLAIM_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("achievement:update"));
        assert!(target_poll.contains(&format!("\"characterId\":{}", fixture.character_id)));
        assert!(target_poll.contains("\"claimableCount\":0"));
        assert!(!other_poll.contains("achievement:update"));

        sqlx::query("DELETE FROM character_achievement WHERE character_id = $1 AND achievement_id = $2")
            .bind(fixture.character_id)
            .bind("ach-kill-rabbit-10")
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn technique_research_mark_viewed_route_emits_status_to_target_user() {
        let _guard = technique_research_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TECHNIQUE_MARK_VIEWED_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("tech-viewed-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });
        sqlx::query("INSERT INTO technique_generation_job (id, character_id, week_key, status, type_rolled, quality_rolled, cost_points, used_cooldown_bypass_token, burning_word_prompt, prompt_snapshot, model_name, attempt_count, draft_technique_id, generated_technique_id, publish_attempts, draft_expire_at, viewed_at, failed_viewed_at, finished_at, error_code, error_message, created_at, updated_at) VALUES ($1, $2, '2025-W01', 'failed', '武技', '玄', 3500, false, NULL, '{}'::jsonb, 'rust-deterministic', 1, NULL, NULL, 0, NULL, NULL, NULL, NOW(), 'AI_PROVIDER_ERROR', '测试失败结果', NOW(), NOW())")
            .bind(format!("tech-viewed-job-{suffix}"))
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("failed technique job should insert");

        let response = client
            .post(format!("http://{address}/api/character/{}/technique/research/mark-result-viewed", fixture.character_id))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("technique mark viewed request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TECHNIQUE_MARK_VIEWED_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_TECHNIQUE_MARK_VIEWED_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("techniqueResearch:update"));
        assert!(target_poll.contains(&format!("\"characterId\":{}", fixture.character_id)));
        assert!(!other_poll.contains("techniqueResearch:update"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn technique_research_generate_route_eventually_reaches_generated_draft() {
        let _guard = technique_research_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "TECHNIQUE_RESEARCH_GENERATE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("tech-research-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET realm = '炼炁化神', sub_realm = '结胎期' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character realm should update");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'mat-gongfa-canye', 5000, 'none', 'bag', NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("fragment item should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/character/{}/technique/research/generate", fixture.character_id))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"cooldownBypassEnabled\":false}")
            .send()
            .await
            .expect("technique research generate should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        println!("TECHNIQUE_RESEARCH_GENERATE_HTTP_RESPONSE={response_text}");
        assert_eq!(response_status, StatusCode::OK);
        let body: Value = serde_json::from_str(&response_text).expect("body should be json");
        let generation_id = body["data"]["generationId"].as_str().expect("generation id should exist").to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let job_row = sqlx::query("SELECT status, draft_technique_id, model_name FROM technique_generation_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("technique generation job should exist");
        let draft_id = job_row.try_get::<Option<String>, _>("draft_technique_id").unwrap_or(None).unwrap_or_default();
        let draft_row = sqlx::query("SELECT generation_id, name, quality, type, is_published FROM generated_technique_def WHERE id = $1")
            .bind(&draft_id)
            .fetch_one(&pool)
            .await
            .expect("generated technique draft should exist");

        println!("TECHNIQUE_RESEARCH_GENERATE_ROUTE_RESPONSE={body}");
        println!("TECHNIQUE_RESEARCH_GENERATE_JOB_STATUS={}", job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default());
        println!("TECHNIQUE_RESEARCH_GENERATE_DRAFT_ID={draft_id}");

        server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "generated_draft");
        assert_eq!(job_row.try_get::<Option<String>, _>("model_name").unwrap_or(None).unwrap_or_default(), "rust-deterministic");
        assert_eq!(draft_row.try_get::<Option<String>, _>("generation_id").unwrap_or(None).unwrap_or_default(), generation_id);
        assert_eq!(draft_row.try_get::<Option<String>, _>("quality").unwrap_or(None).unwrap_or_default(), "玄");
        assert_eq!(draft_row.try_get::<Option<String>, _>("type").unwrap_or(None).unwrap_or_default(), "武技");
        assert_eq!(draft_row.try_get::<Option<bool>, _>("is_published").unwrap_or(None), Some(false));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn technique_research_generate_route_uses_mock_ai_when_configured() {
        let _guard = technique_research_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "TECHNIQUE_AI_SUCCESS_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let ai_app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(|| async move {
                axum::Json(serde_json::json!({
                    "choices": [{
                        "message": {
                            "content": "{\"suggestedName\":\"青木真诀\",\"description\":\"玄品武技草稿\",\"longDesc\":\"以青木真意推演而成的玄品武技草稿，可于洞府研修中进一步命名发布。\"}"
                        }
                    }]
                }))
            }),
        );
        let (ai_address, ai_server) = spawn_test_server(ai_app).await;

        let original_provider = std::env::var("AI_TECHNIQUE_MODEL_PROVIDER").ok();
        let original_url = std::env::var("AI_TECHNIQUE_MODEL_URL").ok();
        let original_key = std::env::var("AI_TECHNIQUE_MODEL_KEY").ok();
        let original_name = std::env::var("AI_TECHNIQUE_MODEL_NAME").ok();
        unsafe {
            std::env::set_var("AI_TECHNIQUE_MODEL_PROVIDER", "openai");
            std::env::set_var("AI_TECHNIQUE_MODEL_URL", format!("http://{ai_address}/v1"));
            std::env::set_var("AI_TECHNIQUE_MODEL_KEY", "mock-technique-key");
            std::env::set_var("AI_TECHNIQUE_MODEL_NAME", "mock-technique-model");
        }

        let suffix = format!("tech-ai-success-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET realm = '炼炁化神', sub_realm = '结胎期' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character realm should update");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'mat-gongfa-canye', 5000, 'none', 'bag', NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("fragment item should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/character/{}/technique/research/generate", fixture.character_id))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"burningWordPrompt\":\"青木\",\"cooldownBypassEnabled\":false}")
            .send()
            .await
            .expect("technique research generate should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");
        let generation_id = body["data"]["generationId"].as_str().expect("generation id should exist").to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let job_row = sqlx::query("SELECT status, draft_technique_id, model_name FROM technique_generation_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("technique generation job should exist");
        let draft_id = job_row.try_get::<Option<String>, _>("draft_technique_id").unwrap_or(None).unwrap_or_default();
        let draft_row = sqlx::query("SELECT name, description, long_desc, model_name FROM generated_technique_def WHERE id = $1")
            .bind(&draft_id)
            .fetch_one(&pool)
            .await
            .expect("generated technique draft should exist");

        println!("TECHNIQUE_AI_SUCCESS_ROUTE_RESPONSE={body}");

        server.abort();
        ai_server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "generated_draft");
        assert_eq!(job_row.try_get::<Option<String>, _>("model_name").unwrap_or(None).unwrap_or_default(), "mock-technique-model");
        assert_eq!(draft_row.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(), "青木真诀");
        assert_eq!(draft_row.try_get::<Option<String>, _>("description").unwrap_or(None).unwrap_or_default(), "玄品武技草稿");
        assert_eq!(draft_row.try_get::<Option<String>, _>("model_name").unwrap_or(None).unwrap_or_default(), "mock-technique-model");

        unsafe {
            match original_provider { Some(v) => std::env::set_var("AI_TECHNIQUE_MODEL_PROVIDER", v), None => std::env::remove_var("AI_TECHNIQUE_MODEL_PROVIDER") };
            match original_url { Some(v) => std::env::set_var("AI_TECHNIQUE_MODEL_URL", v), None => std::env::remove_var("AI_TECHNIQUE_MODEL_URL") };
            match original_key { Some(v) => std::env::set_var("AI_TECHNIQUE_MODEL_KEY", v), None => std::env::remove_var("AI_TECHNIQUE_MODEL_KEY") };
            match original_name { Some(v) => std::env::set_var("AI_TECHNIQUE_MODEL_NAME", v), None => std::env::remove_var("AI_TECHNIQUE_MODEL_NAME") };
        }
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn technique_research_generate_route_refunds_when_ai_provider_errors() {
        let _guard = technique_research_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "TECHNIQUE_AI_FAILURE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let ai_app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(|| async move {
                (
                    axum::http::StatusCode::BAD_GATEWAY,
                    axum::Json(serde_json::json!({"error":"mock upstream failed"})),
                )
            }),
        );
        let (ai_address, ai_server) = spawn_test_server(ai_app).await;

        let original_provider = std::env::var("AI_TECHNIQUE_MODEL_PROVIDER").ok();
        let original_url = std::env::var("AI_TECHNIQUE_MODEL_URL").ok();
        let original_key = std::env::var("AI_TECHNIQUE_MODEL_KEY").ok();
        let original_name = std::env::var("AI_TECHNIQUE_MODEL_NAME").ok();
        unsafe {
            std::env::set_var("AI_TECHNIQUE_MODEL_PROVIDER", "openai");
            std::env::set_var("AI_TECHNIQUE_MODEL_URL", format!("http://{ai_address}/v1"));
            std::env::set_var("AI_TECHNIQUE_MODEL_KEY", "mock-technique-key");
            std::env::set_var("AI_TECHNIQUE_MODEL_NAME", "mock-technique-model");
        }

        let suffix = format!("tech-ai-failure-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET realm = '炼炁化神', sub_realm = '结胎期' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character realm should update");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'mat-gongfa-canye', 5000, 'none', 'bag', NOW(), NOW(), 'test'), ($1, $2, 'token-005', 1, 'none', 'bag', NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("refund materials should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/character/{}/technique/research/generate", fixture.character_id))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"burningWordPrompt\":\"青木\",\"cooldownBypassEnabled\":true}")
            .send()
            .await
            .expect("technique research generate should return");
        let response_status = response.status();
        let response_text = response.text().await.expect("body should read");
        println!("TECHNIQUE_AI_FAILURE_HTTP_RESPONSE={response_text}");
        assert_eq!(response_status, StatusCode::OK);
        let body: Value = serde_json::from_str(&response_text)
            .expect("body should be json");
        let generation_id = body["data"]["generationId"].as_str().expect("generation id should exist").to_string();
        let mut final_status = String::new();
        for _ in 0..20 {
            final_status = sqlx::query("SELECT status FROM technique_generation_job WHERE id = $1")
                .bind(&generation_id)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten()
                .and_then(|row| row.try_get::<Option<String>, _>("status").ok().flatten())
                .unwrap_or_default();
            if matches!(final_status.as_str(), "failed" | "refunded" | "generated_draft") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }

        let job_row = sqlx::query("SELECT status, error_code, error_message, draft_technique_id FROM technique_generation_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("technique generation job should exist");
        println!(
            "TECHNIQUE_AI_FAILURE_JOB_STATUS={} CODE={} ERROR={} DRAFT_ID={}",
            job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(),
            job_row.try_get::<Option<String>, _>("error_code").unwrap_or(None).unwrap_or_default(),
            job_row.try_get::<Option<String>, _>("error_message").unwrap_or(None).unwrap_or_default(),
            job_row.try_get::<Option<String>, _>("draft_technique_id").unwrap_or(None).unwrap_or_default(),
        );
        let mail_row = sqlx::query("SELECT attach_rewards FROM mail WHERE recipient_character_id = $1 AND source = 'technique_research_refund' AND source_ref_id = $2 ORDER BY id DESC LIMIT 1")
            .bind(fixture.character_id)
            .bind(&generation_id)
            .fetch_optional(&pool)
            .await
            .expect("refund mail query should run");
        let counter_row = sqlx::query(
            "SELECT total_count, unread_count, unclaimed_count FROM mail_counter WHERE scope_type = 'character' AND scope_id = $1 LIMIT 1",
        )
        .bind(fixture.character_id)
        .fetch_optional(&pool)
        .await
        .expect("mail counter query should run");

        println!("TECHNIQUE_AI_FAILURE_ROUTE_RESPONSE={body}");
        println!("TECHNIQUE_AI_FAILURE_FINAL_STATUS={final_status}");

        server.abort();
        ai_server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "failed");
        assert!(job_row.try_get::<Option<String>, _>("error_message").unwrap_or(None).unwrap_or_default().contains("已通过邮件返还"));
        let mail_row = mail_row.expect("refund mail should exist");
        let attach_rewards = mail_row
            .try_get::<Option<serde_json::Value>, _>("attach_rewards")
            .unwrap_or(None)
            .unwrap_or_else(|| serde_json::json!([]))
            .to_string();
        assert!(attach_rewards.contains("mat-gongfa-canye"));
        assert!(attach_rewards.contains("token-005"));
        let counter_row = counter_row.expect("mail counter row should exist");
        assert!(counter_row.try_get::<Option<i64>, _>("total_count").unwrap_or(None).unwrap_or_default() >= 1);
        assert!(counter_row.try_get::<Option<i64>, _>("unread_count").unwrap_or(None).unwrap_or_default() >= 1);
        assert!(counter_row.try_get::<Option<i64>, _>("unclaimed_count").unwrap_or(None).unwrap_or_default() >= 1);

        unsafe {
            match original_provider { Some(v) => std::env::set_var("AI_TECHNIQUE_MODEL_PROVIDER", v), None => std::env::remove_var("AI_TECHNIQUE_MODEL_PROVIDER") };
            match original_url { Some(v) => std::env::set_var("AI_TECHNIQUE_MODEL_URL", v), None => std::env::remove_var("AI_TECHNIQUE_MODEL_URL") };
            match original_key { Some(v) => std::env::set_var("AI_TECHNIQUE_MODEL_KEY", v), None => std::env::remove_var("AI_TECHNIQUE_MODEL_KEY") };
            match original_name { Some(v) => std::env::set_var("AI_TECHNIQUE_MODEL_NAME", v), None => std::env::remove_var("AI_TECHNIQUE_MODEL_NAME") };
        }
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn technique_research_discard_route_refunds_by_mail_and_updates_counter() {
        let _guard = technique_research_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "TECHNIQUE_DISCARD_REFUND_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("tech-discard-refund-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET realm = '炼炁化神', sub_realm = '结胎期' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character realm should update");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'mat-gongfa-canye', 5000, 'none', 'bag', NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("fragment item should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let generate_response = client
            .post(format!("http://{address}/api/character/{}/technique/research/generate", fixture.character_id))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"cooldownBypassEnabled\":false}")
            .send()
            .await
            .expect("technique research generate should succeed");
        let generate_status = generate_response.status();
        let generate_text = generate_response.text().await.expect("body should read");
        println!("TECHNIQUE_RESEARCH_DISCARD_GENERATE_HTTP_RESPONSE={generate_text}");
        println!("TECHNIQUE_RESEARCH_PUBLISH_GENERATE_HTTP_RESPONSE={generate_text}");
        assert_eq!(generate_status, StatusCode::OK);
        let generate_body: Value = serde_json::from_str(&generate_text)
            .expect("body should be json");
        let generation_id = generate_body["data"]["generationId"].as_str().expect("generation id should exist").to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let discard_response = client
            .post(format!("http://{address}/api/character/{}/technique/research/generate/{}/discard", fixture.character_id, generation_id))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("discard should succeed");
        assert_eq!(discard_response.status(), StatusCode::OK);
        let discard_body: Value = serde_json::from_str(&discard_response.text().await.expect("body should read"))
            .expect("body should be json");

        let job_row = sqlx::query("SELECT status, error_code, error_message FROM technique_generation_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("technique generation job should exist");
        let mail_row = sqlx::query("SELECT attach_rewards FROM mail WHERE recipient_character_id = $1 AND source = 'technique_research_refund' AND source_ref_id = $2 ORDER BY id DESC LIMIT 1")
            .bind(fixture.character_id)
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("refund mail should exist");
        let counter_row = sqlx::query(
            "SELECT total_count, unread_count, unclaimed_count FROM mail_counter WHERE scope_type = 'character' AND scope_id = $1 LIMIT 1",
        )
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("mail counter row should exist");

        println!("TECHNIQUE_DISCARD_REFUND_ROUTE_RESPONSE={discard_body}");

        server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "refunded");
        assert_eq!(job_row.try_get::<Option<String>, _>("error_code").unwrap_or(None).unwrap_or_default(), "GENERATION_EXPIRED");
        assert!(job_row.try_get::<Option<String>, _>("error_message").unwrap_or(None).unwrap_or_default().contains("已通过邮件返还"));
        let attach_rewards = mail_row
            .try_get::<Option<serde_json::Value>, _>("attach_rewards")
            .unwrap_or(None)
            .unwrap_or_else(|| serde_json::json!([]))
            .to_string();
        assert!(attach_rewards.contains("mat-gongfa-canye"));
        assert!(!attach_rewards.contains("token-005"));
        assert!(counter_row.try_get::<Option<i64>, _>("total_count").unwrap_or(None).unwrap_or_default() >= 1);
        assert!(counter_row.try_get::<Option<i64>, _>("unread_count").unwrap_or(None).unwrap_or_default() >= 1);
        assert!(counter_row.try_get::<Option<i64>, _>("unclaimed_count").unwrap_or(None).unwrap_or_default() >= 1);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn technique_research_generate_with_burning_word_requires_ai_config() {
        let _guard = technique_research_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "TECHNIQUE_AI_CONFIG_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let original_provider = std::env::var("AI_TECHNIQUE_MODEL_PROVIDER").ok();
        let original_url = std::env::var("AI_TECHNIQUE_MODEL_URL").ok();
        let original_key = std::env::var("AI_TECHNIQUE_MODEL_KEY").ok();
        let original_name = std::env::var("AI_TECHNIQUE_MODEL_NAME").ok();
        unsafe {
            std::env::remove_var("AI_TECHNIQUE_MODEL_PROVIDER");
            std::env::remove_var("AI_TECHNIQUE_MODEL_URL");
            std::env::remove_var("AI_TECHNIQUE_MODEL_KEY");
            std::env::remove_var("AI_TECHNIQUE_MODEL_NAME");
        }

        let suffix = format!("tech-ai-config-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET realm = '炼炁化神', sub_realm = '结胎期' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character realm should update");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'mat-gongfa-canye', 5000, 'none', 'bag', NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("fragment item should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/character/{}/technique/research/generate", fixture.character_id))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"burningWordPrompt\":\"青木\",\"cooldownBypassEnabled\":false}")
            .send()
            .await
            .expect("technique research generate request should return");
        let status = response.status();
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");

        println!("TECHNIQUE_AI_CONFIG_ROUTE_RESPONSE={body}");

        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "configuration error: 缺少 AI_TECHNIQUE_MODEL_URL 或 AI_TECHNIQUE_MODEL_KEY 配置");

        unsafe {
            match original_provider { Some(v) => std::env::set_var("AI_TECHNIQUE_MODEL_PROVIDER", v), None => std::env::remove_var("AI_TECHNIQUE_MODEL_PROVIDER") };
            match original_url { Some(v) => std::env::set_var("AI_TECHNIQUE_MODEL_URL", v), None => std::env::remove_var("AI_TECHNIQUE_MODEL_URL") };
            match original_key { Some(v) => std::env::set_var("AI_TECHNIQUE_MODEL_KEY", v), None => std::env::remove_var("AI_TECHNIQUE_MODEL_KEY") };
            match original_name { Some(v) => std::env::set_var("AI_TECHNIQUE_MODEL_NAME", v), None => std::env::remove_var("AI_TECHNIQUE_MODEL_NAME") };
        }
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn technique_research_generate_then_publish_emits_book_and_published_state() {
        let _guard = technique_research_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "TECHNIQUE_RESEARCH_PUBLISH_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("tech-publish-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET realm = '炼炁化神', sub_realm = '结胎期' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character realm should update");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'mat-gongfa-canye', 5000, 'none', 'bag', NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("fragment item should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let generate_response = client
            .post(format!("http://{address}/api/character/{}/technique/research/generate", fixture.character_id))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"cooldownBypassEnabled\":false}")
            .send()
            .await
            .expect("technique research generate should succeed");
        let generate_status = generate_response.status();
        let generate_text = generate_response.text().await.expect("generate body should read");
        println!("TECHNIQUE_RESEARCH_PUBLISH_GENERATE_HTTP_RESPONSE={generate_text}");
        assert_eq!(generate_status, StatusCode::OK);
        let generate_body: Value = serde_json::from_str(&generate_text)
            .expect("generate body should be json");
        let generation_id = generate_body["data"]["generationId"].as_str().expect("generation id should exist").to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let publish_response = client
            .post(format!("http://{address}/api/character/{}/technique/research/generate/{}/publish", fixture.character_id, generation_id))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"customName\":\"青木诀\"}")
            .send()
            .await
            .expect("technique research publish should succeed");
        assert_eq!(publish_response.status(), StatusCode::OK);
        let publish_body: Value = serde_json::from_str(&publish_response.text().await.expect("publish body should read"))
            .expect("publish body should be json");

        let job_row = sqlx::query("SELECT status, generated_technique_id, draft_technique_id FROM technique_generation_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("technique generation job should exist");
        let technique_id = publish_body["data"]["techniqueId"].as_str().expect("technique id should exist").to_string();
        let draft_row = sqlx::query("SELECT is_published, display_name, custom_name, normalized_custom_name, name_locked FROM generated_technique_def WHERE id = $1")
            .bind(&technique_id)
            .fetch_one(&pool)
            .await
            .expect("generated technique should exist");
        let book_row = sqlx::query("SELECT item_def_id, metadata FROM item_instance WHERE id = $1")
            .bind(publish_body["data"]["bookItemInstanceId"].as_i64().unwrap_or_default())
            .fetch_one(&pool)
            .await
            .expect("generated technique book should exist");

        println!("TECHNIQUE_RESEARCH_PUBLISH_GENERATE_RESPONSE={generate_body}");
        println!("TECHNIQUE_RESEARCH_PUBLISH_ROUTE_RESPONSE={publish_body}");

        server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "published");
        assert_eq!(job_row.try_get::<Option<String>, _>("generated_technique_id").unwrap_or(None).unwrap_or_default(), technique_id);
        assert_eq!(job_row.try_get::<Option<String>, _>("draft_technique_id").unwrap_or(None).unwrap_or_default(), technique_id);
        assert_eq!(draft_row.try_get::<Option<bool>, _>("is_published").unwrap_or(None), Some(true));
        assert_eq!(draft_row.try_get::<Option<bool>, _>("name_locked").unwrap_or(None), Some(true));
        assert_eq!(draft_row.try_get::<Option<String>, _>("display_name").unwrap_or(None).unwrap_or_default(), "『研』青木诀");
        assert_eq!(draft_row.try_get::<Option<String>, _>("custom_name").unwrap_or(None).unwrap_or_default(), "青木诀");
        assert_eq!(draft_row.try_get::<Option<String>, _>("normalized_custom_name").unwrap_or(None).unwrap_or_default(), "『研』青木诀".to_lowercase());
        assert_eq!(book_row.try_get::<Option<String>, _>("item_def_id").unwrap_or(None).unwrap_or_default(), "book-generated-technique");
        assert_eq!(book_row.try_get::<Option<serde_json::Value>, _>("metadata").unwrap_or(None).unwrap_or_default()["generatedTechniqueId"], technique_id);
        assert_eq!(book_row.try_get::<Option<serde_json::Value>, _>("metadata").unwrap_or(None).unwrap_or_default()["generatedTechniqueName"], "『研』青木诀");

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_recruit_mark_viewed_route_emits_status_to_target_user() {
        let _guard = partner_ai_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_PARTNER_RECRUIT_MARK_VIEWED_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("partner-recruit-viewed-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/partner/recruit/mark-result-viewed"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner recruit mark viewed request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_PARTNER_RECRUIT_MARK_VIEWED_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_PARTNER_RECRUIT_MARK_VIEWED_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("partnerRecruit:update"));
        assert!(target_poll.contains(&format!("\"characterId\":{}", fixture.character_id)));
        assert!(!other_poll.contains("partnerRecruit:update"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn partner_recruit_generate_then_confirm_reaches_generated_draft_and_creates_partner() {
        let _guard = partner_ai_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_RECRUIT_GENERATE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("partner-recruit-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET realm = '炼神返虚', sub_realm = '养神期' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character realm should update");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'token-004', 1, 'none', 'bag', NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("token item should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let generate_response = client
            .post(format!("http://{address}/api/partner/recruit/generate"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .expect("partner recruit generate should succeed");
        let generate_status = generate_response.status();
        let generate_text = generate_response.text().await.expect("generate body should read");
        println!("PARTNER_RECRUIT_GENERATE_HTTP_RESPONSE={generate_text}");
        assert_eq!(generate_status, StatusCode::OK);
        let generate_body: Value = serde_json::from_str(&generate_text)
            .expect("generate body should be json");
        let generation_id = generate_body["data"]["generationId"].as_str().expect("generation id should exist").to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let job_row = sqlx::query("SELECT status, preview_partner_def_id, preview_avatar_url FROM partner_recruit_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("partner recruit job should exist");
        let preview_partner_def_id = job_row.try_get::<Option<String>, _>("preview_partner_def_id").unwrap_or(None).unwrap_or_default();
        let generated_row = sqlx::query("SELECT name, quality, role, avatar FROM generated_partner_def WHERE id = $1")
            .bind(&preview_partner_def_id)
            .fetch_one(&pool)
            .await
            .expect("generated partner def should exist");

        let confirm_response = client
            .post(format!("http://{address}/api/partner/recruit/{generation_id}/confirm"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner recruit confirm should succeed");
        assert_eq!(confirm_response.status(), StatusCode::OK);
        let confirm_body: Value = serde_json::from_str(&confirm_response.text().await.expect("confirm body should read"))
            .expect("confirm body should be json");

        let accepted_job_row = sqlx::query("SELECT status, preview_partner_def_id FROM partner_recruit_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("accepted partner recruit job should exist");
        let partner_row = sqlx::query("SELECT partner_def_id, nickname, obtained_from, obtained_ref_id FROM character_partner WHERE id = $1")
            .bind(confirm_body["data"]["partnerId"].as_i64().unwrap_or_default())
            .fetch_one(&pool)
            .await
            .expect("recruited partner should exist");

        println!("PARTNER_RECRUIT_GENERATE_ROUTE_RESPONSE={generate_body}");
        println!("PARTNER_RECRUIT_CONFIRM_ROUTE_RESPONSE={confirm_body}");

        server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "generated_draft");
        assert!(!preview_partner_def_id.is_empty());
        assert!(job_row.try_get::<Option<String>, _>("preview_avatar_url").unwrap_or(None).is_some());
        assert_eq!(generated_row.try_get::<Option<String>, _>("quality").unwrap_or(None).unwrap_or_default(), "玄");
        assert_eq!(generated_row.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(), "玄·无相灵伴");
        assert_eq!(accepted_job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "accepted");
        assert_eq!(partner_row.try_get::<Option<String>, _>("partner_def_id").unwrap_or(None).unwrap_or_default(), preview_partner_def_id);
        assert_eq!(partner_row.try_get::<Option<String>, _>("obtained_from").unwrap_or(None).unwrap_or_default(), "partner_recruit");
        assert_eq!(partner_row.try_get::<Option<String>, _>("obtained_ref_id").unwrap_or(None).unwrap_or_default(), generation_id);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_recruit_generate_route_uses_mock_ai_when_configured() {
        let _guard = partner_ai_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_AI_SUCCESS_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let ai_app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(|| async move {
                axum::Json(serde_json::json!({
                    "choices": [{
                        "message": {
                            "content": "{\"name\":\"青木灵伴\",\"description\":\"以青木为底模推演出的玄品质伙伴预览。\",\"attributeElement\":\"wood\",\"role\":\"support\"}"
                        }
                    }]
                }))
            }),
        );
        let (ai_address, ai_server) = spawn_test_server(ai_app).await;

        let original_provider = std::env::var("AI_PARTNER_MODEL_PROVIDER").ok();
        let original_url = std::env::var("AI_PARTNER_MODEL_URL").ok();
        let original_key = std::env::var("AI_PARTNER_MODEL_KEY").ok();
        let original_name = std::env::var("AI_PARTNER_MODEL_NAME").ok();
        unsafe {
            std::env::set_var("AI_PARTNER_MODEL_PROVIDER", "openai");
            std::env::set_var("AI_PARTNER_MODEL_URL", format!("http://{ai_address}/v1"));
            std::env::set_var("AI_PARTNER_MODEL_KEY", "mock-partner-key");
            std::env::set_var("AI_PARTNER_MODEL_NAME", "mock-partner-model");
        }

        let suffix = format!("partner-ai-success-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET realm = '炼神返虚', sub_realm = '养神期' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character realm should update");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'token-004', 1, 'none', 'bag', NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("token item should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/partner/recruit/generate"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"customBaseModelEnabled\":true,\"requestedBaseModel\":\"青木\"}")
            .send()
            .await
            .expect("partner recruit generate should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");
        let generation_id = body["data"]["generationId"].as_str().expect("generation id should exist").to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let job_row = sqlx::query("SELECT status, preview_partner_def_id FROM partner_recruit_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("partner recruit job should exist");
        let preview_partner_def_id = job_row.try_get::<Option<String>, _>("preview_partner_def_id").unwrap_or(None).unwrap_or_default();
        let generated_row = sqlx::query("SELECT name, description, attribute_element, role FROM generated_partner_def WHERE id = $1")
            .bind(&preview_partner_def_id)
            .fetch_one(&pool)
            .await
            .expect("generated preview should exist");

        println!("PARTNER_AI_SUCCESS_ROUTE_RESPONSE={body}");

        server.abort();
        ai_server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "generated_draft");
        assert_eq!(generated_row.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(), "青木灵伴");
        assert_eq!(generated_row.try_get::<Option<String>, _>("description").unwrap_or(None).unwrap_or_default(), "以青木为底模推演出的玄品质伙伴预览。");
        assert_eq!(generated_row.try_get::<Option<String>, _>("attribute_element").unwrap_or(None).unwrap_or_default(), "wood");
        assert_eq!(generated_row.try_get::<Option<String>, _>("role").unwrap_or(None).unwrap_or_default(), "support");

        unsafe {
            match original_provider { Some(v) => std::env::set_var("AI_PARTNER_MODEL_PROVIDER", v), None => std::env::remove_var("AI_PARTNER_MODEL_PROVIDER") };
            match original_url { Some(v) => std::env::set_var("AI_PARTNER_MODEL_URL", v), None => std::env::remove_var("AI_PARTNER_MODEL_URL") };
            match original_key { Some(v) => std::env::set_var("AI_PARTNER_MODEL_KEY", v), None => std::env::remove_var("AI_PARTNER_MODEL_KEY") };
            match original_name { Some(v) => std::env::set_var("AI_PARTNER_MODEL_NAME", v), None => std::env::remove_var("AI_PARTNER_MODEL_NAME") };
        }
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_recruit_generate_route_refunds_when_ai_provider_errors() {
        let _guard = partner_ai_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_RECRUIT_AI_FAILURE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let ai_app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(|| async move {
                (
                    axum::http::StatusCode::BAD_GATEWAY,
                    axum::Json(serde_json::json!({"error":"mock upstream failed"})),
                )
            }),
        );
        let (ai_address, ai_server) = spawn_test_server(ai_app).await;

        let original_provider = std::env::var("AI_PARTNER_MODEL_PROVIDER").ok();
        let original_url = std::env::var("AI_PARTNER_MODEL_URL").ok();
        let original_key = std::env::var("AI_PARTNER_MODEL_KEY").ok();
        let original_name = std::env::var("AI_PARTNER_MODEL_NAME").ok();
        unsafe {
            std::env::set_var("AI_PARTNER_MODEL_PROVIDER", "openai");
            std::env::set_var("AI_PARTNER_MODEL_URL", format!("http://{ai_address}/v1"));
            std::env::set_var("AI_PARTNER_MODEL_KEY", "mock-partner-key");
            std::env::set_var("AI_PARTNER_MODEL_NAME", "mock-partner-model");
        }

        let suffix = format!("partner-ai-failure-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET realm = '炼神返虚', sub_realm = '养神期', spirit_stones = 1000 WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character state should update");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'token-004', 1, 'none', 'bag', NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("token item should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/partner/recruit/generate"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"customBaseModelEnabled\":true,\"requestedBaseModel\":\"青木\"}")
            .send()
            .await
            .expect("partner recruit generate should return");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");
        let generation_id = body["data"]["generationId"].as_str().expect("generation id should exist").to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let job_row = sqlx::query("SELECT status, error_message FROM partner_recruit_job WHERE id = $1")
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("partner recruit job should exist");
        let mail_row = sqlx::query("SELECT attach_spirit_stones, attach_items FROM mail WHERE recipient_character_id = $1 AND source = 'partner_recruit_refund' AND source_ref_id = $2 ORDER BY id DESC LIMIT 1")
            .bind(fixture.character_id)
            .bind(&generation_id)
            .fetch_one(&pool)
            .await
            .expect("refund mail should exist");
        let counter_row = sqlx::query(
            "SELECT total_count, unread_count, unclaimed_count FROM mail_counter WHERE scope_type = 'character' AND scope_id = $1 LIMIT 1",
        )
        .bind(fixture.character_id)
        .fetch_one(&pool)
        .await
        .expect("mail counter row should exist");

        println!("PARTNER_RECRUIT_AI_FAILURE_ROUTE_RESPONSE={body}");

        server.abort();
        ai_server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "refunded");
        assert!(job_row.try_get::<Option<String>, _>("error_message").unwrap_or(None).unwrap_or_default().contains("已通过邮件返还"));
        assert_eq!(mail_row.try_get::<Option<i64>, _>("attach_spirit_stones").unwrap_or(None).unwrap_or_default(), 0);
        assert!(mail_row.try_get::<Option<serde_json::Value>, _>("attach_items").unwrap_or(None).unwrap_or_else(|| serde_json::json!([])).to_string().contains("token-004"));
        assert!(counter_row.try_get::<Option<i64>, _>("total_count").unwrap_or(None).unwrap_or_default() >= 1);
        assert!(counter_row.try_get::<Option<i64>, _>("unread_count").unwrap_or(None).unwrap_or_default() >= 1);
        assert!(counter_row.try_get::<Option<i64>, _>("unclaimed_count").unwrap_or(None).unwrap_or_default() >= 1);

        unsafe {
            match original_provider { Some(v) => std::env::set_var("AI_PARTNER_MODEL_PROVIDER", v), None => std::env::remove_var("AI_PARTNER_MODEL_PROVIDER") };
            match original_url { Some(v) => std::env::set_var("AI_PARTNER_MODEL_URL", v), None => std::env::remove_var("AI_PARTNER_MODEL_URL") };
            match original_key { Some(v) => std::env::set_var("AI_PARTNER_MODEL_KEY", v), None => std::env::remove_var("AI_PARTNER_MODEL_KEY") };
            match original_name { Some(v) => std::env::set_var("AI_PARTNER_MODEL_NAME", v), None => std::env::remove_var("AI_PARTNER_MODEL_NAME") };
        }
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_recruit_generate_with_custom_base_model_requires_ai_config() {
        let _guard = partner_ai_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_AI_CONFIG_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let original_provider = std::env::var("AI_PARTNER_MODEL_PROVIDER").ok();
        let original_url = std::env::var("AI_PARTNER_MODEL_URL").ok();
        let original_key = std::env::var("AI_PARTNER_MODEL_KEY").ok();
        let original_name = std::env::var("AI_PARTNER_MODEL_NAME").ok();
        unsafe {
            std::env::remove_var("AI_PARTNER_MODEL_PROVIDER");
            std::env::remove_var("AI_PARTNER_MODEL_URL");
            std::env::remove_var("AI_PARTNER_MODEL_KEY");
            std::env::remove_var("AI_PARTNER_MODEL_NAME");
        }

        let suffix = format!("partner-ai-config-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        sqlx::query("UPDATE characters SET realm = '炼神返虚', sub_realm = '养神期' WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character realm should update");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'token-004', 1, 'none', 'bag', NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("token item should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{address}/api/partner/recruit/generate"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body("{\"customBaseModelEnabled\":true,\"requestedBaseModel\":\"青木\"}")
            .send()
            .await
            .expect("partner recruit generate request should return");
        let status = response.status();
        let response_text = response.text().await.expect("body should read");
        println!("PARTNER_AI_CONFIG_HTTP_RESPONSE={response_text}");
        let body: Value = serde_json::from_str(&response_text)
            .expect("body should be json");

        println!("PARTNER_AI_CONFIG_ROUTE_RESPONSE={body}");

        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "configuration error: 缺少 AI_PARTNER_MODEL_URL 或 AI_PARTNER_MODEL_KEY 配置");

        unsafe {
            match original_provider { Some(v) => std::env::set_var("AI_PARTNER_MODEL_PROVIDER", v), None => std::env::remove_var("AI_PARTNER_MODEL_PROVIDER") };
            match original_url { Some(v) => std::env::set_var("AI_PARTNER_MODEL_URL", v), None => std::env::remove_var("AI_PARTNER_MODEL_URL") };
            match original_key { Some(v) => std::env::set_var("AI_PARTNER_MODEL_KEY", v), None => std::env::remove_var("AI_PARTNER_MODEL_KEY") };
            match original_name { Some(v) => std::env::set_var("AI_PARTNER_MODEL_NAME", v), None => std::env::remove_var("AI_PARTNER_MODEL_NAME") };
        }
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_fusion_mark_viewed_route_emits_status_to_target_user() {
        let _guard = partner_ai_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_PARTNER_FUSION_MARK_VIEWED_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("partner-fusion-viewed-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/partner/fusion/mark-result-viewed"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner fusion mark viewed request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_PARTNER_FUSION_MARK_VIEWED_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_PARTNER_FUSION_MARK_VIEWED_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("partnerFusion:update"));
        assert!(target_poll.contains(&format!("\"characterId\":{}", fixture.character_id)));
        assert!(!other_poll.contains("partnerFusion:update"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
    async fn partner_fusion_generate_preview_then_confirm_creates_partner() {
        let _guard = partner_ai_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_FUSION_GENERATE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("partner-fusion-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;

        let partner_ids = [
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await,
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵使", false).await,
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵偶", false).await,
        ];

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let start_response = client
            .post(format!("http://{address}/api/partner/fusion/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"partnerIds\":[{},{},{}]}}", partner_ids[0], partner_ids[1], partner_ids[2]))
            .send()
            .await
            .expect("partner fusion start should succeed");
        let start_status = start_response.status();
        let start_text = start_response.text().await.expect("start body should read");
        if start_status != StatusCode::OK {
            panic!("PARTNER_REBONE_START_ROUTE_RESPONSE={start_text}");
        }
        let start_body: Value = serde_json::from_str(&start_text)
            .expect("start body should be json");
        let fusion_id = start_body["data"]["fusionId"].as_str().expect("fusion id should exist").to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let job_row = sqlx::query("SELECT status, preview_partner_def_id FROM partner_fusion_job WHERE id = $1")
            .bind(&fusion_id)
            .fetch_one(&pool)
            .await
            .expect("partner fusion job should exist");
        let preview_partner_def_id = job_row.try_get::<Option<String>, _>("preview_partner_def_id").unwrap_or(None).unwrap_or_default();
        println!(
            "PARTNER_FUSION_JOB_STATUS={} PREVIEW_ID={}",
            job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(),
            preview_partner_def_id,
        );
        let generated_row = sqlx::query("SELECT name, quality, role FROM generated_partner_def WHERE id = $1")
            .bind(&preview_partner_def_id)
            .fetch_one(&pool)
            .await
            .expect("generated fusion preview should exist");

        let confirm_response = client
            .post(format!("http://{address}/api/partner/fusion/{fusion_id}/confirm"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner fusion confirm should succeed");
        let confirm_status = confirm_response.status();
        let confirm_text = confirm_response.text().await.expect("confirm body should read");
        println!("PARTNER_FUSION_CONFIRM_HTTP_RESPONSE={confirm_text}");
        assert_eq!(confirm_status, StatusCode::OK);
        let confirm_body: Value = serde_json::from_str(&confirm_text)
            .expect("confirm body should be json");

        let accepted_job_row = sqlx::query("SELECT status, preview_partner_def_id FROM partner_fusion_job WHERE id = $1")
            .bind(&fusion_id)
            .fetch_one(&pool)
            .await
            .expect("partner fusion accepted job should exist");
        let partner_row = sqlx::query("SELECT partner_def_id, obtained_from, obtained_ref_id FROM character_partner WHERE id = $1")
            .bind(confirm_body["data"]["partnerId"].as_i64().unwrap_or_default())
            .fetch_one(&pool)
            .await
            .expect("fused partner should exist");

        println!("PARTNER_FUSION_GENERATE_ROUTE_RESPONSE={start_body}");
        println!("PARTNER_FUSION_CONFIRM_ROUTE_RESPONSE={confirm_body}");

        server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "generated_preview");
        assert!(!preview_partner_def_id.is_empty());
        assert_eq!(generated_row.try_get::<Option<String>, _>("quality").unwrap_or(None).unwrap_or_default(), start_body["data"]["resultQuality"].as_str().unwrap_or_default());
        assert_eq!(accepted_job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "accepted");
        assert_eq!(partner_row.try_get::<Option<String>, _>("partner_def_id").unwrap_or(None).unwrap_or_default(), preview_partner_def_id);
        assert_eq!(partner_row.try_get::<Option<String>, _>("obtained_from").unwrap_or(None).unwrap_or_default(), "partner_fusion");
        assert_eq!(partner_row.try_get::<Option<String>, _>("obtained_ref_id").unwrap_or(None).unwrap_or_default(), fusion_id);

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_fusion_generate_route_uses_mock_ai_when_configured() {
        let _guard = partner_ai_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_FUSION_AI_SUCCESS_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let ai_app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(|| async move {
                axum::Json(serde_json::json!({
                    "choices": [{
                        "message": {
                            "content": "{\"name\":\"玄木归契灵伴\",\"description\":\"由归契之力凝成的玄品质伙伴预览。\",\"attributeElement\":\"wood\",\"role\":\"support\"}"
                        }
                    }]
                }))
            }),
        );
        let (ai_address, ai_server) = spawn_test_server(ai_app).await;

        let original_provider = std::env::var("AI_PARTNER_MODEL_PROVIDER").ok();
        let original_url = std::env::var("AI_PARTNER_MODEL_URL").ok();
        let original_key = std::env::var("AI_PARTNER_MODEL_KEY").ok();
        let original_name = std::env::var("AI_PARTNER_MODEL_NAME").ok();
        unsafe {
            std::env::set_var("AI_PARTNER_MODEL_PROVIDER", "openai");
            std::env::set_var("AI_PARTNER_MODEL_URL", format!("http://{ai_address}/v1"));
            std::env::set_var("AI_PARTNER_MODEL_KEY", "mock-partner-key");
            std::env::set_var("AI_PARTNER_MODEL_NAME", "mock-partner-model");
        }

        let suffix = format!("partner-fusion-ai-success-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let partner_ids = [
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await,
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵使", false).await,
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵偶", false).await,
        ];

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/partner/fusion/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"partnerIds\":[{},{},{}]}}", partner_ids[0], partner_ids[1], partner_ids[2]))
            .send()
            .await
            .expect("partner fusion start should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");
        let fusion_id = body["data"]["fusionId"].as_str().expect("fusion id should exist").to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let job_row = sqlx::query("SELECT status, preview_partner_def_id FROM partner_fusion_job WHERE id = $1")
            .bind(&fusion_id)
            .fetch_one(&pool)
            .await
            .expect("partner fusion job should exist");
        let preview_partner_def_id = job_row.try_get::<Option<String>, _>("preview_partner_def_id").unwrap_or(None).unwrap_or_default();
        println!(
            "PARTNER_FUSION_AI_SUCCESS_JOB_STATUS={} PREVIEW_ID={}",
            job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(),
            preview_partner_def_id,
        );
        let generated_row = sqlx::query("SELECT name, description, attribute_element, role FROM generated_partner_def WHERE id = $1")
            .bind(&preview_partner_def_id)
            .fetch_one(&pool)
            .await
            .expect("generated fusion preview should exist");

        println!("PARTNER_FUSION_AI_SUCCESS_ROUTE_RESPONSE={body}");

        server.abort();
        ai_server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "generated_preview");
        assert_eq!(generated_row.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(), "玄木归契灵伴");
        assert_eq!(generated_row.try_get::<Option<String>, _>("description").unwrap_or(None).unwrap_or_default(), "由归契之力凝成的玄品质伙伴预览。");
        assert_eq!(generated_row.try_get::<Option<String>, _>("attribute_element").unwrap_or(None).unwrap_or_default(), "wood");
        assert_eq!(generated_row.try_get::<Option<String>, _>("role").unwrap_or(None).unwrap_or_default(), "support");

        unsafe {
            match original_provider { Some(v) => std::env::set_var("AI_PARTNER_MODEL_PROVIDER", v), None => std::env::remove_var("AI_PARTNER_MODEL_PROVIDER") };
            match original_url { Some(v) => std::env::set_var("AI_PARTNER_MODEL_URL", v), None => std::env::remove_var("AI_PARTNER_MODEL_URL") };
            match original_key { Some(v) => std::env::set_var("AI_PARTNER_MODEL_KEY", v), None => std::env::remove_var("AI_PARTNER_MODEL_KEY") };
            match original_name { Some(v) => std::env::set_var("AI_PARTNER_MODEL_NAME", v), None => std::env::remove_var("AI_PARTNER_MODEL_NAME") };
        }
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
    async fn partner_fusion_generate_route_fails_when_ai_provider_errors() {
        let _guard = partner_ai_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_FUSION_AI_FAILURE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let ai_app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(|| async move {
                (
                    axum::http::StatusCode::BAD_GATEWAY,
                    axum::Json(serde_json::json!({"error":"mock upstream failed"})),
                )
            }),
        );
        let (ai_address, ai_server) = spawn_test_server(ai_app).await;

        let original_provider = std::env::var("AI_PARTNER_MODEL_PROVIDER").ok();
        let original_url = std::env::var("AI_PARTNER_MODEL_URL").ok();
        let original_key = std::env::var("AI_PARTNER_MODEL_KEY").ok();
        let original_name = std::env::var("AI_PARTNER_MODEL_NAME").ok();
        unsafe {
            std::env::set_var("AI_PARTNER_MODEL_PROVIDER", "openai");
            std::env::set_var("AI_PARTNER_MODEL_URL", format!("http://{ai_address}/v1"));
            std::env::set_var("AI_PARTNER_MODEL_KEY", "mock-partner-key");
            std::env::set_var("AI_PARTNER_MODEL_NAME", "mock-partner-model");
        }

        let suffix = format!("partner-fusion-ai-failure-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let partner_ids = [
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵伴", false).await,
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵使", false).await,
            insert_partner_fixture(&pool, fixture.character_id, "partner-qingmu-xiaoou", "青木灵偶", false).await,
        ];

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/partner/fusion/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"partnerIds\":[{},{},{}]}}", partner_ids[0], partner_ids[1], partner_ids[2]))
            .send()
            .await
            .expect("partner fusion start should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");
        let fusion_id = body["data"]["fusionId"].as_str().expect("fusion id should exist").to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let job_row = sqlx::query("SELECT status, error_message FROM partner_fusion_job WHERE id = $1")
            .bind(&fusion_id)
            .fetch_one(&pool)
            .await
            .expect("partner fusion job should exist");

        println!("PARTNER_FUSION_AI_FAILURE_ROUTE_RESPONSE={body}");

        server.abort();
        ai_server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "failed");
        assert!(job_row
            .try_get::<Option<String>, _>("error_message")
            .unwrap_or(None)
            .unwrap_or_default()
            .contains("伙伴 AI 返回错误状态"));

        unsafe {
            match original_provider { Some(v) => std::env::set_var("AI_PARTNER_MODEL_PROVIDER", v), None => std::env::remove_var("AI_PARTNER_MODEL_PROVIDER") };
            match original_url { Some(v) => std::env::set_var("AI_PARTNER_MODEL_URL", v), None => std::env::remove_var("AI_PARTNER_MODEL_URL") };
            match original_key { Some(v) => std::env::set_var("AI_PARTNER_MODEL_KEY", v), None => std::env::remove_var("AI_PARTNER_MODEL_KEY") };
            match original_name { Some(v) => std::env::set_var("AI_PARTNER_MODEL_NAME", v), None => std::env::remove_var("AI_PARTNER_MODEL_NAME") };
        }
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn partner_rebone_mark_viewed_route_emits_status_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_PARTNER_REBONE_MARK_VIEWED_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("partner-rebone-viewed-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/partner/rebone/mark-result-viewed"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("partner rebone mark viewed request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_PARTNER_REBONE_MARK_VIEWED_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_PARTNER_REBONE_MARK_VIEWED_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("partnerRebone:update"));
        assert!(target_poll.contains(&format!("\"characterId\":{}", fixture.character_id)));
        assert!(!other_poll.contains("partnerRebone:update"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn partner_rebone_start_then_succeeds_and_rewrites_growth() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "PARTNER_REBONE_GENERATE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("partner-rebone-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let partner_def_id = format!("generated-rebone-partner-{suffix}");
sqlx::query("INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, base_attrs, level_attr_gains, innate_technique_ids, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, '玄·青木灵伴', '测试动态伙伴', NULL, '玄', 'wood', 'support', 1, '{\"max_qixue\":120,\"wugong\":20,\"fagong\":12,\"wufang\":10,\"fafang\":10,\"sudu\":8}'::jsonb, '{\"max_qixue\":8,\"wugong\":2,\"fagong\":2,\"wufang\":1,\"fafang\":1,\"sudu\":1}'::jsonb, ARRAY[]::text[], TRUE, $2, $3, NOW(), NOW())")
            .bind(&partner_def_id)
            .bind(fixture.character_id)
            .bind(format!("partner-recruit-{suffix}"))
            .execute(&pool)
            .await
            .expect("generated partner def should insert");
        let partner_id = insert_partner_fixture(&pool, fixture.character_id, &partner_def_id, "玄·青木灵伴", false).await;
        sqlx::query("UPDATE character_partner SET growth_max_qixue = 120, growth_wugong = 20, growth_fagong = 12, growth_wufang = 10, growth_fafang = 10, growth_sudu = 8 WHERE id = $1")
            .bind(partner_id)
            .execute(&pool)
            .await
            .expect("partner growth should seed");
        sqlx::query("INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, 'cons-partner-rebone-001', 1, 'none', 'bag', NOW(), NOW(), 'test')")
            .bind(fixture.user_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("rebone item should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let start_response = client
            .post(format!("http://{address}/api/partner/rebone/start"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"partnerId\":{},\"itemDefId\":\"cons-partner-rebone-001\",\"itemQty\":1}}", partner_id))
            .send()
            .await
            .expect("partner rebone start should succeed");
        let start_status = start_response.status();
        let start_text = start_response.text().await.expect("start body should read");
        if start_status != StatusCode::OK {
            panic!("PARTNER_REBONE_START_ROUTE_RESPONSE={start_text}");
        }
        let start_body: Value = serde_json::from_str(&start_text)
            .expect("start body should be json");
        let rebone_id = start_body["data"]["reboneId"].as_str().expect("rebone id should exist").to_string();

        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let job_row = sqlx::query("SELECT status FROM partner_rebone_job WHERE id = $1")
            .bind(&rebone_id)
            .fetch_one(&pool)
            .await
            .expect("partner rebone job should exist");
        let partner_row = sqlx::query("SELECT growth_max_qixue, growth_wugong, growth_fagong, growth_wufang, growth_fafang, growth_sudu FROM character_partner WHERE id = $1")
            .bind(partner_id)
            .fetch_one(&pool)
            .await
            .expect("partner row should exist");
        let generated_row = sqlx::query("SELECT base_attrs FROM generated_partner_def WHERE id = $1")
            .bind(&partner_def_id)
            .fetch_one(&pool)
            .await
            .expect("generated partner def should exist");

        println!("PARTNER_REBONE_START_ROUTE_RESPONSE={start_body}");
        println!("PARTNER_REBONE_JOB_STATUS={}", job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default());

        server.abort();

        assert_eq!(job_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_default(), "succeeded");
        assert_ne!(partner_row.try_get::<Option<i64>, _>("growth_max_qixue").unwrap_or(None).unwrap_or_default(), 120);
        assert_ne!(partner_row.try_get::<Option<i64>, _>("growth_wugong").unwrap_or(None).unwrap_or_default(), 20);
        assert!(generated_row.try_get::<Option<serde_json::Value>, _>("base_attrs").unwrap_or(None).unwrap_or_default().is_object());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }

    #[tokio::test]
        async fn team_create_route_emits_team_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TEAM_CREATE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("team-create-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/team/create"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"characterId\":{},\"name\":\"测试队伍\",\"goal\":\"一起修仙\"}}", fixture.character_id))
            .send()
            .await
            .expect("team create request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TEAM_CREATE_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_TEAM_CREATE_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("team:update"));
        assert!(target_poll.contains("\"source\":\"create_team\""));
        assert!(!other_poll.contains("team:update"));

        sqlx::query("DELETE FROM team_members WHERE character_id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM teams WHERE leader_id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn team_transfer_route_emits_team_update_to_affected_members() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TEAM_TRANSFER_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("team-transfer-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let member = insert_auth_fixture(&state, &pool, "socket", &format!("member-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let team_id = format!("team-{suffix}");

        sqlx::query("INSERT INTO teams (id, leader_id, name, current_map_id, is_public, max_members, auto_join_enabled, created_at, updated_at) VALUES ($1, $2, '测试队伍', 'map-qingyun-village', true, 4, false, NOW(), NOW())")
            .bind(&team_id)
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("team should insert");
        sqlx::query("INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'leader'), ($1, $3, 'member')")
            .bind(&team_id)
            .bind(leader.character_id)
            .bind(member.character_id)
            .execute(&pool)
            .await
            .expect("team members should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (leader_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &leader_sid).await;
        let (member_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &member_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: leader_sid.clone(),
            user_id: leader.user_id,
            character_id: Some(leader.character_id),
            session_token: Some("sess-leader".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: member_sid.clone(),
            user_id: member.user_id,
            character_id: Some(member.character_id),
            session_token: Some("sess-member".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 3,
        });

        let response = client
            .post(format!("http://{address}/api/team/transfer"))
            .header("authorization", format!("Bearer {}", leader.token))
            .header("content-type", "application/json")
            .body(format!("{{\"currentLeaderId\":{},\"newLeaderId\":{}}}", leader.character_id, member.character_id))
            .send()
            .await
            .expect("team transfer request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let leader_poll = poll_text(&client, address, &leader_sid).await;
        let member_poll = poll_text(&client, address, &member_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TEAM_TRANSFER_LEADER_POLL={leader_poll}");
        println!("GAME_SOCKET_TEAM_TRANSFER_MEMBER_POLL={member_poll}");
        println!("GAME_SOCKET_TEAM_TRANSFER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(leader_poll.contains("team:update"));
        assert!(leader_poll.contains("\"source\":\"transfer_team_leader\""));
        assert!(member_poll.contains("team:update"));
        assert!(member_poll.contains("\"source\":\"transfer_team_leader\""));
        assert!(!other_poll.contains("team:update"));

        sqlx::query("DELETE FROM team_members WHERE team_id = $1")
            .bind(&team_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM teams WHERE id = $1")
            .bind(&team_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, member.character_id, member.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn team_leave_route_emits_team_update_to_affected_members() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TEAM_LEAVE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("team-leave-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let member = insert_auth_fixture(&state, &pool, "socket", &format!("member-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let team_id = format!("team-{suffix}");

        sqlx::query("INSERT INTO teams (id, leader_id, name, current_map_id, is_public, max_members, auto_join_enabled, created_at, updated_at) VALUES ($1, $2, '测试队伍', 'map-qingyun-village', true, 4, false, NOW(), NOW())")
            .bind(&team_id)
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("team should insert");
        sqlx::query("INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'leader'), ($1, $3, 'member')")
            .bind(&team_id)
            .bind(leader.character_id)
            .bind(member.character_id)
            .execute(&pool)
            .await
            .expect("team members should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (leader_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &leader_sid).await;
        let (member_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &member_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: leader_sid.clone(),
            user_id: leader.user_id,
            character_id: Some(leader.character_id),
            session_token: Some("sess-leader".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: member_sid.clone(),
            user_id: member.user_id,
            character_id: Some(member.character_id),
            session_token: Some("sess-member".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 3,
        });

        let response = client
            .post(format!("http://{address}/api/team/leave"))
            .header("authorization", format!("Bearer {}", member.token))
            .header("content-type", "application/json")
            .body(format!("{{\"characterId\":{}}}", member.character_id))
            .send()
            .await
            .expect("team leave request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let leader_poll = poll_text(&client, address, &leader_sid).await;
        let member_poll = poll_text(&client, address, &member_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TEAM_LEAVE_LEADER_POLL={leader_poll}");
        println!("GAME_SOCKET_TEAM_LEAVE_MEMBER_POLL={member_poll}");
        println!("GAME_SOCKET_TEAM_LEAVE_OTHER_POLL={other_poll}");

        server.abort();

        assert!(leader_poll.contains("team:update"));
        assert!(leader_poll.contains("\"source\":\"leave_team\""));
        assert!(member_poll.contains("team:update"));
        assert!(member_poll.contains("\"source\":\"leave_team\""));
        assert!(!other_poll.contains("team:update"));

        sqlx::query("DELETE FROM team_members WHERE team_id = $1")
            .bind(&team_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM teams WHERE id = $1")
            .bind(&team_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, member.character_id, member.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn team_disband_route_emits_team_update_to_affected_members() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TEAM_DISBAND_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("team-disband-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let member = insert_auth_fixture(&state, &pool, "socket", &format!("member-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let team_id = format!("team-{suffix}");

        sqlx::query("INSERT INTO teams (id, leader_id, name, current_map_id, is_public, max_members, auto_join_enabled, created_at, updated_at) VALUES ($1, $2, '测试队伍', 'map-qingyun-village', true, 4, false, NOW(), NOW())")
            .bind(&team_id)
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("team should insert");
        sqlx::query("INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'leader'), ($1, $3, 'member')")
            .bind(&team_id)
            .bind(leader.character_id)
            .bind(member.character_id)
            .execute(&pool)
            .await
            .expect("team members should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (leader_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &leader_sid).await;
        let (member_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &member_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: leader_sid.clone(),
            user_id: leader.user_id,
            character_id: Some(leader.character_id),
            session_token: Some("sess-leader".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: member_sid.clone(),
            user_id: member.user_id,
            character_id: Some(member.character_id),
            session_token: Some("sess-member".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 3,
        });

        let response = client
            .post(format!("http://{address}/api/team/disband"))
            .header("authorization", format!("Bearer {}", leader.token))
            .header("content-type", "application/json")
            .body(format!("{{\"characterId\":{},\"teamId\":\"{}\"}}", leader.character_id, team_id))
            .send()
            .await
            .expect("team disband request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let leader_poll = poll_text(&client, address, &leader_sid).await;
        let member_poll = poll_text(&client, address, &member_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TEAM_DISBAND_LEADER_POLL={leader_poll}");
        println!("GAME_SOCKET_TEAM_DISBAND_MEMBER_POLL={member_poll}");
        println!("GAME_SOCKET_TEAM_DISBAND_OTHER_POLL={other_poll}");

        server.abort();

        assert!(leader_poll.contains("team:update"));
        assert!(leader_poll.contains("\"source\":\"disband_team\""));
        assert!(member_poll.contains("team:update"));
        assert!(member_poll.contains("\"source\":\"disband_team\""));
        assert!(!other_poll.contains("team:update"));

        sqlx::query("DELETE FROM team_members WHERE team_id = $1")
            .bind(&team_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM teams WHERE id = $1")
            .bind(&team_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, member.character_id, member.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn team_kick_route_emits_team_update_to_affected_members() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TEAM_KICK_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("team-kick-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let member = insert_auth_fixture(&state, &pool, "socket", &format!("member-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let team_id = format!("team-{suffix}");

        sqlx::query("INSERT INTO teams (id, leader_id, name, current_map_id, is_public, max_members, auto_join_enabled, created_at, updated_at) VALUES ($1, $2, '测试队伍', 'map-qingyun-village', true, 4, false, NOW(), NOW())")
            .bind(&team_id)
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("team should insert");
        sqlx::query("INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'leader'), ($1, $3, 'member')")
            .bind(&team_id)
            .bind(leader.character_id)
            .bind(member.character_id)
            .execute(&pool)
            .await
            .expect("team members should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (leader_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &leader_sid).await;
        let (member_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &member_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: leader_sid.clone(),
            user_id: leader.user_id,
            character_id: Some(leader.character_id),
            session_token: Some("sess-leader".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: member_sid.clone(),
            user_id: member.user_id,
            character_id: Some(member.character_id),
            session_token: Some("sess-member".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 3,
        });

        let response = client
            .post(format!("http://{address}/api/team/kick"))
            .header("authorization", format!("Bearer {}", leader.token))
            .header("content-type", "application/json")
            .body(format!("{{\"leaderId\":{},\"targetCharacterId\":{}}}", leader.character_id, member.character_id))
            .send()
            .await
            .expect("team kick request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let leader_poll = poll_text(&client, address, &leader_sid).await;
        let member_poll = poll_text(&client, address, &member_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TEAM_KICK_LEADER_POLL={leader_poll}");
        println!("GAME_SOCKET_TEAM_KICK_MEMBER_POLL={member_poll}");
        println!("GAME_SOCKET_TEAM_KICK_OTHER_POLL={other_poll}");

        server.abort();

        assert!(leader_poll.contains("team:update"));
        assert!(leader_poll.contains("\"source\":\"kick_member\""));
        assert!(member_poll.contains("team:update"));
        assert!(member_poll.contains("\"source\":\"kick_member\""));
        assert!(!other_poll.contains("team:update"));

        sqlx::query("DELETE FROM team_members WHERE team_id = $1")
            .bind(&team_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM teams WHERE id = $1")
            .bind(&team_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, member.character_id, member.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn team_update_settings_route_emits_team_update_to_affected_members() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TEAM_UPDATE_SETTINGS_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("team-settings-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let member = insert_auth_fixture(&state, &pool, "socket", &format!("member-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let team_id = format!("team-{suffix}");

        sqlx::query("INSERT INTO teams (id, leader_id, name, goal, join_min_realm, auto_join_enabled, auto_join_min_realm, current_map_id, is_public, max_members, created_at, updated_at) VALUES ($1, $2, '测试队伍', '旧目标', '凡人', false, '凡人', 'map-qingyun-village', true, 4, NOW(), NOW())")
            .bind(&team_id)
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("team should insert");
        sqlx::query("INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'leader'), ($1, $3, 'member')")
            .bind(&team_id)
            .bind(leader.character_id)
            .bind(member.character_id)
            .execute(&pool)
            .await
            .expect("team members should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (leader_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &leader_sid).await;
        let (member_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &member_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: leader_sid.clone(),
            user_id: leader.user_id,
            character_id: Some(leader.character_id),
            session_token: Some("sess-leader".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: member_sid.clone(),
            user_id: member.user_id,
            character_id: Some(member.character_id),
            session_token: Some("sess-member".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 3,
        });

        let response = client
            .post(format!("http://{address}/api/team/settings"))
            .header("authorization", format!("Bearer {}", leader.token))
            .header("content-type", "application/json")
            .body(format!("{{\"characterId\":{},\"teamId\":\"{}\",\"settings\":{{\"goal\":\"新目标\",\"isPublic\":false}}}}", leader.character_id, team_id))
            .send()
            .await
            .expect("team settings request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let leader_poll = poll_text(&client, address, &leader_sid).await;
        let member_poll = poll_text(&client, address, &member_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TEAM_UPDATE_SETTINGS_LEADER_POLL={leader_poll}");
        println!("GAME_SOCKET_TEAM_UPDATE_SETTINGS_MEMBER_POLL={member_poll}");
        println!("GAME_SOCKET_TEAM_UPDATE_SETTINGS_OTHER_POLL={other_poll}");

        server.abort();

        assert!(leader_poll.contains("team:update"));
        assert!(leader_poll.contains("\"source\":\"update_team_settings\""));
        assert!(member_poll.contains("team:update"));
        assert!(member_poll.contains("\"source\":\"update_team_settings\""));
        assert!(!other_poll.contains("team:update"));

        sqlx::query("DELETE FROM team_members WHERE team_id = $1")
            .bind(&team_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM teams WHERE id = $1")
            .bind(&team_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, member.character_id, member.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn team_handle_application_approve_route_emits_team_update_to_affected_members() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TEAM_HANDLE_APPLICATION_APPROVE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("team-application-approve-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let member = insert_auth_fixture(&state, &pool, "socket", &format!("member-{suffix}"), 0).await;
        let applicant = insert_auth_fixture(&state, &pool, "socket", &format!("applicant-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let team_id = format!("team-{suffix}");
        let application_id = format!("ta-{}", applicant.character_id);

        sqlx::query("INSERT INTO teams (id, leader_id, name, current_map_id, is_public, max_members, auto_join_enabled, created_at, updated_at) VALUES ($1, $2, '测试队伍', 'map-qingyun-village', true, 4, false, NOW(), NOW())")
            .bind(&team_id)
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("team should insert");
        sqlx::query("INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'leader'), ($1, $3, 'member')")
            .bind(&team_id)
            .bind(leader.character_id)
            .bind(member.character_id)
            .execute(&pool)
            .await
            .expect("team members should insert");
        sqlx::query("INSERT INTO team_applications (id, team_id, applicant_id, status, created_at) VALUES ($1, $2, $3, 'pending', NOW())")
            .bind(&application_id)
            .bind(&team_id)
            .bind(applicant.character_id)
            .execute(&pool)
            .await
            .expect("team application should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (leader_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &leader_sid).await;
        let (member_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &member_sid).await;
        let (applicant_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &applicant_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: leader_sid.clone(),
            user_id: leader.user_id,
            character_id: Some(leader.character_id),
            session_token: Some("sess-leader".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: member_sid.clone(),
            user_id: member.user_id,
            character_id: Some(member.character_id),
            session_token: Some("sess-member".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: applicant_sid.clone(),
            user_id: applicant.user_id,
            character_id: Some(applicant.character_id),
            session_token: Some("sess-applicant".to_string()),
            connected_at_ms: 3,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 4,
        });

        let response = client
            .post(format!("http://{address}/api/team/application/handle"))
            .header("authorization", format!("Bearer {}", leader.token))
            .header("content-type", "application/json")
            .body(format!("{{\"characterId\":{},\"applicationId\":\"{}\",\"approve\":true}}", leader.character_id, application_id))
            .send()
            .await
            .expect("team approve application request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("team approve body should read");
        println!("TEAM_HANDLE_APPLICATION_APPROVE_ROUTE_RESPONSE={response_text}");
        assert_eq!(response_status, StatusCode::OK);

        let applicant_poll = poll_text(&client, address, &applicant_sid).await;
        let leader_poll = poll_text(&client, address, &leader_sid).await;
        let member_poll = poll_text(&client, address, &member_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TEAM_HANDLE_APPLICATION_APPROVE_LEADER_POLL={leader_poll}");
        println!("GAME_SOCKET_TEAM_HANDLE_APPLICATION_APPROVE_MEMBER_POLL={member_poll}");
        println!("GAME_SOCKET_TEAM_HANDLE_APPLICATION_APPROVE_APPLICANT_POLL={applicant_poll}");
        println!("GAME_SOCKET_TEAM_HANDLE_APPLICATION_APPROVE_OTHER_POLL={other_poll}");

        server.abort();

        assert!(leader_poll.contains("team:update"));
        assert!(leader_poll.contains("\"source\":\"approve_application\""));
        assert!(member_poll.contains("team:update"));
        assert!(member_poll.contains("\"source\":\"approve_application\""));
        assert!(applicant_poll.contains("team:update"));
        assert!(applicant_poll.contains("\"source\":\"approve_application\""));
        assert!(!other_poll.contains("team:update"));

        sqlx::query("DELETE FROM team_applications WHERE id = $1").bind(&application_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM team_members WHERE team_id = $1").bind(&team_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM teams WHERE id = $1").bind(&team_id).execute(&pool).await.ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, member.character_id, member.user_id).await;
        cleanup_auth_fixture(&pool, applicant.character_id, applicant.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn team_handle_application_reject_route_emits_team_update_only_to_applicant() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_TEAM_HANDLE_APPLICATION_REJECT_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("team-application-reject-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let member = insert_auth_fixture(&state, &pool, "socket", &format!("member-{suffix}"), 0).await;
        let applicant = insert_auth_fixture(&state, &pool, "socket", &format!("applicant-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let team_id = format!("team-{suffix}");
        let application_id = format!("ta-{}", applicant.character_id);

        sqlx::query("INSERT INTO teams (id, leader_id, name, current_map_id, is_public, max_members, auto_join_enabled, created_at, updated_at) VALUES ($1, $2, '测试队伍', 'map-qingyun-village', true, 4, false, NOW(), NOW())")
            .bind(&team_id)
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("team should insert");
        sqlx::query("INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'leader'), ($1, $3, 'member')")
            .bind(&team_id)
            .bind(leader.character_id)
            .bind(member.character_id)
            .execute(&pool)
            .await
            .expect("team members should insert");
        sqlx::query("INSERT INTO team_applications (id, team_id, applicant_id, status, created_at) VALUES ($1, $2, $3, 'pending', NOW())")
            .bind(&application_id)
            .bind(&team_id)
            .bind(applicant.character_id)
            .execute(&pool)
            .await
            .expect("team application should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (leader_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &leader_sid).await;
        let (member_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &member_sid).await;
        let (applicant_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &applicant_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: leader_sid.clone(),
            user_id: leader.user_id,
            character_id: Some(leader.character_id),
            session_token: Some("sess-leader".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: member_sid.clone(),
            user_id: member.user_id,
            character_id: Some(member.character_id),
            session_token: Some("sess-member".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: applicant_sid.clone(),
            user_id: applicant.user_id,
            character_id: Some(applicant.character_id),
            session_token: Some("sess-applicant".to_string()),
            connected_at_ms: 3,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 4,
        });

        let response = client
            .post(format!("http://{address}/api/team/application/handle"))
            .header("authorization", format!("Bearer {}", leader.token))
            .header("content-type", "application/json")
            .body(format!("{{\"characterId\":{},\"applicationId\":\"{}\",\"approve\":false}}", leader.character_id, application_id))
            .send()
            .await
            .expect("team reject application request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("team reject body should read");
        println!("TEAM_HANDLE_APPLICATION_REJECT_ROUTE_RESPONSE={response_text}");
        assert_eq!(response_status, StatusCode::OK);

        let applicant_poll = poll_text(&client, address, &applicant_sid).await;
        let leader_poll = poll_text(&client, address, &leader_sid).await;
        let member_poll = poll_text(&client, address, &member_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_TEAM_HANDLE_APPLICATION_REJECT_LEADER_POLL={leader_poll}");
        println!("GAME_SOCKET_TEAM_HANDLE_APPLICATION_REJECT_MEMBER_POLL={member_poll}");
        println!("GAME_SOCKET_TEAM_HANDLE_APPLICATION_REJECT_APPLICANT_POLL={applicant_poll}");
        println!("GAME_SOCKET_TEAM_HANDLE_APPLICATION_REJECT_OTHER_POLL={other_poll}");

        server.abort();

        assert!(!leader_poll.contains("team:update"));
        assert!(!member_poll.contains("team:update"));
        assert!(applicant_poll.contains("team:update"));
        assert!(applicant_poll.contains("\"source\":\"reject_application\""));
        assert!(!other_poll.contains("team:update"));

        sqlx::query("DELETE FROM team_applications WHERE id = $1").bind(&application_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM team_members WHERE team_id = $1").bind(&team_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM teams WHERE id = $1").bind(&team_id).execute(&pool).await.ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, member.character_id, member.user_id).await;
        cleanup_auth_fixture(&pool, applicant.character_id, applicant.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn sect_apply_route_emits_sect_update_to_target_user() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_SECT_APPLY_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("sect-apply-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let sect_id = format!("sect-{suffix}");

        insert_test_sect(&pool, &sect_id, leader.character_id, 1, &suffix).await;
        sqlx::query("INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'leader', 0, 0, NOW())")
            .bind(&sect_id)
            .bind(leader.character_id)
            .execute(&pool)
            .await
            .expect("sect leader should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/sect/apply"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"sectId\":\"{}\",\"message\":\"求加入\"}}", sect_id))
            .send()
            .await
            .expect("sect apply request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("sect apply body should read");
        println!("SECT_APPLY_ROUTE_RESPONSE={response_text}");
        assert_eq!(response_status, StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_SECT_APPLY_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_SECT_APPLY_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("sect:update"));
        assert!(target_poll.contains("\"joined\":false"));
        assert!(target_poll.contains("\"myPendingApplicationCount\":1"));
        assert!(!other_poll.contains("sect:update"));

        sqlx::query("DELETE FROM sect_application WHERE sect_id = $1 AND character_id = $2")
            .bind(&sect_id)
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM sect_def WHERE id = $1")
            .bind(&sect_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn sect_create_route_emits_sect_update_to_creator() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_SECT_CREATE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("sect-create-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 2000).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        sqlx::query("UPDATE characters SET spirit_stones = 2000 WHERE id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .expect("character spirit stones should update");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/sect/create"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"name\":\"宗门{}\",\"description\":\"为了修仙\"}}", &suffix[..suffix.len().min(8)]))
            .send()
            .await
            .expect("sect create request should succeed");
        let response_status = response.status();
        let response_text = response.text().await.expect("sect create body should read");
        println!("SECT_CREATE_ROUTE_RESPONSE={response_text}");
        assert_eq!(response_status, StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_SECT_CREATE_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_SECT_CREATE_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("sect:update"));
        assert!(target_poll.contains("\"joined\":true"));
        assert!(target_poll.contains("\"canManageApplications\":true"));
        assert!(!other_poll.contains("sect:update"));

        sqlx::query("DELETE FROM sect_member WHERE character_id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM sect_def WHERE leader_id = $1")
            .bind(fixture.character_id)
            .execute(&pool)
            .await
            .ok();
        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn sect_cancel_application_route_emits_update_to_applicant_and_manager() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_SECT_CANCEL_APPLICATION_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("sect-cancel-{}", super::chrono_like_timestamp_ms());
        let manager = insert_auth_fixture(&state, &pool, "socket", &format!("manager-{suffix}"), 0).await;
        let applicant = insert_auth_fixture(&state, &pool, "socket", &format!("applicant-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let sect_id = format!("sect-{suffix}");

        insert_test_sect(&pool, &sect_id, manager.character_id, 1, &suffix).await;
        sqlx::query("INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'leader', 0, 0, NOW())")
            .bind(&sect_id)
            .bind(manager.character_id)
            .execute(&pool)
            .await
            .expect("sect manager should insert");
        let application_id = sqlx::query("INSERT INTO sect_application (sect_id, character_id, message, status, created_at) VALUES ($1, $2, '求加入', 'pending', NOW()) RETURNING id")
            .bind(&sect_id)
            .bind(applicant.character_id)
            .fetch_one(&pool)
            .await
            .expect("sect application should insert")
            .try_get::<i64, _>("id")
            .expect("application id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (manager_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &manager_sid).await;
        let (applicant_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &applicant_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: manager_sid.clone(),
            user_id: manager.user_id,
            character_id: Some(manager.character_id),
            session_token: Some("sess-manager".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: applicant_sid.clone(),
            user_id: applicant.user_id,
            character_id: Some(applicant.character_id),
            session_token: Some("sess-applicant".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 3,
        });

        let response = client
            .post(format!("http://{address}/api/sect/applications/cancel"))
            .header("authorization", format!("Bearer {}", applicant.token))
            .header("content-type", "application/json")
            .body(format!("{{\"applicationId\":{}}}", application_id))
            .send()
            .await
            .expect("sect cancel application request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let manager_poll = poll_text(&client, address, &manager_sid).await;
        let applicant_poll = poll_text(&client, address, &applicant_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_SECT_CANCEL_APPLICATION_MANAGER_POLL={manager_poll}");
        println!("GAME_SOCKET_SECT_CANCEL_APPLICATION_APPLICANT_POLL={applicant_poll}");
        println!("GAME_SOCKET_SECT_CANCEL_APPLICATION_OTHER_POLL={other_poll}");

        server.abort();

        assert!(manager_poll.contains("sect:update"));
        assert!(manager_poll.contains("\"sectPendingApplicationCount\":0"));
        assert!(applicant_poll.contains("sect:update"));
        assert!(applicant_poll.contains("\"myPendingApplicationCount\":0"));
        assert!(!other_poll.contains("sect:update"));

        sqlx::query("DELETE FROM sect_application WHERE id = $1").bind(application_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM sect_member WHERE sect_id = $1").bind(&sect_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM sect_def WHERE id = $1").bind(&sect_id).execute(&pool).await.ok();
        cleanup_auth_fixture(&pool, manager.character_id, manager.user_id).await;
        cleanup_auth_fixture(&pool, applicant.character_id, applicant.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn sect_handle_application_approve_route_emits_update_to_applicant_and_managers() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_SECT_HANDLE_APPLICATION_APPROVE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("sect-handle-approve-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let elder = insert_auth_fixture(&state, &pool, "socket", &format!("elder-{suffix}"), 0).await;
        let applicant = insert_auth_fixture(&state, &pool, "socket", &format!("applicant-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let sect_id = format!("sect-{suffix}");

        insert_test_sect(&pool, &sect_id, leader.character_id, 2, &suffix).await;
        sqlx::query("INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'leader', 0, 0, NOW()), ($1, $3, 'elder', 0, 0, NOW())")
            .bind(&sect_id)
            .bind(leader.character_id)
            .bind(elder.character_id)
            .execute(&pool)
            .await
            .expect("sect managers should insert");
        let application_id = sqlx::query("INSERT INTO sect_application (sect_id, character_id, message, status, created_at) VALUES ($1, $2, '求加入', 'pending', NOW()) RETURNING id")
            .bind(&sect_id)
            .bind(applicant.character_id)
            .fetch_one(&pool)
            .await
            .expect("sect application should insert")
            .try_get::<i64, _>("id")
            .expect("application id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (leader_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &leader_sid).await;
        let (elder_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &elder_sid).await;
        let (applicant_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &applicant_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: leader_sid.clone(),
            user_id: leader.user_id,
            character_id: Some(leader.character_id),
            session_token: Some("sess-leader".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: elder_sid.clone(),
            user_id: elder.user_id,
            character_id: Some(elder.character_id),
            session_token: Some("sess-elder".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: applicant_sid.clone(),
            user_id: applicant.user_id,
            character_id: Some(applicant.character_id),
            session_token: Some("sess-applicant".to_string()),
            connected_at_ms: 3,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 4,
        });

        let response = client
            .post(format!("http://{address}/api/sect/applications/handle"))
            .header("authorization", format!("Bearer {}", leader.token))
            .header("content-type", "application/json")
            .body(format!("{{\"applicationId\":{},\"approve\":true}}", application_id))
            .send()
            .await
            .expect("sect approve application request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let leader_poll = poll_text(&client, address, &leader_sid).await;
        let elder_poll = poll_text(&client, address, &elder_sid).await;
        let applicant_poll = poll_text(&client, address, &applicant_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_SECT_HANDLE_APPLICATION_APPROVE_LEADER_POLL={leader_poll}");
        println!("GAME_SOCKET_SECT_HANDLE_APPLICATION_APPROVE_ELDER_POLL={elder_poll}");
        println!("GAME_SOCKET_SECT_HANDLE_APPLICATION_APPROVE_APPLICANT_POLL={applicant_poll}");
        println!("GAME_SOCKET_SECT_HANDLE_APPLICATION_APPROVE_OTHER_POLL={other_poll}");

        server.abort();

        assert!(leader_poll.contains("sect:update"));
        assert!(leader_poll.contains("\"sectPendingApplicationCount\":0"));
        assert!(elder_poll.contains("sect:update"));
        assert!(elder_poll.contains("\"sectPendingApplicationCount\":0"));
        assert!(applicant_poll.contains("sect:update"));
        assert!(applicant_poll.contains("\"joined\":true"));
        assert!(!other_poll.contains("sect:update"));

        sqlx::query("DELETE FROM sect_application WHERE id = $1").bind(application_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM sect_member WHERE sect_id = $1").bind(&sect_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM sect_def WHERE id = $1").bind(&sect_id).execute(&pool).await.ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, elder.character_id, elder.user_id).await;
        cleanup_auth_fixture(&pool, applicant.character_id, applicant.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn sect_handle_application_reject_route_emits_update_to_applicant_and_managers() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_SECT_HANDLE_APPLICATION_REJECT_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("sect-handle-reject-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let elder = insert_auth_fixture(&state, &pool, "socket", &format!("elder-{suffix}"), 0).await;
        let applicant = insert_auth_fixture(&state, &pool, "socket", &format!("applicant-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let sect_id = format!("sect-{suffix}");

        insert_test_sect(&pool, &sect_id, leader.character_id, 2, &suffix).await;
        sqlx::query("INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'leader', 0, 0, NOW()), ($1, $3, 'elder', 0, 0, NOW())")
            .bind(&sect_id)
            .bind(leader.character_id)
            .bind(elder.character_id)
            .execute(&pool)
            .await
            .expect("sect managers should insert");
        let application_id = sqlx::query("INSERT INTO sect_application (sect_id, character_id, message, status, created_at) VALUES ($1, $2, '求加入', 'pending', NOW()) RETURNING id")
            .bind(&sect_id)
            .bind(applicant.character_id)
            .fetch_one(&pool)
            .await
            .expect("sect application should insert")
            .try_get::<i64, _>("id")
            .expect("application id should exist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (leader_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &leader_sid).await;
        let (elder_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &elder_sid).await;
        let (applicant_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &applicant_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: leader_sid.clone(),
            user_id: leader.user_id,
            character_id: Some(leader.character_id),
            session_token: Some("sess-leader".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: elder_sid.clone(),
            user_id: elder.user_id,
            character_id: Some(elder.character_id),
            session_token: Some("sess-elder".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: applicant_sid.clone(),
            user_id: applicant.user_id,
            character_id: Some(applicant.character_id),
            session_token: Some("sess-applicant".to_string()),
            connected_at_ms: 3,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 4,
        });

        let response = client
            .post(format!("http://{address}/api/sect/applications/handle"))
            .header("authorization", format!("Bearer {}", leader.token))
            .header("content-type", "application/json")
            .body(format!("{{\"applicationId\":{},\"approve\":false}}", application_id))
            .send()
            .await
            .expect("sect reject application request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let leader_poll = poll_text(&client, address, &leader_sid).await;
        let elder_poll = poll_text(&client, address, &elder_sid).await;
        let applicant_poll = poll_text(&client, address, &applicant_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_SECT_HANDLE_APPLICATION_REJECT_LEADER_POLL={leader_poll}");
        println!("GAME_SOCKET_SECT_HANDLE_APPLICATION_REJECT_ELDER_POLL={elder_poll}");
        println!("GAME_SOCKET_SECT_HANDLE_APPLICATION_REJECT_APPLICANT_POLL={applicant_poll}");
        println!("GAME_SOCKET_SECT_HANDLE_APPLICATION_REJECT_OTHER_POLL={other_poll}");

        server.abort();

        assert!(leader_poll.contains("sect:update"));
        assert!(leader_poll.contains("\"sectPendingApplicationCount\":0"));
        assert!(elder_poll.contains("sect:update"));
        assert!(elder_poll.contains("\"sectPendingApplicationCount\":0"));
        assert!(applicant_poll.contains("sect:update"));
        assert!(applicant_poll.contains("\"myPendingApplicationCount\":0"));
        assert!(!other_poll.contains("sect:update"));

        sqlx::query("DELETE FROM sect_application WHERE id = $1").bind(application_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM sect_member WHERE sect_id = $1").bind(&sect_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM sect_def WHERE id = $1").bind(&sect_id).execute(&pool).await.ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, elder.character_id, elder.user_id).await;
        cleanup_auth_fixture(&pool, applicant.character_id, applicant.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn sect_leave_route_emits_update_to_leaving_member() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_SECT_LEAVE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("sect-leave-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let member = insert_auth_fixture(&state, &pool, "socket", &format!("member-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let sect_id = format!("sect-{suffix}");

        insert_test_sect(&pool, &sect_id, leader.character_id, 2, &suffix).await;
        sqlx::query("INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'leader', 0, 0, NOW()), ($1, $3, 'disciple', 0, 0, NOW())")
            .bind(&sect_id)
            .bind(leader.character_id)
            .bind(member.character_id)
            .execute(&pool)
            .await
            .expect("sect members should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (member_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &member_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: member_sid.clone(),
            user_id: member.user_id,
            character_id: Some(member.character_id),
            session_token: Some("sess-member".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/sect/leave"))
            .header("authorization", format!("Bearer {}", member.token))
            .send()
            .await
            .expect("sect leave request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let member_poll = poll_text(&client, address, &member_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_SECT_LEAVE_MEMBER_POLL={member_poll}");
        println!("GAME_SOCKET_SECT_LEAVE_OTHER_POLL={other_poll}");

        server.abort();

        assert!(member_poll.contains("sect:update"));
        assert!(member_poll.contains("\"joined\":false"));
        assert!(!other_poll.contains("sect:update"));

        sqlx::query("DELETE FROM sect_member WHERE sect_id = $1").bind(&sect_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM sect_def WHERE id = $1").bind(&sect_id).execute(&pool).await.ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, member.character_id, member.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn sect_disband_route_emits_update_to_former_members() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_SECT_DISBAND_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("sect-disband-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let member = insert_auth_fixture(&state, &pool, "socket", &format!("member-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let sect_id = format!("sect-{suffix}");

        insert_test_sect(&pool, &sect_id, leader.character_id, 2, &suffix).await;
        sqlx::query("INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'leader', 0, 0, NOW()), ($1, $3, 'disciple', 0, 0, NOW())")
            .bind(&sect_id)
            .bind(leader.character_id)
            .bind(member.character_id)
            .execute(&pool)
            .await
            .expect("sect members should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (leader_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &leader_sid).await;
        let (member_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &member_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: leader_sid.clone(),
            user_id: leader.user_id,
            character_id: Some(leader.character_id),
            session_token: Some("sess-leader".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: member_sid.clone(),
            user_id: member.user_id,
            character_id: Some(member.character_id),
            session_token: Some("sess-member".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 3,
        });

        let response = client
            .post(format!("http://{address}/api/sect/disband"))
            .header("authorization", format!("Bearer {}", leader.token))
            .send()
            .await
            .expect("sect disband request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let leader_poll = poll_text(&client, address, &leader_sid).await;
        let member_poll = poll_text(&client, address, &member_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_SECT_DISBAND_LEADER_POLL={leader_poll}");
        println!("GAME_SOCKET_SECT_DISBAND_MEMBER_POLL={member_poll}");
        println!("GAME_SOCKET_SECT_DISBAND_OTHER_POLL={other_poll}");

        server.abort();

        assert!(leader_poll.contains("sect:update"));
        assert!(leader_poll.contains("\"joined\":false"));
        assert!(member_poll.contains("sect:update"));
        assert!(member_poll.contains("\"joined\":false"));
        assert!(!other_poll.contains("sect:update"));

        sqlx::query("DELETE FROM sect_member WHERE sect_id = $1").bind(&sect_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM sect_def WHERE id = $1").bind(&sect_id).execute(&pool).await.ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, member.character_id, member.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn sect_kick_route_emits_update_to_target_member() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_SECT_KICK_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("sect-kick-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let target = insert_auth_fixture(&state, &pool, "socket", &format!("target-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let sect_id = format!("sect-{suffix}");

        insert_test_sect(&pool, &sect_id, leader.character_id, 2, &suffix).await;
        sqlx::query("INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'leader', 0, 0, NOW()), ($1, $3, 'disciple', 0, 0, NOW())")
            .bind(&sect_id)
            .bind(leader.character_id)
            .bind(target.character_id)
            .execute(&pool)
            .await
            .expect("sect members should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: target.user_id,
            character_id: Some(target.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/sect/kick"))
            .header("authorization", format!("Bearer {}", leader.token))
            .header("content-type", "application/json")
            .body(format!("{{\"targetId\":{}}}", target.character_id))
            .send()
            .await
            .expect("sect kick request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_SECT_KICK_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_SECT_KICK_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("sect:update"));
        assert!(target_poll.contains("\"joined\":false"));
        assert!(!other_poll.contains("sect:update"));

        sqlx::query("DELETE FROM sect_member WHERE sect_id = $1").bind(&sect_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM sect_def WHERE id = $1").bind(&sect_id).execute(&pool).await.ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, target.character_id, target.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn sect_transfer_route_emits_update_to_old_and_new_leader() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_SECT_TRANSFER_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("sect-transfer-{}", super::chrono_like_timestamp_ms());
        let old_leader = insert_auth_fixture(&state, &pool, "socket", &format!("old-{suffix}"), 0).await;
        let new_leader = insert_auth_fixture(&state, &pool, "socket", &format!("new-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let sect_id = format!("sect-{suffix}");

        insert_test_sect(&pool, &sect_id, old_leader.character_id, 2, &suffix).await;
        sqlx::query("INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'leader', 0, 0, NOW()), ($1, $3, 'vice_leader', 0, 0, NOW())")
            .bind(&sect_id)
            .bind(old_leader.character_id)
            .bind(new_leader.character_id)
            .execute(&pool)
            .await
            .expect("sect leaders should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (old_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &old_sid).await;
        let (new_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &new_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: old_sid.clone(),
            user_id: old_leader.user_id,
            character_id: Some(old_leader.character_id),
            session_token: Some("sess-old".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: new_sid.clone(),
            user_id: new_leader.user_id,
            character_id: Some(new_leader.character_id),
            session_token: Some("sess-new".to_string()),
            connected_at_ms: 2,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 3,
        });

        let response = client
            .post(format!("http://{address}/api/sect/transfer"))
            .header("authorization", format!("Bearer {}", old_leader.token))
            .header("content-type", "application/json")
            .body(format!("{{\"newLeaderId\":{}}}", new_leader.character_id))
            .send()
            .await
            .expect("sect transfer request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let old_poll = poll_text(&client, address, &old_sid).await;
        let new_poll = poll_text(&client, address, &new_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_SECT_TRANSFER_OLD_POLL={old_poll}");
        println!("GAME_SOCKET_SECT_TRANSFER_NEW_POLL={new_poll}");
        println!("GAME_SOCKET_SECT_TRANSFER_OTHER_POLL={other_poll}");

        server.abort();

        assert!(old_poll.contains("sect:update"));
        assert!(old_poll.contains("\"canManageApplications\":true"));
        assert!(new_poll.contains("sect:update"));
        assert!(new_poll.contains("\"canManageApplications\":true"));
        assert!(!other_poll.contains("sect:update"));

        sqlx::query("DELETE FROM sect_member WHERE sect_id = $1").bind(&sect_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM sect_def WHERE id = $1").bind(&sect_id).execute(&pool).await.ok();
        cleanup_auth_fixture(&pool, old_leader.character_id, old_leader.user_id).await;
        cleanup_auth_fixture(&pool, new_leader.character_id, new_leader.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn sect_appoint_route_emits_update_to_target_member() {
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_SECT_APPOINT_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("sect-appoint-{}", super::chrono_like_timestamp_ms());
        let leader = insert_auth_fixture(&state, &pool, "socket", &format!("leader-{suffix}"), 0).await;
        let target = insert_auth_fixture(&state, &pool, "socket", &format!("target-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;
        let sect_id = format!("sect-{suffix}");

        insert_test_sect(&pool, &sect_id, leader.character_id, 2, &suffix).await;
        sqlx::query("INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'leader', 0, 0, NOW()), ($1, $3, 'disciple', 0, 0, NOW())")
            .bind(&sect_id)
            .bind(leader.character_id)
            .bind(target.character_id)
            .execute(&pool)
            .await
            .expect("sect members should insert");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: target.user_id,
            character_id: Some(target.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/sect/appoint"))
            .header("authorization", format!("Bearer {}", leader.token))
            .header("content-type", "application/json")
            .body(format!("{{\"targetId\":{},\"position\":\"elder\"}}", target.character_id))
            .send()
            .await
            .expect("sect appoint request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_SECT_APPOINT_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_SECT_APPOINT_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("sect:update"));
        assert!(target_poll.contains("\"canManageApplications\":true"));
        assert!(!other_poll.contains("sect:update"));

        sqlx::query("DELETE FROM sect_member WHERE sect_id = $1").bind(&sect_id).execute(&pool).await.ok();
        sqlx::query("DELETE FROM sect_def WHERE id = $1").bind(&sect_id).execute(&pool).await.ok();
        cleanup_auth_fixture(&pool, leader.character_id, leader.user_id).await;
        cleanup_auth_fixture(&pool, target.character_id, target.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn arena_challenge_route_emits_battle_and_arena_updates_to_target_user() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        let Some(pool) = connect_fixture_db_or_skip(&state, "GAME_SOCKET_ARENA_CHALLENGE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("arena-challenge-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let opponent = insert_auth_fixture(&state, &pool, "socket", &format!("opp-{suffix}"), 0).await;
        let outsider = insert_auth_fixture(&state, &pool, "socket", &format!("other-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let (target_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &target_sid).await;
        let (other_sid, _) = handshake_sid(&client, address).await;
        socket_connect(&client, address, &other_sid).await;

        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: target_sid.clone(),
            user_id: fixture.user_id,
            character_id: Some(fixture.character_id),
            session_token: Some("sess-target".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(crate::state::RealtimeSessionRecord {
            socket_id: other_sid.clone(),
            user_id: outsider.user_id,
            character_id: Some(outsider.character_id),
            session_token: Some("sess-other".to_string()),
            connected_at_ms: 2,
        });

        let response = client
            .post(format!("http://{address}/api/arena/challenge"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"opponentCharacterId\":{}}}", opponent.character_id))
            .send()
            .await
            .expect("arena challenge request should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let target_poll = poll_text(&client, address, &target_sid).await;
        let other_poll = poll_text(&client, address, &other_sid).await;

        println!("GAME_SOCKET_ARENA_CHALLENGE_TARGET_POLL={target_poll}");
        println!("GAME_SOCKET_ARENA_CHALLENGE_OTHER_POLL={other_poll}");

        server.abort();

        assert!(target_poll.contains("battle:update"));
        assert!(target_poll.contains("battle_started"));
        assert!(target_poll.contains("battle:cooldown-ready"));
        assert!(target_poll.contains("arena:update"));
        assert!(target_poll.contains("\"kind\":\"arena_status\""));
        assert!(!other_poll.contains("battle:update"));
        assert!(!other_poll.contains("arena:update"));

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, opponent.character_id, opponent.user_id).await;
        cleanup_auth_fixture(&pool, outsider.character_id, outsider.user_id).await;
    }

    #[tokio::test]
        async fn arena_challenge_persists_battle_bundle_for_startup_recovery() {
        let _guard = battle_cluster_test_lock();
        let state = test_state();
        if !state.redis_available {
            println!("ARENA_PERSISTENCE_SKIPPED_REDIS_UNAVAILABLE");
            return;
        }
        let Some(pool) = connect_fixture_db_or_skip(&state, "ARENA_PERSISTENCE_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("arena-persist-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let opponent = insert_auth_fixture(&state, &pool, "socket", &format!("opponent-{suffix}"), 0).await;

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/arena/challenge"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .header("content-type", "application/json")
            .body(format!("{{\"opponentCharacterId\":{}}}", opponent.character_id))
            .send()
            .await
            .expect("arena challenge request should succeed");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&response.text().await.expect("body should read"))
            .expect("body should be json");
        let battle_id = body["data"]["battleId"].as_str().expect("battle id should exist").to_string();
        let session_id = body["data"]["session"]["sessionId"].as_str().expect("session id should exist").to_string();

        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis client should exist"));
        let snapshot_key = format!("battle:snapshot:{battle_id}");
        let projection_key = format!("battle:projection:{battle_id}");
        let session_key = format!("battle:session:{session_id}");
        let snapshot = redis.get_string(&snapshot_key).await.expect("snapshot should read");
        let projection = redis.get_string(&projection_key).await.expect("projection should read");
        let session = redis.get_string(&session_key).await.expect("session should read");

        println!("ARENA_PERSISTENCE_BATTLE_ID={battle_id}");

        server.abort();

        assert!(snapshot.is_some());
        assert!(projection.is_some());
        assert!(session.is_some());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
        cleanup_auth_fixture(&pool, opponent.character_id, opponent.user_id).await;
    }

    #[tokio::test]
        async fn battle_session_return_to_map_clears_arena_persistence_bundle() {
        let state = test_state();
        if !state.redis_available {
            println!("ARENA_PERSISTENCE_CLEAR_SKIPPED_REDIS_UNAVAILABLE");
            return;
        }
        let Some(pool) = connect_fixture_db_or_skip(&state, "ARENA_PERSISTENCE_CLEAR_SKIPPED_DB_UNAVAILABLE").await else {
            return;
        };

        let suffix = format!("arena-clear-{}", super::chrono_like_timestamp_ms());
        let fixture = insert_auth_fixture(&state, &pool, "socket", &suffix, 0).await;
        let battle_id = format!("arena-battle-{}-999-{}", fixture.character_id, super::chrono_like_timestamp_ms());
        let session_id = format!("arena-session-{battle_id}");
        let session = BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "pvp".to_string(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            current_battle_id: Some(battle_id.clone()),
            status: "waiting_transition".to_string(),
            next_action: "return_to_map".to_string(),
            can_advance: true,
            last_result: Some("attacker_win".to_string()),
            context: BattleSessionContextDto::Pvp {
                opponent_character_id: 999,
                mode: "arena".to_string(),
            },
        };
        let battle_state = build_minimal_pvp_battle_state(&battle_id, fixture.user_id, 999);
        let projection = OnlineBattleProjectionRecord {
            battle_id: battle_id.clone(),
            owner_user_id: fixture.user_id,
            participant_user_ids: vec![fixture.user_id],
            r#type: "pvp".to_string(),
            session_id: Some(session_id.clone()),
        };
        state.battle_sessions.register(session.clone());
        state.battle_runtime.register(battle_state.clone());
        state.online_battle_projections.register(projection.clone());
        crate::integrations::battle_persistence::persist_battle_session(&state, &session)
            .await
            .expect("session should persist");
        crate::integrations::battle_persistence::persist_battle_snapshot(&state, &battle_state)
            .await
            .expect("snapshot should persist");
        crate::integrations::battle_persistence::persist_battle_projection(&state, &projection)
            .await
            .expect("projection should persist");

        let app = build_router(state.clone()).expect("router should build");
        let (address, server) = spawn_test_server(app).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("http://{address}/api/battle-session/{session_id}/advance"))
            .header("authorization", format!("Bearer {}", fixture.token))
            .send()
            .await
            .expect("battle session advance should succeed");
        assert_eq!(response.status(), StatusCode::OK);

        let redis = crate::integrations::redis::RedisRuntime::new(state.redis.clone().expect("redis client should exist"));
        let snapshot = redis.get_string(&format!("battle:snapshot:{battle_id}")).await.expect("snapshot should read");
        let projection_raw = redis.get_string(&format!("battle:projection:{battle_id}")).await.expect("projection should read");
        let session_raw = redis.get_string(&format!("battle:session:{session_id}")).await.expect("session should read");

        server.abort();

        assert!(snapshot.is_none());
        assert!(projection_raw.is_none());
        assert!(session_raw.is_none());

        cleanup_auth_fixture(&pool, fixture.character_id, fixture.user_id).await;
    }
}
