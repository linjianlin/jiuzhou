/**
 * 物品/货币消耗操作模块
 *
 * 作用：提供按物品定义 ID 消耗材料、按实例 ID 消耗道具、消耗/增加角色货币等原子操作。
 *       所有函数通过 `query()` 自动走事务连接，无需传入 client。
 *
 * 输入/输出：
 * - consumeMaterialByDefId(characterId, materialItemDefId, qty) — 按定义 ID 扣除材料
 * - consumeSpecificItemInstance(characterId, itemInstanceId, qty) — 按实例 ID 扣除道具
 * - consumeCharacterStoredResources(characterId, costs) — 扣除角色存量资源（银两/灵石/经验）
 * - consumeCharacterCurrencies(characterId, costs) — 扣除角色货币（银两/灵石）
 * - consumeCharacterCurrenciesExact(characterId, costs) — 按 bigint 精确扣除角色货币（银两/灵石）
 * - addCharacterCurrencies(characterId, gains) — 增加角色货币
 * - addCharacterCurrenciesExact(characterId, gains) — 按 bigint 精确增加角色货币
 *
 * 被引用方：equipment.ts（强化/精炼/洗炼消耗）、socket.ts（镶嵌消耗）、
 *           disassemble.ts（拆解奖励增加货币）、bag.ts（如需）
 *
 * 数据流：
 * - 物品扣除：查询 item_instance 表并锁定目标行 → 校验数量 → 执行扣除
 * - 资源变更：锁定角色资源基线 → 叠加 Redis pending Delta → 校验余额 → 事务提交后写入 signed Delta
 *
 * 边界条件：
 * 1. consumeMaterialByDefId 优先消耗未锁定、数量最多的堆叠行，全部锁定时报"材料已锁定"
 * 2. number 版资源增减必须走统一 Delta 口径；否则 flush 窗口内继续直写 `characters` 会和缓存账本出现裂缝
 */
import { query } from "../../../config/database.js";
import { clampInt } from "./helpers.js";
import {
  bufferCharacterSettlementCurrencyExactDeltas,
  loadCharacterSettlementCurrencyExactSnapshot,
  loadCharacterSettlementResourceSnapshot,
} from "../../shared/characterSettlementResourceDeltaService.js";
import { applyCharacterRewardDeltas } from "../../shared/characterRewardSettlement.js";
import { afterTransactionCommit } from "../../../config/database.js";
import {
  bufferCharacterItemInstanceMutations,
  loadProjectedCharacterItemInstanceById,
  loadProjectedCharacterItemInstances,
  type BufferedCharacterItemInstanceMutation,
} from "../../shared/characterItemInstanceMutationService.js";
import { getItemDefinitionById } from "../../staticConfigLoader.js";

type CharacterStoredResourceSnapshot = {
  silver: number;
  spiritStones: number;
  exp: number;
};

type CharacterCurrencyExactSnapshot = {
  silver: bigint;
  spiritStones: bigint;
};

export type MaterialConsumeRequirement = {
  itemId: string;
  qty: number;
  itemName?: string | null;
};

type MaterialConsumePlanResult =
  | {
      success: true;
      message: string;
      mutations: BufferedCharacterItemInstanceMutation[];
    }
  | {
      success: false;
      message: string;
    };

export type ConsumeCharacterStoredResourcesResult =
  | {
      success: true;
      message: string;
      remaining?: CharacterStoredResourceSnapshot;
    }
  | {
      success: false;
      message: string;
    };

type ConsumeCharacterCurrenciesExactResult =
  | {
      success: true;
      message: string;
      remaining?: CharacterCurrencyExactSnapshot;
    }
  | {
      success: false;
      message: string;
    };

type AddCharacterCurrenciesExactResult =
  | {
      success: true;
      message: string;
      remaining?: CharacterCurrencyExactSnapshot;
    }
  | {
      success: false;
      message: string;
    };

const normalizeNonNegativeBigint = (value: bigint | null | undefined): bigint => {
  if (value === null || value === undefined) return 0n;
  return value > 0n ? value : 0n;
};

const buildItemMutation = (
  prefix: string,
  characterId: number,
  itemId: number,
  index: number,
  qty: number,
  snapshot: Awaited<ReturnType<typeof loadProjectedCharacterItemInstanceById>>,
): BufferedCharacterItemInstanceMutation => {
  if (!snapshot) {
    throw new Error(`库存实例不存在: ${itemId}`);
  }
  if (qty <= 0) {
    return {
      opId: `${prefix}:${itemId}:${Date.now()}:${index}`,
      characterId,
      itemId,
      createdAt: Date.now() + index,
      kind: "delete",
      snapshot: null,
    };
  }
  return {
    opId: `${prefix}:${itemId}:${Date.now()}:${index}`,
    characterId,
    itemId,
    createdAt: Date.now() + index,
    kind: "upsert",
    snapshot: {
      ...snapshot,
      qty,
    },
  };
};

const normalizeMaterialConsumeRequirements = (
  requirements: readonly MaterialConsumeRequirement[],
): MaterialConsumeRequirement[] => {
  const requirementMap = new Map<string, MaterialConsumeRequirement>();
  for (const requirement of requirements) {
    const itemId = String(requirement.itemId || '').trim();
    const normalizedQty = clampInt(requirement.qty, 0, 999999);
    if (!itemId || normalizedQty <= 0) {
      continue;
    }

    const existing = requirementMap.get(itemId);
    if (existing) {
      existing.qty += normalizedQty;
      if (!existing.itemName && requirement.itemName) {
        existing.itemName = requirement.itemName;
      }
      continue;
    }

    requirementMap.set(itemId, {
      itemId,
      qty: normalizedQty,
      itemName: requirement.itemName,
    });
  }

  return [...requirementMap.values()];
};

const buildMaterialConsumePlan = async (
  characterId: number,
  requirements: readonly MaterialConsumeRequirement[],
): Promise<MaterialConsumePlanResult> => {
  const normalizedRequirements = normalizeMaterialConsumeRequirements(requirements);
  if (normalizedRequirements.length <= 0) {
    return { success: true, message: '无需校验材料', mutations: [] };
  }

  const projectedItems = await loadProjectedCharacterItemInstances(characterId);
  const materialRowsByItemId = new Map<string, Array<{ id: number; qty: number; locked: boolean }>>();
  const materialSnapshotMap = new Map<string, { totalQty: number; unlockedQty: number }>();

  for (const item of projectedItems) {
    if (item.location !== 'bag' && item.location !== 'warehouse') {
      continue;
    }

    const itemId = String(item.item_def_id);
    const qty = Math.max(0, Number(item.qty) || 0);
    if (qty <= 0) {
      continue;
    }

    const rows = materialRowsByItemId.get(itemId) ?? [];
    rows.push({ id: item.id, qty, locked: item.locked });
    materialRowsByItemId.set(itemId, rows);

    const snapshot = materialSnapshotMap.get(itemId) ?? { totalQty: 0, unlockedQty: 0 };
    snapshot.totalQty += qty;
    if (!item.locked) {
      snapshot.unlockedQty += qty;
    }
    materialSnapshotMap.set(itemId, snapshot);
  }

  const mutations: BufferedCharacterItemInstanceMutation[] = [];
  for (const requirement of normalizedRequirements) {
    const snapshot = materialSnapshotMap.get(requirement.itemId) ?? { totalQty: 0, unlockedQty: 0 };
    const itemName = requirement.itemName ?? getItemDefinitionById(requirement.itemId)?.name ?? requirement.itemId;
    if (snapshot.totalQty < requirement.qty) {
      return {
        success: false,
        message: `材料不足：${itemName}，需要${requirement.qty}，当前${snapshot.totalQty}`,
      };
    }
    if (snapshot.unlockedQty < requirement.qty) {
      return {
        success: false,
        message: `材料已锁定：${itemName}`,
      };
    }

    const unlockedRows = [...(materialRowsByItemId.get(requirement.itemId) ?? [])]
      .filter((row) => !row.locked && row.qty > 0)
      .sort((left, right) => right.qty - left.qty || left.id - right.id);

    let remaining = requirement.qty;
    for (const row of unlockedRows) {
      if (remaining <= 0) {
        break;
      }
      const consumeQty = Math.min(row.qty, remaining);
      const snapshotRow = await loadProjectedCharacterItemInstanceById(characterId, row.id);
      mutations.push(buildItemMutation(
        'consume-material',
        characterId,
        row.id,
        mutations.length,
        row.qty - consumeQty,
        snapshotRow,
      ));
      remaining -= consumeQty;
    }
  }

  return { success: true, message: '材料校验通过', mutations };
};

export const validateMaterialConsumeRequirements = async (
  characterId: number,
  requirements: readonly MaterialConsumeRequirement[],
): Promise<{ success: boolean; message: string }> => {
  const result = await buildMaterialConsumePlan(characterId, requirements);
  return { success: result.success, message: result.message };
};

/**
 * 按物品定义 ID 消耗指定数量的材料
 * 从 bag/warehouse 位置的未锁定行中按数量降序扣除
 */
export const consumeMaterialByDefId = async (
  characterId: number,
  materialItemDefId: string,
  qty: number,
): Promise<{ success: boolean; message: string }> => {
  const result = await buildMaterialConsumePlan(characterId, [{
    itemId: materialItemDefId,
    qty,
  }]);
  if (!result.success) {
    return result;
  }

  await bufferCharacterItemInstanceMutations(result.mutations);
  return { success: true, message: '扣除成功' };
};

export const consumeCharacterStoredResourcesAndMaterialsAtomically = async (
  characterId: number,
  costs: {
    silver?: number;
    spiritStones?: number;
    exp?: number;
    materials?: readonly MaterialConsumeRequirement[];
  },
): Promise<ConsumeCharacterStoredResourcesResult> => {
  const silverCost = Math.max(0, Math.floor(Number(costs.silver) || 0));
  const spiritCost = Math.max(0, Math.floor(Number(costs.spiritStones) || 0));
  const expCost = Math.max(0, Math.floor(Number(costs.exp) || 0));
  const materialRequirements = normalizeMaterialConsumeRequirements(costs.materials ?? []);

  const materialPlanResult = await buildMaterialConsumePlan(characterId, materialRequirements);
  if (!materialPlanResult.success) {
    return materialPlanResult;
  }

  const resourceSnapshot = await loadCharacterSettlementResourceSnapshot(characterId, {
    forUpdate: true,
  });
  if (!resourceSnapshot) {
    return { success: false, message: '角色不存在' };
  }
  if (resourceSnapshot.silver < silverCost) {
    return { success: false, message: `银两不足，需要${silverCost}` };
  }
  if (resourceSnapshot.spiritStones < spiritCost) {
    return { success: false, message: `灵石不足，需要${spiritCost}` };
  }
  if (resourceSnapshot.exp < expCost) {
    return { success: false, message: `经验不足，需要${expCost}` };
  }

  if (materialPlanResult.mutations.length > 0) {
    await bufferCharacterItemInstanceMutations(materialPlanResult.mutations);
  }
  if (silverCost > 0 || spiritCost > 0 || expCost > 0) {
    await applyCharacterRewardDeltas(new Map([[
      characterId,
      {
        silver: -silverCost,
        spiritStones: -spiritCost,
        exp: -expCost,
      },
    ]]));
  }

  return {
    success: true,
    message: '扣除成功',
    remaining: {
      silver: resourceSnapshot.silver - silverCost,
      spiritStones: resourceSnapshot.spiritStones - spiritCost,
      exp: resourceSnapshot.exp - expCost,
    },
  };
};

/**
 * 按物品实例 ID 消耗指定数量的道具
 * 仅允许消耗 bag/warehouse 位置的未锁定物品
 */
export const consumeSpecificItemInstance = async (
  characterId: number,
  itemInstanceId: number,
  qty: number,
): Promise<{ success: boolean; message: string; itemDefId?: string }> => {
  const need = clampInt(qty, 1, 999999);
  const row = await loadProjectedCharacterItemInstanceById(characterId, itemInstanceId);
  if (!row)
    return { success: false, message: "道具不存在" };
  if (row.locked) return { success: false, message: "道具已锁定" };
  if (!["bag", "warehouse"].includes(String(row.location))) {
    return { success: false, message: "道具当前位置不可消耗" };
  }
  if ((Number(row.qty) || 0) < need)
    return { success: false, message: "道具数量不足" };

  await bufferCharacterItemInstanceMutations([
    buildItemMutation(
      "consume-item-instance",
      characterId,
      row.id,
      0,
      row.qty - need,
      row,
    ),
  ]);
  return {
    success: true,
    message: "扣除成功",
    itemDefId: String(row.item_def_id),
  };
};

/**
 * 扣除角色存量资源（银两、灵石、经验）
 * 三者均为 0 时直接返回成功
 */
export const consumeCharacterStoredResources = async (
  characterId: number,
  costs: { silver?: number; spiritStones?: number; exp?: number },
): Promise<ConsumeCharacterStoredResourcesResult> => {
  const silverCost = Math.max(0, Math.floor(Number(costs.silver) || 0));
  const spiritCost = Math.max(0, Math.floor(Number(costs.spiritStones) || 0));
  const expCost = Math.max(0, Math.floor(Number(costs.exp) || 0));
  if (silverCost <= 0 && spiritCost <= 0 && expCost <= 0)
    return { success: true, message: "无需扣除资源" };

  const resourceSnapshot = await loadCharacterSettlementResourceSnapshot(characterId, {
    forUpdate: true,
  });
  if (!resourceSnapshot) {
    return { success: false, message: "角色不存在" };
  }

  if (resourceSnapshot.silver < silverCost) {
    return { success: false, message: `银两不足，需要${silverCost}` };
  }
  if (resourceSnapshot.spiritStones < spiritCost) {
    return { success: false, message: `灵石不足，需要${spiritCost}` };
  }
  if (resourceSnapshot.exp < expCost) {
    return { success: false, message: `经验不足，需要${expCost}` };
  }

  await applyCharacterRewardDeltas(new Map([[
    characterId,
    {
      silver: -silverCost,
      spiritStones: -spiritCost,
      exp: -expCost,
    },
  ]]));

  return {
    success: true,
    message: "扣除成功",
    remaining: {
      silver: resourceSnapshot.silver - silverCost,
      spiritStones: resourceSnapshot.spiritStones - spiritCost,
      exp: resourceSnapshot.exp - expCost,
    },
  };
};

/**
 * 扣除角色货币（银两、灵石）
 * 两者均为 0 时直接返回成功
 */
export const consumeCharacterCurrencies = async (
  characterId: number,
  costs: { silver?: number; spiritStones?: number },
): Promise<ConsumeCharacterStoredResourcesResult> => {
  return consumeCharacterStoredResources(characterId, costs);
};

/**
 * 按 bigint 精确扣除角色货币（银两、灵石）
 * 两者均为 0 时直接返回成功
 */
export const consumeCharacterCurrenciesExact = async (
  characterId: number,
  costs: { silver?: bigint; spiritStones?: bigint },
): Promise<ConsumeCharacterCurrenciesExactResult> => {
  const silverCost = normalizeNonNegativeBigint(costs.silver);
  const spiritCost = normalizeNonNegativeBigint(costs.spiritStones);
  if (silverCost <= 0n && spiritCost <= 0n) {
    return { success: true, message: "无需扣除货币" };
  }

  const currencySnapshot = await loadCharacterSettlementCurrencyExactSnapshot(characterId, {
    forUpdate: true,
  });
  if (!currencySnapshot) {
    return { success: false, message: "角色不存在" };
  }

  if (currencySnapshot.silver < silverCost) {
    return { success: false, message: `银两不足，需要${silverCost.toString()}` };
  }
  if (currencySnapshot.spiritStones < spiritCost) {
    return { success: false, message: `灵石不足，需要${spiritCost.toString()}` };
  }

  await afterTransactionCommit(async () => {
    await bufferCharacterSettlementCurrencyExactDeltas(new Map([[
      characterId,
      {
        silver: -silverCost,
        spiritStones: -spiritCost,
      },
    ]]));
  });

  return {
    success: true,
    message: "扣除成功",
    remaining: {
      silver: currencySnapshot.silver - silverCost,
      spiritStones: currencySnapshot.spiritStones - spiritCost,
    },
  };
};

/**
 * 增加角色货币（银两、灵石）
 * 两者均为 0 时直接返回成功
 */
export const addCharacterCurrencies = async (
  characterId: number,
  gains: { silver?: number; spiritStones?: number },
): Promise<{ success: boolean; message: string }> => {
  const silverGain = Math.max(0, Math.floor(Number(gains.silver) || 0));
  const spiritGain = Math.max(0, Math.floor(Number(gains.spiritStones) || 0));
  if (silverGain <= 0 && spiritGain <= 0)
    return { success: true, message: "无需增加货币" };

  const resourceSnapshot = await loadCharacterSettlementResourceSnapshot(characterId);
  if (!resourceSnapshot) {
    return { success: false, message: "角色不存在" };
  }
  await applyCharacterRewardDeltas(new Map([[
    characterId,
    {
      exp: 0,
      silver: silverGain,
      spiritStones: spiritGain,
    },
  ]]));
  return { success: true, message: "增加成功" };
};

/**
 * 按 bigint 精确增加角色货币（银两、灵石）
 * 两者均为 0 时直接返回成功
 */
export const addCharacterCurrenciesExact = async (
  characterId: number,
  gains: { silver?: bigint; spiritStones?: bigint },
  options: { includeRemaining?: boolean } = {},
): Promise<AddCharacterCurrenciesExactResult> => {
  const silverGain = normalizeNonNegativeBigint(gains.silver);
  const spiritGain = normalizeNonNegativeBigint(gains.spiritStones);
  if (silverGain <= 0n && spiritGain <= 0n) {
    return { success: true, message: "无需增加货币" };
  }

  const currencySnapshot = await loadCharacterSettlementCurrencyExactSnapshot(characterId);
  if (!currencySnapshot) {
    return { success: false, message: "角色不存在" };
  }
  await afterTransactionCommit(async () => {
    await bufferCharacterSettlementCurrencyExactDeltas(new Map([[
      characterId,
      {
        silver: silverGain,
        spiritStones: spiritGain,
      },
    ]]));
  });
  return {
    success: true,
    message: "增加成功",
    ...(options.includeRemaining
      ? {
          remaining: {
            silver: currencySnapshot.silver + silverGain,
            spiritStones: currencySnapshot.spiritStones + spiritGain,
          },
        }
      : {}),
  };
};
