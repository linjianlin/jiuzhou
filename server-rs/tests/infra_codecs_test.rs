use jiuzhou_server_rs::infra::redis::codecs::{
    decode_json, encode_json, BattleSessionProjectionCodec, BattleStateCodec, BattleStaticCodec,
};

#[test]
fn redis_codecs_roundtrip_expected_fields() {
    let battle_state = BattleStateCodec {
        round_count: 3,
        current_team: "attacker".to_string(),
        phase: "running".to_string(),
        random_index: 17,
        log_cursor: 99,
    };
    let battle_state_json = encode_json(&battle_state).expect("encode battle state");
    let decoded_battle_state: BattleStateCodec =
        decode_json(&battle_state_json).expect("decode battle state");
    assert_eq!(battle_state, decoded_battle_state);

    let battle_static = BattleStaticCodec {
        battle_id: "battle-1".to_string(),
        battle_type: "pve".to_string(),
        cooldown_timing_mode: "tick".to_string(),
        first_mover: "attacker".to_string(),
        random_seed: "seed-1".to_string(),
    };
    let battle_static_json = encode_json(&battle_static).expect("encode battle static");
    let decoded_battle_static: BattleStaticCodec =
        decode_json(&battle_static_json).expect("decode battle static");
    assert_eq!(battle_static, decoded_battle_static);

    let session = BattleSessionProjectionCodec {
        session_id: "session-1".to_string(),
        session_type: "pve".to_string(),
        owner_user_id: 1,
        current_battle_id: Some("battle-1".to_string()),
        status: "running".to_string(),
        next_action: "none".to_string(),
        updated_at: 1_234,
    };
    let session_json = encode_json(&session).expect("encode session");
    let decoded_session: BattleSessionProjectionCodec =
        decode_json(&session_json).expect("decode session");
    assert_eq!(session, decoded_session);

    let idle_lock_token = "idle-start:550e8400-e29b-41d4-a716-446655440000";
    assert!(idle_lock_token.starts_with("idle-start:"));
}
