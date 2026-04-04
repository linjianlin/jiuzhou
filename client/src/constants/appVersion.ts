/**
 * 应用版本相关稳定常量。
 *
 * 作用：
 * 1. 集中维护版本清单路径、轮询间隔和刷新提示文案，让更新检测组件与运行时服务共享单一配置入口。
 * 2. 把“更新检测策略”中的稳定值提前外提到常量层，避免组件 render 或轮询回调里重复创建相同对象与字符串。
 * 3. 不做什么：不参与网络请求、不解析版本元数据，也不直接触发页面刷新。
 *
 * 输入 / 输出：
 * - 输入：无，模块内声明稳定常量。
 * - 输出：版本清单路径、轮询参数与提示文案常量。
 *
 * 数据流 / 状态流：
 * 常量定义
 * -> 运行时版本服务构造请求地址
 * -> 根部更新检测组件复用轮询周期与提示文案。
 *
 * 复用设计说明：
 * 1. 清单路径只在这里定义一次，避免构建层与运行时层将来再次各写一个 `version.json` 字符串。
 * 2. 刷新提示文案属于高频产品变更点，集中后只改一处即可覆盖所有入口。
 * 3. 轮询间隔放在常量层后，后续若要根据业务节奏调整频率，不需要进入组件逻辑修改行为代码。
 *
 * 关键边界条件与坑点：
 * 1. 轮询间隔不能过短，否则会在长时间挂机场景里制造无意义请求。
 * 2. 清单路径必须保持根路径格式，保证启用 CDN 基址后仍能命中同一份静态版本清单。
 */

import { resolveAppVersionManifestPath } from '../shared/appVersionShared';

export const APP_VERSION_MANIFEST_PATH = resolveAppVersionManifestPath('version.json');
export const APP_VERSION_POLL_INTERVAL_MS = 2 * 60 * 1000;
export const APP_VERSION_REFRESH_MODAL_TITLE = '检测到新版本';
export const APP_VERSION_REFRESH_MODAL_CONTENT = '当前页面已有新版本可用，刷新后即可加载最新内容。';
