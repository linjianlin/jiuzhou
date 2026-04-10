/**
 * 战斗恢复 Redis 持久化契约。
 *
 * 作用：
 * 1. 做什么：集中声明 battle / pve-resume / character runtime resource 的 Redis key 命名与 JSON 读取结构。
 * 2. 做什么：把 Node 现网 Redis 顶层字段显式映射为 Rust 强类型，供恢复阶段直接反序列化。
 * 3. 不做什么：不执行战斗恢复、不推进 battle engine，也不重新设计 Redis 结构。
 *
 * 输入 / 输出：
 * - 输入：Redis key 字符串、battle/pve-resume/resource JSON 文本。
 * - 输出：可供 recovery loader 直接消费的 key codec 与 typed payload。
 *
 * 数据流 / 状态流：
 * - Redis battle/pve-resume/resource -> 本模块解码 -> recovery loader 归组 -> 后续启动阶段按顺序接入。
 *
 * 复用设计说明：
 * - battle、battle-session 恢复和运行时资源恢复都依赖同一组 key/payload 契约，把命名和字段集中到这里可避免多个 recovery 入口各写一套前缀与字段名。
 * - `odwnerId` 等历史拼写兼容点属于高频踩坑项，集中在 codec 层处理能避免后续业务层重复记忆兼容细节。
 *
 * 关键边界条件与坑点：
 * 1. `battle:state:*` 会同时命中 `battle:state:static:*`，调用方必须显式过滤静态前缀。
 * 2. idle lock 之外的 battle/runtime 数据当前都是 JSON；不能把字符串资源键误当成 battle payload 去解码。
 */
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BattleRedisKey(String);

impl BattleRedisKey {
    const STATE_PREFIX: &'static str = "battle:state:";
    const STATIC_PREFIX: &'static str = "battle:state:static:";
    const PARTICIPANTS_PREFIX: &'static str = "battle:participants:";
    const PVE_RESUME_PREFIX: &'static str = "battle:session:pve-resume:";
    const CHARACTER_RESOURCE_PREFIX: &'static str = "character:runtime:resource:v1:";

    pub fn state(battle_id: impl AsRef<str>) -> Self {
        Self(format!(
            "{}{battle_id}",
            Self::STATE_PREFIX,
            battle_id = battle_id.as_ref()
        ))
    }

    pub fn static_state(battle_id: impl AsRef<str>) -> Self {
        Self(format!(
            "{}{battle_id}",
            Self::STATIC_PREFIX,
            battle_id = battle_id.as_ref()
        ))
    }

    pub fn participants(battle_id: impl AsRef<str>) -> Self {
        Self(format!(
            "{}{battle_id}",
            Self::PARTICIPANTS_PREFIX,
            battle_id = battle_id.as_ref()
        ))
    }

    pub fn pve_resume_intent(owner_user_id: i64) -> Self {
        Self(format!("{}{owner_user_id}", Self::PVE_RESUME_PREFIX))
    }

    pub fn character_runtime_resource(character_id: i64) -> Self {
        Self(format!("{}{character_id}", Self::CHARACTER_RESOURCE_PREFIX))
    }

    pub fn parse(raw: &str) -> Option<Self> {
        if raw.starts_with(Self::STATIC_PREFIX)
            || raw.starts_with(Self::STATE_PREFIX)
            || raw.starts_with(Self::PARTICIPANTS_PREFIX)
            || raw.starts_with(Self::PVE_RESUME_PREFIX)
            || raw.starts_with(Self::CHARACTER_RESOURCE_PREFIX)
        {
            return Some(Self(raw.to_string()));
        }
        None
    }

    pub fn as_ref(&self) -> &str {
        self.0.as_str()
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl AsRef<str> for BattleRedisKey {
    fn as_ref(&self) -> &str {
        self.as_ref()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleDynamicStateRedis {
    pub round_count: u32,
    pub current_team: String,
    pub current_unit_id: Option<String>,
    pub phase: String,
    pub result: Option<Value>,
    pub rewards: Option<Value>,
    pub random_index: u64,
    pub log_cursor: u64,
    pub teams: BattleDynamicTeamsRedis,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BattleDynamicTeamsRedis {
    pub attacker: BattleDynamicTeamRedis,
    pub defender: BattleDynamicTeamRedis,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleDynamicTeamRedis {
    pub total_speed: i64,
    pub units: Vec<BattleDynamicUnitRedis>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleDynamicUnitRedis {
    pub current_attrs: Value,
    pub qixue: i64,
    pub lingqi: i64,
    pub shields: Vec<Value>,
    pub buffs: Vec<Value>,
    pub marks: Vec<Value>,
    pub momentum: i64,
    pub skill_cooldowns: Value,
    pub skill_cooldown_discount_bank: Value,
    pub triggered_phase_ids: Vec<Value>,
    pub control_diminishing: Value,
    pub is_alive: bool,
    pub can_act: bool,
    pub stats: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleStaticStateRedis {
    pub battle_id: String,
    pub battle_type: String,
    pub cooldown_timing_mode: String,
    pub first_mover: String,
    pub random_seed: String,
    pub teams: BattleStaticTeamsRedis,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BattleStaticTeamsRedis {
    pub attacker: BattleStaticTeamRedis,
    pub defender: BattleStaticTeamRedis,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BattleStaticTeamRedis {
    #[serde(rename = "odwnerId")]
    pub odwner_id: Option<i64>,
    pub units: Vec<BattleStaticUnitRedis>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleStaticUnitRedis {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub unit_type: String,
    pub source_id: Value,
    pub formation_order: i64,
    pub owner_unit_id: Option<Value>,
    pub base_attrs: Value,
    pub skills: Vec<Value>,
    pub set_bonus_effects: Vec<Value>,
    pub ai_profile: Option<Value>,
    pub partner_skill_policy: Option<Value>,
    pub is_summon: bool,
    pub summoner_id: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PveResumeIntentRedis {
    pub owner_user_id: i64,
    pub session_id: String,
    pub monster_ids: Vec<String>,
    pub participant_user_ids: Vec<i64>,
    pub battle_id: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CharacterRuntimeResourceRedis {
    pub qixue: i64,
    pub lingqi: i64,
}
