use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/**
 * 通用奖励 payload 与预览模型。
 *
 * 作用：
 * 1. 做什么：统一归一化 `attach_rewards / reward_payload` 这类奖励 JSON，并生成前端可直接消费的奖励预览 DTO。
 * 2. 做什么：为兑换码、邮件等多个入口复用同一套奖励解析与 JSON 回写规则，避免业务侧各自维护一份近似映射。
 * 3. 不做什么：不负责真正发奖落库，不负责奖励文案格式化，也不推断未在 payload 中声明的字段。
 *
 * 输入 / 输出：
 * - 输入：数据库中的 `serde_json::Value` 奖励 payload。
 * - 输出：归一化后的 `NormalizedGrantedRewardPayload`、通用预览 `GrantedRewardPreviewView`，以及可复用的 JSON 回写结构。
 *
 * 数据流 / 状态流：
 * - PostgreSQL/Redis reward JSON -> 本模块归一化 -> 路由 DTO 预览 / 邮件落库 metadata。
 *
 * 复用设计说明：
 * - 兑换码奖励与邮件附件预览都需要同一套“奖励类型 -> 前端 DTO”映射，把解析逻辑集中到这里后，后续补 mail claim、活动补偿等入口都能直接复用。
 * - 奖励字段是高频演进点，集中维护能避免 `exp/silver/spiritStones/items/...` 在多个服务里散落判断。
 *
 * 关键边界条件与坑点：
 * 1. 这里只保留当前前端已识别的奖励类型，不为未知字段做宽泛透传，避免协议漂移。
 * 2. 字符串列表必须去重且去空；否则邮件与兑换码会出现重复奖励预览。
 */
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq)]
pub struct GrantedRewardPayload {
    #[serde(default)]
    pub exp: Option<i64>,
    #[serde(default)]
    pub silver: Option<i64>,
    #[serde(rename = "spiritStones", alias = "spirit_stones", default)]
    pub spirit_stones: Option<i64>,
    #[serde(default)]
    pub items: Option<Vec<GrantedRewardItemPayload>>,
    #[serde(default)]
    pub techniques: Option<Vec<String>>,
    #[serde(default)]
    pub titles: Option<Vec<String>>,
    #[serde(rename = "unlockFeatures", alias = "unlock_features", default)]
    pub unlock_features: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct GrantedRewardItemPayload {
    #[serde(rename = "itemDefId", alias = "item_def_id")]
    pub item_def_id: String,
    #[serde(alias = "qty")]
    pub quantity: i64,
    #[serde(rename = "itemName", alias = "item_name", default)]
    pub item_name: Option<String>,
    #[serde(rename = "itemIcon", alias = "item_icon", default)]
    pub item_icon: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NormalizedGrantedRewardPayload {
    pub exp: i64,
    pub silver: i64,
    pub spirit_stones: i64,
    pub items: Vec<GrantedRewardItemPayload>,
    pub techniques: Vec<String>,
    pub titles: Vec<String>,
    pub unlock_features: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum GrantedRewardPreviewView {
    #[serde(rename = "exp")]
    Exp { amount: i64 },
    #[serde(rename = "silver")]
    Silver { amount: i64 },
    #[serde(rename = "spirit_stones")]
    SpiritStones { amount: i64 },
    #[serde(rename = "item")]
    Item {
        #[serde(rename = "itemDefId")]
        item_def_id: String,
        quantity: i64,
        #[serde(rename = "itemName", skip_serializing_if = "Option::is_none")]
        item_name: Option<String>,
        #[serde(rename = "itemIcon", skip_serializing_if = "Option::is_none")]
        item_icon: Option<String>,
    },
    #[serde(rename = "technique")]
    Technique {
        #[serde(rename = "techniqueId")]
        technique_id: String,
        #[serde(rename = "techniqueName", skip_serializing_if = "Option::is_none")]
        technique_name: Option<String>,
        #[serde(rename = "techniqueIcon", skip_serializing_if = "Option::is_none")]
        technique_icon: Option<String>,
    },
    #[serde(rename = "feature_unlock")]
    FeatureUnlock {
        #[serde(rename = "featureCode")]
        feature_code: String,
    },
    #[serde(rename = "title")]
    Title { title: String },
}

pub fn normalize_reward_payload(raw: Option<Value>) -> NormalizedGrantedRewardPayload {
    let parsed = raw
        .and_then(|value| serde_json::from_value::<GrantedRewardPayload>(value).ok())
        .unwrap_or_default();

    let items = parsed
        .items
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let item_def_id = item.item_def_id.trim().to_string();
            let quantity = item.quantity.max(0);
            if item_def_id.is_empty() || quantity <= 0 {
                return None;
            }
            Some(GrantedRewardItemPayload {
                item_def_id,
                quantity,
                item_name: item
                    .item_name
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                item_icon: item
                    .item_icon
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
            })
        })
        .collect::<Vec<_>>();

    NormalizedGrantedRewardPayload {
        exp: parsed.exp.unwrap_or(0).max(0),
        silver: parsed.silver.unwrap_or(0).max(0),
        spirit_stones: parsed.spirit_stones.unwrap_or(0).max(0),
        items,
        techniques: normalize_unique_strings(parsed.techniques.unwrap_or_default()),
        titles: normalize_unique_strings(parsed.titles.unwrap_or_default()),
        unlock_features: normalize_unique_strings(parsed.unlock_features.unwrap_or_default()),
    }
}

pub fn build_reward_preview(
    payload: &NormalizedGrantedRewardPayload,
) -> Vec<GrantedRewardPreviewView> {
    let mut rewards = Vec::new();
    if payload.exp > 0 {
        rewards.push(GrantedRewardPreviewView::Exp { amount: payload.exp });
    }
    if payload.silver > 0 {
        rewards.push(GrantedRewardPreviewView::Silver {
            amount: payload.silver,
        });
    }
    if payload.spirit_stones > 0 {
        rewards.push(GrantedRewardPreviewView::SpiritStones {
            amount: payload.spirit_stones,
        });
    }
    for item in &payload.items {
        rewards.push(GrantedRewardPreviewView::Item {
            item_def_id: item.item_def_id.clone(),
            quantity: item.quantity,
            item_name: item.item_name.clone(),
            item_icon: item.item_icon.clone(),
        });
    }
    for technique_id in &payload.techniques {
        rewards.push(GrantedRewardPreviewView::Technique {
            technique_id: technique_id.clone(),
            technique_name: None,
            technique_icon: None,
        });
    }
    for title in &payload.titles {
        rewards.push(GrantedRewardPreviewView::Title {
            title: title.clone(),
        });
    }
    for feature_code in &payload.unlock_features {
        rewards.push(GrantedRewardPreviewView::FeatureUnlock {
            feature_code: feature_code.clone(),
        });
    }
    rewards
}

pub fn build_grant_rewards_input(payload: &NormalizedGrantedRewardPayload) -> Value {
    let mut map = serde_json::Map::new();
    if payload.exp > 0 {
        map.insert("exp".to_string(), Value::from(payload.exp));
    }
    if payload.silver > 0 {
        map.insert("silver".to_string(), Value::from(payload.silver));
    }
    if payload.spirit_stones > 0 {
        map.insert(
            "spirit_stones".to_string(),
            Value::from(payload.spirit_stones),
        );
    }
    if !payload.items.is_empty() {
        map.insert(
            "items".to_string(),
            Value::Array(
                payload
                    .items
                    .iter()
                    .map(|item| {
                        json!({
                            "item_def_id": item.item_def_id,
                            "quantity": item.quantity,
                        })
                    })
                    .collect(),
            ),
        );
    }
    if !payload.techniques.is_empty() {
        map.insert(
            "techniques".to_string(),
            Value::Array(
                payload
                    .techniques
                    .iter()
                    .map(|value| Value::from(value.clone()))
                    .collect(),
            ),
        );
    }
    if !payload.titles.is_empty() {
        map.insert(
            "titles".to_string(),
            Value::Array(
                payload
                    .titles
                    .iter()
                    .map(|value| Value::from(value.clone()))
                    .collect(),
            ),
        );
    }
    if !payload.unlock_features.is_empty() {
        map.insert(
            "unlock_features".to_string(),
            Value::Array(
                payload
                    .unlock_features
                    .iter()
                    .map(|value| Value::from(value.clone()))
                    .collect(),
            ),
        );
    }
    Value::Object(map)
}

pub fn build_reward_payload_json(payload: &NormalizedGrantedRewardPayload) -> Value {
    let mut map = serde_json::Map::new();
    if payload.exp > 0 {
        map.insert("exp".to_string(), Value::from(payload.exp));
    }
    if payload.silver > 0 {
        map.insert("silver".to_string(), Value::from(payload.silver));
    }
    if payload.spirit_stones > 0 {
        map.insert(
            "spiritStones".to_string(),
            Value::from(payload.spirit_stones),
        );
    }
    if !payload.items.is_empty() {
        map.insert(
            "items".to_string(),
            Value::Array(
                payload
                    .items
                    .iter()
                    .map(|item| {
                        json!({
                            "itemDefId": item.item_def_id,
                            "quantity": item.quantity,
                            "itemName": item.item_name,
                            "itemIcon": item.item_icon,
                        })
                    })
                    .collect(),
            ),
        );
    }
    if !payload.techniques.is_empty() {
        map.insert(
            "techniques".to_string(),
            Value::Array(
                payload
                    .techniques
                    .iter()
                    .map(|value| Value::from(value.clone()))
                    .collect(),
            ),
        );
    }
    if !payload.titles.is_empty() {
        map.insert(
            "titles".to_string(),
            Value::Array(
                payload
                    .titles
                    .iter()
                    .map(|value| Value::from(value.clone()))
                    .collect(),
            ),
        );
    }
    if !payload.unlock_features.is_empty() {
        map.insert(
            "unlockFeatures".to_string(),
            Value::Array(
                payload
                    .unlock_features
                    .iter()
                    .map(|value| Value::from(value.clone()))
                    .collect(),
            ),
        );
    }
    Value::Object(map)
}

fn normalize_unique_strings(values: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::with_capacity(values.len());
    for value in values {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() || normalized.contains(&trimmed) {
            continue;
        }
        normalized.push(trimmed);
    }
    normalized
}
