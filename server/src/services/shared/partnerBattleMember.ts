/**
 * 伙伴战斗成员共享构建模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中构建“当前出战伙伴 -> 战斗成员快照”，供战斗缓存、伙伴服务、挂机快照复用。
 * 2. 做什么：集中读取伙伴功法、技能策略与技能定义，避免 partnerService 与缓存层重复拼装同一份战斗数据。
 * 3. 不做什么：不处理伙伴培养写操作，不决定是否允许携带伙伴参战，也不管理缓存生命周期。
 *
 * 输入/输出：
 * - 输入：角色 ID，或 `partnerId + 伙伴定义 + 功法行`。
 * - 输出：伙伴战斗成员 `PartnerBattleMember`，以及复用的技能策略状态。
 *
 * 数据流/状态流：
 * - character_partner -> partnerView / partnerSkillPolicy -> 本模块统一组装 -> partnerService / battle profile cache / idle snapshot。
 *
 * 关键边界条件与坑点：
 * 1. 必须只读取“当前出战伙伴”，不存在时返回 null；不能在这里隐式挑选其他伙伴顶替。
 * 2. 伙伴技能列表必须直接复用“已应用层数强化后的有效技能条目”，不能再按 skillId 回查静态技能表，否则会退回初始等级效果。
 */

import { query } from '../../config/database.js';
import type {
  CharacterData,
  SkillData,
} from '../../battle/battleFactory.js';
import type { PartnerDefConfig } from '../staticConfigLoader.js';
import {
  buildPartnerBattleSkillData,
  buildPartnerEffectiveSkillEntries,
  buildPartnerDisplay,
  loadPartnerTechniqueRows,
  normalizeInteger,
  normalizeText,
  type PartnerComputedAttrsDto,
  type PartnerRow,
  type PartnerTechniqueRow,
} from './partnerView.js';
import {
  buildPartnerBattleSkillPolicy,
  loadPartnerSkillPolicyRows,
  type PartnerSkillPolicySlotDto,
} from './partnerSkillPolicy.js';
import { getPartnerDefinitionById } from '../staticConfigLoader.js';

export interface PartnerBattleMember {
  data: CharacterData;
  skills: SkillData[];
  skillPolicy: { slots: PartnerSkillPolicySlotDto[] };
}

type ActivePartnerBattleRow = PartnerRow & {
  user_id: number;
};

type PartnerBattleSkillPolicyState = {
  availableSkills: ReturnType<typeof buildPartnerEffectiveSkillEntries>;
  persistedRows: Awaited<ReturnType<typeof loadPartnerSkillPolicyRows>>;
};

const toPartnerBattleCharacterData = (
  userId: number,
  partnerId: number,
  nickname: string,
  attributeElement: string,
  computedAttrs: PartnerComputedAttrsDto,
): CharacterData => ({
  user_id: userId,
  id: partnerId,
  nickname,
  realm: '',
  sub_realm: null,
  attribute_element: attributeElement,
  qixue: computedAttrs.qixue,
  max_qixue: computedAttrs.max_qixue,
  lingqi: computedAttrs.lingqi,
  max_lingqi: computedAttrs.max_lingqi,
  wugong: computedAttrs.wugong,
  fagong: computedAttrs.fagong,
  wufang: computedAttrs.wufang,
  fafang: computedAttrs.fafang,
  sudu: computedAttrs.sudu,
  mingzhong: computedAttrs.mingzhong,
  shanbi: computedAttrs.shanbi,
  zhaojia: computedAttrs.zhaojia,
  baoji: computedAttrs.baoji,
  baoshang: computedAttrs.baoshang,
  jianbaoshang: computedAttrs.jianbaoshang,
  jianfantan: computedAttrs.jianfantan,
  kangbao: computedAttrs.kangbao,
  zengshang: computedAttrs.zengshang,
  zhiliao: computedAttrs.zhiliao,
  jianliao: computedAttrs.jianliao,
  xixue: computedAttrs.xixue,
  lengque: computedAttrs.lengque,
  kongzhi_kangxing: computedAttrs.kongzhi_kangxing,
  jin_kangxing: computedAttrs.jin_kangxing,
  mu_kangxing: computedAttrs.mu_kangxing,
  shui_kangxing: computedAttrs.shui_kangxing,
  huo_kangxing: computedAttrs.huo_kangxing,
  tu_kangxing: computedAttrs.tu_kangxing,
  qixue_huifu: computedAttrs.qixue_huifu,
  lingqi_huifu: computedAttrs.lingqi_huifu,
  setBonusEffects: [],
});

export const loadPartnerBattleSkillPolicyState = async (params: {
  partnerId: number;
  definition: PartnerDefConfig;
  techniqueRows: PartnerTechniqueRow[];
  forUpdate: boolean;
}): Promise<PartnerBattleSkillPolicyState> => {
  const availableSkills = buildPartnerEffectiveSkillEntries(
    params.definition,
    params.techniqueRows,
  );
  const persistedRows = await loadPartnerSkillPolicyRows(
    params.partnerId,
    params.forUpdate,
  );
  return {
    availableSkills,
    persistedRows,
  };
};

export const loadActivePartnerBattleMember = async (
  characterId: number,
): Promise<PartnerBattleMember | null> => {
  const normalizedCharacterId = normalizeInteger(characterId);
  if (normalizedCharacterId <= 0) {
    return null;
  }

  const rows = await query(
    `
      SELECT cp.*, c.user_id
      FROM character_partner cp
      JOIN characters c ON c.id = cp.character_id
      WHERE cp.character_id = $1
        AND cp.is_active = TRUE
      LIMIT 1
    `,
    [normalizedCharacterId],
  );
  if (rows.rows.length <= 0) {
    return null;
  }

  const partnerRow = rows.rows[0] as ActivePartnerBattleRow;
  const partnerDef = getPartnerDefinitionById(partnerRow.partner_def_id);
  if (!partnerDef) {
    throw new Error(`伙伴模板不存在: ${partnerRow.partner_def_id}`);
  }

  const techniqueMap = await loadPartnerTechniqueRows([partnerRow.id], false);
  const techniqueRows = techniqueMap.get(partnerRow.id) ?? [];
  const partnerDisplay = buildPartnerDisplay({
    row: partnerRow,
    definition: partnerDef,
    techniqueRows,
  });
  const skillPolicyState = await loadPartnerBattleSkillPolicyState({
    partnerId: partnerRow.id,
    definition: partnerDef,
    techniqueRows,
    forUpdate: false,
  });

  const skills = buildPartnerBattleSkillData(skillPolicyState.availableSkills);

  const userId = normalizeInteger(partnerRow.user_id);
  const attributeElement = normalizeText(partnerDef.attribute_element) || 'none';

  return {
    data: toPartnerBattleCharacterData(
      userId,
      partnerRow.id,
      partnerDisplay.nickname,
      attributeElement,
      partnerDisplay.computedAttrs,
    ),
    skills,
    skillPolicy: buildPartnerBattleSkillPolicy({
      availableSkills: skillPolicyState.availableSkills,
      persistedRows: skillPolicyState.persistedRows,
    }),
  };
};
