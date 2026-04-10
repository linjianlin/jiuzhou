use serde::{Deserialize, Serialize};

pub const GAME_SOCKET_PATH: &str = "/game-socket";
pub const GAME_AUTH_EVENT: &str = "game:auth";
pub const GAME_ERROR_EVENT: &str = "game:error";
pub const GAME_KICKED_EVENT: &str = "game:kicked";
pub const GAME_AUTH_READY_EVENT: &str = "game:auth-ready";
pub const GAME_CHARACTER_EVENT: &str = "game:character";
pub const GAME_ONLINE_PLAYERS_REQUEST_EVENT: &str = "game:onlinePlayers:request";
pub const GAME_ONLINE_PLAYERS_EVENT: &str = "game:onlinePlayers";
pub const BATTLE_SYNC_EVENT: &str = "battle:sync";
pub const BATTLE_UPDATE_EVENT: &str = "battle:update";
pub const BATTLE_COOLDOWN_SYNC_EVENT: &str = "battle:cooldown-sync";
pub const BATTLE_COOLDOWN_READY_EVENT: &str = "battle:cooldown-ready";
pub const IDLE_UPDATE_EVENT: &str = "idle:update";
pub const IDLE_FINISHED_EVENT: &str = "idle:finished";
pub const CHAT_MESSAGE_EVENT: &str = "chat:message";
pub const CHAT_ERROR_EVENT: &str = "chat:error";
pub const CHAT_SEND_EVENT: &str = "chat:send";
pub const TEAM_UPDATE_EVENT: &str = "team:update";
pub const SECT_UPDATE_EVENT: &str = "sect:update";
pub const TASK_UPDATE_EVENT: &str = "task:update";
pub const MAIL_UPDATE_EVENT: &str = "mail:update";
pub const ACHIEVEMENT_UPDATE_EVENT: &str = "achievement:update";
pub const TECHNIQUE_RESEARCH_UPDATE_EVENT: &str = "techniqueResearch:update";
pub const TECHNIQUE_RESEARCH_RESULT_EVENT: &str = "techniqueResearchResult";
pub const PARTNER_RECRUIT_UPDATE_EVENT: &str = "partnerRecruit:update";
pub const PARTNER_RECRUIT_RESULT_EVENT: &str = "partnerRecruitResult";
pub const PARTNER_FUSION_UPDATE_EVENT: &str = "partnerFusion:update";
pub const PARTNER_FUSION_RESULT_EVENT: &str = "partnerFusionResult";
pub const PARTNER_REBONE_UPDATE_EVENT: &str = "partnerRebone:update";
pub const PARTNER_REBONE_RESULT_EVENT: &str = "partnerReboneResult";

pub const CHAT_AUTHED_ROOM: &str = "chat:authed";

pub fn user_room(user_id: i64) -> String {
    format!("chat:user:{user_id}")
}

pub fn character_room(character_id: i64) -> String {
    format!("chat:character:{character_id}")
}

pub fn team_room(team_id: &str) -> String {
    format!("chat:team:{team_id}")
}

pub fn sect_room(sect_id: &str) -> String {
    format!("chat:sect:{sect_id}")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OnlinePlayerDto {
    pub id: i64,
    pub nickname: String,
    #[serde(rename = "monthCardActive")]
    pub month_card_active: bool,
    pub title: String,
    pub realm: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum OnlinePlayersPayload {
    #[serde(rename = "full")]
    Full {
        total: usize,
        players: Vec<OnlinePlayerDto>,
    },
    #[serde(rename = "delta")]
    Delta {
        total: usize,
        joined: Vec<OnlinePlayerDto>,
        left: Vec<i64>,
        updated: Vec<OnlinePlayerDto>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdleItemGainDto {
    #[serde(rename = "itemDefId")]
    pub item_def_id: String,
    #[serde(rename = "itemName")]
    pub item_name: String,
    pub quantity: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdleUpdatePayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "batchIndex")]
    pub batch_index: i64,
    pub result: String,
    #[serde(rename = "expGained")]
    pub exp_gained: i64,
    #[serde(rename = "silverGained")]
    pub silver_gained: i64,
    #[serde(rename = "itemsGained")]
    pub items_gained: Vec<IdleItemGainDto>,
    #[serde(rename = "roundCount")]
    pub round_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdleFinishedPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub reason: String,
}
