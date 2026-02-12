import api from './core';

export type InventoryLocation = 'bag' | 'warehouse' | 'equipped';

export interface InventoryInfoData {
  bag_capacity: number;
  warehouse_capacity: number;
  bag_used: number;
  warehouse_used: number;
}

export interface InventoryInfoResponse {
  success: boolean;
  message?: string;
  data?: InventoryInfoData;
}

export interface ItemDefLite {
  id: string;
  name: string;
  icon: string | null;
  quality: string;
  quality_rank?: number | null;
  category: string;
  sub_category: string | null;
  stack_max: number;
  description: string | null;
  long_desc: string | null;
  tags: unknown;
  effect_defs: unknown;
  base_attrs: unknown;
  base_attrs_raw?: unknown;
  equip_slot: string | null;
  use_type: string | null;
  use_req_realm?: string | null;
  use_req_level?: number | null;
  use_limit_daily?: number | null;
  use_limit_total?: number | null;
  socket_max?: number;
  gem_slot_types?: unknown;
  level?: number | null;
  set_id?: string | null;
  set_name?: string | null;
  set_bonuses?: unknown;
  set_equipped_count?: number;
}

export interface InventoryItemDto {
  id: number;
  item_def_id: string;
  qty: number;
  quality?: string | null;
  quality_rank?: number | null;
  location: InventoryLocation;
  location_slot: number | null;
  equipped_slot: string | null;
  strengthen_level: number;
  refine_level: number;
  affixes: unknown;
  identified: boolean;
  locked: boolean;
  bind_type: string;
  socketed_gems?: unknown;
  created_at: string;
  def?: ItemDefLite;
}

export interface InventoryItemsResponse {
  success: boolean;
  message?: string;
  data?: {
    items: InventoryItemDto[];
    total: number;
    page: number;
    pageSize: number;
  };
}

export const getInventoryInfo = (): Promise<InventoryInfoResponse> => {
  return api.get('/inventory/info');
};

export const getInventoryItems = (
  location: InventoryLocation = 'bag',
  page: number = 1,
  pageSize: number = 200
): Promise<InventoryItemsResponse> => {
  return api.get('/inventory/items', { params: { location, page, pageSize } });
};

export interface InventoryMoveResponse {
  success: boolean;
  message: string;
}

export const moveInventoryItem = (body: {
  itemId: number;
  targetLocation: 'bag' | 'warehouse';
  targetSlot?: number;
}): Promise<InventoryMoveResponse> => {
  return api.post('/inventory/move', body);
};

export interface InventoryUseResponse {
  success: boolean;
  message: string;
  effects?: unknown[];
  data?: {
    character: unknown;
    lootResults?: { type: string; name?: string; amount: number }[];
  };
}

export const inventoryUseItem = (body: {
  itemInstanceId?: number;
  instanceId?: number;
  itemId?: number;
  qty?: number;
}): Promise<InventoryUseResponse> => {
  return api.post('/inventory/use', body);
};

export interface InventoryEquipResponse {
  success: boolean;
  message: string;
  equippedSlot?: string;
  swappedOutItemId?: number;
  data?: { character: unknown };
}

export const equipInventoryItem = (itemId: number): Promise<InventoryEquipResponse> => {
  return api.post('/inventory/equip', { itemId });
};

export interface InventoryUnequipResponse {
  success: boolean;
  message: string;
  movedTo?: { location: 'bag' | 'warehouse'; slot: number };
  data?: { character: unknown };
}

export const unequipInventoryItem = (
  itemId: number,
  targetLocation: 'bag' | 'warehouse' = 'bag'
): Promise<InventoryUnequipResponse> => {
  return api.post('/inventory/unequip', { itemId, targetLocation });
};

export interface InventoryEnhanceResponse {
  success: boolean;
  message: string;
  data?: {
    strengthenLevel: number;
    targetLevel?: number;
    successRatePermyriad?: number;
    roll?: number;
    usedMaterial?: { itemDefId: string; qty: number };
    costs?: { silver: number; spiritStones: number };
    usedEnhanceToolItemDefId?: string;
    usedProtectToolItemDefId?: string;
    protectedDowngrade?: boolean;
    character: unknown | null;
  };
}

export interface InventoryEnhanceRequest {
  itemId?: number;
  itemInstanceId?: number;
  instanceId?: number;
  enhanceToolItemId?: number;
  protectToolItemId?: number;
}

export const enhanceInventoryItem = (
  body: InventoryEnhanceRequest
): Promise<InventoryEnhanceResponse> => {
  return api.post('/inventory/enhance', body);
};

export interface InventoryRefineResponse {
  success: boolean;
  message: string;
  data?: {
    refineLevel: number;
    targetLevel?: number;
    successRatePermyriad?: number;
    roll?: number;
    usedMaterial?: { itemDefId: string; qty: number };
    costs?: { silver: number; spiritStones: number };
    character: unknown | null;
  };
}

export interface InventoryRefineRequest {
  itemId?: number;
  itemInstanceId?: number;
  instanceId?: number;
}

export const refineInventoryItem = (
  body: InventoryRefineRequest
): Promise<InventoryRefineResponse> => {
  return api.post('/inventory/refine', body);
};

export interface SocketedGemEffectDto {
  attr: string;
  value: number;
}

export interface SocketedGemEntryDto {
  slot: number;
  itemDefId: string;
  gemType: string;
  effects: SocketedGemEffectDto[];
  name?: string;
  icon?: string;
}

export interface InventorySocketResponse {
  success: boolean;
  message: string;
  data?: {
    socketedGems: SocketedGemEntryDto[];
    socketMax: number;
    slot: number;
    gem: { itemDefId: string; name: string; icon: string | null; gemType: string };
    replacedGem?: SocketedGemEntryDto;
    character?: unknown;
  } | null;
}

export interface InventorySocketRequest {
  itemId?: number;
  itemInstanceId?: number;
  instanceId?: number;
  gemItemId?: number;
  gemItemInstanceId?: number;
  gemInstanceId?: number;
  slot?: number;
}

export const socketInventoryGem = (body: InventorySocketRequest): Promise<InventorySocketResponse> => {
  return api.post('/inventory/socket', body);
};

export interface InventoryDisassembleResponse {
  success: boolean;
  message: string;
  rewards?: { itemDefId: string; qty: number; itemIds?: number[] };
}

export const disassembleInventoryEquipment = (itemId: number): Promise<InventoryDisassembleResponse> => {
  return api.post('/inventory/disassemble', { itemId });
};

export interface InventoryDisassembleBatchResponse {
  success: boolean;
  message: string;
  disassembledCount?: number;
  rewards?: Array<{ itemDefId: string; qty: number; itemIds?: number[] }>;
}

export const disassembleInventoryEquipmentBatch = (itemIds: number[]): Promise<InventoryDisassembleBatchResponse> => {
  return api.post('/inventory/disassemble/batch', { itemIds });
};

export interface InventoryRemoveBatchResponse {
  success: boolean;
  message: string;
  removedCount?: number;
  removedQtyTotal?: number;
}

export const removeInventoryItemsBatch = (itemIds: number[]): Promise<InventoryRemoveBatchResponse> => {
  return api.post('/inventory/remove/batch', { itemIds });
};

export const sortInventory = (location: 'bag' | 'warehouse' = 'bag'): Promise<{ success: boolean; message: string }> => {
  return api.post('/inventory/sort', { location });
};

export type InventoryCraftKind = 'alchemy' | 'smithing' | 'craft';

export interface InventoryCraftRecipeCostItemDto {
  itemDefId: string;
  itemName: string;
  required: number;
  owned: number;
  missing: number;
}

export interface InventoryCraftRecipeDto {
  id: string;
  name: string;
  recipeType: string;
  product: {
    itemDefId: string;
    name: string;
    icon: string | null;
    qty: number;
  };
  costs: {
    silver: number;
    spiritStones: number;
    exp: number;
    items: InventoryCraftRecipeCostItemDto[];
  };
  requirements: {
    realm: string | null;
    level: number;
    building: string | null;
    realmMet: boolean;
  };
  successRate: number;
  failReturnRate: number;
  maxCraftTimes: number;
  craftable: boolean;
  craftKind: InventoryCraftKind;
}

export interface InventoryCraftRecipesResponse {
  success: boolean;
  message?: string;
  data?: {
    character: {
      realm: string;
      exp: number;
      silver: number;
      spiritStones: number;
    };
    recipes: InventoryCraftRecipeDto[];
  };
}

export const getInventoryCraftRecipes = (recipeType?: string): Promise<InventoryCraftRecipesResponse> => {
  return api.get('/inventory/craft/recipes', { params: recipeType ? { recipeType } : undefined });
};

export interface InventoryCraftExecuteResponse {
  success: boolean;
  message?: string;
  data?: {
    recipeId: string;
    recipeType: string;
    craftKind: InventoryCraftKind;
    times: number;
    successCount: number;
    failCount: number;
    spent: {
      silver: number;
      spiritStones: number;
      exp: number;
      items: Array<{ itemDefId: string; qty: number }>;
    };
    returnedItems: Array<{ itemDefId: string; qty: number }>;
    produced: {
      itemDefId: string;
      itemName: string;
      itemIcon: string | null;
      qty: number;
      itemIds: number[];
    } | null;
    character: {
      exp: number;
      silver: number;
      spiritStones: number;
    };
  };
}

export const executeInventoryCraftRecipe = (body: {
  recipeId: string;
  times?: number;
}): Promise<InventoryCraftExecuteResponse> => {
  return api.post('/inventory/craft/execute', body);
};
