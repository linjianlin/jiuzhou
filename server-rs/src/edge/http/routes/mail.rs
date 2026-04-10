use std::{collections::HashMap, future::Future, pin::Pin};

use axum::extract::{Json, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::Serialize;
use serde_json::Value;

use crate::application::reward_payload::GrantedRewardPreviewView;
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_character_context;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, success, ServiceResultResponse};

/**
 * mail 邮件读取与状态管理路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node `/api/mail/list`、`/api/mail/unread`、`/api/mail/read`、`/api/mail/claim`、`/api/mail/claim-all`、`/api/mail/delete`、`/api/mail/delete-all`、`/api/mail/read-all` 八个接口。
 * 2. 做什么：统一复用角色上下文鉴权、查询参数解析与 `sendSuccess/sendResult` 协议，避免邮件状态规则散落在 handler 中。
 * 3. 不做什么：不在路由层直接做附件发放事务，不把奖励入包和计数更新逻辑散落到 handler。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；列表读取接收 `page/pageSize`，写接口接收 `mailId` 或 `onlyRead`。
 * - 输出：列表/红点走 `{ success:true, data }`；已读/删除相关接口走 Node 兼容 `sendResult` 包体。
 *
 * 数据流 / 状态流：
 * - HTTP -> `require_authenticated_character_context` -> `MailRouteServices` -> envelope 输出。
 *
 * 复用设计说明：
 * - 邮件奖励预览直接复用通用 `GrantedRewardPreviewView`，后续 claim 返回、兑换码预览都共享同一份 DTO。
 * - 角色上下文只解析一次，所有邮件接口沿用同一个入口，附件领取和状态写操作共享同一套参数解析，避免 `mailId/autoDisassemble` 校验在多处漂移。
 *
 * 关键边界条件与坑点：
 * 1. `mailId` 允许前端以字符串回传，路由层必须按 Node 语义接受正整数文本。
 * 2. 邮件列表成功包体没有 `message`；只有变更类接口才继续走 `sendResult`。
 */
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailAttachItemOptionsView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equip_options: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_rank: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MailAttachItemView {
    pub item_def_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_name: Option<String>,
    pub qty: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<MailAttachItemOptionsView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailItemView {
    pub id: i64,
    pub sender_type: String,
    pub sender_name: String,
    pub mail_type: String,
    pub title: String,
    pub content: String,
    pub attach_silver: i64,
    pub attach_spirit_stones: i64,
    pub attach_items: Vec<MailAttachItemView>,
    pub attach_rewards: Vec<GrantedRewardPreviewView>,
    pub has_attachments: bool,
    pub has_claimable_attachments: bool,
    pub read_at: Option<String>,
    pub claimed_at: Option<String>,
    pub expire_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailListView {
    pub mails: Vec<MailItemView>,
    pub total: i64,
    pub unread_count: i64,
    pub unclaimed_count: i64,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailUnreadSummaryView {
    pub unread_count: i64,
    pub unclaimed_count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MailMutationData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MailClaimResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rewards: Option<Vec<GrantedRewardPreviewView>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailClaimAllRewardSummary {
    pub silver: i64,
    pub spirit_stones: i64,
    pub item_count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailClaimAllResponse {
    pub success: bool,
    pub message: String,
    pub claimed_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rewards: Option<MailClaimAllRewardSummary>,
}

pub trait MailRouteServices: Send + Sync {
    fn list_mails<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        page: i64,
        page_size: i64,
    ) -> Pin<Box<dyn Future<Output = Result<MailListView, BusinessError>> + Send + 'a>>;

    fn get_unread_summary<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<MailUnreadSummaryView, BusinessError>> + Send + 'a>>;

    fn read_mail<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        mail_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn claim_mail_attachments<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        mail_id: i64,
        auto_disassemble: bool,
    ) -> Pin<Box<dyn Future<Output = Result<MailClaimResponse, BusinessError>> + Send + 'a>>;

    fn claim_all_mail_attachments<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        auto_disassemble: bool,
    ) -> Pin<Box<dyn Future<Output = Result<MailClaimAllResponse, BusinessError>> + Send + 'a>>;

    fn delete_mail<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        mail_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn delete_all_mails<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        only_read: bool,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn mark_all_read<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, Clone, Default)]
pub struct NoopMailRouteServices;

impl MailRouteServices for NoopMailRouteServices {
    fn list_mails<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        page: i64,
        page_size: i64,
    ) -> Pin<Box<dyn Future<Output = Result<MailListView, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(MailListView {
                mails: Vec::new(),
                total: 0,
                unread_count: 0,
                unclaimed_count: 0,
                page,
                page_size,
            })
        })
    }

    fn get_unread_summary<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<MailUnreadSummaryView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(MailUnreadSummaryView {
                unread_count: 0,
                unclaimed_count: 0,
            })
        })
    }

    fn read_mail<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _mail_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("邮件不存在".to_string()),
                None,
            ))
        })
    }

    fn claim_mail_attachments<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _mail_id: i64,
        _auto_disassemble: bool,
    ) -> Pin<Box<dyn Future<Output = Result<MailClaimResponse, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(MailClaimResponse {
                success: false,
                message: "邮件不存在".to_string(),
                rewards: None,
            })
        })
    }

    fn claim_all_mail_attachments<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _auto_disassemble: bool,
    ) -> Pin<Box<dyn Future<Output = Result<MailClaimAllResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(MailClaimAllResponse {
                success: true,
                message: "没有可领取的附件".to_string(),
                claimed_count: 0,
                skipped_count: Some(0),
                rewards: None,
            })
        })
    }

    fn delete_mail<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _mail_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("邮件不存在".to_string()),
                None,
            ))
        })
    }

    fn delete_all_mails<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _only_read: bool,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("已删除0封邮件".to_string()),
                Some(MailMutationData {
                    deleted_count: Some(0),
                    read_count: None,
                }),
            ))
        })
    }

    fn mark_all_read<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("已读0封邮件".to_string()),
                Some(MailMutationData {
                    deleted_count: None,
                    read_count: Some(0),
                }),
            ))
        })
    }
}

pub fn build_mail_router() -> Router<AppState> {
    Router::new()
        .route("/list", get(list_mails_handler))
        .route("/unread", get(unread_summary_handler))
        .route("/read", post(read_mail_handler))
        .route("/claim", post(claim_mail_handler))
        .route("/claim-all", post(claim_all_mails_handler))
        .route("/delete", post(delete_mail_handler))
        .route("/delete-all", post(delete_all_mails_handler))
        .route("/read-all", post(mark_all_read_handler))
}

async fn list_mails_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };

    let page = parse_positive_i64(query.get("page")).unwrap_or(1);
    let page_size = parse_positive_i64(query.get("pageSize"))
        .unwrap_or(50)
        .clamp(1, 100);
    let view = state
        .mail_services
        .list_mails(context.user_id, context.character.id, page, page_size)
        .await?;
    Ok(success(view))
}

async fn unread_summary_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let view = state
        .mail_services
        .get_unread_summary(context.user_id, context.character.id)
        .await?;
    Ok(success(view))
}

async fn read_mail_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let Some(mail_id) = parse_mail_id(payload.get("mailId")) else {
        return Err(BusinessError::new("参数错误"));
    };
    let result = state
        .mail_services
        .read_mail(context.user_id, context.character.id, mail_id)
        .await?;
    Ok(service_result(result))
}

async fn claim_mail_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let Some(mail_id) = parse_mail_id(payload.get("mailId")) else {
        return Err(BusinessError::new("参数错误"));
    };
    let auto_disassemble = parse_auto_disassemble(payload.get("autoDisassemble"))?;
    let result = state
        .mail_services
        .claim_mail_attachments(
            context.user_id,
            context.character.id,
            mail_id,
            auto_disassemble,
        )
        .await?;
    Ok(mail_action_response(result))
}

async fn claim_all_mails_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let auto_disassemble = parse_auto_disassemble(payload.get("autoDisassemble"))?;
    let result = state
        .mail_services
        .claim_all_mail_attachments(
            context.user_id,
            context.character.id,
            auto_disassemble,
        )
        .await?;
    Ok(mail_action_response(result))
}

async fn delete_mail_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let Some(mail_id) = parse_mail_id(payload.get("mailId")) else {
        return Err(BusinessError::new("参数错误"));
    };
    let result = state
        .mail_services
        .delete_mail(context.user_id, context.character.id, mail_id)
        .await?;
    Ok(service_result(result))
}

async fn delete_all_mails_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let only_read = payload
        .get("onlyRead")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let result = state
        .mail_services
        .delete_all_mails(context.user_id, context.character.id, only_read)
        .await?;
    Ok(service_result(result))
}

async fn mark_all_read_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let result = state
        .mail_services
        .mark_all_read(context.user_id, context.character.id)
        .await?;
    Ok(service_result(result))
}

fn parse_positive_i64(raw: Option<&String>) -> Option<i64> {
    raw.and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
}

fn parse_mail_id(raw: Option<&Value>) -> Option<i64> {
    match raw {
        Some(Value::Number(value)) => value.as_i64().filter(|value| *value > 0),
        Some(Value::String(value)) => value.trim().parse::<i64>().ok().filter(|value| *value > 0),
        _ => None,
    }
}

fn parse_auto_disassemble(raw: Option<&Value>) -> Result<bool, BusinessError> {
    match raw {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err(BusinessError::new("参数错误")),
    }
}

fn mail_action_response<T>(result: T) -> Response
where
    T: Serialize + MailActionSuccessFlag,
{
    let status = if result.is_success() {
        StatusCode::OK
    } else {
        StatusCode::BAD_REQUEST
    };
    (status, Json(result)).into_response()
}

trait MailActionSuccessFlag {
    fn is_success(&self) -> bool;
}

impl MailActionSuccessFlag for MailClaimResponse {
    fn is_success(&self) -> bool {
        self.success
    }
}

impl MailActionSuccessFlag for MailClaimAllResponse {
    fn is_success(&self) -> bool {
        self.success
    }
}
