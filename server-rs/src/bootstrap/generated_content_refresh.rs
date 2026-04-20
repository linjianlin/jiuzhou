use sqlx::Row;

use crate::shared::error::AppError;
use crate::state::AppState;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GeneratedContentRefreshSummary {
    pub published_generated_technique_count: usize,
    pub enabled_generated_skill_count: usize,
    pub enabled_generated_technique_layer_count: usize,
    pub enabled_generated_partner_count: usize,
}

pub(crate) async fn refresh_generated_content_on_startup(
    state: &AppState,
) -> Result<GeneratedContentRefreshSummary, AppError> {
    let published_generated_technique_count = count_rows(
        state,
        "SELECT COUNT(1)::bigint AS cnt FROM generated_technique_def WHERE is_published = TRUE AND enabled = TRUE",
    )
    .await?;
    let enabled_generated_skill_count = count_rows(
        state,
        "SELECT COUNT(1)::bigint AS cnt FROM generated_skill_def WHERE enabled = TRUE",
    )
    .await?;
    let enabled_generated_technique_layer_count = count_rows(
        state,
        "SELECT COUNT(1)::bigint AS cnt FROM generated_technique_layer WHERE enabled = TRUE",
    )
    .await?;
    let enabled_generated_partner_count = count_rows(
        state,
        "SELECT COUNT(1)::bigint AS cnt FROM generated_partner_def WHERE enabled = TRUE",
    )
    .await?;

    Ok(GeneratedContentRefreshSummary {
        published_generated_technique_count,
        enabled_generated_skill_count,
        enabled_generated_technique_layer_count,
        enabled_generated_partner_count,
    })
}

async fn count_rows(state: &AppState, sql: &str) -> Result<usize, AppError> {
    let row = state.database.fetch_one(sql, |query| query).await?;
    Ok(row
        .try_get::<Option<i64>, _>("cnt")?
        .unwrap_or_default()
        .max(0) as usize)
}

#[cfg(test)]
mod tests {
    use super::GeneratedContentRefreshSummary;

    #[test]
    fn generated_content_refresh_summary_defaults_to_zero() {
        assert_eq!(
            GeneratedContentRefreshSummary::default(),
            GeneratedContentRefreshSummary {
                published_generated_technique_count: 0,
                enabled_generated_skill_count: 0,
                enabled_generated_technique_layer_count: 0,
                enabled_generated_partner_count: 0,
            }
        );
    }
}
