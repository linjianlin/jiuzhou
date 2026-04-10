use std::collections::HashMap;

use jiuzhou_server_rs::infra::config::settings::Settings;

#[test]
fn settings_default_to_current_server_shape() {
    let settings = Settings::from_map(HashMap::new()).expect("settings");
    assert_eq!(settings.server.port, 6011);
    assert_eq!(settings.server.cors_origin, "http://localhost:6010");
    assert_eq!(settings.redis.url, "redis://localhost:6379");
    assert_eq!(settings.auth.jwt_expires_in, "7d");
}

#[test]
fn settings_allow_targeted_overrides() {
    let settings = Settings::from_map(HashMap::from([
        ("server.port".to_string(), "7011".to_string()),
        ("server.environment".to_string(), "production".to_string()),
        ("logging.json".to_string(), "true".to_string()),
    ]))
    .expect("settings");

    assert_eq!(settings.server.port, 7011);
    assert_eq!(settings.server.environment, "production");
    assert!(settings.logging.json);
}
