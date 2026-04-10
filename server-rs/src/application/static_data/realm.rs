/**
 * 境界静态规则。
 *
 * 作用：
 * 1. 做什么：集中维护 Rust 后端当前已迁移模块共用的境界顺序、主阶段映射与标准化规则。
 * 2. 做什么：提供统一的 0-based / 1-based 境界排名计算，避免 `info`、`dungeon`、后续 `insight/realm` 模块各自维护一套顺序表。
 * 3. 不做什么：不读取数据库、不处理角色实时状态，也不承载突破或装备等业务判断。
 *
 * 输入 / 输出：
 * - 输入：原始 `realm/sub_realm` 字符串。
 * - 输出：标准化后的完整境界文本，或可直接参与比较的境界排名。
 *
 * 数据流 / 状态流：
 * - 业务模块读取角色/静态配置中的境界文本 -> 本模块统一标准化 -> 调用方基于结果做比较或展示。
 *
 * 复用设计说明：
 * - `info`、`dungeon` 与本轮新增的 `insight` 都依赖相同境界顺序；集中后，后续补 `/api/realm`、排行榜或装备需求时不必继续复制顺序表。
 * - 这里把“未知境界保留原文”和“严格排名回退凡人”拆开，避免不同模块为了各自需求偷偷改默认值。
 *
 * 关键边界条件与坑点：
 * 1. 只有显式命中的完整境界才按原值返回；未知文本不会被静默修正成其他阶段，避免把脏数据掩盖成合法值。
 * 2. 1-based 排名最小值固定为 1，供严格比较场景复用；0-based 排名最小值固定为 0，供宽松排序场景复用。
 */
pub const REALM_ORDER: [&str; 13] = [
    "凡人",
    "炼精化炁·养气期",
    "炼精化炁·通脉期",
    "炼精化炁·凝炁期",
    "炼炁化神·炼己期",
    "炼炁化神·采药期",
    "炼炁化神·结胎期",
    "炼神返虚·养神期",
    "炼神返虚·还虚期",
    "炼神返虚·合道期",
    "炼虚合道·证道期",
    "炼虚合道·历劫期",
    "炼虚合道·成圣期",
];

pub fn normalize_realm_keeping_unknown(
    realm_raw: Option<&str>,
    sub_realm_raw: Option<&str>,
) -> String {
    let realm = realm_raw.unwrap_or_default().trim();
    let sub_realm = sub_realm_raw.unwrap_or_default().trim();
    if realm.is_empty() && sub_realm.is_empty() {
        return "凡人".to_string();
    }
    if is_realm_name(realm) {
        return realm.to_string();
    }
    if !realm.is_empty() && !sub_realm.is_empty() {
        let full = format!("{realm}·{sub_realm}");
        if is_realm_name(full.as_str()) {
            return full;
        }
    }
    if let Some(mapped) = map_major_to_first(realm) {
        return mapped.to_string();
    }
    if let Some(mapped) = map_sub_to_full(realm) {
        return mapped.to_string();
    }
    if realm.is_empty() {
        if let Some(mapped) = map_sub_to_full(sub_realm) {
            return mapped.to_string();
        }
    }
    if realm.is_empty() {
        "凡人".to_string()
    } else {
        realm.to_string()
    }
}

pub fn get_realm_rank_zero_based(realm_raw: Option<&str>, sub_realm_raw: Option<&str>) -> usize {
    let normalized = normalize_realm_keeping_unknown(realm_raw, sub_realm_raw);
    REALM_ORDER
        .iter()
        .position(|entry| *entry == normalized)
        .unwrap_or(0)
}

pub fn get_realm_rank_one_based_strict(
    realm_raw: Option<&str>,
    sub_realm_raw: Option<&str>,
) -> i32 {
    let normalized = normalize_realm_keeping_unknown(realm_raw, sub_realm_raw);
    REALM_ORDER
        .iter()
        .position(|entry| *entry == normalized)
        .map(|index| index as i32 + 1)
        .unwrap_or(1)
}

fn is_realm_name(value: &str) -> bool {
    REALM_ORDER.iter().any(|entry| *entry == value)
}

fn map_major_to_first(value: &str) -> Option<&'static str> {
    match value {
        "凡人" => Some("凡人"),
        "炼精化炁" => Some("炼精化炁·养气期"),
        "炼炁化神" => Some("炼炁化神·炼己期"),
        "炼神返虚" => Some("炼神返虚·养神期"),
        "炼虚合道" => Some("炼虚合道·证道期"),
        _ => None,
    }
}

fn map_sub_to_full(value: &str) -> Option<&'static str> {
    match value {
        "养气期" => Some("炼精化炁·养气期"),
        "通脉期" => Some("炼精化炁·通脉期"),
        "凝炁期" => Some("炼精化炁·凝炁期"),
        "炼己期" => Some("炼炁化神·炼己期"),
        "采药期" => Some("炼炁化神·采药期"),
        "结胎期" => Some("炼炁化神·结胎期"),
        "养神期" => Some("炼神返虚·养神期"),
        "还虚期" => Some("炼神返虚·还虚期"),
        "合道期" => Some("炼神返虚·合道期"),
        "证道期" => Some("炼虚合道·证道期"),
        "历劫期" => Some("炼虚合道·历劫期"),
        "成圣期" => Some("炼虚合道·成圣期"),
        _ => None,
    }
}
