use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BattleStateCodec {
    pub round_count: u32,
    pub current_team: String,
    pub phase: String,
    pub random_index: u64,
    pub log_cursor: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BattleStaticCodec {
    pub battle_id: String,
    pub battle_type: String,
    pub cooldown_timing_mode: String,
    pub first_mover: String,
    pub random_seed: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BattleSessionProjectionCodec {
    pub session_id: String,
    pub session_type: String,
    pub owner_user_id: i64,
    pub current_battle_id: Option<String>,
    pub status: String,
    pub next_action: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OnlineCharacterProjectionCodec {
    pub character_id: i64,
    pub user_id: i64,
    pub team_id: Option<String>,
    pub is_team_leader: bool,
}

pub fn encode_json<T>(value: &T) -> Result<String, crate::shared::error::AppError>
where
    T: Serialize,
{
    serde_json::to_string(value).map_err(Into::into)
}

pub fn decode_json<T>(raw: &str) -> Result<T, crate::shared::error::AppError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_str(raw).map_err(Into::into)
}
