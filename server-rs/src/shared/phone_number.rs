use crate::shared::error::AppError;

pub fn normalize_mainland_phone_number(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    let without_separators = trimmed.replace([' ', '-'], "");
    let normalized = if without_separators.starts_with("+86") {
        without_separators[3..].to_string()
    } else if without_separators.starts_with("86") && without_separators.len() == 13 {
        without_separators[2..].to_string()
    } else {
        without_separators
    };

    let valid = normalized.len() == 11
        && normalized.starts_with('1')
        && normalized.chars().all(|ch| ch.is_ascii_digit())
        && matches!(normalized.as_bytes().get(1), Some(b'3'..=b'9'));
    if !valid {
        return Err(AppError::config("手机号格式错误，请输入正确的大陆手机号"));
    }
    Ok(normalized)
}

pub fn mask_phone_number(phone_number: &str) -> Option<String> {
    let normalized = phone_number.trim();
    if normalized.len() < 7 {
        return None;
    }
    Some(format!("{}****{}", &normalized[..3], &normalized[7..]))
}

#[cfg(test)]
mod tests {
    #[test]
    fn normalize_accepts_plus_86_and_spaces() {
        let normalized = super::normalize_mainland_phone_number("+86 138-1234-0000")
            .expect("phone should normalize");
        assert_eq!(normalized, "13812340000");
    }

    #[test]
    fn normalize_rejects_invalid_phone() {
        let error = super::normalize_mainland_phone_number("10086").expect_err("phone should fail");
        assert_eq!(
            error.client_message(),
            "手机号格式错误，请输入正确的大陆手机号"
        );
    }

    #[test]
    fn mask_preserves_prefix_and_suffix() {
        assert_eq!(
            super::mask_phone_number("13812340000").as_deref(),
            Some("138****0000")
        );
    }
}
