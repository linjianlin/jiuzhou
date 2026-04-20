use sqlx::Row;

use crate::shared::error::AppError;
use crate::state::AppState;

#[derive(Debug, Clone, Copy, Default)]
pub struct MailCounterSnapshot {
    pub total_count: i64,
    pub unread_count: i64,
    pub unclaimed_count: i64,
}

#[derive(Debug, Clone)]
pub struct MailCounterDeltaInput {
    pub scope_type: &'static str,
    pub scope_id: i64,
    pub total_count_delta: i64,
    pub unread_count_delta: i64,
    pub unclaimed_count_delta: i64,
}

#[derive(Debug, Clone)]
pub struct MailCounterStateSnapshot {
    pub recipient_user_id: i64,
    pub recipient_character_id: Option<i64>,
    pub is_unread: bool,
    pub is_unclaimed: bool,
}

async fn query_live_mail_counter_snapshot(
    state: &AppState,
    character_id: i64,
    user_id: i64,
) -> Result<MailCounterSnapshot, AppError> {
    let row = state.database.fetch_optional(
        "SELECT COALESCE(SUM(total_count), 0)::bigint AS total_count, COALESCE(SUM(unread_count), 0)::bigint AS unread_count, COALESCE(SUM(unclaimed_count), 0)::bigint AS unclaimed_count FROM ( SELECT COUNT(*)::bigint AS total_count, COUNT(*) FILTER (WHERE read_at IS NULL)::bigint AS unread_count, COUNT(*) FILTER (WHERE claimed_at IS NULL AND (attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL OR attach_rewards IS NOT NULL OR attach_instance_ids IS NOT NULL))::bigint AS unclaimed_count FROM mail WHERE recipient_character_id = $1 AND deleted_at IS NULL AND COALESCE(expire_at, 'infinity'::timestamptz) > NOW() UNION ALL SELECT COUNT(*)::bigint AS total_count, COUNT(*) FILTER (WHERE read_at IS NULL)::bigint AS unread_count, COUNT(*) FILTER (WHERE claimed_at IS NULL AND (attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL OR attach_rewards IS NOT NULL OR attach_instance_ids IS NOT NULL))::bigint AS unclaimed_count FROM mail WHERE recipient_character_id IS NULL AND recipient_user_id = $2 AND deleted_at IS NULL AND COALESCE(expire_at, 'infinity'::timestamptz) > NOW() ) AS snapshot",
        |query| query.bind(character_id).bind(user_id),
    ).await?;
    let row = row.ok_or_else(|| AppError::config("邮件计数快照缺失"))?;
    Ok(MailCounterSnapshot {
        total_count: row.try_get::<Option<i64>, _>("total_count")?.unwrap_or_default(),
        unread_count: row.try_get::<Option<i64>, _>("unread_count")?.unwrap_or_default(),
        unclaimed_count: row.try_get::<Option<i64>, _>("unclaimed_count")?.unwrap_or_default(),
    })
}

pub async fn load_mail_counter_snapshot(
    state: &AppState,
    character_id: i64,
    user_id: i64,
) -> Result<MailCounterSnapshot, AppError> {
    query_live_mail_counter_snapshot(state, character_id, user_id).await
}

pub async fn rebuild_mail_counter_snapshot_for_actor(
    state: &AppState,
    character_id: i64,
    user_id: i64,
) -> Result<MailCounterSnapshot, AppError> {
    state.database.execute(
        "DELETE FROM mail_counter WHERE (scope_type = 'character' AND scope_id = $1) OR (scope_type = 'user' AND scope_id = $2)",
        |query| query.bind(character_id).bind(user_id),
    ).await?;
    state.database.execute(
        "INSERT INTO mail_counter (scope_type, scope_id, total_count, unread_count, unclaimed_count, updated_at) SELECT aggregated.scope_type, aggregated.scope_id, aggregated.total_count, aggregated.unread_count, aggregated.unclaimed_count, NOW() FROM ( SELECT 'character'::varchar(16) AS scope_type, recipient_character_id AS scope_id, COUNT(*)::bigint AS total_count, COUNT(*) FILTER (WHERE read_at IS NULL)::bigint AS unread_count, COUNT(*) FILTER (WHERE claimed_at IS NULL AND (attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL OR attach_rewards IS NOT NULL OR attach_instance_ids IS NOT NULL))::bigint AS unclaimed_count FROM mail WHERE recipient_character_id = $1 AND deleted_at IS NULL AND COALESCE(expire_at, 'infinity'::timestamptz) > NOW() GROUP BY recipient_character_id UNION ALL SELECT 'user'::varchar(16) AS scope_type, recipient_user_id AS scope_id, COUNT(*)::bigint AS total_count, COUNT(*) FILTER (WHERE read_at IS NULL)::bigint AS unread_count, COUNT(*) FILTER (WHERE claimed_at IS NULL AND (attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL OR attach_rewards IS NOT NULL OR attach_instance_ids IS NOT NULL))::bigint AS unclaimed_count FROM mail WHERE recipient_character_id IS NULL AND recipient_user_id = $2 AND deleted_at IS NULL AND COALESCE(expire_at, 'infinity'::timestamptz) > NOW() GROUP BY recipient_user_id ) AS aggregated",
        |query| query.bind(character_id).bind(user_id),
    ).await?;
    query_live_mail_counter_snapshot(state, character_id, user_id).await
}

pub async fn apply_mail_counter_deltas(
    state: &AppState,
    deltas: &[MailCounterDeltaInput],
) -> Result<(), AppError> {
    if deltas.is_empty() {
        return Ok(());
    }

    for delta in deltas.iter().filter(|delta| {
        delta.scope_id > 0
            && (delta.total_count_delta != 0 || delta.unread_count_delta != 0 || delta.unclaimed_count_delta != 0)
    }) {
        state.database.execute(
            "INSERT INTO mail_counter (scope_type, scope_id, total_count, unread_count, unclaimed_count, updated_at) VALUES ($1, $2, $3, $4, $5, NOW()) ON CONFLICT (scope_type, scope_id) DO UPDATE SET total_count = GREATEST(0, mail_counter.total_count + EXCLUDED.total_count), unread_count = GREATEST(0, mail_counter.unread_count + EXCLUDED.unread_count), unclaimed_count = GREATEST(0, mail_counter.unclaimed_count + EXCLUDED.unclaimed_count), updated_at = NOW()",
            |query| query
                .bind(delta.scope_type)
                .bind(delta.scope_id)
                .bind(delta.total_count_delta)
                .bind(delta.unread_count_delta)
                .bind(delta.unclaimed_count_delta),
        ).await?;
        state.database.execute(
            "DELETE FROM mail_counter WHERE scope_type = $1 AND scope_id = $2 AND total_count <= 0 AND unread_count <= 0 AND unclaimed_count <= 0",
            |query| query.bind(delta.scope_type).bind(delta.scope_id),
        ).await?;
    }
    Ok(())
}

pub fn build_new_mail_counter_deltas(
    recipient_user_id: i64,
    recipient_character_id: Option<i64>,
    has_attachments: bool,
) -> Vec<MailCounterDeltaInput> {
    if let Some(character_id) = recipient_character_id.filter(|id| *id > 0) {
        vec![MailCounterDeltaInput {
            scope_type: "character",
            scope_id: character_id,
            total_count_delta: 1,
            unread_count_delta: 1,
            unclaimed_count_delta: if has_attachments { 1 } else { 0 },
        }]
    } else if recipient_user_id > 0 {
        vec![MailCounterDeltaInput {
            scope_type: "user",
            scope_id: recipient_user_id,
            total_count_delta: 1,
            unread_count_delta: 1,
            unclaimed_count_delta: if has_attachments { 1 } else { 0 },
        }]
    } else {
        Vec::new()
    }
}

pub fn build_mail_counter_state(
    recipient_user_id: i64,
    recipient_character_id: Option<i64>,
    read_at: Option<&str>,
    claimed_at: Option<&str>,
    has_attachments: bool,
) -> Option<MailCounterStateSnapshot> {
    if recipient_user_id <= 0 {
        return None;
    }
    Some(MailCounterStateSnapshot {
        recipient_user_id,
        recipient_character_id: recipient_character_id.filter(|id| *id > 0),
        is_unread: read_at.map(|value| value.trim().is_empty()).unwrap_or(true),
        is_unclaimed: claimed_at.map(|value| value.trim().is_empty()).unwrap_or(true) && has_attachments,
    })
}

pub fn build_mail_counter_read_delta(state: &MailCounterStateSnapshot) -> Option<MailCounterDeltaInput> {
    if !state.is_unread {
        return None;
    }
    Some(MailCounterDeltaInput {
        scope_type: if state.recipient_character_id.is_some() { "character" } else { "user" },
        scope_id: state.recipient_character_id.unwrap_or(state.recipient_user_id),
        total_count_delta: 0,
        unread_count_delta: -1,
        unclaimed_count_delta: 0,
    })
}

pub fn build_mail_counter_claim_delta(state: &MailCounterStateSnapshot) -> Option<MailCounterDeltaInput> {
    if !state.is_unread && !state.is_unclaimed {
        return None;
    }
    Some(MailCounterDeltaInput {
        scope_type: if state.recipient_character_id.is_some() { "character" } else { "user" },
        scope_id: state.recipient_character_id.unwrap_or(state.recipient_user_id),
        total_count_delta: 0,
        unread_count_delta: if state.is_unread { -1 } else { 0 },
        unclaimed_count_delta: if state.is_unclaimed { -1 } else { 0 },
    })
}

pub fn build_mail_counter_delete_delta(state: &MailCounterStateSnapshot) -> MailCounterDeltaInput {
    MailCounterDeltaInput {
        scope_type: if state.recipient_character_id.is_some() { "character" } else { "user" },
        scope_id: state.recipient_character_id.unwrap_or(state.recipient_user_id),
        total_count_delta: -1,
        unread_count_delta: if state.is_unread { -1 } else { 0 },
        unclaimed_count_delta: if state.is_unclaimed { -1 } else { 0 },
    }
}

pub async fn backfill_mail_counter_if_empty(state: &AppState) -> Result<(), AppError> {
    let row = state.database.fetch_one(
        "SELECT COUNT(*)::bigint AS cnt FROM mail_counter",
        |query| query,
    ).await?;
    let existing = row.try_get::<Option<i64>, _>("cnt")?.unwrap_or_default();
    if existing > 0 {
        return Ok(());
    }
    state.database.execute(
        "INSERT INTO mail_counter (scope_type, scope_id, total_count, unread_count, unclaimed_count, updated_at) SELECT aggregated.scope_type, aggregated.scope_id, aggregated.total_count, aggregated.unread_count, aggregated.unclaimed_count, NOW() FROM ( SELECT 'character'::varchar(16) AS scope_type, recipient_character_id AS scope_id, COUNT(*)::bigint AS total_count, COUNT(*) FILTER (WHERE read_at IS NULL)::bigint AS unread_count, COUNT(*) FILTER (WHERE claimed_at IS NULL AND (attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL OR attach_rewards IS NOT NULL OR attach_instance_ids IS NOT NULL))::bigint AS unclaimed_count FROM mail WHERE recipient_character_id IS NOT NULL AND deleted_at IS NULL AND COALESCE(expire_at, 'infinity'::timestamptz) > NOW() GROUP BY recipient_character_id UNION ALL SELECT 'user'::varchar(16) AS scope_type, recipient_user_id AS scope_id, COUNT(*)::bigint AS total_count, COUNT(*) FILTER (WHERE read_at IS NULL)::bigint AS unread_count, COUNT(*) FILTER (WHERE claimed_at IS NULL AND (attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL OR attach_rewards IS NOT NULL OR attach_instance_ids IS NOT NULL))::bigint AS unclaimed_count FROM mail WHERE recipient_character_id IS NULL AND recipient_user_id IS NOT NULL AND deleted_at IS NULL AND COALESCE(expire_at, 'infinity'::timestamptz) > NOW() GROUP BY recipient_user_id ) AS aggregated",
        |query| query,
    ).await?;
    Ok(())
}
