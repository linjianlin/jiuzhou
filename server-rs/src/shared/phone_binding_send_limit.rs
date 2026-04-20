use crate::config::MarketPhoneBindingConfig;

const SHANGHAI_OFFSET_SECONDS: i64 = 8 * 60 * 60;
const TWO_HOURS_SECONDS: u64 = 2 * 60 * 60;
const TWO_DAYS_SECONDS: u64 = 2 * 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneBindingSendLimitWindow {
    pub key_segment: &'static str,
    pub key: String,
    pub limit: u64,
    pub expire_seconds: u64,
}

pub fn build_phone_binding_cooldown_key(user_id: i64) -> String {
    format!("market:phone-binding:cooldown:{user_id}")
}

pub fn build_phone_binding_send_limit_windows(
    user_id: i64,
    config: &MarketPhoneBindingConfig,
    unix_ts: i64,
) -> Vec<PhoneBindingSendLimitWindow> {
    let (year, month, day, hour) = shanghai_datetime_parts(unix_ts);
    vec![
        PhoneBindingSendLimitWindow {
            key_segment: "hour",
            key: format!(
                "market:phone-binding:send-limit:hour:{user_id}:{year:04}{month:02}{day:02}{hour:02}"
            ),
            limit: config.send_hourly_limit,
            expire_seconds: TWO_HOURS_SECONDS,
        },
        PhoneBindingSendLimitWindow {
            key_segment: "day",
            key: format!(
                "market:phone-binding:send-limit:day:{user_id}:{year:04}{month:02}{day:02}"
            ),
            limit: config.send_daily_limit,
            expire_seconds: TWO_DAYS_SECONDS,
        },
    ]
}

pub fn build_phone_binding_exceeded_message(key_segment: &str, limit: u64) -> &'static str {
    match key_segment {
        "hour" if limit > 0 => "验证码每小时最多发送5次，请下个整点后再试",
        "day" if limit > 0 => "验证码当天最多发送10次，请明天再试",
        _ => "验证码发送过于频繁，请稍后再试",
    }
}

fn shanghai_datetime_parts(unix_ts: i64) -> (i32, u32, u32, u32) {
    let local = unix_ts + SHANGHAI_OFFSET_SECONDS;
    let days = local.div_euclid(86_400);
    let seconds_of_day = local.rem_euclid(86_400);
    let date = civil_from_days(days);
    let hour = (seconds_of_day / 3600) as u32;
    (date.0, date.1, date.2, hour)
}

fn civil_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use crate::config::MarketPhoneBindingConfig;

    #[test]
    fn windows_follow_shanghai_calendar() {
        let config = MarketPhoneBindingConfig {
            enabled: true,
            aliyun_access_key_id: String::new(),
            aliyun_access_key_secret: String::new(),
            sign_name: String::new(),
            template_code: String::new(),
            code_expire_seconds: 300,
            send_cooldown_seconds: 60,
            send_hourly_limit: 5,
            send_daily_limit: 10,
        };
        let windows = super::build_phone_binding_send_limit_windows(12, &config, 1_744_345_600);
        assert_eq!(
            windows[0].key,
            "market:phone-binding:send-limit:hour:12:2025041112"
        );
        assert_eq!(
            windows[1].key,
            "market:phone-binding:send-limit:day:12:20250411"
        );
    }
}
