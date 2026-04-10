use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::Serialize;
use serde_json::Value;
use sqlx::Row;

use crate::application::static_data::catalog::{
    get_static_data_catalog, SkillDefDto, StaticDataCatalog, TechniqueDetailDto, TechniqueLayerDto,
};
use crate::edge::http::error::BusinessError;

const CHARACTER_TECHNIQUE_READ_SUCCESS_MESSAGE: &str = "获取成功";
const CHARACTER_TECHNIQUE_NOT_LEARNED_MESSAGE: &str = "未学习该功法";
const CHARACTER_TECHNIQUE_NOT_FOUND_MESSAGE: &str = "功法不存在";
const CHARACTER_TECHNIQUE_LAYER_CONFIG_MISSING_MESSAGE: &str = "层级配置不存在";
const CHARACTER_TECHNIQUE_MAX_LAYER_MESSAGE: &str = "已达最高层数";
const PLACEHOLDER_POSTGRES_URL: &str = "postgres://postgres:postgres@127.0.0.1/jiuzhou";

/**
 * 角色功法只读聚合服务。
 *
 * 作用：
 * 1. 做什么：集中实现 `/api/character/:characterId/*` 下功法与技能栏的高频只读查询，覆盖功法状态、已学功法、已装备功法、升级消耗、可用技能、已装备技能与功法被动加成。
 * 2. 做什么：把静态功法目录、技能定义、材料元信息与数据库读表拼装收敛到单一服务，避免路由层重复查表、重复排序、重复做技能解锁计算。
 * 3. 不做什么：不处理功法升级、装配、散功、研修生成等写操作，也不在这里追加 battle/idle/socket 副作用。
 *
 * 输入 / 输出：
 * - 输入：`characterId`，以及升级消耗查询额外接收的 `techniqueId`。
 * - 输出：Node 兼容的只读 DTO，字段命名保持现有前端消费协议，包括 snake_case 的功法/技能槽字段与 camelCase 的状态聚合字段。
 *
 * 数据流 / 状态流：
 * - HTTP 路由 -> 本服务
 * - -> PostgreSQL `character_technique / character_skill_slot`
 * - -> `StaticDataCatalog` 的功法详情/技能定义/物品元信息索引
 * - -> 在服务内一次性完成排序、技能解锁集、被动累计和状态聚合后返回路由层。
 *
 * 复用设计说明：
 * - 功法列表、装备状态、可用技能、升级消耗都依赖同一份 `character_technique` 和静态目录；集中在这里后，排序规则、品质倍率、技能解锁口径与被动累计只维护一份。
 * - `getCharacterTechniqueStatus` 直接复用同一份快照派生 `equippedMain/equippedSubs/equippedSkills/availableSkills/passives`，避免像 Node 那样在多个接口之间重复查表、重复扫层级。
 *
 * 关键边界条件与坑点：
 * 1. 只有角色可见功法才允许进入返回结果；静态目录中被禁用或 `usage_scope=partner_only` 的功法必须直接过滤掉，不能透传数据库脏数据。
 * 2. `getCharacterTechniqueStatus` 中的 `equippedSkills` 必须只保留当前仍可用的技能槽，否则前端会拿到已失效的旧技能配置。
 */
#[derive(Clone)]
pub struct RustCharacterTechniqueReadService {
    pool: sqlx::PgPool,
}

impl Default for RustCharacterTechniqueReadService {
    fn default() -> Self {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy(PLACEHOLDER_POSTGRES_URL)
            .expect("build placeholder postgres pool for character technique service");
        Self::new(pool)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CharacterTechniqueView {
    pub id: i64,
    pub character_id: i64,
    pub technique_id: String,
    pub current_layer: i32,
    pub slot_type: Option<String>,
    pub slot_index: Option<i32>,
    pub acquired_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub technique_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub technique_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub technique_quality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_layer: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribute_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribute_element: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CharacterSkillSlotView {
    pub slot_index: i32,
    pub skill_id: String,
    pub skill_name: String,
    pub skill_icon: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TechniqueUpgradeCostMaterialView {
    #[serde(rename = "itemId")]
    pub item_id: String,
    pub qty: i32,
    #[serde(rename = "itemName", skip_serializing_if = "Option::is_none")]
    pub item_name: Option<String>,
    #[serde(rename = "itemIcon", skip_serializing_if = "Option::is_none")]
    pub item_icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CharacterTechniqueEquippedView {
    pub main: Option<CharacterTechniqueView>,
    pub subs: Vec<CharacterTechniqueView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TechniqueUpgradeCostView {
    #[serde(rename = "currentLayer")]
    pub current_layer: i32,
    #[serde(rename = "maxLayer")]
    pub max_layer: i32,
    pub spirit_stones: i32,
    pub exp: i32,
    pub materials: Vec<TechniqueUpgradeCostMaterialView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AvailableSkillView {
    #[serde(rename = "skillId")]
    pub skill_id: String,
    #[serde(rename = "skillName")]
    pub skill_name: String,
    #[serde(rename = "skillIcon")]
    pub skill_icon: String,
    #[serde(rename = "techniqueId")]
    pub technique_id: String,
    #[serde(rename = "techniqueName")]
    pub technique_name: String,
    pub description: Option<String>,
    #[serde(rename = "costLingqi")]
    pub cost_lingqi: i32,
    #[serde(rename = "costLingqiRate")]
    pub cost_lingqi_rate: f64,
    #[serde(rename = "costQixue")]
    pub cost_qixue: i32,
    #[serde(rename = "costQixueRate")]
    pub cost_qixue_rate: f64,
    pub cooldown: i32,
    #[serde(rename = "targetType")]
    pub target_type: String,
    #[serde(rename = "targetCount")]
    pub target_count: i32,
    #[serde(rename = "damageType")]
    pub damage_type: Option<String>,
    pub element: String,
    pub effects: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CharacterTechniqueStatusView {
    pub techniques: Vec<CharacterTechniqueView>,
    #[serde(rename = "equippedMain")]
    pub equipped_main: Option<CharacterTechniqueView>,
    #[serde(rename = "equippedSubs")]
    pub equipped_subs: Vec<CharacterTechniqueView>,
    #[serde(rename = "equippedSkills")]
    pub equipped_skills: Vec<CharacterSkillSlotView>,
    #[serde(rename = "availableSkills")]
    pub available_skills: Vec<AvailableSkillView>,
    pub passives: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CharacterTechniqueServiceResult<T> {
    pub success: bool,
    pub message: String,
    pub data: Option<T>,
}

#[derive(Debug, Clone)]
struct EquippedTechniqueSnapshot {
    technique_id: String,
    technique_name: String,
    slot_type: String,
    current_layer: i32,
    detail: TechniqueDetailDto,
}

#[derive(Debug, Clone)]
struct TechniqueStatusSnapshot {
    techniques: Vec<CharacterTechniqueView>,
    equipped: Vec<EquippedTechniqueSnapshot>,
    equipped_skills: Vec<CharacterSkillSlotView>,
}

impl RustCharacterTechniqueReadService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    pub async fn get_character_techniques(
        &self,
        character_id: i64,
    ) -> Result<CharacterTechniqueServiceResult<Vec<CharacterTechniqueView>>, BusinessError> {
        let snapshot = self.load_snapshot(character_id).await?;
        Ok(CharacterTechniqueServiceResult {
            success: true,
            message: CHARACTER_TECHNIQUE_READ_SUCCESS_MESSAGE.to_string(),
            data: Some(snapshot.techniques),
        })
    }

    pub async fn get_equipped_techniques(
        &self,
        character_id: i64,
    ) -> Result<CharacterTechniqueServiceResult<CharacterTechniqueEquippedView>, BusinessError> {
        let snapshot = self.load_snapshot(character_id).await?;
        let mut main = None;
        let mut subs = Vec::new();
        for technique in snapshot.techniques {
            match technique.slot_type.as_deref() {
                Some("main") => main = Some(technique),
                Some("sub") => subs.push(technique),
                _ => {}
            }
        }
        Ok(CharacterTechniqueServiceResult {
            success: true,
            message: CHARACTER_TECHNIQUE_READ_SUCCESS_MESSAGE.to_string(),
            data: Some(CharacterTechniqueEquippedView { main, subs }),
        })
    }

    pub async fn get_technique_upgrade_cost(
        &self,
        character_id: i64,
        technique_id: &str,
    ) -> Result<CharacterTechniqueServiceResult<TechniqueUpgradeCostView>, BusinessError> {
        let normalized_technique_id = technique_id.trim();
        let current_layer = sqlx::query(
            r#"
            SELECT current_layer
            FROM character_technique
            WHERE character_id = $1 AND technique_id = $2
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .bind(normalized_technique_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?
        .map(|row| row.get::<i32, _>("current_layer"));
        let Some(current_layer) = current_layer else {
            return Ok(service_failure(CHARACTER_TECHNIQUE_NOT_LEARNED_MESSAGE));
        };

        let catalog = get_static_data_catalog().map_err(internal_business_error)?;
        let Some(detail) = catalog.technique_detail(normalized_technique_id) else {
            return Ok(service_failure(CHARACTER_TECHNIQUE_NOT_FOUND_MESSAGE));
        };
        let max_layer = detail.technique.max_layer.max(1);
        if current_layer >= max_layer {
            return Ok(service_failure(CHARACTER_TECHNIQUE_MAX_LAYER_MESSAGE));
        }

        let next_layer = current_layer + 1;
        let Some(layer) = detail.layers.iter().find(|entry| entry.layer == next_layer) else {
            return Ok(service_failure(
                CHARACTER_TECHNIQUE_LAYER_CONFIG_MISSING_MESSAGE,
            ));
        };
        let quality_multiplier = detail.technique.quality_rank.max(1);
        let materials = layer
            .cost_materials
            .iter()
            .map(|material| {
                let item_meta = catalog.item_meta(material.item_id.as_str());
                TechniqueUpgradeCostMaterialView {
                    item_id: material.item_id.clone(),
                    qty: material.qty,
                    item_name: item_meta.map(|meta| meta.name.clone()),
                    item_icon: item_meta.and_then(|meta| meta.icon.clone()),
                }
            })
            .collect();

        Ok(CharacterTechniqueServiceResult {
            success: true,
            message: CHARACTER_TECHNIQUE_READ_SUCCESS_MESSAGE.to_string(),
            data: Some(TechniqueUpgradeCostView {
                current_layer,
                max_layer,
                spirit_stones: scale_cost(layer.cost_spirit_stones, quality_multiplier),
                exp: scale_cost(layer.cost_exp, quality_multiplier),
                materials,
            }),
        })
    }

    pub async fn get_available_skills(
        &self,
        character_id: i64,
    ) -> Result<CharacterTechniqueServiceResult<Vec<AvailableSkillView>>, BusinessError> {
        let snapshot = self.load_snapshot(character_id).await?;
        Ok(CharacterTechniqueServiceResult {
            success: true,
            message: CHARACTER_TECHNIQUE_READ_SUCCESS_MESSAGE.to_string(),
            data: Some(build_available_skills(&snapshot.equipped)),
        })
    }

    pub async fn get_equipped_skills(
        &self,
        character_id: i64,
    ) -> Result<CharacterTechniqueServiceResult<Vec<CharacterSkillSlotView>>, BusinessError> {
        let snapshot = self.load_snapshot(character_id).await?;
        Ok(CharacterTechniqueServiceResult {
            success: true,
            message: CHARACTER_TECHNIQUE_READ_SUCCESS_MESSAGE.to_string(),
            data: Some(snapshot.equipped_skills),
        })
    }

    pub async fn calculate_technique_passives(
        &self,
        character_id: i64,
    ) -> Result<CharacterTechniqueServiceResult<BTreeMap<String, f64>>, BusinessError> {
        let snapshot = self.load_snapshot(character_id).await?;
        Ok(CharacterTechniqueServiceResult {
            success: true,
            message: "计算成功".to_string(),
            data: Some(build_passives(&snapshot.equipped)),
        })
    }

    pub async fn get_character_technique_status(
        &self,
        character_id: i64,
    ) -> Result<CharacterTechniqueServiceResult<CharacterTechniqueStatusView>, BusinessError> {
        let snapshot = self.load_snapshot(character_id).await?;
        let available_skills = build_available_skills(&snapshot.equipped);
        let available_skill_ids = available_skills
            .iter()
            .map(|entry| entry.skill_id.clone())
            .collect::<HashSet<_>>();
        let equipped_skills = snapshot
            .equipped_skills
            .into_iter()
            .filter(|entry| available_skill_ids.contains(entry.skill_id.as_str()))
            .collect::<Vec<_>>();
        let passives = build_passives(&snapshot.equipped);

        let mut equipped_main = None;
        let mut equipped_subs = Vec::new();
        for technique in &snapshot.techniques {
            match technique.slot_type.as_deref() {
                Some("main") => equipped_main = Some(technique.clone()),
                Some("sub") => equipped_subs.push(technique.clone()),
                _ => {}
            }
        }

        Ok(CharacterTechniqueServiceResult {
            success: true,
            message: CHARACTER_TECHNIQUE_READ_SUCCESS_MESSAGE.to_string(),
            data: Some(CharacterTechniqueStatusView {
                techniques: snapshot.techniques,
                equipped_main,
                equipped_subs,
                equipped_skills,
                available_skills,
                passives,
            }),
        })
    }

    async fn load_snapshot(&self, character_id: i64) -> Result<TechniqueStatusSnapshot, BusinessError> {
        let catalog = get_static_data_catalog().map_err(internal_business_error)?;
        let techniques = self.load_character_techniques(character_id, catalog).await?;
        let equipped = build_equipped_snapshot(catalog, &techniques);
        let equipped_skills = self.load_equipped_skills(character_id, catalog).await?;
        Ok(TechniqueStatusSnapshot {
            techniques,
            equipped,
            equipped_skills,
        })
    }

    async fn load_character_techniques(
        &self,
        character_id: i64,
        catalog: &StaticDataCatalog,
    ) -> Result<Vec<CharacterTechniqueView>, BusinessError> {
        let rows = sqlx::query(
            r#"
            SELECT
              id,
              character_id,
              technique_id,
              current_layer,
              slot_type,
              slot_index,
              acquired_at::text AS acquired_at
            FROM character_technique
            WHERE character_id = $1
            "#,
        )
        .bind(character_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let mut techniques = rows
            .into_iter()
            .filter_map(|row| {
                let technique_id = row.get::<String, _>("technique_id");
                let detail = catalog.technique_detail(technique_id.as_str())?;
                let slot_type = normalize_slot_type(row.try_get::<Option<String>, _>("slot_type").ok().flatten());
                Some(CharacterTechniqueView {
                    id: row.get::<i64, _>("id"),
                    character_id: row.get::<i64, _>("character_id"),
                    technique_id,
                    current_layer: row.get::<i32, _>("current_layer"),
                    slot_type,
                    slot_index: row.try_get::<Option<i32>, _>("slot_index").ok().flatten(),
                    acquired_at: row
                        .try_get::<String, _>("acquired_at")
                        .unwrap_or_else(|_| String::new()),
                    technique_name: Some(detail.technique.name.clone()),
                    technique_type: Some(detail.technique.technique_type.clone()),
                    technique_quality: Some(detail.technique.quality.clone()),
                    max_layer: Some(detail.technique.max_layer),
                    attribute_type: Some(detail.technique.attribute_type.clone()),
                    attribute_element: Some(detail.technique.attribute_element.clone()),
                })
            })
            .collect::<Vec<_>>();

        techniques.sort_by(|left, right| {
            technique_slot_rank(left.slot_type.as_deref())
                .cmp(&technique_slot_rank(right.slot_type.as_deref()))
                .then_with(|| {
                    left.slot_index
                        .unwrap_or(i32::MAX)
                        .cmp(&right.slot_index.unwrap_or(i32::MAX))
                })
                .then_with(|| {
                    let left_rank = catalog
                        .technique_detail(left.technique_id.as_str())
                        .map(|detail| detail.technique.quality_rank)
                        .unwrap_or_default();
                    let right_rank = catalog
                        .technique_detail(right.technique_id.as_str())
                        .map(|detail| detail.technique.quality_rank)
                        .unwrap_or_default();
                    right_rank.cmp(&left_rank)
                })
                .then_with(|| left.technique_id.cmp(&right.technique_id))
        });
        Ok(techniques)
    }

    async fn load_equipped_skills(
        &self,
        character_id: i64,
        catalog: &StaticDataCatalog,
    ) -> Result<Vec<CharacterSkillSlotView>, BusinessError> {
        let rows = sqlx::query(
            r#"
            SELECT slot_index, skill_id
            FROM character_skill_slot
            WHERE character_id = $1
            ORDER BY slot_index
            "#,
        )
        .bind(character_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let slot_index = row.get::<i32, _>("slot_index");
                let skill_id = row.get::<String, _>("skill_id").trim().to_string();
                if slot_index <= 0 || skill_id.is_empty() {
                    return None;
                }
                let skill = catalog.skill(skill_id.as_str());
                Some(CharacterSkillSlotView {
                    slot_index,
                    skill_id: skill_id.clone(),
                    skill_name: skill
                        .map(|entry| entry.name.clone())
                        .unwrap_or_else(|| skill_id.clone()),
                    skill_icon: skill.and_then(|entry| entry.icon.clone()).unwrap_or_default(),
                })
            })
            .collect())
    }
}

fn build_equipped_snapshot(
    catalog: &StaticDataCatalog,
    techniques: &[CharacterTechniqueView],
) -> Vec<EquippedTechniqueSnapshot> {
    techniques
        .iter()
        .filter_map(|technique| {
            if technique.slot_type.is_none() {
                return None;
            }
            let detail = catalog.technique_detail(technique.technique_id.as_str())?;
            Some(EquippedTechniqueSnapshot {
                technique_id: technique.technique_id.clone(),
                technique_name: detail.technique.name.clone(),
                slot_type: technique.slot_type.clone().unwrap_or_default(),
                current_layer: technique.current_layer,
                detail: detail.clone(),
            })
        })
        .collect()
}

fn build_available_skills(equipped: &[EquippedTechniqueSnapshot]) -> Vec<AvailableSkillView> {
    let mut result = Vec::new();
    let mut seen_skill_keys = HashSet::<String>::new();

    for technique in equipped {
        let unlocked_skill_ids = build_unlocked_skill_id_set(&technique.detail.layers, technique.current_layer);
        let skill_upgrade_counts =
            build_skill_upgrade_count_map(&technique.detail.layers, technique.current_layer);
        for skill in &technique.detail.skills {
            let skill_key = format!("{}:{}", technique.technique_id, skill.id);
            if !unlocked_skill_ids.contains(skill.id.as_str())
                || !is_manual_skill(skill)
                || !seen_skill_keys.insert(skill_key)
            {
                continue;
            }
            let effective_skill = build_effective_skill_data(
                skill,
                skill_upgrade_counts.get(skill.id.as_str()).copied().unwrap_or(0),
            );
            result.push(AvailableSkillView {
                skill_id: skill.id.clone(),
                skill_name: skill.name.clone(),
                skill_icon: skill.icon.clone().unwrap_or_default(),
                technique_id: technique.technique_id.clone(),
                technique_name: technique.technique_name.clone(),
                description: skill.description.clone(),
                cost_lingqi: effective_skill.cost_lingqi,
                cost_lingqi_rate: effective_skill.cost_lingqi_rate,
                cost_qixue: effective_skill.cost_qixue,
                cost_qixue_rate: effective_skill.cost_qixue_rate,
                cooldown: effective_skill.cooldown,
                target_type: skill.target_type.clone(),
                target_count: effective_skill.target_count,
                damage_type: skill.damage_type.clone(),
                element: skill.element.clone(),
                effects: effective_skill.effects,
            });
        }
    }

    result.sort_by(|left, right| {
        left.technique_name
            .cmp(&right.technique_name)
            .then_with(|| left.skill_name.cmp(&right.skill_name))
            .then_with(|| left.skill_id.cmp(&right.skill_id))
    });
    result
}

fn build_passives(equipped: &[EquippedTechniqueSnapshot]) -> BTreeMap<String, f64> {
    let mut passives = BTreeMap::<String, f64>::new();
    for technique in equipped {
        let ratio = if is_main_technique(technique) { 1.0 } else { 0.3 };
        for layer in technique
            .detail
            .layers
            .iter()
            .filter(|layer| layer.layer > 0 && layer.layer <= technique.current_layer)
        {
            for passive in &layer.passives {
                let Some((key, value)) = extract_passive_entry(passive) else {
                    continue;
                };
                let effective_value = round_passive_value(value * ratio);
                let next_value = passives.get(key.as_str()).copied().unwrap_or(0.0) + effective_value;
                passives.insert(key, round_passive_value(next_value));
            }
        }
    }
    passives
}

fn build_unlocked_skill_id_set(layers: &[TechniqueLayerDto], current_layer: i32) -> BTreeSet<String> {
    let mut unlocked = BTreeSet::<String>::new();
    for layer in layers
        .iter()
        .filter(|layer| layer.layer > 0 && layer.layer <= current_layer)
    {
        for skill_id in layer
            .unlock_skill_ids
            .iter()
            .chain(layer.upgrade_skill_ids.iter())
        {
            let normalized_skill_id = skill_id.trim();
            if normalized_skill_id.is_empty() {
                continue;
            }
            unlocked.insert(normalized_skill_id.to_string());
        }
    }
    unlocked
}

fn build_skill_upgrade_count_map(
    layers: &[TechniqueLayerDto],
    current_layer: i32,
) -> BTreeMap<String, i32> {
    let mut counts = BTreeMap::<String, i32>::new();
    for layer in layers
        .iter()
        .filter(|layer| layer.layer > 0 && layer.layer <= current_layer)
    {
        for skill_id in &layer.upgrade_skill_ids {
            let normalized_skill_id = skill_id.trim();
            if normalized_skill_id.is_empty() {
                continue;
            }
            *counts.entry(normalized_skill_id.to_string()).or_insert(0) += 1;
        }
    }
    counts
}

#[derive(Debug, Clone)]
struct EffectiveSkillData {
    cost_lingqi: i32,
    cost_lingqi_rate: f64,
    cost_qixue: i32,
    cost_qixue_rate: f64,
    cooldown: i32,
    target_count: i32,
    effects: Vec<Value>,
}

fn build_effective_skill_data(skill: &SkillDefDto, upgrade_level: i32) -> EffectiveSkillData {
    let mut effective = EffectiveSkillData {
        cost_lingqi: skill.cost_lingqi.max(0),
        cost_lingqi_rate: skill.cost_lingqi_rate.max(0.0),
        cost_qixue: skill.cost_qixue.max(0),
        cost_qixue_rate: skill.cost_qixue_rate.max(0.0),
        cooldown: skill.cooldown.max(0),
        target_count: skill.target_count.max(1),
        effects: skill.effects.clone(),
    };
    if upgrade_level <= 0 {
        return effective;
    }

    let upgrade_rules = parse_skill_upgrade_rules(&skill.upgrades);
    for rule in upgrade_rules.into_iter().take(upgrade_level as usize) {
        apply_skill_upgrade_changes(&mut effective, &rule);
    }
    effective
}

fn parse_skill_upgrade_rules(raw: &Value) -> Vec<serde_json::Map<String, Value>> {
    let Some(entries) = raw.as_array() else {
        return Vec::new();
    };
    let mut rules = entries
        .iter()
        .filter_map(|entry| {
            let changes = entry.get("changes")?.as_object()?.clone();
            if changes.is_empty() {
                return None;
            }
            let layer = entry
                .get("layer")
                .and_then(value_as_i64)
                .unwrap_or(1)
                .max(1);
            Some((layer, changes))
        })
        .collect::<Vec<_>>();
    rules.sort_by(|left, right| left.0.cmp(&right.0));
    rules.into_iter().map(|(_, changes)| changes).collect()
}

fn apply_skill_upgrade_changes(
    effective: &mut EffectiveSkillData,
    changes: &serde_json::Map<String, Value>,
) {
    if let Some(target_count) = changes
        .get("target_count")
        .and_then(value_as_i64)
        .map(|value| value.max(1) as i32)
    {
        effective.target_count = target_count;
    }
    if let Some(cooldown_delta) = changes
        .get("cooldown")
        .and_then(value_as_i64)
        .map(|value| value as i32)
    {
        effective.cooldown = (effective.cooldown + cooldown_delta).max(0);
    }
    if let Some(cost_lingqi_delta) = changes
        .get("cost_lingqi")
        .and_then(value_as_i64)
        .map(|value| value as i32)
    {
        effective.cost_lingqi = (effective.cost_lingqi + cost_lingqi_delta).max(0);
    }
    if let Some(cost_lingqi_rate_delta) =
        changes.get("cost_lingqi_rate").and_then(value_as_f64)
    {
        effective.cost_lingqi_rate = (effective.cost_lingqi_rate + cost_lingqi_rate_delta).max(0.0);
    }
    if let Some(cost_qixue_delta) = changes
        .get("cost_qixue")
        .and_then(value_as_i64)
        .map(|value| value as i32)
    {
        effective.cost_qixue = (effective.cost_qixue + cost_qixue_delta).max(0);
    }
    if let Some(cost_qixue_rate_delta) = changes.get("cost_qixue_rate").and_then(value_as_f64) {
        effective.cost_qixue_rate = (effective.cost_qixue_rate + cost_qixue_rate_delta).max(0.0);
    }
    if let Some(effects) = changes.get("effects").and_then(Value::as_array) {
        let mut next_effects = effects.clone();
        if has_damage_effect(&effective.effects) && !has_damage_effect(&next_effects) {
            if let Some(damage_effect) = find_first_damage_effect(&effective.effects) {
                next_effects.insert(0, damage_effect);
            }
        }
        effective.effects = next_effects;
    }
    if let Some(add_effect) = changes.get("addEffect") {
        if add_effect.is_object() {
            effective.effects.push(add_effect.clone());
        }
    }
}

fn is_manual_skill(skill: &SkillDefDto) -> bool {
    skill.trigger_type == "active"
}

fn has_damage_effect(effects: &[Value]) -> bool {
    effects
        .iter()
        .any(|effect| effect.get("type").and_then(Value::as_str) == Some("damage"))
}

fn find_first_damage_effect(effects: &[Value]) -> Option<Value> {
    effects
        .iter()
        .find(|effect| effect.get("type").and_then(Value::as_str) == Some("damage"))
        .cloned()
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.trim().parse::<i64>().ok()))
}

fn value_as_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.trim().parse::<f64>().ok()))
}

fn extract_passive_entry(value: &Value) -> Option<(String, f64)> {
    let key = value.get("key")?.as_str()?.trim().to_string();
    let number = value.get("value")?.as_f64()?;
    if key.is_empty() || !number.is_finite() {
        return None;
    }
    Some((key, number))
}

fn round_passive_value(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

fn technique_slot_rank(slot_type: Option<&str>) -> i32 {
    match slot_type {
        Some("main") => 0,
        Some("sub") => 1,
        _ => 2,
    }
}

fn normalize_slot_type(slot_type: Option<String>) -> Option<String> {
    match slot_type.as_deref() {
        Some("main") => Some("main".to_string()),
        Some("sub") => Some("sub".to_string()),
        _ => None,
    }
}

fn is_main_technique(technique: &EquippedTechniqueSnapshot) -> bool {
    technique.slot_type == "main"
}

fn scale_cost(base_cost: i32, quality_multiplier: i32) -> i32 {
    base_cost.max(0).saturating_mul(quality_multiplier.max(1))
}

fn service_failure<T>(message: &str) -> CharacterTechniqueServiceResult<T> {
    CharacterTechniqueServiceResult {
        success: false,
        message: message.to_string(),
        data: None,
    }
}

fn internal_business_error(error: impl std::fmt::Display) -> BusinessError {
    tracing::error!("character technique service failed: {error}");
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unlocked_skill_set_includes_upgrade_only_skills() {
        let layers = vec![
            TechniqueLayerDto {
                technique_id: "tech-a".to_string(),
                layer: 1,
                cost_spirit_stones: 0,
                cost_exp: 0,
                cost_materials: Vec::new(),
                passives: Vec::new(),
                unlock_skill_ids: vec!["skill-a".to_string()],
                upgrade_skill_ids: Vec::new(),
                required_realm: None,
                required_quest_id: None,
                layer_desc: None,
            },
            TechniqueLayerDto {
                technique_id: "tech-a".to_string(),
                layer: 2,
                cost_spirit_stones: 0,
                cost_exp: 0,
                cost_materials: Vec::new(),
                passives: Vec::new(),
                unlock_skill_ids: Vec::new(),
                upgrade_skill_ids: vec!["skill-b".to_string()],
                required_realm: None,
                required_quest_id: None,
                layer_desc: None,
            },
        ];

        let unlocked = build_unlocked_skill_id_set(&layers, 2);

        assert!(unlocked.contains("skill-a"));
        assert!(unlocked.contains("skill-b"));
    }

    #[test]
    fn effective_skill_data_preserves_damage_effect_when_upgrade_replaces_effects() {
        let skill = SkillDefDto {
            id: "skill-a".to_string(),
            code: None,
            name: "断岳".to_string(),
            description: None,
            icon: None,
            source_type: "technique".to_string(),
            source_id: Some("tech-a".to_string()),
            cost_lingqi: 10,
            cost_lingqi_rate: 0.0,
            cost_qixue: 0,
            cost_qixue_rate: 0.0,
            cooldown: 2,
            target_type: "enemy".to_string(),
            target_count: 1,
            damage_type: Some("physical".to_string()),
            element: "none".to_string(),
            effects: vec![json!({ "type": "damage", "rate": 1.2 })],
            trigger_type: "active".to_string(),
            conditions: None,
            ai_priority: 50,
            ai_conditions: None,
            upgrades: json!([
                {
                    "layer": 1,
                    "changes": {
                        "effects": [
                            { "type": "buff", "key": "atkPct", "value": 0.2 }
                        ],
                        "cooldown": -1
                    }
                }
            ]),
            sort_weight: 0,
            version: 1,
            enabled: true,
        };

        let effective = build_effective_skill_data(&skill, 1);

        assert_eq!(effective.cooldown, 1);
        assert_eq!(
            effective.effects.first().and_then(|entry| entry.get("type")).and_then(Value::as_str),
            Some("damage")
        );
        assert_eq!(effective.effects.len(), 2);
    }

    #[test]
    fn passives_apply_sub_technique_ratio() {
        let equipped = vec![
            EquippedTechniqueSnapshot {
                technique_id: "tech-main".to_string(),
                technique_name: "主功法".to_string(),
                slot_type: "main".to_string(),
                current_layer: 1,
                detail: TechniqueDetailDto {
                    technique: sample_technique("tech-main", "主功法"),
                    layers: vec![sample_passive_layer("tech-main", 1.0)],
                    skills: Vec::new(),
                },
            },
            EquippedTechniqueSnapshot {
                technique_id: "tech-sub".to_string(),
                technique_name: "副功法".to_string(),
                slot_type: "sub".to_string(),
                current_layer: 1,
                detail: TechniqueDetailDto {
                    technique: sample_technique("tech-sub", "副功法"),
                    layers: vec![sample_passive_layer("tech-sub", 1.0)],
                    skills: Vec::new(),
                },
            },
        ];

        let passives = build_passives(&equipped);

        assert_eq!(passives.get("atkPct").copied(), Some(1.3));
    }

    fn sample_technique(id: &str, name: &str) -> crate::application::static_data::catalog::TechniqueDefDto {
        crate::application::static_data::catalog::TechniqueDefDto {
            id: id.to_string(),
            code: None,
            name: name.to_string(),
            technique_type: "main".to_string(),
            quality: "天".to_string(),
            quality_rank: 4,
            max_layer: 9,
            required_realm: "凡人".to_string(),
            attribute_type: "physical".to_string(),
            attribute_element: "none".to_string(),
            tags: Vec::new(),
            description: None,
            long_desc: None,
            icon: None,
            obtain_type: None,
            obtain_hint: Vec::new(),
            sort_weight: 0,
            version: 1,
            enabled: true,
        }
    }

    fn sample_passive_layer(technique_id: &str, value: f64) -> TechniqueLayerDto {
        TechniqueLayerDto {
            technique_id: technique_id.to_string(),
            layer: 1,
            cost_spirit_stones: 0,
            cost_exp: 0,
            cost_materials: Vec::new(),
            passives: vec![json!({ "key": "atkPct", "value": value })],
            unlock_skill_ids: Vec::new(),
            upgrade_skill_ids: Vec::new(),
            required_realm: None,
            required_quest_id: None,
            layer_desc: None,
        }
    }
}
