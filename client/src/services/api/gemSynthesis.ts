import api from './core';

export type GemType = 'attack' | 'defense' | 'survival' | 'all';

export interface GemSynthesisRecipeDto {
  recipeId: string;
  name: string;
  gemType: GemType;
  seriesKey: string;
  fromLevel: number;
  toLevel: number;
  input: {
    itemDefId: string;
    name: string;
    icon: string | null;
    qty: number;
    owned: number;
  };
  output: {
    itemDefId: string;
    name: string;
    icon: string | null;
    qty: number;
  };
  costs: {
    silver: number;
    spiritStones: number;
  };
  successRate: number;
  maxSynthesizeTimes: number;
  canSynthesize: boolean;
}

export interface GemSynthesisRecipeListResponse {
  success: boolean;
  message: string;
  data?: {
    character: {
      silver: number;
      spiritStones: number;
    };
    recipes: GemSynthesisRecipeDto[];
  };
}

export interface GemSynthesisExecuteResponse {
  success: boolean;
  message: string;
  data?: {
    recipeId: string;
    gemType: GemType;
    seriesKey: string;
    fromLevel: number;
    toLevel: number;
    times: number;
    successCount: number;
    failCount: number;
    successRate: number;
    consumed: {
      itemDefId: string;
      qty: number;
    };
    spent: {
      silver: number;
      spiritStones: number;
    };
    produced: {
      itemDefId: string;
      qty: number;
      itemIds: number[];
    } | null;
    character: unknown;
  };
}

export interface GemSynthesisBatchResponse {
  success: boolean;
  message: string;
  data?: {
    gemType: GemType;
    seriesKey: string;
    sourceLevel: number;
    targetLevel: number;
    totalSpent: {
      silver: number;
      spiritStones: number;
    };
    steps: Array<{
      recipeId: string;
      seriesKey: string;
      fromLevel: number;
      toLevel: number;
      times: number;
      successCount: number;
      failCount: number;
      successRate: number;
      consumed: {
        itemDefId: string;
        qty: number;
      };
      spent: {
        silver: number;
        spiritStones: number;
      };
      produced: {
        itemDefId: string;
        qty: number;
        itemIds: number[];
      };
    }>;
    character: unknown;
  };
}

export interface GemConvertOptionDto {
  inputLevel: number;
  outputLevel: number;
  inputGemQtyPerConvert: number;
  ownedInputGemQty: number;
  costSpiritStonesPerConvert: number;
  maxConvertTimes: number;
  canConvert: boolean;
  candidateGemCount: number;
}

export interface GemConvertOptionListResponse {
  success: boolean;
  message: string;
  data?: {
    character: {
      silver: number;
      spiritStones: number;
    };
    options: GemConvertOptionDto[];
  };
}

export interface GemConvertExecuteResponse {
  success: boolean;
  message: string;
  data?: {
    inputLevel: number;
    outputLevel: number;
    times: number;
    consumed: {
      inputGemQty: number;
      selectedGemItemIds: number[];
    };
    spent: {
      spiritStones: number;
    };
    produced: {
      totalQty: number;
      items: Array<{
        itemDefId: string;
        name: string;
        icon: string | null;
        qty: number;
        itemIds: number[];
      }>;
    };
    character: unknown;
  };
}

export const getInventoryGemSynthesisRecipes = (): Promise<GemSynthesisRecipeListResponse> => {
  return api.get('/inventory/gem/recipes');
};

export const getInventoryGemConvertOptions = (): Promise<GemConvertOptionListResponse> => {
  return api.get('/inventory/gem/convert/options');
};

export const synthesizeInventoryGem = (body: {
  recipeId: string;
  times?: number;
}): Promise<GemSynthesisExecuteResponse> => {
  return api.post('/inventory/gem/synthesize', body);
};

export const synthesizeInventoryGemBatch = (body: {
  gemType: GemType;
  targetLevel: number;
  sourceLevel?: number;
  seriesKey?: string;
}): Promise<GemSynthesisBatchResponse> => {
  return api.post('/inventory/gem/synthesize/batch', body);
};

export const convertInventoryGem = (body: {
  selectedGemItemIds: number[];
  times?: number;
}): Promise<GemConvertExecuteResponse> => {
  return api.post('/inventory/gem/convert', body);
};
