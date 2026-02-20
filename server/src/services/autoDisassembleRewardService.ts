import type { GenerateOptions } from './equipmentService.js';
import { generateEquipment } from './equipmentService.js';
import { buildDisassembleRewardPlan } from './disassembleRewardPlanner.js';
import {
  shouldAutoDisassembleBySetting,
  type AutoDisassembleCandidateMeta,
  type AutoDisassembleSetting,
} from './autoDisassembleRules.js';
export type { AutoDisassembleRuleSet, AutoDisassembleSetting } from './autoDisassembleRules.js';

export type PendingMailItem = {
  item_def_id: string;
  qty: number;
  options?: {
    bindType?: string;
    equipOptions?: unknown;
  };
};

export interface GrantItemCreateResult {
  success: boolean;
  message: string;
  itemIds?: number[];
  equipment?: {
    quality?: string;
    qualityRank?: number;
  };
}

export type GrantItemCreateFn = (params: {
  itemDefId: string;
  qty: number;
  bindType?: string;
  obtainedFrom: string;
  equipOptions?: unknown;
}) => Promise<GrantItemCreateResult>;

export type AddCharacterSilverFn = (
  characterId: number,
  silver: number
) => Promise<{ success: boolean; message: string }>;

export interface GrantRewardItemWithAutoDisassembleInput {
  characterId: number;
  itemDefId: string;
  qty: number;
  bindType?: string;
  itemMeta: {
    itemName?: string | null;
    category: string;
    subCategory?: string | null;
    effectDefs?: unknown;
    qualityRank?: number | null;
  };
  autoDisassembleSetting: AutoDisassembleSetting;
  sourceObtainedFrom: string;
  createItem: GrantItemCreateFn;
  addSilver?: AddCharacterSilverFn;
  sourceEquipOptions?: unknown;
}

export interface GrantedRewardItem {
  itemDefId: string;
  qty: number;
  itemIds: number[];
}

export interface GrantRewardItemWithAutoDisassembleResult {
  grantedItems: GrantedRewardItem[];
  pendingMailItems: PendingMailItem[];
  warnings: string[];
  gainedSilver: number;
}

const normalizeItemIds = (itemIds?: number[]): number[] => {
  if (!Array.isArray(itemIds)) return [];
  return itemIds.filter((id) => Number.isInteger(id) && id > 0);
};

const appendGrantedItem = (
  result: GrantRewardItemWithAutoDisassembleResult,
  itemDefId: string,
  qty: number,
  itemIds: number[]
): void => {
  const existing = result.grantedItems.find((item) => item.itemDefId === itemDefId);
  if (existing) {
    existing.qty += qty;
    if (itemIds.length > 0) {
      existing.itemIds.push(...itemIds);
    }
    return;
  }
  result.grantedItems.push({ itemDefId, qty, itemIds: [...itemIds] });
};

const appendPendingMailItem = (
  result: GrantRewardItemWithAutoDisassembleResult,
  mailItem: PendingMailItem
): void => {
  const targetOptions = mailItem.options;
  const targetBindType = targetOptions?.bindType || 'none';
  const targetEquipOptionsKey = JSON.stringify(targetOptions?.equipOptions || null);
  const existing = result.pendingMailItems.find((item) => {
    const bindType = item.options?.bindType || 'none';
    const equipOptionsKey = JSON.stringify(item.options?.equipOptions || null);
    return item.item_def_id === mailItem.item_def_id && bindType === targetBindType && equipOptionsKey === targetEquipOptionsKey;
  });

  if (existing) {
    existing.qty += mailItem.qty;
    return;
  }
  result.pendingMailItems.push({
    item_def_id: mailItem.item_def_id,
    qty: mailItem.qty,
    ...(targetOptions ? { options: { ...targetOptions } } : {}),
  });
};

const mergeResult = (
  target: GrantRewardItemWithAutoDisassembleResult,
  source: GrantRewardItemWithAutoDisassembleResult
): void => {
  for (const item of source.grantedItems) {
    appendGrantedItem(target, item.itemDefId, item.qty, item.itemIds);
  }
  for (const mailItem of source.pendingMailItems) {
    appendPendingMailItem(target, mailItem);
  }
  if (source.gainedSilver > 0) {
    target.gainedSilver += source.gainedSilver;
  }
};

const createEmptyResult = (): GrantRewardItemWithAutoDisassembleResult => ({
  grantedItems: [],
  pendingMailItems: [],
  warnings: [],
  gainedSilver: 0,
});

const isQualityName = (value: unknown): value is '黄' | '玄' | '地' | '天' => {
  return value === '黄' || value === '玄' || value === '地' || value === '天';
};

const toGenerateOptions = (raw: unknown): GenerateOptions => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const out: GenerateOptions = {};

  if (isQualityName(record.quality)) {
    out.quality = record.quality;
  }

  if (record.qualityWeights && typeof record.qualityWeights === 'object' && !Array.isArray(record.qualityWeights)) {
    const inputWeights = record.qualityWeights as Record<string, unknown>;
    const weights: Partial<Record<'黄' | '玄' | '地' | '天', number>> = {};
    for (const [key, value] of Object.entries(inputWeights)) {
      if (!isQualityName(key)) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) continue;
      weights[key] = n;
    }
    if (Object.keys(weights).length > 0) {
      out.qualityWeights = weights as Record<'黄' | '玄' | '地' | '天', number>;
    }
  }

  const realmRank = Number(record.realmRank);
  if (Number.isInteger(realmRank) && realmRank > 0) {
    out.realmRank = realmRank;
  }

  if (typeof record.identified === 'boolean') {
    out.identified = record.identified;
  }

  const bindType = String(record.bindType || '').trim();
  if (bindType) {
    out.bindType = bindType;
  }

  const obtainedFrom = String(record.obtainedFrom || '').trim();
  if (obtainedFrom) {
    out.obtainedFrom = obtainedFrom;
  }

  const seed = Number(record.seed);
  if (Number.isInteger(seed)) {
    out.seed = seed;
  }

  const fuyuan = Number(record.fuyuan);
  if (Number.isFinite(fuyuan) && fuyuan > 0) {
    out.fuyuan = fuyuan;
  }

  return out;
};

const buildEquipRollOptionsForAttempt = (raw: unknown, attemptIndex: number): GenerateOptions => {
  const normalized = toGenerateOptions(raw);
  if (Number.isInteger(normalized.seed)) return normalized;
  return {
    ...normalized,
    seed: Date.now() + attemptIndex * 7919 + Math.floor(Math.random() * 1000),
  };
};

export const grantRewardItemWithAutoDisassemble = async (
  input: GrantRewardItemWithAutoDisassembleInput
): Promise<GrantRewardItemWithAutoDisassembleResult> => {
  const result = createEmptyResult();

  const normalizedQty = Math.max(0, Math.floor(input.qty));
  if (normalizedQty <= 0) return result;

  const category = String(input.itemMeta.category || '').trim();
  const subCategory = input.itemMeta.subCategory ?? null;
  const itemName = String(input.itemMeta.itemName || '').trim();
  const effectDefs = input.itemMeta.effectDefs;
  const baseQualityRank = (() => {
    const n = Number(input.itemMeta.qualityRank);
    if (Number.isInteger(n) && n > 0) return n;
    return 1;
  })();

  if (!input.autoDisassembleSetting.enabled) {
    const createResult = await input.createItem({
      itemDefId: input.itemDefId,
      qty: normalizedQty,
      ...(input.bindType ? { bindType: input.bindType } : {}),
      obtainedFrom: input.sourceObtainedFrom,
      ...(input.sourceEquipOptions !== undefined ? { equipOptions: input.sourceEquipOptions } : {}),
    });

    if (createResult.success) {
      appendGrantedItem(result, input.itemDefId, normalizedQty, normalizeItemIds(createResult.itemIds));
      return result;
    }

    if (createResult.message === '背包已满') {
      const options =
        input.bindType || input.sourceEquipOptions
          ? {
              ...(input.bindType ? { bindType: input.bindType } : {}),
              ...(input.sourceEquipOptions ? { equipOptions: input.sourceEquipOptions } : {}),
            }
          : undefined;
      appendPendingMailItem(result, {
        item_def_id: input.itemDefId,
        qty: normalizedQty,
        ...(options ? { options } : {}),
      });
      appendGrantedItem(result, input.itemDefId, normalizedQty, []);
      return result;
    }

    result.warnings.push(`物品创建失败: ${input.itemDefId}, ${createResult.message}`);
    return result;
  }

  for (let i = 0; i < normalizedQty; i++) {
    let sourceEquipOptionsForCreate = input.sourceEquipOptions;
    let generatedQualityRank = baseQualityRank;

    const createSourceItem = async () => {
      const sourceCreateResult = await input.createItem({
        itemDefId: input.itemDefId,
        qty: 1,
        ...(input.bindType ? { bindType: input.bindType } : {}),
        obtainedFrom: input.sourceObtainedFrom,
        ...(sourceEquipOptionsForCreate !== undefined ? { equipOptions: sourceEquipOptionsForCreate } : {}),
      });

      if (sourceCreateResult.success) {
        appendGrantedItem(result, input.itemDefId, 1, normalizeItemIds(sourceCreateResult.itemIds));
        return;
      }

      if (sourceCreateResult.message === '背包已满') {
        const options =
          input.bindType || sourceEquipOptionsForCreate !== undefined
            ? {
                ...(input.bindType ? { bindType: input.bindType } : {}),
                ...(sourceEquipOptionsForCreate !== undefined ? { equipOptions: sourceEquipOptionsForCreate } : {}),
              }
            : undefined;
        appendPendingMailItem(result, {
          item_def_id: input.itemDefId,
          qty: 1,
          ...(options ? { options } : {}),
        });
        appendGrantedItem(result, input.itemDefId, 1, []);
        return;
      }

      result.warnings.push(`物品创建失败: ${input.itemDefId}, ${sourceCreateResult.message}`);
    };

    /**
     * 装备品质由生成器最终决定，必须先做一次“预生成”拿到真实品质，
     * 才能进行自动分解判定；否则会用模板品质误判。
     */
    if (category === 'equipment') {
      const equipRollOptions = buildEquipRollOptionsForAttempt(input.sourceEquipOptions, i + 1);
      sourceEquipOptionsForCreate = equipRollOptions;
      const generated = await generateEquipment(input.itemDefId, equipRollOptions);
      if (generated) {
        generatedQualityRank = Number.isInteger(generated.qualityRank) && generated.qualityRank > 0
          ? generated.qualityRank
          : baseQualityRank;
      } else {
        result.warnings.push(`装备预生成失败: ${input.itemDefId}`);
        await createSourceItem();
        continue;
      }
    }

    const candidateMeta: AutoDisassembleCandidateMeta = {
      itemName,
      category,
      subCategory,
      effectDefs,
      qualityRank: generatedQualityRank,
    };

    if (!shouldAutoDisassembleBySetting(input.autoDisassembleSetting, candidateMeta)) {
      await createSourceItem();
      continue;
    }

    const rewardPlan = buildDisassembleRewardPlan({
      category,
      subCategory,
      effectDefs,
      qualityRankRaw: generatedQualityRank,
      strengthenLevelRaw: 0,
      refineLevelRaw: 0,
      affixesRaw: [],
      qty: 1,
    });
    if (!rewardPlan.success) {
      result.warnings.push(`自动分解规则计算失败: ${input.itemDefId}, ${rewardPlan.message}`);
      await createSourceItem();
      continue;
    }

    const tempResult = createEmptyResult();
    let rewardApplySuccess = true;

    for (const rewardItem of rewardPlan.rewards.items) {
      const rewardCreateResult = await input.createItem({
        itemDefId: rewardItem.itemDefId,
        qty: rewardItem.qty,
        obtainedFrom: 'auto_disassemble',
      });

      if (rewardCreateResult.success) {
        appendGrantedItem(tempResult, rewardItem.itemDefId, rewardItem.qty, normalizeItemIds(rewardCreateResult.itemIds));
        continue;
      }

      if (rewardCreateResult.message === '背包已满') {
        appendPendingMailItem(tempResult, {
          item_def_id: rewardItem.itemDefId,
          qty: rewardItem.qty,
        });
        appendGrantedItem(tempResult, rewardItem.itemDefId, rewardItem.qty, []);
        continue;
      }

      rewardApplySuccess = false;
      result.warnings.push(`自动分解奖励入包失败: ${rewardItem.itemDefId}, ${rewardCreateResult.message}`);
      break;
    }

    if (rewardApplySuccess && rewardPlan.rewards.silver > 0) {
      if (!input.addSilver) {
        rewardApplySuccess = false;
        result.warnings.push(`自动分解银两发放失败: ${input.itemDefId}, 缺少addSilver实现`);
      } else {
        const addSilverResult = await input.addSilver(input.characterId, rewardPlan.rewards.silver);
        if (!addSilverResult.success) {
          rewardApplySuccess = false;
          result.warnings.push(`自动分解银两发放失败: ${input.itemDefId}, ${addSilverResult.message}`);
        } else {
          tempResult.gainedSilver += rewardPlan.rewards.silver;
        }
      }
    }

    if (!rewardApplySuccess) {
      await createSourceItem();
      continue;
    }

    mergeResult(result, tempResult);
  }

  return result;
};
