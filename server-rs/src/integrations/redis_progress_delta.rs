use std::collections::HashMap;
use std::future::Future;

use crate::integrations::redis::RedisRuntime;
use crate::shared::error::AppError;

pub const PROGRESS_DELTA_DIRTY_INDEX_KEY: &str = "character:progress-delta:index";
pub const PROGRESS_DELTA_KEY_PREFIX: &str = "character:progress-delta:";
pub const PROGRESS_DELTA_INFLIGHT_KEY_PREFIX: &str = "character:progress-delta:inflight:";

const CLAIM_PROGRESS_DELTA_LUA: &str = r#"
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

const FINALIZE_CLAIMED_PROGRESS_DELTA_LUA: &str = r#"
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

const RESTORE_CLAIMED_PROGRESS_DELTA_LUA: &str = r#"
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
pub struct CharacterProgressDeltaField {
    pub character_id: i64,
    pub field: String,
    pub increment: i64,
}

fn build_progress_delta_key(character_id: i64) -> String {
    format!("{PROGRESS_DELTA_KEY_PREFIX}{character_id}")
}

fn build_inflight_progress_delta_key(character_id: i64) -> String {
    format!("{PROGRESS_DELTA_INFLIGHT_KEY_PREFIX}{character_id}")
}

pub async fn buffer_character_progress_delta_fields(
    runtime: &RedisRuntime,
    fields: &[CharacterProgressDeltaField],
) -> Result<(), AppError> {
    let normalized: Vec<_> = fields
        .iter()
        .filter_map(|field| {
            let character_id = field.character_id;
            let increment = field.increment;
            let normalized_field = field.field.trim();
            (character_id > 0 && increment > 0 && !normalized_field.is_empty()).then(|| {
                (character_id, normalized_field.to_string(), increment)
            })
        })
        .collect();

    if normalized.is_empty() {
        return Ok(());
    }

    runtime
        .with_pipeline(|pipeline| {
            for (character_id, field, increment) in &normalized {
                pipeline
                    .cmd("HINCRBY")
                    .arg(build_progress_delta_key(*character_id))
                    .arg(field)
                    .arg(*increment)
                    .ignore()
                    .cmd("SADD")
                    .arg(PROGRESS_DELTA_DIRTY_INDEX_KEY)
                    .arg(character_id.to_string())
                    .ignore();
            }
        })
        .await
}

pub async fn list_dirty_character_ids_for_progress_delta(
    runtime: &RedisRuntime,
    limit: usize,
) -> Result<Vec<i64>, AppError> {
    let values = runtime
        .srandmember(PROGRESS_DELTA_DIRTY_INDEX_KEY, limit.max(1))
        .await?;
    let mut normalized: Vec<i64> = values
        .into_iter()
        .filter_map(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .collect();
    normalized.sort_unstable();
    Ok(normalized)
}

pub async fn claim_character_progress_delta(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<bool, AppError> {
    Ok(runtime
        .eval_i64(
            CLAIM_PROGRESS_DELTA_LUA,
            &[
                PROGRESS_DELTA_DIRTY_INDEX_KEY,
                &build_progress_delta_key(character_id),
                &build_inflight_progress_delta_key(character_id),
            ],
            &[&character_id.to_string()],
        )
        .await?
        == 1)
}

pub async fn load_claimed_character_progress_delta_hash(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<HashMap<String, String>, AppError> {
    runtime
        .hgetall(&build_inflight_progress_delta_key(character_id))
        .await
}

pub async fn finalize_claimed_character_progress_delta(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<(), AppError> {
    let _ = runtime
        .eval_i64(
            FINALIZE_CLAIMED_PROGRESS_DELTA_LUA,
            &[
                PROGRESS_DELTA_DIRTY_INDEX_KEY,
                &build_progress_delta_key(character_id),
                &build_inflight_progress_delta_key(character_id),
            ],
            &[&character_id.to_string()],
        )
        .await?;
    Ok(())
}

pub async fn restore_claimed_character_progress_delta(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<(), AppError> {
    let _ = runtime
        .eval_i64(
            RESTORE_CLAIMED_PROGRESS_DELTA_LUA,
            &[
                PROGRESS_DELTA_DIRTY_INDEX_KEY,
                &build_progress_delta_key(character_id),
                &build_inflight_progress_delta_key(character_id),
            ],
            &[&character_id.to_string()],
        )
        .await?;
    Ok(())
}

pub fn parse_progress_delta_hash(hash: HashMap<String, String>) -> HashMap<String, i64> {
    hash.into_iter()
        .filter_map(|(field, value)| value.parse::<i64>().ok().map(|parsed| (field, parsed)))
        .collect()
}

pub async fn flush_character_progress_deltas<F, Fut>(
    runtime: &RedisRuntime,
    limit: usize,
    processor: F,
) -> Result<Vec<i64>, AppError>
where
    F: Fn(i64, HashMap<String, i64>) -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
{
    let dirty_character_ids = list_dirty_character_ids_for_progress_delta(runtime, limit).await?;
    let mut flushed_character_ids = Vec::new();

    for character_id in dirty_character_ids {
        if !claim_character_progress_delta(runtime, character_id).await? {
            continue;
        }

        let claimed_hash = load_claimed_character_progress_delta_hash(runtime, character_id).await?;
        let parsed_hash = parse_progress_delta_hash(claimed_hash);
        if parsed_hash.is_empty() {
            finalize_claimed_character_progress_delta(runtime, character_id).await?;
            continue;
        }

        match processor(character_id, parsed_hash).await {
            Ok(()) => {
                finalize_claimed_character_progress_delta(runtime, character_id).await?;
                flushed_character_ids.push(character_id);
            }
            Err(error) => {
                restore_claimed_character_progress_delta(runtime, character_id).await?;
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
    fn parse_progress_delta_hash_ignores_invalid_numbers() {
        let parsed = super::parse_progress_delta_hash(HashMap::from([
            ("task:1".to_string(), "2".to_string()),
            ("task:2".to_string(), "invalid".to_string()),
        ]));

        assert_eq!(parsed.get("task:1"), Some(&2));
        assert!(!parsed.contains_key("task:2"));
    }
}
