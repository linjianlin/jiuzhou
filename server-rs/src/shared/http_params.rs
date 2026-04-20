pub fn get_single_param(value: Option<&str>) -> String {
    value.unwrap_or_default().to_string()
}

pub fn get_single_query_value(value: Option<&str>) -> String {
    value.unwrap_or_default().to_string()
}

pub fn parse_positive_int(value: impl AsRef<str>) -> Option<i64> {
    let parsed = value.as_ref().trim().parse::<i64>().ok()?;
    (parsed > 0).then_some(parsed)
}

pub fn parse_non_empty_text(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim();
    (!normalized.is_empty()).then(|| normalized.to_string())
}

pub fn parse_finite_number(value: impl AsRef<str>) -> Option<f64> {
    let normalized = value.as_ref().trim();
    if normalized.is_empty() {
        return None;
    }

    let parsed = normalized.parse::<f64>().ok()?;
    parsed.is_finite().then_some(parsed)
}

#[cfg(test)]
mod tests {
    use super::{
        get_single_param, get_single_query_value, parse_finite_number, parse_non_empty_text,
        parse_positive_int,
    };

    #[test]
    fn get_single_param_defaults_to_empty_string() {
        assert_eq!(get_single_param(None), "");
        assert_eq!(get_single_param(Some("chapter-1")), "chapter-1");
    }

    #[test]
    fn get_single_query_value_defaults_to_empty_string() {
        assert_eq!(get_single_query_value(None), "");
        assert_eq!(get_single_query_value(Some("20")), "20");
    }

    #[test]
    fn parse_positive_int_accepts_only_positive_integers() {
        assert_eq!(parse_positive_int("10"), Some(10));
        assert_eq!(parse_positive_int("0"), None);
        assert_eq!(parse_positive_int("-1"), None);
        assert_eq!(parse_positive_int("1.5"), None);
    }

    #[test]
    fn parse_non_empty_text_trims_whitespace() {
        assert_eq!(
            parse_non_empty_text(Some("  hello  ")),
            Some("hello".to_string())
        );
        assert_eq!(parse_non_empty_text(Some("   ")), None);
        assert_eq!(parse_non_empty_text(None), None);
    }

    #[test]
    fn parse_finite_number_accepts_only_finite_values() {
        assert_eq!(parse_finite_number("12.5"), Some(12.5));
        assert_eq!(parse_finite_number("NaN"), None);
        assert_eq!(parse_finite_number(""), None);
    }
}
