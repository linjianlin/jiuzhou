use std::collections::HashMap;
use std::future::Future;

use crate::integrations::redis::RedisRuntime;
use crate::shared::error::AppError;

pub const RESOURCE_DELTA_DIRTY_INDEX_KEY: &str = "character:resource-delta:index";
pub const RESOURCE_DELTA_KEY_PREFIX: &str = "character:resource-delta:";
pub const RESOURCE_DELTA_INFLIGHT_KEY_PREFIX: &str = "character:resource-delta:inflight:";

const CLAIM_RESOURCE_DELTA_LUA: &str = r#"
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

const FINALIZE_RESOURCE_DELTA_LUA: &str = r#"
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

const RESTORE_RESOURCE_DELTA_LUA: &str = r#"
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
pub struct CharacterResourceDeltaField {
    pub character_id: i64,
    pub field: String,
    pub increment: i64,
}

fn build_resource_delta_key(character_id: i64) -> String {
    format!("{RESOURCE_DELTA_KEY_PREFIX}{character_id}")
}

fn build_inflight_resource_delta_key(character_id: i64) -> String {
    format!("{RESOURCE_DELTA_INFLIGHT_KEY_PREFIX}{character_id}")
}

pub async fn buffer_character_resource_delta_fields(
    runtime: &RedisRuntime,
    fields: &[CharacterResourceDeltaField],
) -> Result<(), AppError> {
    let normalized = fields
        .iter()
        .filter_map(|field| {
            let character_id = field.character_id;
            let increment = field.increment;
            let normalized_field = field.field.trim();
            (character_id > 0 && increment > 0 && !normalized_field.is_empty()).then(|| {
                (character_id, normalized_field.to_string(), increment)
            })
        })
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        return Ok(());
    }
    runtime.with_pipeline(|pipeline| {
        for (character_id, field, increment) in &normalized {
            pipeline
                .cmd("HINCRBY")
                .arg(build_resource_delta_key(*character_id))
                .arg(field)
                .arg(*increment)
                .ignore()
                .cmd("SADD")
                .arg(RESOURCE_DELTA_DIRTY_INDEX_KEY)
                .arg(character_id.to_string())
                .ignore();
        }
    }).await
}

pub async fn list_dirty_character_ids_for_resource_delta(
    runtime: &RedisRuntime,
    limit: usize,
) -> Result<Vec<i64>, AppError> {
    let values = runtime.srandmember(RESOURCE_DELTA_DIRTY_INDEX_KEY, limit.max(1)).await?;
    let mut normalized = values.into_iter().filter_map(|value| value.parse::<i64>().ok()).filter(|value| *value > 0).collect::<Vec<_>>();
    normalized.sort_unstable();
    Ok(normalized)
}

pub async fn claim_character_resource_delta(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<bool, AppError> {
    Ok(runtime.eval_i64(
        CLAIM_RESOURCE_DELTA_LUA,
        &[
            RESOURCE_DELTA_DIRTY_INDEX_KEY,
            &build_resource_delta_key(character_id),
            &build_inflight_resource_delta_key(character_id),
        ],
        &[&character_id.to_string()],
    ).await? == 1)
}

pub async fn load_claimed_character_resource_delta_hash(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<HashMap<String, String>, AppError> {
    runtime.hgetall(&build_inflight_resource_delta_key(character_id)).await
}

pub async fn finalize_claimed_character_resource_delta(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<(), AppError> {
    let _ = runtime.eval_i64(
        FINALIZE_RESOURCE_DELTA_LUA,
        &[
            RESOURCE_DELTA_DIRTY_INDEX_KEY,
            &build_resource_delta_key(character_id),
            &build_inflight_resource_delta_key(character_id),
        ],
        &[&character_id.to_string()],
    ).await?;
    Ok(())
}

pub async fn restore_claimed_character_resource_delta(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<(), AppError> {
    let _ = runtime.eval_i64(
        RESTORE_RESOURCE_DELTA_LUA,
        &[
            RESOURCE_DELTA_DIRTY_INDEX_KEY,
            &build_resource_delta_key(character_id),
            &build_inflight_resource_delta_key(character_id),
        ],
        &[&character_id.to_string()],
    ).await?;
    Ok(())
}

pub fn parse_resource_delta_hash(hash: HashMap<String, String>) -> HashMap<String, i64> {
    hash.into_iter().filter_map(|(field, value)| value.parse::<i64>().ok().map(|parsed| (field, parsed))).collect()
}

pub async fn flush_character_resource_deltas<F, Fut>(
    runtime: &RedisRuntime,
    limit: usize,
    processor: F,
) -> Result<Vec<i64>, AppError>
where
    F: Fn(i64, HashMap<String, i64>) -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
{
    let dirty_character_ids = list_dirty_character_ids_for_resource_delta(runtime, limit).await?;
    let mut flushed_character_ids = Vec::new();
    for character_id in dirty_character_ids {
        if !claim_character_resource_delta(runtime, character_id).await? {
            continue;
        }
        let claimed_hash = load_claimed_character_resource_delta_hash(runtime, character_id).await?;
        let parsed = parse_resource_delta_hash(claimed_hash);
        if parsed.is_empty() {
            finalize_claimed_character_resource_delta(runtime, character_id).await?;
            continue;
        }
        match processor(character_id, parsed).await {
            Ok(()) => {
                finalize_claimed_character_resource_delta(runtime, character_id).await?;
                flushed_character_ids.push(character_id);
            }
            Err(error) => {
                restore_claimed_character_resource_delta(runtime, character_id).await?;
                return Err(error);
            }
        }
    }
    Ok(flushed_character_ids)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    #[test]
    fn parse_resource_delta_hash_ignores_invalid_numbers() {
        let parsed = super::parse_resource_delta_hash(HashMap::from([
            ("silver".to_string(), "12".to_string()),
            ("exp".to_string(), "invalid".to_string()),
        ]));
        assert_eq!(parsed.get("silver"), Some(&12));
        assert!(!parsed.contains_key("exp"));
        println!("RESOURCE_DELTA_HASH={}", serde_json::json!(parsed));
    }
}
