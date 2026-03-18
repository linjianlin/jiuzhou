/**
 * 伙伴技能策略共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护伙伴技能策略的读取、默认补尾、禁用分组、顺序归一化与战斗策略生成。
 * 2. 做什么：把“伙伴当前有效技能全集 + 已保存策略”合并成单一视图，供路由、服务与战斗链路复用。
 * 3. 不做什么：不做伙伴归属鉴权，不处理 HTTP 参数，也不直接决定前端按钮文案。
 *
 * 输入/输出：
 * - 输入：伙伴 ID、当前有效技能列表、数据库中的策略行、客户端提交的完整 slots。
 * - 输出：面板展示 DTO、战斗消费 DTO，以及保存前的归一化 slot 列表。
 *
 * 数据流/状态流：
 * partnerView.buildPartnerEffectiveSkillEntries -> 本模块合并默认策略/持久化策略 -> partnerService / battleEngine / PartnerModal。
 *
 * 关键边界条件与坑点：
 * 1. 新技能没有历史配置时必须自动补到启用列表末尾，不能让前端或战斗链路各自决定默认顺序。
 * 2. 已失效技能必须在合并时直接剔除，禁止继续保留幽灵策略或兜底成旧行为。
 */
import { query } from '../../config/database.js';
import {
  isManualSkillTriggerType,
  normalizeExplicitSkillTriggerType,
} from '../../shared/skillTriggerType.js';
import {
  normalizeInteger,
  normalizeText,
  type PartnerEffectiveSkillEntry,
} from './partnerView.js';

export type PartnerSkillPolicyRow = {
  id: number;
  partner_id: number;
  skill_id: string;
  priority: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

export type PartnerSkillPolicySlotDto = {
  skillId: string;
  priority: number;
  enabled: boolean;
};

export type PartnerSkillPolicyEntryDto = {
  skillId: string;
  skillName: string;
  skillIcon: string;
  skillDescription?: string;
  cost_lingqi?: number;
  cost_lingqi_rate?: number;
  cost_qixue?: number;
  cost_qixue_rate?: number;
  cooldown?: number;
  target_type?: string;
  target_count?: number;
  damage_type?: string | null;
  element?: string;
  effects?: object[];
  sourceTechniqueId: string;
  sourceTechniqueName: string;
  sourceTechniqueQuality: string;
  priority: number;
  enabled: boolean;
};

export type PartnerSkillPolicyDto = {
  partnerId: number;
  entries: PartnerSkillPolicyEntryDto[];
};

export type PartnerSkillPolicyValidationResult =
  | { success: true; value: PartnerSkillPolicySlotDto[] }
  | { success: false; message: string };

const sortByPriority = <T extends { priority: number; naturalOrder: number }>(entries: T[]): T[] => {
  return [...entries].sort((left, right) => left.priority - right.priority || left.naturalOrder - right.naturalOrder);
};

const filterManualSkillPolicyEntries = (
  availableSkills: PartnerEffectiveSkillEntry[],
): PartnerEffectiveSkillEntry[] => {
  return availableSkills.filter((skill) => (
    isManualSkillTriggerType(
      normalizeExplicitSkillTriggerType(skill.trigger_type),
    )
  ));
};

export const loadPartnerSkillPolicyRows = async (
  partnerId: number,
  forUpdate: boolean,
): Promise<PartnerSkillPolicyRow[]> => {
  const normalizedPartnerId = normalizeInteger(partnerId);
  if (normalizedPartnerId <= 0) return [];
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT *
      FROM character_partner_skill_policy
      WHERE partner_id = $1
      ORDER BY enabled DESC, priority ASC, id ASC
      ${lockSql}
    `,
    [normalizedPartnerId],
  );
  return result.rows as PartnerSkillPolicyRow[];
};

const buildMergedEntries = (params: {
  availableSkills: PartnerEffectiveSkillEntry[];
  persistedRows: PartnerSkillPolicyRow[];
}): Array<PartnerSkillPolicyEntryDto & { naturalOrder: number }> => {
  const availableSkills = filterManualSkillPolicyEntries(params.availableSkills);
  const persistedRowMap = new Map<string, PartnerSkillPolicyRow>();
  for (const row of params.persistedRows) {
    const skillId = normalizeText(row.skill_id);
    if (!skillId) continue;
    if (persistedRowMap.has(skillId)) continue;
    persistedRowMap.set(skillId, row);
  }

  const enabledConfigured: Array<PartnerSkillPolicyEntryDto & { naturalOrder: number }> = [];
  const disabledConfigured: Array<PartnerSkillPolicyEntryDto & { naturalOrder: number }> = [];
  const defaultEnabled: Array<PartnerSkillPolicyEntryDto & { naturalOrder: number }> = [];

  availableSkills.forEach((skill, naturalOrder) => {
    const persistedRow = persistedRowMap.get(skill.skillId) ?? null;
    const persistedPriority = persistedRow ? normalizeInteger(persistedRow.priority, 1) : naturalOrder + 1;
    const baseEntry = {
      skillId: skill.skillId,
      skillName: skill.skillName,
      skillIcon: skill.skillIcon,
      skillDescription: skill.skillDescription,
      cost_lingqi: skill.cost_lingqi,
      cost_lingqi_rate: skill.cost_lingqi_rate,
      cost_qixue: skill.cost_qixue,
      cost_qixue_rate: skill.cost_qixue_rate,
      cooldown: skill.cooldown,
      target_type: skill.target_type,
      target_count: skill.target_count,
      damage_type: skill.damage_type,
      element: skill.element,
      effects: skill.effects,
      sourceTechniqueId: skill.sourceTechniqueId,
      sourceTechniqueName: skill.sourceTechniqueName,
      sourceTechniqueQuality: skill.sourceTechniqueQuality,
      priority: persistedPriority,
      enabled: persistedRow ? Boolean(persistedRow.enabled) : true,
      naturalOrder,
    };

    if (!persistedRow) {
      defaultEnabled.push(baseEntry);
      return;
    }

    if (persistedRow.enabled) {
      enabledConfigured.push(baseEntry);
      return;
    }

    disabledConfigured.push(baseEntry);
  });

  const orderedEnabled = [
    ...sortByPriority(enabledConfigured),
    ...defaultEnabled,
  ].map((entry, index) => ({
    ...entry,
    priority: index + 1,
    enabled: true,
  }));

  const orderedDisabled = sortByPriority(disabledConfigured).map((entry, index) => ({
    ...entry,
    priority: orderedEnabled.length + index + 1,
    enabled: false,
  }));

  return [...orderedEnabled, ...orderedDisabled];
};

export const buildPartnerSkillPolicyDto = (params: {
  partnerId: number;
  availableSkills: PartnerEffectiveSkillEntry[];
  persistedRows: PartnerSkillPolicyRow[];
}): PartnerSkillPolicyDto => {
  return {
    partnerId: normalizeInteger(params.partnerId),
    entries: buildMergedEntries(params).map(({ naturalOrder: _naturalOrder, ...entry }) => entry),
  };
};

export const buildPartnerBattleSkillPolicy = (params: {
  availableSkills: PartnerEffectiveSkillEntry[];
  persistedRows: PartnerSkillPolicyRow[];
}): { slots: PartnerSkillPolicySlotDto[] } => {
  return {
    slots: buildMergedEntries({
      availableSkills: params.availableSkills,
      persistedRows: params.persistedRows,
    }).map(({ skillId, priority, enabled }) => ({
      skillId,
      priority,
      enabled,
    })),
  };
};

export const normalizePartnerSkillPolicySlotsForSave = (params: {
  availableSkills: PartnerEffectiveSkillEntry[];
  slots: PartnerSkillPolicySlotDto[];
}): PartnerSkillPolicyValidationResult => {
  const availableSkills = filterManualSkillPolicyEntries(params.availableSkills);
  const availableSkillIds = new Set(availableSkills.map((skill) => skill.skillId));
  if (params.slots.length !== availableSkills.length) {
    return { success: false, message: '技能策略必须覆盖伙伴当前全部可配置技能' };
  }

  const seenSkillIds = new Set<string>();
  const enabledSlots: Array<PartnerSkillPolicySlotDto & { naturalOrder: number }> = [];
  const disabledSlots: Array<PartnerSkillPolicySlotDto & { naturalOrder: number }> = [];
  let invalidSlotFound = false;

  params.slots.forEach((slot, naturalOrder) => {
    const skillId = normalizeText(slot.skillId);
    const priority = normalizeInteger(slot.priority);
    if (!skillId) {
      invalidSlotFound = true;
      return;
    }
    if (seenSkillIds.has(skillId)) {
      invalidSlotFound = true;
      return;
    }
    seenSkillIds.add(skillId);
    if (!availableSkillIds.has(skillId)) {
      invalidSlotFound = true;
      return;
    }
    if (priority <= 0) {
      invalidSlotFound = true;
      return;
    }
    const normalizedSlot = {
      skillId,
      priority,
      enabled: slot.enabled,
      naturalOrder,
    };
    if (slot.enabled) {
      enabledSlots.push(normalizedSlot);
      return;
    }
    disabledSlots.push(normalizedSlot);
  });

  if (invalidSlotFound || seenSkillIds.size !== params.availableSkills.length) {
    return { success: false, message: '技能策略存在重复、缺失或非法技能' };
  }

  const normalizedSlots = [
    ...sortByPriority(enabledSlots),
    ...sortByPriority(disabledSlots),
  ].map((slot, index) => ({
    skillId: slot.skillId,
    priority: index + 1,
    enabled: slot.enabled,
  }));

  return {
    success: true,
    value: normalizedSlots,
  };
};
