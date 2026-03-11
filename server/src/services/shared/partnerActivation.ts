/**
 * 伙伴出战切换共享入口
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护“同一角色同一时间最多只有一个出战伙伴”的数据库更新顺序，供伙伴服务复用。
 * 2. 做什么：统一支持“切到指定伙伴出战”和“清空当前出战伙伴”两种动作，避免业务层重复拼接容易撞唯一索引的 SQL。
 * 3. 不做什么：不负责鉴权、不校验伙伴是否属于角色、不组装伙伴详情 DTO。
 *
 * 输入/输出：
 * - 输入：角色 ID、可选目标伙伴 ID，以及事务内 SQL 执行器。
 * - 输出：无返回值；成功表示数据库中的出战状态已完成切换或清空。
 *
 * 数据流/状态流：
 * partnerService.activate / partnerService.dismiss -> 本模块先清空当前出战伙伴 -> 如有目标伙伴再激活 -> service 继续读取刷新后的伙伴详情。
 *
 * 关键边界条件与坑点：
 * 1. 数据库上存在“每个角色最多一个 `is_active = true`”的唯一索引，不能再用单条 `CASE WHEN` 批量更新，否则会在行更新顺序上撞约束。
 * 2. 当存在目标伙伴时，本模块依赖调用方已经在事务里完成角色与目标伙伴的归属校验；若跳过前置校验，第二条更新可能静默影响 0 行。
 */

type PartnerActivationSqlParam = string | number | boolean | null;

type PartnerActivationQueryResult = {
  rows: readonly Record<string, string | number | boolean | null>[];
};

export type PartnerActivationQueryExecutor = (
  sql: string,
  params: readonly PartnerActivationSqlParam[],
) => Promise<PartnerActivationQueryResult>;

export const clearCharacterPartnerActivation = async (params: {
  characterId: number;
  execute: PartnerActivationQueryExecutor;
}): Promise<void> => {
  const { characterId, execute } = params;

  await execute(
    `
      UPDATE character_partner
      SET is_active = FALSE,
          updated_at = NOW()
      WHERE character_id = $1 AND is_active = TRUE
    `,
    [characterId],
  );
};

export const setCharacterPartnerActivation = async (params: {
  characterId: number;
  partnerId: number | null;
  execute: PartnerActivationQueryExecutor;
}): Promise<void> => {
  const { characterId, partnerId, execute } = params;

  await clearCharacterPartnerActivation({
    characterId,
    execute,
  });

  if (partnerId === null) {
    return;
  }

  await execute(
    `
      UPDATE character_partner
      SET is_active = TRUE,
          updated_at = NOW()
      WHERE character_id = $1 AND id = $2
    `,
    [characterId, partnerId],
  );
};
