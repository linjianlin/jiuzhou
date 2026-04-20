use std::path::PathBuf;

use tokio::fs;

use crate::config::StorageConfig;
use crate::shared::error::AppError;
use crate::state::AppState;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AvatarCleanupSummary {
    pub enabled: bool,
    pub cleared_avatar_row_count: usize,
    pub deleted_local_file_count: usize,
}

pub async fn clear_all_avatars_once(state: &AppState) -> Result<AvatarCleanupSummary, AppError> {
    let enabled = std::env::var("CLEAR_AVATARS")
        .ok()
        .map(|value| value == "1")
        .unwrap_or(false);
    if !enabled {
        return Ok(AvatarCleanupSummary {
            enabled: false,
            ..AvatarCleanupSummary::default()
        });
    }

    let rows = state
        .database
        .fetch_all(
            "UPDATE characters SET avatar = NULL, updated_at = CURRENT_TIMESTAMP WHERE avatar IS NOT NULL RETURNING id",
            |query| query,
        )
        .await?;
    let deleted_local_file_count = clear_local_avatar_files(&state.config.storage).await?;
    Ok(AvatarCleanupSummary {
        enabled: true,
        cleared_avatar_row_count: rows.len(),
        deleted_local_file_count,
    })
}

async fn clear_local_avatar_files(storage: &StorageConfig) -> Result<usize, AppError> {
    let avatar_dir: PathBuf = storage.uploads_dir.join("avatars");
    if !avatar_dir.exists() {
        return Ok(0);
    }

    let mut entries = fs::read_dir(&avatar_dir).await?;
    let mut deleted = 0_usize;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let metadata = entry.metadata().await?;
        if metadata.is_file() {
            fs::remove_file(path).await?;
            deleted += 1;
        }
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::clear_local_avatar_files;
    use crate::config::StorageConfig;

    #[tokio::test]
    async fn clear_local_avatar_files_removes_uploaded_files_only() {
        let temp_dir = std::env::temp_dir().join(format!(
            "server-rs-avatar-cleanup-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let avatar_dir = temp_dir.join("avatars");
        tokio::fs::create_dir_all(&avatar_dir).await.expect("avatar dir should exist");
        tokio::fs::write(avatar_dir.join("avatar-a.png"), b"a").await.expect("avatar a should write");
        tokio::fs::write(avatar_dir.join("avatar-b.png"), b"b").await.expect("avatar b should write");
        tokio::fs::create_dir_all(avatar_dir.join("nested")).await.expect("nested dir should write");

        let deleted = clear_local_avatar_files(&StorageConfig { uploads_dir: temp_dir.clone() })
            .await
            .expect("avatar cleanup should succeed");

        assert_eq!(deleted, 2);
        assert!(avatar_dir.join("nested").exists());
        println!("AVATAR_CLEANUP_DELETED_COUNT={deleted}");
    }
}
