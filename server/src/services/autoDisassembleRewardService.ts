import {
  resolveDisassembleRewardItemDefIdByQualityRank,
  resolveQualityRank,
} from './equipmentDisassembleRules.js';

export interface AutoDisassembleSetting {
  enabled: boolean;
  maxQualityRank: number;
}

export type PendingMailItem = {
  item_def_id: string;
  qty: number;
  options?: {
    bindType?: string;
    equipOptions?: Record<string, number>;
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
  equipOptions?: Record<string, number>;
}) => Promise<GrantItemCreateResult>;

export type DeleteItemInstancesFn = (characterId: number, itemIds: number[]) => Promise<void>;

export interface GrantRewardItemWithAutoDisassembleInput {
  characterId: number;
  itemDefId: string;
  qty: number;
  bindType?: string;
  itemCategory: string;
  autoDisassembleSetting: AutoDisassembleSetting;
  sourceObtainedFrom: string;
  createItem: GrantItemCreateFn;
  deleteItemInstances: DeleteItemInstancesFn;
  sourceEquipOptions?: Record<string, number>;
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

const resolveGeneratedQualityRank = (createResult: GrantItemCreateResult): number => {
  const raw = Number(createResult.equipment?.qualityRank);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return resolveQualityRank(createResult.equipment?.quality);
};

export const grantRewardItemWithAutoDisassemble = async (
  input: GrantRewardItemWithAutoDisassembleInput
): Promise<GrantRewardItemWithAutoDisassembleResult> => {
  const result: GrantRewardItemWithAutoDisassembleResult = {
    grantedItems: [],
    pendingMailItems: [],
    warnings: [],
  };

  const normalizedQty = Math.max(0, Math.floor(input.qty));
  if (normalizedQty <= 0) return result;

  const shouldTryAutoDisassemble =
    input.itemCategory === 'equipment' && input.autoDisassembleSetting.enabled;

  if (!shouldTryAutoDisassemble) {
    const createResult = await input.createItem({
      itemDefId: input.itemDefId,
      qty: normalizedQty,
      ...(input.bindType ? { bindType: input.bindType } : {}),
      obtainedFrom: input.sourceObtainedFrom,
      ...(input.sourceEquipOptions ? { equipOptions: input.sourceEquipOptions } : {}),
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
    const sourceCreateResult = await input.createItem({
      itemDefId: input.itemDefId,
      qty: 1,
      ...(input.bindType ? { bindType: input.bindType } : {}),
      obtainedFrom: input.sourceObtainedFrom,
      ...(input.sourceEquipOptions ? { equipOptions: input.sourceEquipOptions } : {}),
    });

    if (!sourceCreateResult.success) {
      if (sourceCreateResult.message === '背包已满') {
        const options =
          input.bindType || input.sourceEquipOptions
            ? {
                ...(input.bindType ? { bindType: input.bindType } : {}),
                ...(input.sourceEquipOptions ? { equipOptions: input.sourceEquipOptions } : {}),
              }
            : undefined;
        appendPendingMailItem(result, {
          item_def_id: input.itemDefId,
          qty: 1,
          ...(options ? { options } : {}),
        });
        appendGrantedItem(result, input.itemDefId, 1, []);
      } else {
        result.warnings.push(`物品创建失败: ${input.itemDefId}, ${sourceCreateResult.message}`);
      }
      continue;
    }

    const generatedQualityRank = resolveGeneratedQualityRank(sourceCreateResult);
    const disassembleRewardItemDefId = resolveDisassembleRewardItemDefIdByQualityRank(generatedQualityRank);
    const shouldDisassembleCurrent =
      Boolean(disassembleRewardItemDefId) &&
      generatedQualityRank > 0 &&
      generatedQualityRank <= input.autoDisassembleSetting.maxQualityRank;

    if (shouldDisassembleCurrent && disassembleRewardItemDefId) {
      const rewardCreateResult = await input.createItem({
        itemDefId: disassembleRewardItemDefId,
        qty: 1,
        obtainedFrom: 'auto_disassemble',
      });

      if (rewardCreateResult.success || rewardCreateResult.message === '背包已满') {
        const sourceItemIds = normalizeItemIds(sourceCreateResult.itemIds);
        if (sourceItemIds.length > 0) {
          await input.deleteItemInstances(input.characterId, sourceItemIds);
        }

        if (rewardCreateResult.success) {
          appendGrantedItem(result, disassembleRewardItemDefId, 1, normalizeItemIds(rewardCreateResult.itemIds));
        } else {
          appendPendingMailItem(result, {
            item_def_id: disassembleRewardItemDefId,
            qty: 1,
          });
          appendGrantedItem(result, disassembleRewardItemDefId, 1, []);
        }
        continue;
      }

      result.warnings.push(
        `自动分解入包失败，保留原装备: ${disassembleRewardItemDefId}, ${rewardCreateResult.message}`
      );
    }

    appendGrantedItem(result, input.itemDefId, 1, normalizeItemIds(sourceCreateResult.itemIds));
  }

  return result;
};
