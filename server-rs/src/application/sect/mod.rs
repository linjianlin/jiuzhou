/**
 * sect 应用模块。
 *
 * 作用：
 * 1. 做什么：承载 `/api/sect` 当前已迁移的只读服务实现，统一组织宗门详情、搜索和个人祈福状态读取。
 * 2. 不做什么：不在模块入口混入创建/申请/建筑升级等写链路，这些后续按独立事务边界继续迁移。
 *
 * 输入 / 输出：
 * - 输入：HTTP 路由层透传的 `characterId / sectId / keyword / page / limit`。
 * - 输出：Node 兼容宗门 DTO 与响应包体。
 *
 * 数据流 / 状态流：
 * - 路由层 -> `service` -> PostgreSQL / 月卡共享查询 -> DTO。
 *
 * 复用设计说明：
 * - 先把详情装配和搜索聚合固定到独立模块，后续 `/api/sect/buildings/list`、`/api/sect/bonuses`、`/api/sect/logs` 都能复用同一批基础查询与映射。
 *
 * 关键边界条件与坑点：
 * 1. 无，本模块当前只做 re-export，真实边界条件由 `service.rs` 维护。
 * 2. 无，原因同上。
 */
pub mod service;
