use sqlx::Row;

use crate::shared::error::AppError;
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PerformanceIndexDefinition {
    pub name: &'static str,
    pub create_sql: &'static str,
    pub match_fragments: &'static [&'static str],
}

pub const PERFORMANCE_INDEX_DEFINITIONS: &[PerformanceIndexDefinition] = &[
    PerformanceIndexDefinition {
        name: "idx_mail_character_active_scope",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_mail_character_active_scope ON mail (recipient_character_id, (COALESCE(expire_at, 'infinity'::timestamptz)), created_at DESC, id DESC) WHERE deleted_at IS NULL",
        match_fragments: &[
            "recipient_character_id",
            "COALESCE(expire_at, 'infinity'::timestamp with time zone)",
            "created_at DESC",
            "id DESC",
            "deleted_at IS NULL",
        ],
    },
    PerformanceIndexDefinition {
        name: "idx_mail_character_active_counter",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_mail_character_active_counter ON mail (recipient_character_id, (COALESCE(expire_at, 'infinity'::timestamptz))) INCLUDE (read_at, claimed_at, attach_silver, attach_spirit_stones) WHERE deleted_at IS NULL",
        match_fragments: &[
            "recipient_character_id",
            "COALESCE(expire_at, 'infinity'::timestamp with time zone)",
            "INCLUDE (read_at, claimed_at, attach_silver, attach_spirit_stones)",
            "deleted_at IS NULL",
        ],
    },
    PerformanceIndexDefinition {
        name: "idx_mail_user_active_scope",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_mail_user_active_scope ON mail (recipient_user_id, (COALESCE(expire_at, 'infinity'::timestamptz)), created_at DESC, id DESC) WHERE deleted_at IS NULL AND recipient_character_id IS NULL",
        match_fragments: &[
            "recipient_user_id",
            "COALESCE(expire_at, 'infinity'::timestamp with time zone)",
            "created_at DESC",
            "id DESC",
            "deleted_at IS NULL",
            "recipient_character_id IS NULL",
        ],
    },
    PerformanceIndexDefinition {
        name: "idx_mail_user_active_counter",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_mail_user_active_counter ON mail (recipient_user_id, (COALESCE(expire_at, 'infinity'::timestamptz))) INCLUDE (read_at, claimed_at, attach_silver, attach_spirit_stones) WHERE deleted_at IS NULL AND recipient_character_id IS NULL",
        match_fragments: &[
            "recipient_user_id",
            "COALESCE(expire_at, 'infinity'::timestamp with time zone)",
            "INCLUDE (read_at, claimed_at, attach_silver, attach_spirit_stones)",
            "deleted_at IS NULL",
            "recipient_character_id IS NULL",
        ],
    },
    PerformanceIndexDefinition {
        name: "idx_mail_character_expire_cleanup",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_mail_character_expire_cleanup ON mail (recipient_character_id, expire_at) WHERE deleted_at IS NULL AND expire_at IS NOT NULL",
        match_fragments: &[
            "recipient_character_id",
            "expire_at",
            "deleted_at IS NULL",
            "expire_at IS NOT NULL",
        ],
    },
    PerformanceIndexDefinition {
        name: "idx_mail_user_expire_cleanup",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_mail_user_expire_cleanup ON mail (recipient_user_id, expire_at) WHERE recipient_character_id IS NULL AND deleted_at IS NULL AND expire_at IS NOT NULL",
        match_fragments: &[
            "recipient_user_id",
            "expire_at",
            "recipient_character_id IS NULL",
            "deleted_at IS NULL",
            "expire_at IS NOT NULL",
        ],
    },
    PerformanceIndexDefinition {
        name: "idx_mail_deleted_history_cleanup",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_mail_deleted_history_cleanup ON mail (deleted_at, id) WHERE deleted_at IS NOT NULL",
        match_fragments: &["deleted_at", "id", "deleted_at IS NOT NULL"],
    },
    PerformanceIndexDefinition {
        name: "idx_mail_expired_history_cleanup",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_mail_expired_history_cleanup ON mail (expire_at, id) WHERE deleted_at IS NULL AND expire_at IS NOT NULL",
        match_fragments: &[
            "expire_at",
            "id",
            "deleted_at IS NULL",
            "expire_at IS NOT NULL",
        ],
    },
    PerformanceIndexDefinition {
        name: "idx_item_instance_stackable_lookup",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_item_instance_stackable_lookup ON item_instance (owner_character_id, location, item_def_id, (COALESCE(NULLIF(LOWER(BTRIM(bind_type)), ''), 'none')), qty DESC, id ASC) WHERE (metadata IS NULL OR LOWER(BTRIM(metadata::text)) = 'null') AND (quality IS NULL OR BTRIM(quality) = '') AND (quality_rank IS NULL OR quality_rank <= 0)",
        match_fragments: &[
            "owner_character_id",
            "location",
            "item_def_id",
            "COALESCE(NULLIF(LOWER(BTRIM(bind_type)), ''), 'none')",
            "qty DESC",
            "id",
            "metadata IS NULL OR LOWER(BTRIM(metadata::text)) = 'null'",
            "quality IS NULL OR BTRIM(quality) = ''",
            "quality_rank IS NULL OR quality_rank <= 0",
        ],
    },
    PerformanceIndexDefinition {
        name: "idx_character_task_progress_active_lookup",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_character_task_progress_active_lookup ON character_task_progress (character_id, status, task_id) INCLUDE (progress, tracked, accepted_at, completed_at, claimed_at) WHERE status IS DISTINCT FROM 'claimed'",
        match_fragments: &[
            "character_task_progress",
            "character_id",
            "status",
            "task_id",
            "INCLUDE (progress, tracked, accepted_at, completed_at, claimed_at)",
            "status IS DISTINCT FROM 'claimed'",
        ],
    },
    PerformanceIndexDefinition {
        name: "idx_market_listing_item_instance_id",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_market_listing_item_instance_id ON market_listing (item_instance_id) WHERE item_instance_id IS NOT NULL",
        match_fragments: &["item_instance_id", "item_instance_id IS NOT NULL"],
    },
    PerformanceIndexDefinition {
        name: "idx_generated_technique_def_published_id",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_generated_technique_def_published_id ON generated_technique_def (id) WHERE is_published = true AND enabled = true",
        match_fragments: &[
            "generated_technique_def",
            "id",
            "is_published = true",
            "enabled = true",
        ],
    },
    PerformanceIndexDefinition {
        name: "idx_generated_skill_def_enabled_sort_source",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_generated_skill_def_enabled_sort_source ON generated_skill_def (sort_weight DESC, id ASC) INCLUDE (source_id) WHERE enabled = true",
        match_fragments: &[
            "generated_skill_def",
            "sort_weight DESC",
            "id",
            "include (source_id)",
            "enabled = true",
        ],
    },
    PerformanceIndexDefinition {
        name: "idx_generated_technique_layer_enabled_order",
        create_sql: "CREATE INDEX IF NOT EXISTS idx_generated_technique_layer_enabled_order ON generated_technique_layer (technique_id, layer ASC) WHERE enabled = true",
        match_fragments: &[
            "generated_technique_layer",
            "technique_id",
            "layer",
            "enabled = true",
        ],
    },
];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PerformanceIndexSummary {
    pub ensured_index_count: usize,
    pub rebuilt_index_count: usize,
}

pub async fn ensure_performance_indexes(
    state: &AppState,
) -> Result<PerformanceIndexSummary, AppError> {
    let mut summary = PerformanceIndexSummary::default();
    for definition in PERFORMANCE_INDEX_DEFINITIONS {
        let existing_definition = load_existing_index_definition(state, definition.name).await?;
        if let Some(existing_definition) = existing_definition {
            if matches_expected_fragments(&existing_definition, definition.match_fragments) {
                summary.ensured_index_count += 1;
                continue;
            }
            state
                .database
                .execute(
                    &format!("DROP INDEX IF EXISTS {}", definition.name),
                    |query| query,
                )
                .await?;
            summary.rebuilt_index_count += 1;
        }
        state
            .database
            .execute(definition.create_sql, |query| query)
            .await?;
        summary.ensured_index_count += 1;
    }
    Ok(summary)
}

async fn load_existing_index_definition(
    state: &AppState,
    index_name: &str,
) -> Result<Option<String>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1 LIMIT 1",
            |query| query.bind(index_name),
        )
        .await?;
    Ok(row.and_then(|row| row.try_get::<Option<String>, _>("indexdef").ok().flatten()))
}

fn normalize_sql(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn matches_expected_fragments(index_definition_sql: &str, fragments: &[&str]) -> bool {
    let normalized = normalize_sql(index_definition_sql);
    fragments
        .iter()
        .all(|fragment| normalized.contains(&normalize_sql(fragment)))
}

#[cfg(test)]
mod tests {
    use super::{PERFORMANCE_INDEX_DEFINITIONS, matches_expected_fragments};

    #[test]
    fn performance_index_definitions_cover_expected_hotspots() {
        assert!(PERFORMANCE_INDEX_DEFINITIONS.len() >= 13);
        assert!(
            PERFORMANCE_INDEX_DEFINITIONS
                .iter()
                .any(|definition| definition.name == "idx_item_instance_stackable_lookup")
        );
        assert!(
            PERFORMANCE_INDEX_DEFINITIONS
                .iter()
                .any(|definition| definition.name == "idx_market_listing_item_instance_id")
        );
        println!(
            "PERFORMANCE_INDEX_DEFINITION_COUNT={}",
            PERFORMANCE_INDEX_DEFINITIONS.len()
        );
    }

    #[test]
    fn performance_index_fragment_matcher_is_whitespace_insensitive() {
        let sql = "CREATE INDEX IF NOT EXISTS idx_test ON mail (recipient_character_id, expire_at) WHERE deleted_at IS NULL";
        assert!(matches_expected_fragments(
            sql,
            &["recipient_character_id", "deleted_at IS NULL"]
        ));
        assert!(!matches_expected_fragments(sql, &["recipient_user_id"]));
    }
}
