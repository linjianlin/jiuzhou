use std::collections::HashMap;
use std::future::Future;

use crate::integrations::redis::RedisRuntime;
use crate::shared::error::AppError;

pub const ITEM_GRANT_DELTA_DIRTY_INDEX_KEY: &str = "character:item-grant-delta:index";
pub const ITEM_GRANT_DELTA_KEY_PREFIX: &str = "character:item-grant-delta:";
pub const ITEM_GRANT_DELTA_INFLIGHT_KEY_PREFIX: &str = "character:item-grant-delta:inflight:";

const CLAIM_ITEM_GRANT_DELTA_LUA: &str = r#"
local dirtyIndexKey = KEYS[1]
local mainKey = KEYS[2]
local inflightKey = KEYS[3]
local characterId = ARGV[1]

if redis.call('EXISTS', inflightKey) == 1 then
  return 0
end

if redis.call('EXISTS', mainKey) == 0 then
  redis.call('SREM', dirtyIndexKey, characterId)
  return 0
end

redis.call('RENAME', mainKey, inflightKey)
return 1
"#;

const FINALIZE_ITEM_GRANT_DELTA_LUA: &str = r#"
local dirtyIndexKey = KEYS[1]
local mainKey = KEYS[2]
local inflightKey = KEYS[3]
local characterId = ARGV[1]

redis.call('DEL', inflightKey)
if redis.call('EXISTS', mainKey) == 1 then
  redis.call('SADD', dirtyIndexKey, characterId)
else
  redis.call('SREM', dirtyIndexKey, characterId)
end
return 1
"#;

const RESTORE_ITEM_GRANT_DELTA_LUA: &str = r#"
local dirtyIndexKey = KEYS[1]
local mainKey = KEYS[2]
local inflightKey = KEYS[3]
local characterId = ARGV[1]

local inflightValues = redis.call('HGETALL', inflightKey)
if next(inflightValues) == nil then
  if redis.call('EXISTS', mainKey) == 1 then
    redis.call('SADD', dirtyIndexKey, characterId)
  else
    redis.call('SREM', dirtyIndexKey, characterId)
  end
  return 0
end

for i = 1, #inflightValues, 2 do
  redis.call('HINCRBY', mainKey, inflightValues[i], tonumber(inflightValues[i + 1]))
end
redis.call('DEL', inflightKey)
redis.call('SADD', dirtyIndexKey, characterId)
return 1
"#;

#[derive(Debug, Clone)]
pub struct CharacterItemGrantDelta {
    pub character_id: i64,
    pub user_id: i64,
    pub item_def_id: String,
    pub qty: i64,
    pub bind_type: String,
    pub obtained_from: String,
    pub obtained_ref_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct DecodedCharacterItemGrantDelta {
    pub user_id: i64,
    pub item_def_id: String,
    pub bind_type: String,
    pub obtained_from: String,
    pub obtained_ref_id: Option<String>,
    pub qty: i64,
}

fn build_item_grant_delta_key(character_id: i64) -> String {
    format!("{ITEM_GRANT_DELTA_KEY_PREFIX}{character_id}")
}

fn build_inflight_item_grant_delta_key(character_id: i64) -> String {
    format!("{ITEM_GRANT_DELTA_INFLIGHT_KEY_PREFIX}{character_id}")
}

fn encode_item_grant_payload(delta: &CharacterItemGrantDelta) -> Option<String> {
    let item_def_id = delta.item_def_id.trim();
    let bind_type = delta.bind_type.trim();
    let obtained_from = delta.obtained_from.trim();
    if delta.character_id <= 0 || delta.user_id <= 0 || delta.qty <= 0 || item_def_id.is_empty() || obtained_from.is_empty() {
        return None;
    }
    serde_json::to_string(&serde_json::json!({
        "userId": delta.user_id,
        "itemDefId": item_def_id,
        "bindType": if bind_type.is_empty() { "none" } else { bind_type },
        "obtainedFrom": obtained_from,
        "obtainedRefId": delta.obtained_ref_id.as_deref().map(str::trim).filter(|value| !value.is_empty()),
    })).ok()
}

pub fn decode_item_grant_payload(raw: &str, qty: i64) -> Option<DecodedCharacterItemGrantDelta> {
    if qty <= 0 {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let user_id = parsed.get("userId").and_then(|value| value.as_i64())?;
    let item_def_id = parsed.get("itemDefId").and_then(|value| value.as_str())?.trim().to_string();
    let bind_type = parsed.get("bindType").and_then(|value| value.as_str()).unwrap_or("none").trim().to_string();
    let obtained_from = parsed.get("obtainedFrom").and_then(|value| value.as_str())?.trim().to_string();
    let obtained_ref_id = parsed.get("obtainedRefId").and_then(|value| value.as_str()).map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    if user_id <= 0 || item_def_id.is_empty() || obtained_from.is_empty() {
        return None;
    }
    Some(DecodedCharacterItemGrantDelta {
        user_id,
        item_def_id,
        bind_type: if bind_type.is_empty() { "none".to_string() } else { bind_type },
        obtained_from,
        obtained_ref_id,
        qty,
    })
}

pub async fn buffer_character_item_grant_deltas(
    runtime: &RedisRuntime,
    deltas: &[CharacterItemGrantDelta],
) -> Result<(), AppError> {
    let normalized = deltas
        .iter()
        .filter_map(|delta| encode_item_grant_payload(delta).map(|payload| (delta.character_id, payload, delta.qty)))
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        return Ok(());
    }
    runtime
        .with_pipeline(|pipeline| {
            for (character_id, payload, qty) in &normalized {
                pipeline
                    .cmd("HINCRBY")
                    .arg(build_item_grant_delta_key(*character_id))
                    .arg(payload)
                    .arg(*qty)
                    .ignore()
                    .cmd("SADD")
                    .arg(ITEM_GRANT_DELTA_DIRTY_INDEX_KEY)
                    .arg(character_id.to_string())
                    .ignore();
            }
        })
        .await
}

pub async fn list_dirty_character_ids_for_item_grant_delta(
    runtime: &RedisRuntime,
    limit: usize,
) -> Result<Vec<i64>, AppError> {
    let values = runtime.srandmember(ITEM_GRANT_DELTA_DIRTY_INDEX_KEY, limit.max(1)).await?;
    let mut normalized = values
        .into_iter()
        .filter_map(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .collect::<Vec<_>>();
    normalized.sort_unstable();
    Ok(normalized)
}

pub async fn claim_character_item_grant_delta(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<bool, AppError> {
    Ok(runtime.eval_i64(
        CLAIM_ITEM_GRANT_DELTA_LUA,
        &[
            ITEM_GRANT_DELTA_DIRTY_INDEX_KEY,
            &build_item_grant_delta_key(character_id),
            &build_inflight_item_grant_delta_key(character_id),
        ],
        &[&character_id.to_string()],
    ).await? == 1)
}

pub async fn load_claimed_character_item_grant_delta_hash(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<HashMap<String, String>, AppError> {
    runtime.hgetall(&build_inflight_item_grant_delta_key(character_id)).await
}

pub async fn finalize_claimed_character_item_grant_delta(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<(), AppError> {
    let _ = runtime.eval_i64(
        FINALIZE_ITEM_GRANT_DELTA_LUA,
        &[
            ITEM_GRANT_DELTA_DIRTY_INDEX_KEY,
            &build_item_grant_delta_key(character_id),
            &build_inflight_item_grant_delta_key(character_id),
        ],
        &[&character_id.to_string()],
    ).await?;
    Ok(())
}

pub async fn restore_claimed_character_item_grant_delta(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<(), AppError> {
    let _ = runtime.eval_i64(
        RESTORE_ITEM_GRANT_DELTA_LUA,
        &[
            ITEM_GRANT_DELTA_DIRTY_INDEX_KEY,
            &build_item_grant_delta_key(character_id),
            &build_inflight_item_grant_delta_key(character_id),
        ],
        &[&character_id.to_string()],
    ).await?;
    Ok(())
}

pub fn parse_item_grant_delta_hash(hash: HashMap<String, String>) -> Vec<DecodedCharacterItemGrantDelta> {
    hash.into_iter()
        .filter_map(|(field, value)| value.parse::<i64>().ok().and_then(|qty| decode_item_grant_payload(&field, qty)))
        .collect()
}

pub async fn flush_character_item_grant_deltas<F, Fut>(
    runtime: &RedisRuntime,
    limit: usize,
    processor: F,
) -> Result<Vec<i64>, AppError>
where
    F: Fn(i64, Vec<DecodedCharacterItemGrantDelta>) -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
{
    let dirty_character_ids = list_dirty_character_ids_for_item_grant_delta(runtime, limit).await?;
    let mut flushed_character_ids = Vec::new();
    for character_id in dirty_character_ids {
        if !claim_character_item_grant_delta(runtime, character_id).await? {
            continue;
        }
        let claimed_hash = load_claimed_character_item_grant_delta_hash(runtime, character_id).await?;
        let parsed = parse_item_grant_delta_hash(claimed_hash);
        if parsed.is_empty() {
            finalize_claimed_character_item_grant_delta(runtime, character_id).await?;
            continue;
        }
        match processor(character_id, parsed).await {
            Ok(()) => {
                finalize_claimed_character_item_grant_delta(runtime, character_id).await?;
                flushed_character_ids.push(character_id);
            }
            Err(error) => {
                restore_claimed_character_item_grant_delta(runtime, character_id).await?;
                return Err(error);
            }
        }
    }
    Ok(flushed_character_ids)
}

#[cfg(test)]
mod tests {
    use super::{decode_item_grant_payload, parse_item_grant_delta_hash};
    use std::collections::HashMap;

    #[test]
    fn item_grant_payload_decodes_expected_shape() {
        let decoded = decode_item_grant_payload(
            r#"{"userId":7,"itemDefId":"mat-005","bindType":"none","obtainedFrom":"battle_reward","obtainedRefId":"generic_pve_v1"}"#,
            2,
        )
        .expect("payload should decode");
        assert_eq!(decoded.user_id, 7);
        assert_eq!(decoded.item_def_id, "mat-005");
        assert_eq!(decoded.qty, 2);
        println!("ITEM_GRANT_DELTA_DECODED={}", serde_json::json!({
            "userId": decoded.user_id,
            "itemDefId": decoded.item_def_id,
            "qty": decoded.qty,
        }));
    }

    #[test]
    fn parse_item_grant_delta_hash_ignores_invalid_rows() {
        let parsed = parse_item_grant_delta_hash(HashMap::from([
            (
                r#"{"userId":7,"itemDefId":"mat-005","bindType":"none","obtainedFrom":"battle_reward","obtainedRefId":"generic_pve_v1"}"#.to_string(),
                "2".to_string(),
            ),
            ("invalid".to_string(), "1".to_string()),
        ]));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].item_def_id, "mat-005");
    }
}
