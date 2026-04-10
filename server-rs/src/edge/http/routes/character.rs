use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::application::character::service::{
    CharacterRouteData, RenameCharacterWithCardResult, UpdateCharacterSettingResult,
};
use crate::application::character_technique::service::CharacterTechniqueServiceResult;
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_user_id;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, ServiceResultResponse};

/// character 兼容路由。
///
/// 作用：
/// 1. 做什么：提供 `/check`、`/info`、`/create`、`/updatePosition`、`/renameWithCard`、character settings，以及角色功法/技能的读写接口。
/// 2. 做什么：复用现有 Bearer + session 校验语义，并把返回 envelope 保持为 Node 当前的 `sendResult` 形状。
/// 3. 不做什么：不扩展更大的库存、聊天或其它与当前角色最小合同无关的 mutation 能力。
///
/// 输入 / 输出：
/// - 输入：Authorization Bearer token；create 额外接收 `{ nickname, gender }`；updatePosition 额外接收 `{ currentMapId, currentRoomId }`；renameWithCard 额外接收 `{ itemInstanceId, nickname }`；settings mutation 接收 `{ enabled, rules? }`。
/// - 输出：Node 兼容 `{ success, message, data? }`；其中 `data` 为 `{ character, hasCharacter }`。
///
/// 数据流 / 状态流：
/// - HTTP 请求 -> 会话校验 -> `AuthRouteServices::{check_character,create_character,update_character_position,...settings mutations}`
/// - -> application 层统一读取/写入角色最小快照 -> 这里做最薄 envelope 转换。
///
/// 复用设计说明：
/// - `/auth/bootstrap`、`/character/check`、`/character/create`、`/character/renameWithCard` 与 settings mutation 共用同一套 session 校验与基础角色快照结构，避免登录后首创角链路和后续角色 mutation 链路出现口径漂移。
/// - 只在路由层负责协议转换与 Node 可见参数校验，业务读写全部下沉，避免 handler 重复拼接 itemInstanceId 解析、布尔转换、rules 形状校验和写库 SQL。
///
/// 关键边界条件与坑点：
/// 1. 被踢下线必须继续返回 `401 + kicked:true`，不能被统一抹平成普通未登录。
/// 2. `/info` 无角色时必须维持 `400 { success:false, message:'角色不存在' }`，而不是返回 `200 + hasCharacter:false`。
/// 3. `/create` 路由层必须继续保留 Node 可见的参数报错文案：`道号和性别不能为空`、`性别参数错误`。
/// 4. `/updatePosition` 必须继续复用同一鉴权路径，并保持 service 返回的 `位置参数不能为空`、`位置参数过长`、`角色不存在`、`位置更新成功` 文案不变。
/// 5. `renameWithCard` 路由层必须继续保留 Node 可见的参数报错文案：`itemInstanceId参数错误`、`道号不能为空`。
/// 6. `updateAutoDisassemble` 必须继续保留 Node 可见的 rules 形状报错文案：`rules参数错误，需为数组`、`rules参数错误，规则项需为对象`。
/// 7. `/:characterId/*` 的功法接口必须先做路径角色所有权校验；未建角账号和访问他人角色都要维持 `403 { success:false, message:'无权限访问该角色' }`。
/// 8. 功法装配/卸下必须继续拦截“战斗中无法切换功法”；该报错走业务失败包体，不能抬成 4xx。
#[derive(Debug, Deserialize)]
struct CreateCharacterPayload {
    nickname: Option<String>,
    gender: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateCharacterPositionPayload {
    #[serde(rename = "currentMapId")]
    current_map_id: Option<String>,
    #[serde(rename = "currentRoomId")]
    current_room_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateBooleanSettingPayload {
    enabled: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct UpdateAutoDisassemblePayload {
    enabled: Option<Value>,
    rules: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct RenameCharacterWithCardPayload {
    #[serde(rename = "itemInstanceId")]
    item_instance_id: Option<Value>,
    nickname: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TechniqueEquipPayload {
    #[serde(rename = "techniqueId")]
    technique_id: Option<String>,
    #[serde(rename = "slotType")]
    slot_type: Option<String>,
    #[serde(rename = "slotIndex")]
    slot_index: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct TechniqueUnequipPayload {
    #[serde(rename = "techniqueId")]
    technique_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SkillEquipPayload {
    #[serde(rename = "skillId")]
    skill_id: Option<String>,
    #[serde(rename = "slotIndex")]
    slot_index: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct SkillUnequipPayload {
    #[serde(rename = "slotIndex")]
    slot_index: Option<Value>,
}

pub fn build_character_router() -> Router<AppState> {
    Router::new()
        .route("/check", get(check_character_handler))
        .route("/info", get(get_character_info_handler))
        .route("/create", post(create_character_handler))
        .route("/updatePosition", post(update_character_position_handler))
        .route("/renameWithCard", post(rename_character_with_card_handler))
        .route(
            "/{characterId}/technique/status",
            get(get_character_technique_status_handler),
        )
        .route(
            "/{characterId}/techniques",
            get(get_character_techniques_handler),
        )
        .route(
            "/{characterId}/techniques/equipped",
            get(get_equipped_techniques_handler),
        )
        .route(
            "/{characterId}/technique/{techniqueId}/upgrade-cost",
            get(get_technique_upgrade_cost_handler),
        )
        .route(
            "/{characterId}/technique/{techniqueId}/upgrade",
            post(upgrade_technique_handler),
        )
        .route(
            "/{characterId}/technique/equip",
            post(equip_technique_handler),
        )
        .route(
            "/{characterId}/technique/unequip",
            post(unequip_technique_handler),
        )
        .route(
            "/{characterId}/technique/{techniqueId}/dissipate",
            post(dissipate_technique_handler),
        )
        .route(
            "/{characterId}/skills/available",
            get(get_available_skills_handler),
        )
        .route(
            "/{characterId}/skills/equipped",
            get(get_equipped_skills_handler),
        )
        .route("/{characterId}/skill/equip", post(equip_skill_handler))
        .route("/{characterId}/skill/unequip", post(unequip_skill_handler))
        .route(
            "/{characterId}/technique/passives",
            get(get_technique_passives_handler),
        )
        .route(
            "/updateAutoCastSkills",
            post(update_auto_cast_skills_handler),
        )
        .route(
            "/updateAutoDisassemble",
            post(update_auto_disassemble_handler),
        )
        .route(
            "/updateDungeonNoStaminaCost",
            post(update_dungeon_no_stamina_cost_handler),
        )
}

async fn create_character_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateCharacterPayload>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let normalized_nickname = payload.nickname.unwrap_or_default().trim().to_string();
    let gender = payload.gender.unwrap_or_default();
    if normalized_nickname.is_empty() || gender.is_empty() {
        return Err(BusinessError::new("道号和性别不能为空"));
    }

    if gender != "male" && gender != "female" {
        return Err(BusinessError::new("性别参数错误"));
    }

    let result = state
        .auth_services
        .create_character(user_id, normalized_nickname, gender)
        .await?;
    Ok(service_result(ServiceResultResponse::new(
        result.success,
        Some(result.message),
        result.data,
    )))
}

async fn check_character_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let result = state.auth_services.check_character(user_id).await?;
    let message = if result.has_character {
        "已有角色"
    } else {
        "未创建角色"
    };

    Ok(service_result(ServiceResultResponse::new(
        true,
        Some(message.to_string()),
        Some(CharacterRouteData {
            character: result.character,
            has_character: result.has_character,
        }),
    )))
}

async fn get_character_info_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let result = state.auth_services.check_character(user_id).await?;
    if !result.has_character {
        return Ok(service_result(
            ServiceResultResponse::<CharacterRouteData>::new(
                false,
                Some("角色不存在".to_string()),
                None,
            ),
        ));
    }

    Ok(service_result(ServiceResultResponse::new(
        true,
        Some("获取成功".to_string()),
        Some(CharacterRouteData {
            character: result.character,
            has_character: true,
        }),
    )))
}

async fn update_character_position_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UpdateCharacterPositionPayload>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let result = state
        .auth_services
        .update_character_position(
            user_id,
            payload.current_map_id.unwrap_or_default(),
            payload.current_room_id.unwrap_or_default(),
        )
        .await?;

    Ok(service_result(
        ServiceResultResponse::<serde_json::Value>::new(result.success, Some(result.message), None),
    ))
}

async fn rename_character_with_card_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RenameCharacterWithCardPayload>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let Some(item_instance_id) = parse_positive_item_instance_id(payload.item_instance_id.as_ref())
    else {
        return Err(BusinessError::new("itemInstanceId参数错误"));
    };

    let normalized_nickname = payload.nickname.unwrap_or_default().trim().to_string();
    if normalized_nickname.is_empty() {
        return Err(BusinessError::new("道号不能为空"));
    }

    let result = state
        .auth_services
        .rename_character_with_card(user_id, item_instance_id, normalized_nickname)
        .await?;

    Ok(rename_result_response(result))
}

async fn update_auto_cast_skills_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UpdateBooleanSettingPayload>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let result = state
        .auth_services
        .update_auto_cast_skills(user_id, json_truthy(payload.enabled.as_ref()))
        .await?;

    Ok(setting_result_response(result))
}

async fn get_character_technique_status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<String>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .character_technique_service
        .get_character_technique_status(character_id)
        .await?;
    Ok(character_technique_result_response(result))
}

async fn get_character_techniques_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<String>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .character_technique_service
        .get_character_techniques(character_id)
        .await?;
    Ok(character_technique_result_response(result))
}

async fn get_equipped_techniques_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<String>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .character_technique_service
        .get_equipped_techniques(character_id)
        .await?;
    Ok(character_technique_result_response(result))
}

async fn get_technique_upgrade_cost_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((character_id, technique_id)): Path<(String, String)>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .character_technique_service
        .get_technique_upgrade_cost(character_id, technique_id.as_str())
        .await?;
    Ok(character_technique_result_response(result))
}

async fn get_available_skills_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<String>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .character_technique_service
        .get_available_skills(character_id)
        .await?;
    Ok(character_technique_result_response(result))
}

async fn upgrade_technique_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((character_id, technique_id)): Path<(String, String)>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .character_technique_service
        .upgrade_technique(character_id, technique_id.as_str())
        .await?;
    Ok(character_technique_result_response(result))
}

async fn equip_technique_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<String>,
    Json(payload): Json<TechniqueEquipPayload>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };
    if is_character_in_active_battle(&state, character_id).await {
        return Ok(character_technique_failure_response("战斗中无法切换功法"));
    }

    let technique_id = payload.technique_id.unwrap_or_default().trim().to_string();
    let slot_type = payload.slot_type.unwrap_or_default().trim().to_string();
    if technique_id.is_empty() || slot_type.is_empty() {
        return Err(BusinessError::new("缺少必要参数"));
    }
    if slot_type != "main" && slot_type != "sub" {
        return Err(BusinessError::new("无效的槽位类型"));
    }

    let result = state
        .character_technique_service
        .equip_technique(
            character_id,
            technique_id.as_str(),
            slot_type.as_str(),
            parse_positive_i32(payload.slot_index.as_ref()),
        )
        .await?;
    Ok(character_technique_result_response(result))
}

async fn unequip_technique_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<String>,
    Json(payload): Json<TechniqueUnequipPayload>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };
    if is_character_in_active_battle(&state, character_id).await {
        return Ok(character_technique_failure_response("战斗中无法切换功法"));
    }

    let technique_id = payload.technique_id.unwrap_or_default().trim().to_string();
    if technique_id.is_empty() {
        return Err(BusinessError::new("缺少功法ID"));
    }

    let result = state
        .character_technique_service
        .unequip_technique(character_id, technique_id.as_str())
        .await?;
    Ok(character_technique_result_response(result))
}

async fn dissipate_technique_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((character_id, technique_id)): Path<(String, String)>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };
    let normalized_technique_id = technique_id.trim().to_string();
    if normalized_technique_id.is_empty() {
        return Err(BusinessError::new("缺少功法ID"));
    }

    let result = state
        .character_technique_service
        .dissipate_technique(character_id, normalized_technique_id.as_str())
        .await?;
    Ok(character_technique_result_response(result))
}

async fn get_equipped_skills_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<String>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .character_technique_service
        .get_equipped_skills(character_id)
        .await?;
    Ok(character_technique_result_response(result))
}

async fn equip_skill_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<String>,
    Json(payload): Json<SkillEquipPayload>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };

    let skill_id = payload.skill_id.unwrap_or_default().trim().to_string();
    let Some(slot_index) = parse_positive_i32(payload.slot_index.as_ref()) else {
        if skill_id.is_empty() {
            return Err(BusinessError::new("缺少必要参数"));
        }
        return Err(BusinessError::new("缺少必要参数"));
    };
    if skill_id.is_empty() {
        return Err(BusinessError::new("缺少必要参数"));
    }

    let result = state
        .character_technique_service
        .equip_skill(character_id, skill_id.as_str(), slot_index)
        .await?;
    Ok(character_technique_result_response(result))
}

async fn unequip_skill_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<String>,
    Json(payload): Json<SkillUnequipPayload>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };

    let Some(slot_index) = parse_positive_i32(payload.slot_index.as_ref()) else {
        return Err(BusinessError::new("缺少槽位索引"));
    };
    let result = state
        .character_technique_service
        .unequip_skill(character_id, slot_index)
        .await?;
    Ok(character_technique_result_response(result))
}

async fn get_technique_passives_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<String>,
) -> Result<Response, BusinessError> {
    let character_id = match require_owned_character_id(&state, &headers, &character_id).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .character_technique_service
        .calculate_technique_passives(character_id)
        .await?;
    Ok(character_technique_result_response(result))
}

async fn update_auto_disassemble_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UpdateAutoDisassemblePayload>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let rules = validate_auto_disassemble_rules_shape(payload.rules)?;
    let result = state
        .auth_services
        .update_auto_disassemble(user_id, json_truthy(payload.enabled.as_ref()), rules)
        .await?;

    Ok(setting_result_response(result))
}

async fn update_dungeon_no_stamina_cost_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UpdateBooleanSettingPayload>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let result = state
        .auth_services
        .update_dungeon_no_stamina_cost(user_id, json_truthy(payload.enabled.as_ref()))
        .await?;

    Ok(setting_result_response(result))
}

fn setting_result_response(result: UpdateCharacterSettingResult) -> Response {
    service_result(ServiceResultResponse::<serde_json::Value>::new(
        result.success,
        Some(result.message),
        None,
    ))
}

fn rename_result_response(result: RenameCharacterWithCardResult) -> Response {
    service_result(ServiceResultResponse::<serde_json::Value>::new(
        result.success,
        Some(result.message),
        None,
    ))
}

fn character_technique_result_response<T>(result: CharacterTechniqueServiceResult<T>) -> Response
where
    T: Serialize,
{
    service_result(ServiceResultResponse::new(
        result.success,
        Some(result.message),
        result.data,
    ))
}

fn character_technique_failure_response(message: &str) -> Response {
    service_result(ServiceResultResponse::<serde_json::Value>::new(
        false,
        Some(message.to_string()),
        None,
    ))
}

fn validate_auto_disassemble_rules_shape(
    rules: Option<Value>,
) -> Result<Option<Vec<Value>>, BusinessError> {
    let Some(rules) = rules else {
        return Ok(None);
    };

    let Value::Array(items) = rules else {
        return Err(BusinessError::new("rules参数错误，需为数组"));
    };

    if items.iter().any(|item| item.is_null() || !item.is_object()) {
        return Err(BusinessError::new("rules参数错误，规则项需为对象"));
    }

    Ok(Some(items))
}

fn json_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(enabled)) => *enabled,
        Some(Value::Number(number)) => number.as_f64().map(|item| item != 0.0).unwrap_or(false),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn parse_positive_item_instance_id(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    match value {
        Value::Number(number) => number.as_i64().filter(|item| *item > 0),
        Value::String(text) => text.trim().parse::<i64>().ok().filter(|item| *item > 0),
        _ => None,
    }
}

fn parse_positive_i32(value: Option<&Value>) -> Option<i32> {
    let value = value?;
    match value {
        Value::Number(number) => number
            .as_i64()
            .and_then(|item| i32::try_from(item).ok())
            .filter(|item| *item > 0),
        Value::String(text) => text.trim().parse::<i32>().ok().filter(|item| *item > 0),
        _ => None,
    }
}

async fn is_character_in_active_battle(state: &AppState, character_id: i64) -> bool {
    state
        .runtime_services
        .read()
        .await
        .battle_registry
        .find_battle_id_by_character_id(character_id)
        .is_some()
}

async fn require_owned_character_id(
    state: &AppState,
    headers: &HeaderMap,
    raw_character_id: &str,
) -> Result<i64, Response> {
    let character_id = match parse_positive_character_id(raw_character_id) {
        Ok(character_id) => character_id,
        Err(error) => return Err(error.into_response()),
    };
    let user_id = require_authenticated_user_id(state, headers).await?;
    let character_result = match state.auth_services.check_character(user_id).await {
        Ok(result) => result,
        Err(error) => return Err(error.into_response()),
    };
    let has_access = character_result
        .character
        .as_ref()
        .is_some_and(|character| character_result.has_character && character.id == character_id);
    if !has_access {
        return Err(BusinessError::with_status(
            "无权限访问该角色",
            axum::http::StatusCode::FORBIDDEN,
        )
        .into_response());
    }
    Ok(character_id)
}

fn parse_positive_character_id(raw_character_id: &str) -> Result<i64, BusinessError> {
    raw_character_id
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|character_id| *character_id > 0)
        .ok_or_else(|| BusinessError::new("无效的角色ID"))
}
