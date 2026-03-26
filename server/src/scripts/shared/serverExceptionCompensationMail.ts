/**
 * 服务器异常补偿邮件模板共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义本次服务器异常补偿的奖励道具、数量、邮件标题、正文、来源标识与过期时间。
 * 2. 做什么：统一校验补偿道具是否存在于静态配置，避免 dry-run 摘要、execute 发奖、报告输出各自硬编码一份道具信息。
 * 3. 不做什么：不筛选活跃玩家、不执行邮件发送，也不写数据库。
 *
 * 输入/输出：
 * - 输入：无。
 * - 输出：补偿邮件配置，以及可直接传给 `mailService.sendBulkMail({ attachRewards })` 的奖励载荷。
 *
 * 数据流/状态流：
 * 运维脚本启动 -> 本模块解析静态物品配置 -> 返回补偿模板 -> 上游脚本决定 dry-run/execute。
 *
 * 关键边界条件与坑点：
 * 1. 奖励道具 ID 和展示名称必须来自同一份静态配置，不能在脚本里重复手写“ID 一份、名字一份”。
 * 2. 这里只生成当前任务需要的固定模板，不做可编辑运营后台那类过度抽象，避免把一次性脚本写成低收益配置系统。
 */

import type { GrantedRewardPayload } from '../../services/shared/rewardPayload.js';
import { getItemDefinitionById } from '../../services/staticConfigLoader.js';

export const SERVER_EXCEPTION_COMPENSATION_ITEM_DEF_ID = 'cons-011';
export const SERVER_EXCEPTION_COMPENSATION_ITEM_QTY = 8;
export const SERVER_EXCEPTION_COMPENSATION_MAIL_EXPIRE_DAYS = 30;
export const SERVER_EXCEPTION_COMPENSATION_MAIL_SOURCE = 'script:server-exception-compensation';

export type ServerExceptionCompensationConfig = {
  itemDefId: string;
  itemName: string;
  itemQty: number;
  expireDays: number;
  title: string;
  content: string;
  source: string;
};

export const buildServerExceptionCompensationRewardPayload = (): GrantedRewardPayload => {
  return {
    items: [
      {
        itemDefId: SERVER_EXCEPTION_COMPENSATION_ITEM_DEF_ID,
        quantity: SERVER_EXCEPTION_COMPENSATION_ITEM_QTY,
      },
    ],
  };
};

export const resolveServerExceptionCompensationConfig =
  (): ServerExceptionCompensationConfig => {
    const itemDefinition = getItemDefinitionById(
      SERVER_EXCEPTION_COMPENSATION_ITEM_DEF_ID,
    );
    if (!itemDefinition) {
      throw new Error(
        `补偿道具不存在：${SERVER_EXCEPTION_COMPENSATION_ITEM_DEF_ID}`,
      );
    }

    const itemName = itemDefinition.name;

    return {
      itemDefId: SERVER_EXCEPTION_COMPENSATION_ITEM_DEF_ID,
      itemName,
      itemQty: SERVER_EXCEPTION_COMPENSATION_ITEM_QTY,
      expireDays: SERVER_EXCEPTION_COMPENSATION_MAIL_EXPIRE_DAYS,
      title: '服务器异常补偿已送达',
      content: `因本次服务器异常影响体验，补偿【${itemName}】x${SERVER_EXCEPTION_COMPENSATION_ITEM_QTY}，请及时查收。`,
      source: SERVER_EXCEPTION_COMPENSATION_MAIL_SOURCE,
    };
  };
