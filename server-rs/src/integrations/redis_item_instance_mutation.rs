use std::collections::HashMap;
use std::future::Future;

use crate::integrations::redis::RedisRuntime;
use crate::shared::error::AppError;

pub const ITEM_INSTANCE_MUTATION_DIRTY_INDEX_KEY: &str = "character:item-instance-mutation:index";
pub const ITEM_INSTANCE_MUTATION_KEY_PREFIX: &str = "character:item-instance-mutation:";
pub const ITEM_INSTANCE_MUTATION_INFLIGHT_KEY_PREFIX: &str = "character:item-instance-mutation:inflight:";

const CLAIM_ITEM_INSTANCE_MUTATION_LUA: &str = r#"
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

const FINALIZE_ITEM_INSTANCE_MUTATION_LUA: &str = r#"
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

const RESTORE_ITEM_INSTANCE_MUTATION_LUA: &str = r#"
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
  redis.call('HSET', mainKey, inflightValues[i], inflightValues[i + 1])
end
redis.call('DEL', inflightKey)
redis.call('SADD', dirtyIndexKey, characterId)
return 1
"#;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct ItemInstanceMutationSnapshot {
    pub id: i64,
    pub owner_user_id: i64,
    pub owner_character_id: i64,
    pub item_def_id: String,
    pub qty: i64,
    pub quality: Option<String>,
    pub quality_rank: Option<i64>,
    pub bind_type: String,
    pub bind_owner_user_id: Option<i64>,
    pub bind_owner_character_id: Option<i64>,
    pub location: String,
    pub location_slot: Option<i64>,
    pub equipped_slot: Option<String>,
    pub strengthen_level: i64,
    pub refine_level: i64,
    pub socketed_gems: serde_json::Value,
    pub random_seed: Option<i64>,
    pub affixes: serde_json::Value,
    pub identified: bool,
    pub affix_gen_version: i64,
    pub affix_roll_meta: serde_json::Value,
    pub custom_name: Option<String>,
    pub locked: bool,
    pub expire_at: Option<String>,
    pub obtained_from: Option<String>,
    pub obtained_ref_id: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct BufferedItemInstanceMutation {
    pub op_id: String,
    pub character_id: i64,
    pub item_id: i64,
    pub created_at_ms: i64,
    pub kind: String,
    pub snapshot: Option<ItemInstanceMutationSnapshot>,
}

fn build_item_instance_mutation_key(character_id: i64) -> String {
    format!("{ITEM_INSTANCE_MUTATION_KEY_PREFIX}{character_id}")
}

fn build_inflight_item_instance_mutation_key(character_id: i64) -> String {
    format!("{ITEM_INSTANCE_MUTATION_INFLIGHT_KEY_PREFIX}{character_id}")
}

fn build_item_instance_mutation_field(item_id: i64) -> String {
    item_id.to_string()
}

fn normalize_mutation(mutation: &BufferedItemInstanceMutation) -> Option<BufferedItemInstanceMutation> {
    let op_id = mutation.op_id.trim();
    if mutation.character_id <= 0 || mutation.item_id <= 0 || op_id.is_empty() {
        return None;
    }
    match mutation.kind.trim() {
        "delete" => Some(BufferedItemInstanceMutation {
            op_id: op_id.to_string(),
            character_id: mutation.character_id,
            item_id: mutation.item_id,
            created_at_ms: mutation.created_at_ms.max(0),
            kind: "delete".to_string(),
            snapshot: None,
        }),
        _ => {
            let snapshot = mutation.snapshot.clone()?;
            (snapshot.id == mutation.item_id && snapshot.owner_character_id == mutation.character_id).then(|| BufferedItemInstanceMutation {
                op_id: op_id.to_string(),
                character_id: mutation.character_id,
                item_id: mutation.item_id,
                created_at_ms: mutation.created_at_ms.max(0),
                kind: "upsert".to_string(),
                snapshot: Some(snapshot),
            })
        }
    }
}

pub async fn buffer_item_instance_mutations(
    runtime: &RedisRuntime,
    mutations: &[BufferedItemInstanceMutation],
) -> Result<(), AppError> {
    let normalized = mutations.iter().filter_map(normalize_mutation).collect::<Vec<_>>();
    if normalized.is_empty() {
        return Ok(());
    }
    runtime.with_pipeline(|pipeline| {
        for mutation in &normalized {
            pipeline
                .cmd("HSET")
                .arg(build_item_instance_mutation_key(mutation.character_id))
                .arg(build_item_instance_mutation_field(mutation.item_id))
                .arg(serde_json::to_string(mutation).unwrap_or_else(|_| "{}".to_string()))
                .ignore()
                .cmd("SADD")
                .arg(ITEM_INSTANCE_MUTATION_DIRTY_INDEX_KEY)
                .arg(mutation.character_id.to_string())
                .ignore();
        }
    }).await
}

pub async fn list_dirty_character_ids_for_item_instance_mutation(
    runtime: &RedisRuntime,
    limit: usize,
) -> Result<Vec<i64>, AppError> {
    let values = runtime.srandmember(ITEM_INSTANCE_MUTATION_DIRTY_INDEX_KEY, limit.max(1)).await?;
    let mut normalized = values.into_iter().filter_map(|value| value.parse::<i64>().ok()).filter(|value| *value > 0).collect::<Vec<_>>();
    normalized.sort_unstable();
    Ok(normalized)
}

pub async fn claim_character_item_instance_mutations(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<bool, AppError> {
    Ok(runtime.eval_i64(
        CLAIM_ITEM_INSTANCE_MUTATION_LUA,
        &[
            ITEM_INSTANCE_MUTATION_DIRTY_INDEX_KEY,
            &build_item_instance_mutation_key(character_id),
            &build_inflight_item_instance_mutation_key(character_id),
        ],
        &[&character_id.to_string()],
    ).await? == 1)
}

pub async fn load_claimed_item_instance_mutation_hash(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<HashMap<String, String>, AppError> {
    runtime.hgetall(&build_inflight_item_instance_mutation_key(character_id)).await
}

pub async fn finalize_claimed_item_instance_mutations(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<(), AppError> {
    let _ = runtime.eval_i64(
        FINALIZE_ITEM_INSTANCE_MUTATION_LUA,
        &[
            ITEM_INSTANCE_MUTATION_DIRTY_INDEX_KEY,
            &build_item_instance_mutation_key(character_id),
            &build_inflight_item_instance_mutation_key(character_id),
        ],
        &[&character_id.to_string()],
    ).await?;
    Ok(())
}

pub async fn restore_claimed_item_instance_mutations(
    runtime: &RedisRuntime,
    character_id: i64,
) -> Result<(), AppError> {
    let _ = runtime.eval_i64(
        RESTORE_ITEM_INSTANCE_MUTATION_LUA,
        &[
            ITEM_INSTANCE_MUTATION_DIRTY_INDEX_KEY,
            &build_item_instance_mutation_key(character_id),
            &build_inflight_item_instance_mutation_key(character_id),
        ],
        &[&character_id.to_string()],
    ).await?;
    Ok(())
}

pub fn parse_item_instance_mutation_hash(hash: HashMap<String, String>) -> Vec<BufferedItemInstanceMutation> {
    let mut out = hash
        .into_values()
        .filter_map(|raw| serde_json::from_str::<BufferedItemInstanceMutation>(&raw).ok())
        .filter_map(|mutation| normalize_mutation(&mutation))
        .collect::<Vec<_>>();
    out.sort_by(|left, right| left.created_at_ms.cmp(&right.created_at_ms).then(left.op_id.cmp(&right.op_id)));
    out
}

pub async fn flush_item_instance_mutations<F, Fut>(
    runtime: &RedisRuntime,
    limit: usize,
    processor: F,
) -> Result<Vec<i64>, AppError>
where
    F: Fn(i64, Vec<BufferedItemInstanceMutation>) -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
{
    let dirty_character_ids = list_dirty_character_ids_for_item_instance_mutation(runtime, limit).await?;
    let mut flushed_character_ids = Vec::new();
    for character_id in dirty_character_ids {
        if !claim_character_item_instance_mutations(runtime, character_id).await? {
            continue;
        }
        let claimed_hash = load_claimed_item_instance_mutation_hash(runtime, character_id).await?;
        let parsed = parse_item_instance_mutation_hash(claimed_hash);
        if parsed.is_empty() {
            finalize_claimed_item_instance_mutations(runtime, character_id).await?;
            continue;
        }
        match processor(character_id, parsed).await {
            Ok(()) => {
                finalize_claimed_item_instance_mutations(runtime, character_id).await?;
                flushed_character_ids.push(character_id);
            }
            Err(error) => {
                restore_claimed_item_instance_mutations(runtime, character_id).await?;
                return Err(error);
            }
        }
    }
    Ok(flushed_character_ids)
}

#[cfg(test)]
mod tests {
    use super::{BufferedItemInstanceMutation, ItemInstanceMutationSnapshot, parse_item_instance_mutation_hash};
    use std::collections::HashMap;

    #[test]
    fn parse_item_instance_mutation_hash_reads_mail_relocation() {
        let mutation = BufferedItemInstanceMutation {
            op_id: "market-cancel:1:1".to_string(),
            character_id: 9,
            item_id: 77,
            created_at_ms: 123,
            kind: "upsert".to_string(),
            snapshot: Some(ItemInstanceMutationSnapshot {
                id: 77,
                owner_user_id: 8,
                owner_character_id: 9,
                item_def_id: "equip-weapon-001".to_string(),
                qty: 1,
                quality: Some("黄".to_string()),
                quality_rank: Some(1),
                bind_type: "none".to_string(),
                bind_owner_user_id: None,
                bind_owner_character_id: None,
                location: "mail".to_string(),
                location_slot: None,
                equipped_slot: None,
                strengthen_level: 0,
                refine_level: 0,
                socketed_gems: serde_json::json!([]),
                random_seed: None,
                affixes: serde_json::json!([]),
                identified: true,
                affix_gen_version: 0,
                affix_roll_meta: serde_json::json!({}),
                custom_name: None,
                locked: false,
                expire_at: None,
                obtained_from: Some("market".to_string()),
                obtained_ref_id: Some("listing-1".to_string()),
                metadata: None,
            }),
        };
        let parsed = parse_item_instance_mutation_hash(HashMap::from([(
            "77".to_string(),
            serde_json::to_string(&mutation).expect("mutation should serialize"),
        )]));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].snapshot.as_ref().map(|snapshot| snapshot.location.as_str()), Some("mail"));
        println!("ITEM_INSTANCE_MUTATION_DELTA={}", serde_json::json!({"itemId": parsed[0].item_id, "location": parsed[0].snapshot.as_ref().map(|snapshot| snapshot.location.clone())}));
    }
}
