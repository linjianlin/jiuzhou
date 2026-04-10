use std::{future::Future, pin::Pin};

use tracing::info;

use crate::edge::http::routes::afdian::{
    AfdianRouteError, AfdianRouteServices, AfdianWebhookOrderInput, AfdianWebhookPayloadInput,
};

/**
 * afdian webhook 最小应用服务。
 *
 * 作用：
 * 1. 做什么：接住 `/api/afdian/webhook` 的订单回调输入，先把 Node 侧已经冻结的必要字段校验与日志上下文收敛到单一入口。
 * 2. 做什么：为后续补 OpenAPI 回查、订单落库、兑换码生成保留稳定 service 边界，避免路由层再次堆业务判断。
 * 3. 不做什么：当前不回查爱发电 OpenAPI、不写 PostgreSQL、不创建兑换码与私信任务。
 *
 * 输入 / 输出：
 * - 输入：完整 webhook JSON 负载。
 * - 输出：成功时返回 `Ok(())`；字段缺失时返回固定错误文案，供路由层映射成 `{ ec, em }`。
 *
 * 数据流 / 状态流：
 * - HTTP webhook -> 路由层判定是否为订单事件 -> 本服务做最小字段归一化/日志 -> 路由层输出兼容协议。
 *
 * 复用设计说明：
 * - 必填字段校验与日志上下文统一放在这里，后续无论接 OpenAPI 回查还是持久化实现，都复用同一套输入收敛逻辑，避免 webhook、重放脚本、回归测试各写一遍。
 * - 路由层只保留协议转换；业务层只关注订单最小事实，减少 `ec/em` 协议和订单字段校验交叉污染。
 *
 * 关键边界条件与坑点：
 * 1. 非订单测试请求必须继续在路由层直接返回成功，本服务不应把它当成错误。
 * 2. 字段缺失文案必须保持 `爱发电 webhook 缺少必要字段：<field>`，否则后续与 Node 行为对拍会漂移。
 */
#[derive(Debug, Clone, Default)]
pub struct RustAfdianRouteService;

impl RustAfdianRouteService {
    pub fn new() -> Self {
        Self
    }
}

impl AfdianRouteServices for RustAfdianRouteService {
    fn handle_webhook<'a>(
        &'a self,
        payload: AfdianWebhookPayloadInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), AfdianRouteError>> + Send + 'a>> {
        Box::pin(async move {
            let Some(order) = payload.data.as_ref().and_then(|data| data.order.as_ref()) else {
                return Ok(());
            };

            let normalized = normalize_order(order)?;
            info!(
                out_trade_no = %normalized.out_trade_no,
                user_id = %normalized.user_id,
                plan_id = %normalized.plan_id,
                month = normalized.month,
                total_amount = %normalized.total_amount,
                status = normalized.status,
                "afdian order webhook accepted"
            );

            Ok(())
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
struct NormalizedAfdianOrder {
    out_trade_no: String,
    user_id: String,
    plan_id: String,
    month: i32,
    total_amount: String,
    status: f64,
}

fn normalize_order(
    order: &AfdianWebhookOrderInput,
) -> Result<NormalizedAfdianOrder, AfdianRouteError> {
    Ok(NormalizedAfdianOrder {
        out_trade_no: normalize_required_text_field(order.out_trade_no.as_deref(), "out_trade_no")?,
        user_id: normalize_required_text_field(order.user_id.as_deref(), "user_id")?,
        plan_id: normalize_required_text_field(order.plan_id.as_deref(), "plan_id")?,
        month: normalize_required_positive_integer_field(order.month, "month")?,
        total_amount: normalize_required_text_field(order.total_amount.as_deref(), "total_amount")?,
        status: normalize_required_number_field(order.status.as_ref(), "status")?,
    })
}

fn normalize_required_text_field(
    value: Option<&str>,
    field_name: &str,
) -> Result<String, AfdianRouteError> {
    let Some(value) = value.map(str::trim) else {
        return Err(missing_field_error(field_name));
    };
    if value.is_empty() {
        return Err(missing_field_error(field_name));
    }
    Ok(value.to_string())
}

fn normalize_required_positive_integer_field(
    value: Option<i32>,
    field_name: &str,
) -> Result<i32, AfdianRouteError> {
    let Some(value) = value else {
        return Err(missing_field_error(field_name));
    };
    if value <= 0 {
        return Err(missing_field_error(field_name));
    }
    Ok(value)
}

fn normalize_required_number_field(
    value: Option<&serde_json::Number>,
    field_name: &str,
) -> Result<f64, AfdianRouteError> {
    let Some(value) = value.and_then(serde_json::Number::as_f64) else {
        return Err(missing_field_error(field_name));
    };
    if value.is_nan() {
        return Err(missing_field_error(field_name));
    }
    Ok(value)
}

fn missing_field_error(field_name: &str) -> AfdianRouteError {
    AfdianRouteError::new(format!("爱发电 webhook 缺少必要字段：{field_name}"))
}
