/**
 * 伙伴系统服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一处理伙伴总览、出战切换、经验灌注、打书、主线发放初始伙伴和战斗快照构建。
 * 2) 不做什么：不解析 HTTP 参数，不直接决定 HTTP 参数结构；伙伴功法直接复用现有角色功法静态配置，不额外维护第二套功法定义。
 *
 * 输入/输出：
 * - 输入：characterId / userId、partnerId、经验预算、功法书信息、静态配置。
 * - 输出：统一 `{ success, message, data }` 结果，以及可复用的伙伴战斗成员快照。
 *
 * 数据流/状态流：
 * route / mainQuest / itemService / pve -> partnerService -> partnerRules + staticConfig + SQL -> DTO / 战斗快照。
 *
 * 关键边界条件与坑点：
 * 1) 伙伴升级与打书都必须在事务内锁定角色与伙伴行，避免经验双花和并发覆盖。
 * 2) 伙伴属性只由模板 + 成长值 + 等级 + 已学伙伴功法决定，严禁混入角色装备、悟道或套装属性。
 */
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { invalidateCharacterComputedCache } from './characterComputedService.js';
import {
  PARTNER_SYSTEM_FEATURE_CODE,
  isFeatureUnlocked,
} from './featureUnlockService.js';
import {
  getPartnerDefinitionById,
  getPartnerGrowthConfig,
  getStaticPartnerDefinitions,
  getItemDefinitionById,
  type PartnerDefConfig,
} from './staticConfigLoader.js';
import {
  getActivePartnerBattleMemberByCharacterId,
  scheduleActivePartnerBattleCacheRefreshByCharacterId,
} from './battle/shared/profileCache.js';
import { scheduleOnlineBattleCharacterSnapshotRefreshByCharacterId } from './onlineBattleProjectionService.js';
import { schedulePartnerRankSnapshotRefreshByCharacterId } from './partnerRankSnapshotService.js';
import { resolveGeneratedTechniqueBookDisplay } from './shared/generatedTechniqueBookView.js';
import {
  PARTNER_TECHNIQUE_PREVIEW_ITEM_LOCATION,
  buildPartnerTechniqueLearnPreviewMetadata,
} from './shared/partnerTechniqueLearnPreviewState.js';
import {
  deletePartnerTechniqueLearnPreviewItemsByIds,
  loadPartnerTechniqueLearnPreviewRecords,
} from './shared/partnerTechniqueLearnPreviewStore.js';
import {
  PARTNER_GROWTH_KEYS,
  listReplaceablePartnerTechniqueIds,
  resolvePartnerInjectPlan,
  type PartnerGrowthValues,
  type PartnerLearnedTechniqueState,
} from './shared/partnerRules.js';
import { setCharacterPartnerActivation } from './shared/partnerActivation.js';
import {
  attachPartnerTradeState,
  buildEffectivePartnerTechniqueEntries,
  buildPartnerDisplay,
  buildPartnerDetails,
  buildPartnerTechniqueDto,
  type EffectivePartnerTechniqueEntry,
  findEffectivePartnerTechniqueEntry,
  getPartnerTechniqueStaticMeta,
  loadPartnerDisplayById,
  loadPartnerRows,
  loadPartnerTechniqueRows,
  loadSinglePartnerRow,
  normalizeInteger,
  normalizeText,
  type PartnerComputedAttrsDto,
  type PartnerDetailDto,
  type PartnerDisplayDto,
  type PartnerGrowthDto,
  type PartnerPassiveAttrsDto,
  type PartnerRow,
  type PartnerTechniqueDto,
  type PartnerTechniqueStaticMeta,
  type PartnerTechniqueRow,
  type PartnerTechniqueSkillDto,
} from './shared/partnerView.js';
import { ensurePartnerInnateTechniquesVisible } from './shared/partnerInnateTechniqueVisibility.js';
import { loadPartnerMarketTradeStateMap, loadActivePartnerMarketListing } from './shared/partnerMarketState.js';
import {
  consumeCharacterStoredResourcesAndMaterialsAtomically,
} from './inventory/shared/consume.js';
import { loadCharacterSettlementResourceSnapshot } from './shared/characterSettlementResourceDeltaService.js';
import {
  loadActivePartnerFusionMaterial,
  loadPartnerFusionLockStateMap,
} from './shared/partnerFusionState.js';
import {
  buildPartnerSkillPolicyDto,
  normalizePartnerSkillPolicySlotsForSave,
  type PartnerSkillPolicyDto,
  type PartnerSkillPolicySlotDto,
} from './shared/partnerSkillPolicy.js';
import { loadPartnerBattleSkillPolicyState, type PartnerBattleMember } from './shared/partnerBattleMember.js';
import {
  resolvePartnerLevelLimit,
  type PartnerOwnerRealmContext,
} from './shared/partnerLevelLimit.js';
import { resolveTechniqueBookLearning } from './shared/techniqueBookRules.js';
import { consumeRenameCardItemInstance } from './shared/characterRenameCard.js';
import { validatePartnerDescription } from './shared/partnerDescriptionRules.js';
import { validatePartnerName } from './shared/partnerNameRules.js';
import {
  getItemMetaMap,
  getTechniqueLayerByTechniqueAndLayerStatic,
  resolveTechniqueCostMultiplierByQuality,
  scaleTechniqueBaseCostByQuality,
} from './shared/techniqueUpgradeRules.js';
import {
  deleteManagedAvatarIfReplaced,
  isValidManagedAvatarUrl,
  normalizeManagedAvatarValue,
} from './uploadService.js';
import { consumeSpecificItemInstance } from './inventory/shared/consume.js';
import {
  bufferCharacterItemInstanceMutations,
  type CharacterItemInstanceMetadata,
  type JsonValue,
  loadProjectedCharacterItemInstanceById,
  loadProjectedCharacterItemInstances,
  loadProjectedCharacterItemInstancesByLocation,
  reserveItemInstanceIds,
} from './shared/characterItemInstanceMutationService.js';
import { executeGeneratedPartnerRebone } from './shared/partnerReboneExecution.js';
import {
  getTechniqueDetailByIdForPartner,
  type SkillDefRow,
  type TechniqueDefRow,
  type TechniqueLayerRow,
} from './techniqueService.js';

export type {
  PartnerComputedAttrsDto,
  PartnerDetailDto,
  PartnerDisplayDto,
  PartnerGrowthDto,
  PartnerPassiveAttrsDto,
  PartnerTechniqueDto,
  PartnerTechniqueSkillDto,
} from './shared/partnerView.js';
export type {
  PartnerSkillPolicyDto,
  PartnerSkillPolicySlotDto,
} from './shared/partnerSkillPolicy.js';
export type { PartnerBattleMember } from './shared/partnerBattleMember.js';

const STARTER_PARTNER_DEF_ID = 'partner-qingmu-xiaoou';
const PARTNER_REBONE_ELIXIR_ITEM_DEF_ID = 'cons-partner-rebone-001';

type CharacterPartnerContextRow = {
  characterId: number;
  userId: number;
  exp: number;
  spiritStones: number;
  realm: string;
  subRealm: string | null;
};

export interface PartnerTechniqueUpgradeCostDto {
  currentLayer: number;
  maxLayer: number;
  nextLayer: number;
  spiritStones: number;
  exp: number;
  materials: Array<{ itemId: string; qty: number; itemName?: string; itemIcon?: string | null }>;
}

export interface PartnerTechniqueDetailDto {
  technique: TechniqueDefRow;
  layers: TechniqueLayerRow[];
  skills: SkillDefRow[];
  currentLayer: number;
  isInnate: boolean;
}

export interface PartnerUpgradeTechniqueResultDto {
  partner: PartnerDetailDto;
  updatedTechnique: PartnerTechniqueDto;
  newLayer: number;
}

export interface PartnerBookDto {
  itemInstanceId: number;
  itemDefId: string;
  name: string;
  icon: string | null;
  techniqueId: string;
  techniqueName: string;
  quality: string;
  qty: number;
}

export interface PartnerConsumableDto {
  itemDefId: string;
  itemInstanceId: number;
  name: string;
  icon: string | null;
  qty: number;
}

export interface PartnerOverviewDto {
  unlocked: true;
  featureCode: string;
  characterExp: number;
  activePartnerId: number | null;
  partners: PartnerDetailDto[];
  books: PartnerBookDto[];
  partnerConsumables: PartnerConsumableDto[];
  pendingTechniqueLearnPreview: PartnerPendingTechniqueLearnPreviewDto | null;
}

export interface PartnerInjectResultDto {
  partner: PartnerDetailDto;
  spentExp: number;
  characterExp: number;
  levelsGained: number;
}

export interface PartnerLearnTechniqueResultDto {
  partner: PartnerDetailDto;
  learnedTechnique: PartnerTechniqueDto;
  replacedTechnique: PartnerTechniqueDto | null;
  remainingBooks: PartnerBookDto[];
}

export interface PartnerTechniqueLearnPreviewDto {
  partnerId: number;
  itemInstanceId: number;
  learnedTechnique: PartnerTechniqueDto;
  replacedTechnique: PartnerTechniqueDto;
}

export interface PartnerPendingTechniqueLearnPreviewDto {
  book: PartnerBookDto;
  preview: PartnerTechniqueLearnPreviewDto;
}

export type PartnerTechniqueLearnActionResultDto =
  | {
      mode: 'learned';
      result: PartnerLearnTechniqueResultDto;
    }
  | {
      mode: 'preview_replace';
      preview: PartnerTechniqueLearnPreviewDto;
    };

export interface PartnerDiscardTechniqueBookResultDto {
  remainingBooks: PartnerBookDto[];
}

export interface PartnerRenameResultDto {
  partner: PartnerDetailDto;
}

export interface PartnerRewardDto {
  partnerId: number;
  partnerDefId: string;
  partnerName: string;
  partnerAvatar: string | null;
}

export interface CreatePartnerInstanceResult {
  reward: PartnerRewardDto;
  activated: boolean;
}

export interface PartnerResult<T = undefined> {
  success: boolean;
  message: string;
  data?: T;
}

const randomIntInclusive = (min: number, max: number): number => {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
};

const buildPartnerTechniqueLearnedEntry = (params: {
  techniqueId: string;
  itemDefId: string;
}): EffectivePartnerTechniqueEntry => ({
  row: null,
  techniqueId: params.techniqueId,
  currentLayer: 1,
  isInnate: false,
  learnedFromItemDefId: params.itemDefId,
});

/**
 * 伙伴战斗相关写入后的统一刷新入口。
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把“伙伴战斗缓存刷新 + 在线战斗角色投影刷新”收口到单一入口，避免伙伴切换、培养、技能策略等写链路各漏刷一处。
 * 2) 做什么：确保后续进入战斗读取到的当前出战伙伴，与伙伴面板里刚提交成功的最新状态保持一致。
 * 3) 不做什么：不做数据库写入，也不决定哪些业务该调用；调用方仍需在真正影响伙伴战斗快照后显式使用本函数。
 *
 * 输入/输出：
 * - 输入：characterId。
 * - 输出：无；副作用是在事务提交后刷新伙伴战斗缓存与在线战斗角色快照。
 *
 * 数据流/状态流：
 * partnerService 写库成功 -> 本函数登记 after-commit 刷新 -> battle/profileCache + onlineBattleProjection 同步更新。
 *
 * 关键边界条件与坑点：
 * 1) 这里只做提交后刷新，不在事务中抢先覆盖运行时快照，避免事务回滚后把 Redis/内存状态写脏。
 * 2) 在线战斗入口实际读取的是角色在线战斗投影里的 `activePartner`；只刷伙伴缓存而不刷投影，会导致“面板已切换、开战仍是旧伙伴”。
 */
const schedulePartnerBattleStateRefreshByCharacterId = async (
  characterId: number,
): Promise<void> => {
  await Promise.all([
    scheduleActivePartnerBattleCacheRefreshByCharacterId(characterId),
    scheduleOnlineBattleCharacterSnapshotRefreshByCharacterId(characterId),
  ]);
};

const loadPartnerTechniqueBookContext = async (params: {
  characterId: number;
  itemInstanceId: number;
  forUpdate: boolean;
}): Promise<PartnerResult<PartnerTechniqueBookContext>> => {
  const lockSql = params.forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT id, item_def_id, metadata
      FROM item_instance
      WHERE id = $1 AND owner_character_id = $2
      LIMIT 1
      ${lockSql}
    `,
    [params.itemInstanceId, params.characterId],
  );
  if (result.rows.length <= 0) {
    return { success: false, message: '功法书不存在' };
  }

  const row = result.rows[0] as {
    id: number | string | bigint | null;
    item_def_id: string | null;
    metadata: object | null;
  };
  const itemDefId = normalizeText(row.item_def_id);
  if (!itemDefId) {
    return { success: false, message: '功法书数据异常' };
  }

  const itemDef = getItemDefinitionById(itemDefId);
  const learning = resolveTechniqueBookLearning({
    itemDef,
    metadata: row.metadata,
  });
  if (!learning) {
    return { success: false, message: '该道具不是可供伙伴学习的功法书' };
  }

  return {
    success: true,
    message: 'ok',
    data: {
      itemInstanceId: normalizeInteger(row.id, 1),
      itemDefId,
      techniqueId: learning.techniqueId,
    },
  };
};

const loadPartnerTechniqueLearnContext = async (params: {
  characterId: number;
  partnerId: number;
  itemDefId: string;
  techniqueId: string;
  forUpdate: boolean;
}): Promise<PartnerResult<PartnerTechniqueLearnContext>> => {
  const unlockState = await assertPartnerSystemUnlocked(params.characterId);
  if (!unlockState.success) {
    return { success: false, message: unlockState.message };
  }

  const character = await loadCharacterPartnerContext(params.characterId, false);
  if (!character) {
    return { success: false, message: '角色不存在' };
  }

  const partnerRow = await loadSinglePartnerRow(params.characterId, params.partnerId, params.forUpdate);
  if (!partnerRow) {
    return { success: false, message: '伙伴不存在' };
  }
  if (await loadActivePartnerMarketListing(params.partnerId, params.forUpdate)) {
    return { success: false, message: '已在坊市挂单的伙伴不可学习功法' };
  }
  const fusionBlockedMessage = await getPartnerFusionBlockedMessage(params.partnerId, params.forUpdate, '学习功法');
  if (fusionBlockedMessage) {
    return { success: false, message: fusionBlockedMessage };
  }

  const partnerDef = await loadPartnerDefinitionOrThrow(partnerRow.partner_def_id);
  const techniqueMeta = getPartnerTechniqueStaticMeta(params.techniqueId, 1);
  if (!techniqueMeta) {
    return { success: false, message: '伙伴功法不存在或未开放' };
  }

  const techniqueMap = await loadPartnerTechniqueRows([params.partnerId], params.forUpdate);
  const currentTechniqueRows = techniqueMap.get(params.partnerId) ?? [];
  if (currentTechniqueRows.some((row) => row.technique_id === params.techniqueId)) {
    return { success: false, message: '该伙伴已学习此功法' };
  }

  const maxTechniqueSlots = normalizeInteger(partnerDef.max_technique_slots);
  const currentTechniqueStates = buildTechniqueStateList(partnerDef, currentTechniqueRows);
  const replaceableTechniqueIds = listReplaceablePartnerTechniqueIds(
    currentTechniqueStates,
    maxTechniqueSlots,
  );
  const currentEffectiveTechniqueCount = currentTechniqueStates.length;
  const learnedTechnique = buildPartnerTechniqueDto(
    buildPartnerTechniqueLearnedEntry({
      techniqueId: params.techniqueId,
      itemDefId: params.itemDefId,
    }),
    techniqueMeta,
  );

  return {
    success: true,
    message: 'ok',
    data: {
      character,
      partnerRow,
      partnerDef,
      currentTechniqueRows,
      currentEffectiveTechniqueCount,
      learnedTechnique,
      maxTechniqueSlots,
      replaceableTechniqueIds,
    },
  };
};

type OwnedPartnerTechniqueContext = {
  character: CharacterPartnerContextRow;
  partnerRow: PartnerRow;
  partnerDef: PartnerDefConfig;
  techniqueEntry: EffectivePartnerTechniqueEntry;
  techniqueMeta: PartnerTechniqueStaticMeta;
};

const loadOwnedPartnerTechniqueContext = async (params: {
  characterId: number;
  partnerId: number;
  techniqueId: string;
  forUpdate: boolean;
}): Promise<PartnerResult<OwnedPartnerTechniqueContext>> => {
  const unlockState = await assertPartnerSystemUnlocked(params.characterId);
  if (!unlockState.success) {
    return { success: false, message: unlockState.message };
  }

  const character = await loadCharacterPartnerContext(params.characterId, false);
  if (!character) {
    return { success: false, message: '角色不存在' };
  }

  const partnerRow = await loadSinglePartnerRow(params.characterId, params.partnerId, params.forUpdate);
  if (!partnerRow) {
    return { success: false, message: '伙伴不存在' };
  }
  const partnerDef = await loadPartnerDefinitionOrThrow(partnerRow.partner_def_id);

  const techniqueMap = await loadPartnerTechniqueRows([params.partnerId], params.forUpdate);
  const techniqueRows = techniqueMap.get(params.partnerId) ?? [];
  const techniqueEntry = findEffectivePartnerTechniqueEntry(
    partnerDef,
    techniqueRows,
    params.techniqueId,
  );
  if (!techniqueEntry) {
    return { success: false, message: '该伙伴未学习此功法' };
  }

  const techniqueMeta = getPartnerTechniqueStaticMeta(
    techniqueEntry.techniqueId,
    techniqueEntry.currentLayer,
  );
  if (!techniqueMeta) {
    return { success: false, message: '伙伴功法不存在或未开放' };
  }

  return {
    success: true,
    message: 'ok',
    data: {
      character,
      partnerRow,
      partnerDef,
      techniqueEntry,
      techniqueMeta,
    },
  };
};

const resolveRandomReplaceableTechniqueId = (
  replaceableTechniqueIds: string[],
): string | null => {
  if (replaceableTechniqueIds.length <= 0) {
    return null;
  }
  return replaceableTechniqueIds[
    randomIntInclusive(0, replaceableTechniqueIds.length - 1)
  ] ?? null;
};

const buildReplacePreviewTechnique = (
  currentTechniqueRows: PartnerTechniqueRow[],
  replacedTechniqueId: string,
): PartnerTechniqueDto | null => {
  const replacedRow =
    currentTechniqueRows.find((row) => row.technique_id === replacedTechniqueId) ?? null;
  if (!replacedRow) {
    return null;
  }
  const replacedTechniqueMeta = getPartnerTechniqueStaticMeta(
    replacedRow.technique_id,
    replacedRow.current_layer,
  );
  if (!replacedTechniqueMeta) {
    return null;
  }
  return buildPartnerTechniqueDto({
    row: replacedRow,
    techniqueId: replacedRow.technique_id,
    currentLayer: normalizeInteger(replacedRow.current_layer, 1),
    isInnate: false,
    learnedFromItemDefId: replacedRow.learned_from_item_def_id ?? null,
  }, replacedTechniqueMeta);
};

const buildPartnerTechniqueLearnSuccessResult = async (params: {
  characterId: number;
  partnerRow: PartnerRow;
  partnerDef: PartnerDefConfig;
  character: CharacterPartnerContextRow;
  partnerId: number;
  techniqueId: string;
  replacedTechnique: PartnerTechniqueDto | null;
  successMessage: string;
}): Promise<PartnerResult<PartnerLearnTechniqueResultDto>> => {
  const refreshedTechniqueMap = await loadPartnerTechniqueRows([params.partnerId], false);
  const partner = await buildPartnerDetailWithTradeState({
    row: params.partnerRow,
    definition: params.partnerDef,
    techniqueRows: refreshedTechniqueMap.get(params.partnerId) ?? [],
    ownerRealm: {
      realm: params.character.realm,
      subRealm: params.character.subRealm,
    },
  });
  const learnedTechnique = partner.techniques.find(
    (entry) => entry.techniqueId === params.techniqueId,
  );
  if (!learnedTechnique) {
    return { success: false, message: '伙伴功法刷新失败' };
  }

  await schedulePartnerBattleStateRefreshByCharacterId(params.characterId);
  await schedulePartnerRankSnapshotRefreshByCharacterId(params.characterId);

  return {
    success: true,
    message: params.successMessage,
    data: {
      partner,
      learnedTechnique,
      replacedTechnique: params.replacedTechnique,
      remainingBooks: await loadPartnerBooks(params.characterId),
    },
  };
};

const applyPartnerTechniqueLearn = async (params: {
  characterId: number;
  partnerId: number;
  itemDefId: string;
  techniqueId: string;
  allowRandomReplacement: boolean;
  replacedTechniqueId?: string | null;
}): Promise<PartnerResult<PartnerLearnTechniqueResultDto>> => {
  const contextResult = await loadPartnerTechniqueLearnContext({
    characterId: params.characterId,
    partnerId: params.partnerId,
    itemDefId: params.itemDefId,
    techniqueId: params.techniqueId,
    forUpdate: true,
  });
  if (!contextResult.success || !contextResult.data) {
    return { success: false, message: contextResult.message };
  }

  const context = contextResult.data;
  if (context.currentEffectiveTechniqueCount < context.maxTechniqueSlots) {
    await query(
      `
        INSERT INTO character_partner_technique (
          partner_id,
          technique_id,
          current_layer,
          is_innate,
          learned_from_item_def_id,
          created_at,
          updated_at
        )
        VALUES ($1, $2, 1, FALSE, $3, NOW(), NOW())
      `,
      [params.partnerId, params.techniqueId, params.itemDefId],
    );
    return buildPartnerTechniqueLearnSuccessResult({
      characterId: params.characterId,
      partnerRow: context.partnerRow,
      partnerDef: context.partnerDef,
      character: context.character,
      partnerId: params.partnerId,
      techniqueId: params.techniqueId,
      replacedTechnique: null,
      successMessage: '伙伴学习功法成功',
    });
  }

  if (context.replaceableTechniqueIds.length <= 0) {
    return { success: false, message: '当前只有天生功法，无法继续打书' };
  }

  const replacedTechniqueId =
    normalizeText(params.replacedTechniqueId) ||
    (params.allowRandomReplacement ? resolveRandomReplaceableTechniqueId(context.replaceableTechniqueIds) : null);
  if (!replacedTechniqueId) {
    return { success: false, message: '请先确认要覆盖的功法' };
  }
  if (!context.replaceableTechniqueIds.includes(replacedTechniqueId)) {
    return { success: false, message: '预览已失效，请重新选择功法书' };
  }

  const replacedTechnique = buildReplacePreviewTechnique(
    context.currentTechniqueRows,
    replacedTechniqueId,
  );
  if (!replacedTechnique) {
    return { success: false, message: '被覆盖功法不存在或已失效' };
  }

  await query(
    `
      UPDATE character_partner_technique
      SET technique_id = $2,
          current_layer = 1,
          is_innate = FALSE,
          learned_from_item_def_id = $3,
          updated_at = NOW()
      WHERE partner_id = $1 AND technique_id = $4
    `,
    [params.partnerId, params.techniqueId, params.itemDefId, replacedTechniqueId],
  );

  return buildPartnerTechniqueLearnSuccessResult({
    characterId: params.characterId,
    partnerRow: context.partnerRow,
    partnerDef: context.partnerDef,
    character: context.character,
    partnerId: params.partnerId,
    techniqueId: params.techniqueId,
    replacedTechnique,
    successMessage: '伙伴打书成功，原功法已被覆盖',
  });
};

type PartnerItemInstanceRow = {
  id: number;
  item_def_id: string;
  qty: number;
  location: string;
  location_slot: number | null;
  metadata: object | null;
};

type PartnerPreviewItemInstanceRow = PartnerItemInstanceRow & {
  owner_user_id: number | string | bigint | null;
  owner_character_id: number | string | bigint | null;
  quality: string | null;
  quality_rank: number | string | bigint | null;
  bind_type: string | null;
  bind_owner_user_id: number | string | bigint | null;
  bind_owner_character_id: number | string | bigint | null;
  locked: boolean;
  expire_at: string | Date | null;
  obtained_from: string | null;
  obtained_ref_id: string | null;
  affixes: object | null;
  socketed_gems: object | null;
  affix_roll_meta: object | null;
  random_seed: number | string | bigint | null;
  identified: boolean;
  affix_gen_version: number | string | bigint | null;
  strengthen_level: number | string | bigint | null;
  refine_level: number | string | bigint | null;
  custom_name: string | null;
};

type PartnerTechniqueBookContext = {
  itemInstanceId: number;
  itemDefId: string;
  techniqueId: string;
};

type PartnerTechniqueLearnContext = {
  character: CharacterPartnerContextRow;
  partnerRow: PartnerRow;
  partnerDef: PartnerDefConfig;
  currentTechniqueRows: PartnerTechniqueRow[];
  currentEffectiveTechniqueCount: number;
  learnedTechnique: PartnerTechniqueDto;
  maxTechniqueSlots: number;
  replaceableTechniqueIds: string[];
};

type PartnerPendingTechniqueLearnPreviewContext = {
  book: PartnerBookDto;
  preview: PartnerTechniqueLearnPreviewDto;
};

const normalizePreviewMetadataForSnapshot = (
  metadata: ReturnType<typeof buildPartnerTechniqueLearnPreviewMetadata>,
): CharacterItemInstanceMetadata => {
  const cloned = JSON.parse(JSON.stringify(metadata)) as JsonValue;
  if (cloned !== null && !Array.isArray(cloned) && typeof cloned === 'object') {
    return cloned;
  }
  return null;
};

const loadCharacterPartnerContext = async (
  characterId: number,
  forUpdate: boolean,
): Promise<CharacterPartnerContextRow | null> => {
  // 这里只在“后续会直接写 characters 行本身”时才需要 FOR UPDATE。
  // 伙伴链路多数场景只读取角色境界/余额快照，继续锁 characters 会把角色行放大成总串行点。
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT id, user_id, exp, spirit_stones, realm, sub_realm
      FROM characters
      WHERE id = $1
      LIMIT 1
      ${lockSql}
    `,
    [characterId],
  );
  if (result.rows.length <= 0) return null;
  const row = result.rows[0] as {
    id: number | string | bigint | null;
    user_id: number | string | bigint | null;
    exp: number | string | bigint | null;
    spirit_stones: number | string | bigint | null;
    realm: string | null;
    sub_realm: string | null;
  };
  return {
    characterId: normalizeInteger(row.id),
    userId: normalizeInteger(row.user_id),
    exp: normalizeInteger(row.exp),
    spiritStones: normalizeInteger(row.spirit_stones),
    realm: normalizeText(row.realm) || '凡人',
    subRealm: normalizeText(row.sub_realm) || null,
  };
};

const buildPartnerBookDto = (
  row: Pick<PartnerItemInstanceRow, 'id' | 'item_def_id' | 'qty' | 'metadata'>,
): PartnerBookDto | null => {
  const itemDefId = normalizeText(row.item_def_id);
  if (!itemDefId) return null;

  const itemDef = getItemDefinitionById(itemDefId);
  const learning = resolveTechniqueBookLearning({
    itemDef,
    metadata: row.metadata,
  });
  if (!itemDef || !learning) return null;

  const techniqueMeta = getPartnerTechniqueStaticMeta(learning.techniqueId, 1);
  if (!techniqueMeta) return null;

  const generatedDisplay = resolveGeneratedTechniqueBookDisplay(itemDefId, row.metadata);
  return {
    itemInstanceId: normalizeInteger(row.id, 1),
    itemDefId,
    name:
      normalizeText(generatedDisplay?.name) ||
      normalizeText(itemDef.name) ||
      itemDefId,
    icon: normalizeText(itemDef.icon) || null,
    techniqueId: learning.techniqueId,
    techniqueName:
      normalizeText(generatedDisplay?.generatedTechniqueName) ||
      normalizeText(techniqueMeta.definition.name) ||
      learning.techniqueId,
    quality:
      normalizeText(generatedDisplay?.quality) ||
      normalizeText(itemDef.quality) ||
      normalizeText(techniqueMeta.definition.quality) ||
      '黄',
    qty: normalizeInteger(row.qty, 1),
  };
};

const loadPartnerDefinitionOrThrow = async (
  partnerDefId: string,
): Promise<PartnerDefConfig> => {
  const definition = await getPartnerDefinitionById(partnerDefId);
  if (!definition) {
    throw new Error(`伙伴模板不存在: ${partnerDefId}`);
  }
  return definition;
};

const buildPartnerDetailWithTradeState = async (params: {
  row: PartnerRow;
  definition: PartnerDefConfig;
  techniqueRows: PartnerTechniqueRow[];
  ownerRealm: PartnerOwnerRealmContext;
}): Promise<PartnerDetailDto> => {
  const tradeStateMap = await loadPartnerMarketTradeStateMap([params.row.id]);
  const fusionStateMap = await loadPartnerFusionLockStateMap([params.row.id]);
  return attachPartnerTradeState(
    buildPartnerDisplay(params),
    {
      tradeState: tradeStateMap.get(params.row.id),
      fusionState: fusionStateMap.get(params.row.id),
    },
  );
};

const loadPartnerBooks = async (characterId: number): Promise<PartnerBookDto[]> => {
  const result = await query(
    `
      SELECT id, item_def_id, qty, location, location_slot, metadata
      FROM item_instance
      WHERE owner_character_id = $1
        AND location = 'bag'
        AND qty > 0
      ORDER BY location_slot ASC NULLS LAST, id ASC
    `,
    [characterId],
  );

  const books: PartnerBookDto[] = [];
  for (const row of result.rows as PartnerItemInstanceRow[]) {
    const book = buildPartnerBookDto(row);
    if (!book) continue;
    books.push(book);
  }

  return books;
};

const buildPendingPartnerTechniqueLearnPreview = async (params: {
  characterId: number;
  itemRow: Pick<PartnerItemInstanceRow, 'id' | 'item_def_id' | 'qty' | 'metadata'>;
  state: {
    partnerId: number;
    learnedTechniqueId: string;
    replacedTechniqueId: string;
  };
  forUpdate: boolean;
}): Promise<PartnerResult<PartnerPendingTechniqueLearnPreviewDto>> => {
  const book = buildPartnerBookDto(params.itemRow);
  if (!book) {
    return { success: false, message: '待处理打书预览中的功法书数据异常' };
  }

  if (book.techniqueId !== params.state.learnedTechniqueId) {
    return { success: false, message: '待处理打书预览与功法书不匹配' };
  }

  const contextResult = await loadPartnerTechniqueLearnContext({
    characterId: params.characterId,
    partnerId: params.state.partnerId,
    itemDefId: book.itemDefId,
    techniqueId: params.state.learnedTechniqueId,
    forUpdate: params.forUpdate,
  });
  if (!contextResult.success || !contextResult.data) {
    return { success: false, message: contextResult.message };
  }

  const replacedTechnique = buildReplacePreviewTechnique(
    contextResult.data.currentTechniqueRows,
    params.state.replacedTechniqueId,
  );
  if (!replacedTechnique) {
    return { success: false, message: '待处理打书预览中的被替换功法已失效' };
  }

  return {
    success: true,
    message: 'ok',
    data: {
      book,
      preview: {
        partnerId: params.state.partnerId,
        itemInstanceId: book.itemInstanceId,
        learnedTechnique: contextResult.data.learnedTechnique,
        replacedTechnique,
      },
    },
  };
};

type PendingPartnerTechniqueLearnPreviewInvalidPolicy = 'strict' | 'cleanup_invalid';

const loadPendingPartnerTechniqueLearnPreviewInternal = async (params: {
  characterId: number;
  forUpdate: boolean;
  invalidPolicy: PendingPartnerTechniqueLearnPreviewInvalidPolicy;
}): Promise<PartnerResult<PartnerPendingTechniqueLearnPreviewDto | null>> => {
  const records = await loadPartnerTechniqueLearnPreviewRecords({
    characterId: params.characterId,
    forUpdate: params.forUpdate,
  });
  if (records.length <= 0) {
    return { success: true, message: 'ok', data: null };
  }

  const validPreviews: PartnerPendingTechniqueLearnPreviewDto[] = [];
  const invalidItemIds: number[] = [];

  for (const record of records) {
    if (!record.state) {
      if (params.invalidPolicy === 'strict') {
        return { success: false, message: '待处理打书预览数据异常' };
      }
      invalidItemIds.push(normalizeInteger(record.row.id));
      continue;
    }

    const previewResult = await buildPendingPartnerTechniqueLearnPreview({
      characterId: params.characterId,
      itemRow: record.row,
      state: record.state,
      forUpdate: params.forUpdate,
    });
    if (!previewResult.success || !previewResult.data) {
      if (params.invalidPolicy === 'strict') {
        return { success: false, message: previewResult.message };
      }
      invalidItemIds.push(normalizeInteger(record.row.id));
      continue;
    }
    validPreviews.push(previewResult.data);
  }

  if (params.invalidPolicy === 'cleanup_invalid' && invalidItemIds.length > 0) {
    await deletePartnerTechniqueLearnPreviewItemsByIds({
      characterId: params.characterId,
      itemInstanceIds: invalidItemIds,
    });
  }

  if (validPreviews.length <= 0) {
    return { success: true, message: 'ok', data: null };
  }
  if (validPreviews.length > 1) {
    return { success: false, message: '存在多个待处理的伙伴打书预览，请先清理异常数据' };
  }

  return {
    success: true,
    message: 'ok',
    data: validPreviews[0] ?? null,
  };
};

const loadPendingPartnerTechniqueLearnPreview = async (
  characterId: number,
): Promise<PartnerResult<PartnerPendingTechniqueLearnPreviewDto | null>> => {
  return loadPendingPartnerTechniqueLearnPreviewInternal({
    characterId,
    forUpdate: false,
    invalidPolicy: 'cleanup_invalid',
  });
};

const loadPendingPartnerTechniqueLearnPreviewByItem = async (params: {
  characterId: number;
  itemInstanceId: number;
  forUpdate: boolean;
}): Promise<PartnerResult<PartnerPendingTechniqueLearnPreviewDto>> => {
  const records = await loadPartnerTechniqueLearnPreviewRecords({
    characterId: params.characterId,
    forUpdate: params.forUpdate,
  });
  const matchedRecord = records.find((record) => normalizeInteger(record.row.id) === params.itemInstanceId) ?? null;
  if (!matchedRecord) {
    return { success: false, message: '待处理打书预览不存在' };
  }
  if (!matchedRecord.state) {
    return { success: false, message: '待处理打书预览数据异常' };
  }

  return buildPendingPartnerTechniqueLearnPreview({
    characterId: params.characterId,
    itemRow: matchedRecord.row,
    state: matchedRecord.state,
    forUpdate: params.forUpdate,
  });
};

const reservePartnerTechniqueLearnPreviewBook = async (params: {
  characterId: number;
  itemInstanceId: number;
  partnerId: number;
  learnedTechniqueId: string;
  replacedTechniqueId: string;
}): Promise<PartnerResult<number>> => {
  const existingPreview = (await loadProjectedCharacterItemInstances(params.characterId))
    .find((item) => item.location === PARTNER_TECHNIQUE_PREVIEW_ITEM_LOCATION) ?? null;
  if (existingPreview) {
    return { success: false, message: '当前已有待处理的伙伴打书预览，请先确认或放弃' };
  }

  const itemRow = await loadProjectedCharacterItemInstanceById(params.characterId, params.itemInstanceId);
  if (!itemRow) {
    return { success: false, message: '功法书不存在' };
  }
  if (itemRow.locked) {
    return { success: false, message: '道具已锁定' };
  }
  if (!['bag', 'warehouse'].includes(normalizeText(itemRow.location))) {
    return { success: false, message: '道具当前位置不可用于伙伴打书预览' };
  }
  const currentQty = normalizeInteger(itemRow.qty, 1);
  if (currentQty <= 0) {
    return { success: false, message: '道具数量不足' };
  }

  const metadata = buildPartnerTechniqueLearnPreviewMetadata(itemRow.metadata, {
    partnerId: params.partnerId,
    learnedTechniqueId: params.learnedTechniqueId,
    replacedTechniqueId: params.replacedTechniqueId,
  });
  const snapshotMetadata = normalizePreviewMetadataForSnapshot(metadata);

  if (currentQty === 1) {
    await bufferCharacterItemInstanceMutations([
      {
        opId: `partner-technique-preview-move:${params.itemInstanceId}:${Date.now()}`,
        characterId: params.characterId,
        itemId: params.itemInstanceId,
        createdAt: Date.now(),
        kind: 'upsert',
        snapshot: {
          ...itemRow,
          location: PARTNER_TECHNIQUE_PREVIEW_ITEM_LOCATION,
          location_slot: null,
          equipped_slot: null,
          metadata: snapshotMetadata,
        },
      },
    ]);
    return {
      success: true,
      message: 'ok',
      data: params.itemInstanceId,
    };
  }

  const [previewItemInstanceId] = await reserveItemInstanceIds(1);
  if (!Number.isInteger(previewItemInstanceId) || previewItemInstanceId <= 0) {
    return { success: false, message: '保留待处理功法书失败' };
  }
  await bufferCharacterItemInstanceMutations([
    {
      opId: `partner-technique-preview-source:${params.itemInstanceId}:${Date.now()}`,
      characterId: params.characterId,
      itemId: params.itemInstanceId,
      createdAt: Date.now(),
      kind: 'upsert',
      snapshot: {
        ...itemRow,
        qty: currentQty - 1,
      },
    },
    {
      opId: `partner-technique-preview-clone:${previewItemInstanceId}:${Date.now()}`,
      characterId: params.characterId,
      itemId: previewItemInstanceId,
      createdAt: Date.now() + 1,
      kind: 'upsert',
      snapshot: {
        ...itemRow,
        id: previewItemInstanceId,
        qty: 1,
        location: PARTNER_TECHNIQUE_PREVIEW_ITEM_LOCATION,
        location_slot: null,
        equipped_slot: null,
        metadata: snapshotMetadata,
        created_at: new Date(),
      },
    },
  ]);

  return {
    success: true,
    message: 'ok',
    data: previewItemInstanceId,
  };
};

const deletePendingPartnerTechniqueLearnPreviewBook = async (params: {
  characterId: number;
  itemInstanceId: number;
}): Promise<PartnerResult> => {
  const previewItem = await loadProjectedCharacterItemInstanceById(params.characterId, params.itemInstanceId);
  if (!previewItem || previewItem.location !== PARTNER_TECHNIQUE_PREVIEW_ITEM_LOCATION) {
    return { success: false, message: '待处理打书预览不存在或已失效' };
  }
  await bufferCharacterItemInstanceMutations([
    {
      opId: `partner-technique-preview-delete:${params.itemInstanceId}:${Date.now()}`,
      characterId: params.characterId,
      itemId: params.itemInstanceId,
      createdAt: Date.now(),
      kind: 'delete',
      snapshot: null,
    },
  ]);
  return { success: true, message: 'ok' };
};

const loadPartnerConsumables = async (
  characterId: number,
): Promise<PartnerConsumableDto[]> => {
  const itemDef = getItemDefinitionById(PARTNER_REBONE_ELIXIR_ITEM_DEF_ID);
  if (!itemDef) {
    return [];
  }

  return (await loadProjectedCharacterItemInstancesByLocation(characterId, 'bag'))
    .filter((row) => row.qty > 0 && row.item_def_id === PARTNER_REBONE_ELIXIR_ITEM_DEF_ID)
    .sort((left, right) => {
      const leftSlot = left.location_slot ?? Number.MAX_SAFE_INTEGER;
      const rightSlot = right.location_slot ?? Number.MAX_SAFE_INTEGER;
      if (leftSlot !== rightSlot) return leftSlot - rightSlot;
      return left.id - right.id;
    })
    .map((row) => ({
    itemDefId: PARTNER_REBONE_ELIXIR_ITEM_DEF_ID,
    itemInstanceId: normalizeInteger(row.id, 1),
    name: normalizeText(itemDef.name) || PARTNER_REBONE_ELIXIR_ITEM_DEF_ID,
    icon: normalizeText(itemDef.icon) || null,
    qty: normalizeInteger(row.qty, 1),
  }));
};

const buildTechniqueStateList = (
  definition: PartnerDefConfig,
  techniqueRows: PartnerTechniqueRow[],
): PartnerLearnedTechniqueState[] => {
  return buildEffectivePartnerTechniqueEntries(definition, techniqueRows).map((entry) => ({
    techniqueId: entry.techniqueId,
    isInnate: entry.isInnate,
  }));
};

const assertPartnerSystemUnlocked = async (
  characterId: number,
): Promise<PartnerResult> => {
  const unlocked = await isFeatureUnlocked(
    characterId,
    PARTNER_SYSTEM_FEATURE_CODE,
  );
  if (!unlocked) {
    return { success: false, message: '伙伴系统尚未解锁' };
  }
  return { success: true, message: 'ok' };
};

const getPartnerFusionBlockedMessage = async (
  partnerId: number,
  forUpdate: boolean,
  actionLabel: string,
): Promise<string | null> => {
  const fusionState = await loadActivePartnerFusionMaterial(partnerId, forUpdate);
  if (!fusionState) return null;
  return `归契中的伙伴不可${actionLabel}`;
};

const buildPartnerTechniqueUpgradeCost = async (params: {
  techniqueId: string;
  techniqueMeta: PartnerTechniqueStaticMeta;
}): Promise<PartnerTechniqueUpgradeCostDto | null> => {
  const { techniqueId, techniqueMeta } = params;
  if (techniqueMeta.currentLayer >= techniqueMeta.maxLayer) return null;
  const nextLayer = techniqueMeta.currentLayer + 1;
  const nextLayerConfig = getTechniqueLayerByTechniqueAndLayerStatic(
    techniqueId,
    nextLayer,
  );
  if (!nextLayerConfig) return null;
  const qualityMultiplier = resolveTechniqueCostMultiplierByQuality(
    techniqueMeta.definition.quality,
  );
  const metaMap = await getItemMetaMap(
    nextLayerConfig.costMaterials.map((entry) => entry.itemId),
  );
  return {
    currentLayer: techniqueMeta.currentLayer,
    maxLayer: techniqueMeta.maxLayer,
    nextLayer,
    spiritStones: scaleTechniqueBaseCostByQuality(
      nextLayerConfig.costSpiritStones,
      qualityMultiplier,
    ),
    exp: scaleTechniqueBaseCostByQuality(
      nextLayerConfig.costExp,
      qualityMultiplier,
    ),
    materials: nextLayerConfig.costMaterials.map((entry) => {
      const meta = metaMap.get(entry.itemId) ?? null;
      return {
        itemId: entry.itemId,
        qty: entry.qty,
        itemName: meta?.name,
        itemIcon: meta?.icon,
      };
    }),
  };
};

const buildPartnerTechniqueDetailDto = async (params: {
  techniqueId: string;
  currentLayer: number;
  isInnate: boolean;
}): Promise<PartnerTechniqueDetailDto | null> => {
  const detail = await getTechniqueDetailByIdForPartner(params.techniqueId);
  if (!detail) {
    return null;
  }

  return {
    technique: detail.technique,
    layers: detail.layers,
    skills: detail.skills,
    currentLayer: params.currentLayer,
    isInnate: params.isInnate,
  };
};

const loadPreviewPartnerTechniqueDetail = async (
  partnerId: number,
  techniqueId: string,
): Promise<PartnerResult<PartnerTechniqueDetailDto>> => {
  const partner = await loadPartnerDisplayById(partnerId);
  if (!partner) {
    return { success: false, message: '伙伴不存在' };
  }

  const technique = partner.techniques.find((entry) => entry.techniqueId === techniqueId) ?? null;
  if (!technique) {
    return { success: false, message: '该伙伴未学习此功法' };
  }

  const detail = await buildPartnerTechniqueDetailDto({
    techniqueId: technique.techniqueId,
    currentLayer: technique.currentLayer,
    isInnate: technique.isInnate,
  });
  if (!detail) {
    return { success: false, message: '伙伴功法详情不存在' };
  }

  return {
    success: true,
    message: '获取成功',
    data: detail,
  };
};

const buildPartnerRewardDto = (
  partnerId: number,
  definition: PartnerDefConfig,
): PartnerRewardDto => ({
  partnerId,
  partnerDefId: definition.id,
  partnerName: normalizeText(definition.name) || definition.id,
  partnerAvatar: normalizeText(definition.avatar) || null,
});

/**
 * 创建伙伴实例共享入口。
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把“根据伙伴定义创建实例”收敛成单入口，供初始伙伴发放与 AI 招募确认复用。
 * 2) 做什么：统一处理成长初值、首个伙伴自动出战、来源字段写入，避免两条获得链路各写一套插入 SQL。
 * 3) 不做什么：不负责功能解锁、不负责招募扣费，也不刷新前端总览。
 *
 * 输入/输出：
 * - 输入：角色ID、伙伴定义、来源字段、可选昵称。
 * - 输出：新伙伴奖励 DTO 与是否自动出战。
 *
 * 数据流/状态流：
 * starter reward / recruit confirm -> createPartnerInstanceFromDefinition -> character_partner -> partnerService/buildActivePartnerBattleMember。
 *
 * 关键边界条件与坑点：
 * 1) 插入前必须校验所有天生功法都能在统一功法入口读到，否则战斗构建会在运行时爆炸。
 * 2) 新获得伙伴默认保持未出战，把“是否携带伙伴战斗”的决定完全交给玩家显式控制。
 */
const createPartnerInstanceFromDefinition = async (params: {
  characterId: number;
  definition: PartnerDefConfig;
  obtainedFrom: string;
  obtainedRefId?: string;
  nickname?: string;
}): Promise<CreatePartnerInstanceResult> => {
  const { characterId, definition, obtainedFrom, obtainedRefId, nickname } = params;
  const growthValues = Object.fromEntries(
    PARTNER_GROWTH_KEYS.map((key) => [key, 1000]),
  ) as PartnerGrowthValues;

  const innateTechniqueVisibility = await ensurePartnerInnateTechniquesVisible(definition);
  if (!innateTechniqueVisibility.success) {
    throw new Error(`伙伴天生功法不存在: ${innateTechniqueVisibility.missingTechniqueIds.join(', ')}`);
  }

  const activated = false;
  const insertResult = await query(
    `
      INSERT INTO character_partner (
        character_id,
        partner_def_id,
        nickname,
        level,
        progress_exp,
        growth_max_qixue,
        growth_wugong,
        growth_fagong,
        growth_wufang,
        growth_fafang,
        growth_sudu,
        is_active,
        obtained_from,
        obtained_ref_id,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 1, 0, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
      RETURNING id
    `,
    [
      characterId,
      definition.id,
      normalizeText(nickname) || normalizeText(definition.name) || definition.id,
      growthValues.max_qixue,
      growthValues.wugong,
      growthValues.fagong,
      growthValues.wufang,
      growthValues.fafang,
      growthValues.sudu,
      activated,
      obtainedFrom,
      normalizeText(obtainedRefId) || null,
    ],
  );
  const partnerId = normalizeInteger(insertResult.rows[0]?.id, 1);
  await schedulePartnerRankSnapshotRefreshByCharacterId(characterId);
  return {
    reward: buildPartnerRewardDto(partnerId, definition),
    activated,
  };
};

class PartnerService {
  async listLearnTechniqueBooks(characterId: number): Promise<PartnerBookDto[]> {
    return loadPartnerBooks(characterId);
  }

  async getPreview(partnerId: number): Promise<PartnerResult<PartnerDisplayDto>> {
    try {
      const partner = await loadPartnerDisplayById(partnerId);
      if (!partner) {
        return { success: false, message: '伙伴不存在' };
      }

      return {
        success: true,
        message: 'ok',
        data: partner,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴详情读取失败：${reason}` };
    }
  }

  async getOverview(characterId: number): Promise<PartnerResult<PartnerOverviewDto>> {
    try {
      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const [
        character,
        resourceSnapshot,
        rows,
        books,
        partnerConsumables,
        pendingTechniqueLearnPreviewResult,
      ] = await Promise.all([
        loadCharacterPartnerContext(characterId, false),
        loadCharacterSettlementResourceSnapshot(characterId),
        loadPartnerRows(characterId, false),
        loadPartnerBooks(characterId),
        loadPartnerConsumables(characterId),
        loadPendingPartnerTechniqueLearnPreview(characterId),
      ]);
      if (!character) return { success: false, message: '角色不存在' };
      if (!pendingTechniqueLearnPreviewResult.success) {
        return { success: false, message: pendingTechniqueLearnPreviewResult.message };
      }

      const partnerIds = rows.map((row) => row.id);
      const [techniqueMap, tradeStateMap, fusionStateMap] = await Promise.all([
        loadPartnerTechniqueRows(partnerIds, false),
        loadPartnerMarketTradeStateMap(partnerIds),
        loadPartnerFusionLockStateMap(partnerIds),
      ]);
      const partners = await buildPartnerDetails({
        rows,
        techniqueMap,
        ownerRealmMap: new Map(
          rows.map((row) => [row.character_id, {
            realm: character.realm,
            subRealm: character.subRealm,
          }]),
        ),
        tradeStateMap,
        fusionStateMap,
      });
      const pendingTechniqueLearnPreview = pendingTechniqueLearnPreviewResult.data ?? null;

      return {
        success: true,
        message: 'ok',
        data: {
          unlocked: true,
          featureCode: PARTNER_SYSTEM_FEATURE_CODE,
          characterExp: resourceSnapshot?.exp ?? character.exp,
          activePartnerId:
            partners.find((entry) => entry.isActive)?.id ?? null,
          partners,
          books,
          partnerConsumables,
          pendingTechniqueLearnPreview,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴总览读取失败：${reason}` };
    }
  }

  async getSkillPolicy(
    characterId: number,
    partnerId: number,
  ): Promise<PartnerResult<PartnerSkillPolicyDto>> {
    try {
      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(characterId, false);
      if (!character) return { success: false, message: '角色不存在' };

      const partnerRow = await loadSinglePartnerRow(characterId, partnerId, false);
      if (!partnerRow) return { success: false, message: '伙伴不存在' };
      const partnerDef = await loadPartnerDefinitionOrThrow(partnerRow.partner_def_id);

      const techniqueMap = await loadPartnerTechniqueRows([partnerId], false);
      const techniqueRows = techniqueMap.get(partnerId) ?? [];
      const skillPolicyState = await loadPartnerBattleSkillPolicyState({
        partnerId,
        definition: partnerDef,
        techniqueRows,
        forUpdate: false,
      });

      return {
        success: true,
        message: 'ok',
        data: buildPartnerSkillPolicyDto({
          partnerId,
          availableSkills: skillPolicyState.availableSkills,
          persistedRows: skillPolicyState.persistedRows,
        }),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴技能策略读取失败：${reason}` };
    }
  }

  @Transactional
  async updateSkillPolicy(
    characterId: number,
    partnerId: number,
    slots: PartnerSkillPolicySlotDto[],
  ): Promise<PartnerResult<PartnerSkillPolicyDto>> {
    try {
      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(characterId, false);
      if (!character) {
        return { success: false, message: '角色不存在' };
      }

      const partnerRow = await loadSinglePartnerRow(characterId, partnerId, true);
      if (!partnerRow) return { success: false, message: '伙伴不存在' };
      const fusionBlockedMessage = await getPartnerFusionBlockedMessage(partnerId, true, '保存技能策略');
      if (fusionBlockedMessage) {
        return { success: false, message: fusionBlockedMessage };
      }
      const partnerDef = await loadPartnerDefinitionOrThrow(partnerRow.partner_def_id);

      const techniqueMap = await loadPartnerTechniqueRows([partnerId], true);
      const techniqueRows = techniqueMap.get(partnerId) ?? [];
      const skillPolicyState = await loadPartnerBattleSkillPolicyState({
        partnerId,
        definition: partnerDef,
        techniqueRows,
        forUpdate: true,
      });
      const normalizedSlotsResult = normalizePartnerSkillPolicySlotsForSave({
        availableSkills: skillPolicyState.availableSkills,
        slots,
      });
      if (!normalizedSlotsResult.success) {
        return { success: false, message: normalizedSlotsResult.message };
      }

      await query(
        `
          DELETE FROM character_partner_skill_policy
          WHERE partner_id = $1
        `,
        [partnerId],
      );

      for (const slot of normalizedSlotsResult.value) {
        await query(
          `
            INSERT INTO character_partner_skill_policy (
              partner_id,
              skill_id,
              priority,
              enabled,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, NOW(), NOW())
          `,
          [partnerId, slot.skillId, slot.priority, slot.enabled],
        );
      }
      await schedulePartnerBattleStateRefreshByCharacterId(characterId);

      return {
        success: true,
        message: '伙伴技能策略已保存',
        data: buildPartnerSkillPolicyDto({
          partnerId,
          availableSkills: skillPolicyState.availableSkills,
          persistedRows: normalizedSlotsResult.value.map((slot, index) => ({
            id: index + 1,
            partner_id: partnerId,
            skill_id: slot.skillId,
            priority: slot.priority,
            enabled: slot.enabled,
            created_at: new Date(),
            updated_at: new Date(),
          })),
        }),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴技能策略保存失败：${reason}` };
    }
  }

  @Transactional
  async activate(
    characterId: number,
    partnerId: number,
  ): Promise<PartnerResult<{ activePartnerId: number; partner: PartnerDetailDto }>> {
    try {
      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(characterId, false);
      if (!character) {
        return { success: false, message: '角色不存在' };
      }

      const targetPartner = await loadSinglePartnerRow(characterId, partnerId, true);
      if (!targetPartner) return { success: false, message: '伙伴不存在' };
      if (await loadActivePartnerMarketListing(partnerId, true)) {
        return { success: false, message: '已在坊市挂单的伙伴不可出战' };
      }
      const fusionBlockedMessage = await getPartnerFusionBlockedMessage(partnerId, true, '出战');
      if (fusionBlockedMessage) {
        return { success: false, message: fusionBlockedMessage };
      }

      if (!targetPartner.is_active) {
        await setCharacterPartnerActivation({
          characterId,
          partnerId,
          execute: query,
        });
      }

      const rows = await loadPartnerRows(characterId, false);
      const techniqueMap = await loadPartnerTechniqueRows([partnerId], false);
      const refreshedPartner = rows.find((row) => row.id === partnerId);
      if (!refreshedPartner) {
        return { success: false, message: '伙伴状态刷新失败' };
      }
      const partnerDef = await loadPartnerDefinitionOrThrow(refreshedPartner.partner_def_id);
      const partner = await buildPartnerDetailWithTradeState({
        row: refreshedPartner,
        definition: partnerDef,
        techniqueRows: techniqueMap.get(partnerId) ?? [],
        ownerRealm: {
          realm: character.realm,
          subRealm: character.subRealm,
        },
      });
      await schedulePartnerBattleStateRefreshByCharacterId(characterId);

      return {
        success: true,
        message: '出战伙伴已切换',
        data: {
          activePartnerId: partnerId,
          partner,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴切换失败：${reason}` };
    }
  }

  @Transactional
  async dismiss(
    characterId: number,
  ): Promise<PartnerResult<{ activePartnerId: null }>> {
    try {
      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(characterId, false);
      if (!character) return { success: false, message: '角色不存在' };

      await setCharacterPartnerActivation({
        characterId,
        partnerId: null,
        execute: query,
      });
      await schedulePartnerBattleStateRefreshByCharacterId(characterId);

      return {
        success: true,
        message: '出战伙伴已下阵',
        data: {
          activePartnerId: null,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴下阵失败：${reason}` };
    }
  }

  @Transactional
  async injectExp(
    characterId: number,
    partnerId: number,
    exp: number,
  ): Promise<PartnerResult<PartnerInjectResultDto>> {
    try {
      const injectExpBudget = normalizeInteger(exp);
      if (injectExpBudget <= 0) {
        return { success: false, message: 'exp 参数无效，需为大于 0 的整数' };
      }

      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(characterId, false);
      if (!character) return { success: false, message: '角色不存在' };

      const partnerRow = await loadSinglePartnerRow(characterId, partnerId, true);
      if (!partnerRow) return { success: false, message: '伙伴不存在' };
      if (await loadActivePartnerMarketListing(partnerId, true)) {
        return { success: false, message: '已在坊市挂单的伙伴不可灌注' };
      }
      const fusionBlockedMessage = await getPartnerFusionBlockedMessage(partnerId, true, '灌注');
      if (fusionBlockedMessage) {
        return { success: false, message: fusionBlockedMessage };
      }

      const levelLimit = resolvePartnerLevelLimit({
        ownerRealm: {
          realm: character.realm,
          subRealm: character.subRealm,
        },
        partnerLevel: partnerRow.level,
      });
      if (levelLimit.actualLevel >= levelLimit.levelCap) {
        return {
          success: false,
          message: `当前境界下伙伴等级上限为${levelLimit.levelCap}级，请突破境界后再继续灌注`,
        };
      }

      const injectPlan = resolvePartnerInjectPlan({
        beforeLevel: partnerRow.level,
        beforeProgressExp: partnerRow.progress_exp,
        characterExp: character.exp,
        injectExpBudget,
        config: getPartnerGrowthConfig(),
        maxLevel: levelLimit.levelCap,
      });
      if (injectPlan.spentExp <= 0) {
        return { success: false, message: '角色经验不足' };
      }

      await query(
        `
          UPDATE characters
          SET exp = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [characterId, injectPlan.remainingCharacterExp],
      );
      await query(
        `
          UPDATE character_partner
          SET level = $2,
              progress_exp = $3,
              updated_at = NOW()
          WHERE id = $1
        `,
        [partnerId, injectPlan.afterLevel, injectPlan.afterProgressExp],
      );

      const refreshedPartner = await loadSinglePartnerRow(characterId, partnerId, false);
      if (!refreshedPartner) {
        return { success: false, message: '伙伴刷新失败' };
      }
      const partnerDef = await loadPartnerDefinitionOrThrow(refreshedPartner.partner_def_id);
      const techniqueMap = await loadPartnerTechniqueRows([partnerId], false);
      const partner = await buildPartnerDetailWithTradeState({
        row: refreshedPartner,
        definition: partnerDef,
        techniqueRows: techniqueMap.get(partnerId) ?? [],
        ownerRealm: {
          realm: character.realm,
          subRealm: character.subRealm,
        },
      });

      await invalidateCharacterComputedCache(characterId);
      await schedulePartnerBattleStateRefreshByCharacterId(characterId);
      await schedulePartnerRankSnapshotRefreshByCharacterId(characterId);

      return {
        success: true,
        message: '伙伴灌注成功',
        data: {
          partner,
          spentExp: injectPlan.spentExp,
          characterExp: injectPlan.remainingCharacterExp,
          levelsGained: injectPlan.gainedLevels,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴灌注失败：${reason}` };
    }
  }

  @Transactional
  async renameWithCard(
    characterId: number,
    partnerId: number,
    itemInstanceId: number,
    nickname: string,
    description?: string | null,
    avatar?: string | null,
  ): Promise<PartnerResult<PartnerRenameResultDto>> {
    try {
      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(characterId, false);
      if (!character) return { success: false, message: '角色不存在' };

      const partnerRow = await loadSinglePartnerRow(characterId, partnerId, true);
      if (!partnerRow) return { success: false, message: '伙伴不存在' };
      if (await loadActivePartnerMarketListing(partnerId, true)) {
        return { success: false, message: '已在坊市挂单的伙伴不可改名' };
      }
      const fusionBlockedMessage = await getPartnerFusionBlockedMessage(partnerId, true, '改名');
      if (fusionBlockedMessage) {
        return { success: false, message: fusionBlockedMessage };
      }

      const nicknameValidation = await validatePartnerName(nickname);
      if (!nicknameValidation.success) {
        return { success: false, message: nicknameValidation.message };
      }
      const descriptionValidation = description === undefined
        ? {
            success: true as const,
            description: partnerRow.description,
          }
        : validatePartnerDescription(description);
      if (!descriptionValidation.success) {
        return { success: false, message: descriptionValidation.message };
      }

      const normalizedAvatar = avatar === undefined
        ? undefined
        : normalizeManagedAvatarValue(avatar);
      if (normalizedAvatar && !isValidManagedAvatarUrl(normalizedAvatar)) {
        return { success: false, message: '头像地址不合法' };
      }

      const consumeResult = await consumeRenameCardItemInstance(characterId, itemInstanceId);
      if (!consumeResult.success) {
        return { success: false, message: consumeResult.message };
      }

      await query(
        `
          UPDATE character_partner
          SET nickname = $2,
              description = $3,
              avatar = $4,
              updated_at = NOW()
          WHERE id = $1
        `,
        [
          partnerId,
          nicknameValidation.nickname,
          descriptionValidation.description,
          normalizedAvatar === undefined ? partnerRow.avatar : normalizedAvatar,
        ],
      );

      await deleteManagedAvatarIfReplaced(
        partnerRow.avatar,
        normalizedAvatar === undefined ? partnerRow.avatar : normalizedAvatar,
      );

      const refreshedPartner = await loadSinglePartnerRow(characterId, partnerId, false);
      if (!refreshedPartner) {
        return { success: false, message: '伙伴刷新失败' };
      }
      const partnerDef = await loadPartnerDefinitionOrThrow(refreshedPartner.partner_def_id);
      const techniqueMap = await loadPartnerTechniqueRows([partnerId], false);
      const partner = await buildPartnerDetailWithTradeState({
        row: refreshedPartner,
        definition: partnerDef,
        techniqueRows: techniqueMap.get(partnerId) ?? [],
        ownerRealm: {
          realm: character.realm,
          subRealm: character.subRealm,
        },
      });

      await schedulePartnerBattleStateRefreshByCharacterId(characterId);
      await schedulePartnerRankSnapshotRefreshByCharacterId(characterId);

      return {
        success: true,
        message: '伙伴改名成功',
        data: {
          partner,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴改名失败：${reason}` };
    }
  }

  @Transactional
  async rerollGeneratedPartnerBaseAttrsByItem(params: {
    characterId: number;
    partnerId: number;
  }): Promise<PartnerResult<PartnerDetailDto>> {
    return executeGeneratedPartnerRebone({
      characterId: params.characterId,
      partnerId: params.partnerId,
      refreshGeneratedSnapshots: true,
      includePartnerDetail: true,
    });
  }

  async getTechniqueUpgradeCost(
    characterId: number,
    partnerId: number,
    techniqueId: string,
  ): Promise<PartnerResult<PartnerTechniqueUpgradeCostDto>> {
    try {
      const contextResult = await loadOwnedPartnerTechniqueContext({
        characterId,
        partnerId,
        techniqueId,
        forUpdate: false,
      });
      if (!contextResult.success || !contextResult.data) {
        return { success: false, message: contextResult.message };
      }

      const cost = await buildPartnerTechniqueUpgradeCost({
        techniqueId: contextResult.data.techniqueEntry.techniqueId,
        techniqueMeta: contextResult.data.techniqueMeta,
      });
      if (!cost) {
        return { success: false, message: '已达最高层数' };
      }

      return {
        success: true,
        message: '获取成功',
        data: cost,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴功法消耗读取失败：${reason}` };
    }
  }

  async getTechniqueDetail(
    _characterId: number,
    partnerId: number,
    techniqueId: string,
  ): Promise<PartnerResult<PartnerTechniqueDetailDto>> {
    try {
      return loadPreviewPartnerTechniqueDetail(partnerId, techniqueId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴功法详情读取失败：${reason}` };
    }
  }

  @Transactional
  async upgradeTechnique(
    characterId: number,
    partnerId: number,
    techniqueId: string,
  ): Promise<PartnerResult<PartnerUpgradeTechniqueResultDto>> {
    try {
      const contextResult = await loadOwnedPartnerTechniqueContext({
        characterId,
        partnerId,
        techniqueId,
        forUpdate: true,
      });
      if (!contextResult.success || !contextResult.data) {
        return { success: false, message: contextResult.message };
      }

      const {
        character,
        partnerRow,
        partnerDef,
        techniqueEntry,
        techniqueMeta,
      } = contextResult.data;
      if (await loadActivePartnerMarketListing(partnerId, true)) {
        return { success: false, message: '已在坊市挂单的伙伴不可修炼功法' };
      }
      const fusionBlockedMessage = await getPartnerFusionBlockedMessage(partnerId, true, '修炼功法');
      if (fusionBlockedMessage) {
        return { success: false, message: fusionBlockedMessage };
      }

      const cost = await buildPartnerTechniqueUpgradeCost({
        techniqueId: techniqueEntry.techniqueId,
        techniqueMeta,
      });
      if (!cost) {
        return { success: false, message: '已达最高层数' };
      }

      const consumeResourceResult = await consumeCharacterStoredResourcesAndMaterialsAtomically(characterId, {
        spiritStones: cost.spiritStones,
        exp: cost.exp,
        materials: cost.materials,
      });
      if (!consumeResourceResult.success) {
        return { success: false, message: consumeResourceResult.message };
      }

      if (techniqueEntry.row) {
        await query(
          `
            UPDATE character_partner_technique
            SET current_layer = $2,
                updated_at = NOW()
            WHERE id = $1
          `,
          [techniqueEntry.row.id, cost.nextLayer],
        );
      } else {
        await query(
          `
            INSERT INTO character_partner_technique (
              partner_id,
              technique_id,
              current_layer,
              is_innate,
              learned_from_item_def_id,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, TRUE, NULL, NOW(), NOW())
          `,
          [partnerId, techniqueEntry.techniqueId, cost.nextLayer],
        );
      }

      const refreshedTechniqueMap = await loadPartnerTechniqueRows([partnerId], false);
      const partner = await buildPartnerDetailWithTradeState({
        row: partnerRow,
        definition: partnerDef,
        techniqueRows: refreshedTechniqueMap.get(partnerId) ?? [],
        ownerRealm: {
          realm: character.realm,
          subRealm: character.subRealm,
        },
      });
      const updatedTechnique =
        partner.techniques.find((entry) => entry.techniqueId === techniqueId) ?? null;
      if (!updatedTechnique) {
        return { success: false, message: '伙伴功法刷新失败' };
      }

      await invalidateCharacterComputedCache(characterId);
      await schedulePartnerBattleStateRefreshByCharacterId(characterId);
      await schedulePartnerRankSnapshotRefreshByCharacterId(characterId);

      return {
        success: true,
        message: `${updatedTechnique.name}修炼至第${cost.nextLayer}层`,
        data: {
          partner,
          updatedTechnique,
          newLayer: cost.nextLayer,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴功法升级失败：${reason}` };
    }
  }

  @Transactional
  @Transactional
  async startTechniqueLearnByBook(params: {
    characterId: number;
    partnerId: number;
    itemInstanceId: number;
  }): Promise<PartnerResult<PartnerTechniqueLearnActionResultDto>> {
    try {
      const bookResult = await loadPartnerTechniqueBookContext({
        characterId: params.characterId,
        itemInstanceId: params.itemInstanceId,
        forUpdate: false,
      });
      if (!bookResult.success || !bookResult.data) {
        return { success: false, message: bookResult.message };
      }

      const contextResult = await loadPartnerTechniqueLearnContext({
        characterId: params.characterId,
        partnerId: params.partnerId,
        itemDefId: bookResult.data.itemDefId,
        techniqueId: bookResult.data.techniqueId,
        forUpdate: true,
      });
      if (!contextResult.success || !contextResult.data) {
        return { success: false, message: contextResult.message };
      }

      const context = contextResult.data;
      if (context.currentEffectiveTechniqueCount < context.maxTechniqueSlots) {
        const consumeResult = await consumeSpecificItemInstance(
          params.characterId,
          params.itemInstanceId,
          1,
        );
        if (!consumeResult.success) {
          return { success: false, message: consumeResult.message };
        }
        if (normalizeText(consumeResult.itemDefId) !== bookResult.data.itemDefId) {
          return { success: false, message: '功法书已变化，请刷新后重试' };
        }

        const learnResult = await applyPartnerTechniqueLearn({
          characterId: params.characterId,
          partnerId: params.partnerId,
          itemDefId: bookResult.data.itemDefId,
          techniqueId: bookResult.data.techniqueId,
          allowRandomReplacement: false,
        });
        if (!learnResult.success || !learnResult.data) {
          throw new Error(learnResult.message);
        }
        return {
          success: true,
          message: learnResult.message,
          data: {
            mode: 'learned',
            result: learnResult.data,
          },
        };
      }

      const replacedTechniqueId = resolveRandomReplaceableTechniqueId(context.replaceableTechniqueIds);
      if (!replacedTechniqueId) {
        return { success: false, message: '当前只有天生功法，无法继续打书' };
      }
      const replacedTechnique = buildReplacePreviewTechnique(
        context.currentTechniqueRows,
        replacedTechniqueId,
      );
      if (!replacedTechnique) {
        return { success: false, message: '预览目标功法不存在或已失效' };
      }
      const reserveResult = await reservePartnerTechniqueLearnPreviewBook({
        characterId: params.characterId,
        itemInstanceId: params.itemInstanceId,
        partnerId: params.partnerId,
        learnedTechniqueId: context.learnedTechnique.techniqueId,
        replacedTechniqueId,
      });
      if (!reserveResult.success || !reserveResult.data) {
        return { success: false, message: reserveResult.message };
      }

      return {
        success: true,
        message: '请确认本次功法替换预览',
        data: {
          mode: 'preview_replace',
          preview: {
            partnerId: params.partnerId,
            itemInstanceId: reserveResult.data,
            learnedTechnique: context.learnedTechnique,
            replacedTechnique,
          },
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴打书预览失败：${reason}` };
    }
  }

  @Transactional
  async confirmTechniqueLearnPreview(params: {
    characterId: number;
    partnerId: number;
    itemInstanceId: number;
    replacedTechniqueId: string;
  }): Promise<PartnerResult<PartnerLearnTechniqueResultDto>> {
    try {
      const pendingPreviewResult = await loadPendingPartnerTechniqueLearnPreviewByItem({
        characterId: params.characterId,
        itemInstanceId: params.itemInstanceId,
        forUpdate: true,
      });
      if (!pendingPreviewResult.success || !pendingPreviewResult.data) {
        return { success: false, message: pendingPreviewResult.message };
      }
      const pendingPreview = pendingPreviewResult.data;
      if (pendingPreview.preview.partnerId !== params.partnerId) {
        return { success: false, message: '待处理打书预览与当前伙伴不匹配' };
      }
      if (pendingPreview.preview.replacedTechnique.techniqueId !== params.replacedTechniqueId) {
        return { success: false, message: '预览已失效，请重新选择功法书' };
      }

      const learnResult = await applyPartnerTechniqueLearn({
        characterId: params.characterId,
        partnerId: params.partnerId,
        itemDefId: pendingPreview.book.itemDefId,
        techniqueId: pendingPreview.book.techniqueId,
        replacedTechniqueId: params.replacedTechniqueId,
        allowRandomReplacement: false,
      });
      if (!learnResult.success || !learnResult.data) {
        throw new Error(learnResult.message);
      }

      const deleteResult = await deletePendingPartnerTechniqueLearnPreviewBook({
        characterId: params.characterId,
        itemInstanceId: pendingPreview.preview.itemInstanceId,
      });
      if (!deleteResult.success) {
        throw new Error(deleteResult.message);
      }

      return learnResult;
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `确认伙伴打书失败：${reason}` };
    }
  }

  @Transactional
  async discardTechniqueLearnPreview(params: {
    characterId: number;
    itemInstanceId: number;
  }): Promise<PartnerResult<PartnerDiscardTechniqueBookResultDto>> {
    try {
      const pendingPreviewResult = await loadPendingPartnerTechniqueLearnPreviewByItem({
        characterId: params.characterId,
        itemInstanceId: params.itemInstanceId,
        forUpdate: true,
      });
      if (!pendingPreviewResult.success || !pendingPreviewResult.data) {
        return { success: false, message: pendingPreviewResult.message };
      }

      const deleteResult = await deletePendingPartnerTechniqueLearnPreviewBook({
        characterId: params.characterId,
        itemInstanceId: pendingPreviewResult.data.preview.itemInstanceId,
      });
      if (!deleteResult.success) {
        throw new Error(deleteResult.message);
      }

      return {
        success: true,
        message: '已放弃学习，本次功法书已消耗',
        data: {
          remainingBooks: await loadPartnerBooks(params.characterId),
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `放弃伙伴打书失败：${reason}` };
    }
  }

  @Transactional
  async learnTechniqueByItem(params: {
    characterId: number;
    partnerId: number;
    itemDefId: string;
    techniqueId: string;
  }): Promise<PartnerResult<PartnerLearnTechniqueResultDto>> {
    try {
      return applyPartnerTechniqueLearn({
        characterId: params.characterId,
        partnerId: params.partnerId,
        itemDefId: params.itemDefId,
        techniqueId: params.techniqueId,
        allowRandomReplacement: true,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴打书失败：${reason}` };
    }
  }

  async buildActivePartnerBattleMember(params: {
    characterId: number;
  }): Promise<PartnerBattleMember | null> {
    return getActivePartnerBattleMemberByCharacterId(params.characterId);
  }

  /**
   * 按开关构建伙伴战斗成员。
   *
   * 作用（做什么 / 不做什么）：
   * 1) 做什么：把“开关关闭直接不带伙伴”和“开关开启时读取当前出战伙伴”收敛成单入口。
   * 2) 做什么：供在线 PVE、秘境 PVE、挂机会话快照复用，避免三处重复写同样的启用判断。
   * 3) 不做什么：不决定组队规则，调用方仍需在进入这里之前先决定当前是否允许带伙伴。
   *
   * 输入/输出：
   * - 输入：角色 ID、是否启用伙伴参战。
   * - 输出：启用且存在出战伙伴时返回伙伴战斗成员，否则返回 null。
   *
   * 数据流/状态流：
   * battle / idle session -> buildConfiguredPartnerBattleMember -> buildActivePartnerBattleMember -> character_partner.
   *
   * 关键边界条件与坑点：
   * 1) `enabled=false` 时必须直接返回 null，避免额外查库和隐式携带伙伴。
   * 2) 这里只读取“当前出战伙伴”，不会替调用方兜底挑选其他伙伴。
   */
  async buildConfiguredPartnerBattleMember(params: {
    characterId: number;
    enabled: boolean;
  }): Promise<PartnerBattleMember | null> {
    if (!params.enabled) {
      return null;
    }

    return this.buildActivePartnerBattleMember({
      characterId: params.characterId,
    });
  }

  async grantStarterPartner(params: {
    characterId: number;
    obtainedFrom: string;
    obtainedRefId?: string;
  }): Promise<PartnerRewardDto> {
    const starterDefinition = await getPartnerDefinitionById(STARTER_PARTNER_DEF_ID);
    const definition =
      starterDefinition ??
      getStaticPartnerDefinitions().find((entry) => entry.enabled !== false) ??
      null;
    if (!definition) {
      throw new Error('未找到可发放的初始伙伴模板');
    }
    const created = await createPartnerInstanceFromDefinition({
      characterId: params.characterId,
      definition,
      obtainedFrom: params.obtainedFrom,
      obtainedRefId: params.obtainedRefId,
    });
    return created.reward;
  }

  async createPartnerInstanceFromDefinition(params: {
    characterId: number;
    definition: PartnerDefConfig;
    obtainedFrom: string;
    obtainedRefId?: string;
    nickname?: string;
  }): Promise<CreatePartnerInstanceResult> {
    return createPartnerInstanceFromDefinition(params);
  }
}

export const partnerService = new PartnerService();
export default partnerService;
