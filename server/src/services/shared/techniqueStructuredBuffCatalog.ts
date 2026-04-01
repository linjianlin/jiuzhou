/**
 * 功法生成结构化 Buff 目录
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：从现有静态技能/怪物预定义效果提炼允许的 buffKind/buffKey，并补充少量运行时已支持的内置光环属性白名单，统一提供校验。
 * 2) 不做什么：不直接调用 AI、不负责战斗执行、不处理数据库读写。
 *
 * 输入/输出：
 * - 输入：静态技能/怪物定义中的 effects，以及待校验的单个 SkillEffect。
 * - 输出：功法生成可复用的结构化 Buff 目录与校验结果。
 *
 * 数据流/状态流：
 * 静态种子 skill_def/monster_def + 内置光环属性白名单 -> 提炼共享目录 -> prompt 约束 / 生成结果校验共同复用。
 *
 * 关键边界条件与坑点：
 * 1) 只能读取静态预定义数据，不能把历史 AI 生成产物再回灌进白名单，否则脏数据会污染后续约束。
 * 2) 内置补充项只能放“战斗运行时已支持、且当前任务明确需要开放”的属性，避免白名单和真实结算能力脱节。
 */

import type { SkillEffect } from '../../battle/types.js';
import {
  BUFF_APPLY_TYPE_LIST,
  STRUCTURED_BUFF_KIND_LIST,
  normalizeBuffApplyType,
  normalizeBuffAttrKey,
  normalizeBuffKind,
} from '../../battle/utils/buffSpec.js';
import {
  getStaticMonsterDefinitions,
  getStaticSkillDefinitions,
  type MonsterDefConfig,
  type SkillDefConfig,
} from '../staticConfigLoader.js';
import { ATTACK_ATTR_KEY_SET } from './characterAttrRegistry.js';

type TechniqueBuffEffectType = 'buff' | 'debuff';

type TechniqueBuffCatalogEntry = {
  type: TechniqueBuffEffectType;
  buffKind: string;
  buffKey: string;
  attrKey?: string;
  applyType?: 'flat' | 'percent';
};

type TechniqueBuffCatalogCache = {
  kindEnum: string[];
  attrKeyEnum: string[];
  buffKeyEnumByType: {
    buff: string[];
    debuff: string[];
  };
  exampleByTypeAndKind: Record<TechniqueBuffEffectType, Partial<Record<string, TechniqueBuffCatalogEntry>>>;
  kindSet: ReadonlySet<string>;
  attrKeySet: ReadonlySet<string>;
  buffKeySetByType: {
    buff: ReadonlySet<string>;
    debuff: ReadonlySet<string>;
  };
};

export type TechniqueStructuredBuffCatalog = Pick<
  TechniqueBuffCatalogCache,
  'kindEnum' | 'attrKeyEnum' | 'buffKeyEnumByType' | 'exampleByTypeAndKind'
> & {
  applyTypeEnum: readonly string[];
};

export type TechniqueStructuredBuffValidationResult =
  | { success: true }
  | { success: false; reason: string };

let techniqueBuffCatalogCache: TechniqueBuffCatalogCache | null = null;

const SUPPORTED_BUFF_KIND_SET: ReadonlySet<string> = new Set<string>(STRUCTURED_BUFF_KIND_LIST);
const BUILT_IN_AURA_EXTRA_ATTR_KEY_LIST = [
  'max_qixue',
  'kangbao',
  'lengque',
] as const;
const BUILT_IN_AURA_ATTR_KEY_LIST = Object.freeze(
  Array.from(new Set<string>([
    ...ATTACK_ATTR_KEY_SET,
    ...BUILT_IN_AURA_EXTRA_ATTR_KEY_LIST,
  ])).sort(),
);

const toNonEmptyText = (value: string | null | undefined): string => {
  if (typeof value !== 'string') return '';
  const text = value.trim().toLowerCase();
  return text.length > 0 ? text : '';
};

const cloneCatalogEntry = (entry: TechniqueBuffCatalogEntry): TechniqueBuffCatalogEntry => {
  return {
    type: entry.type,
    buffKind: entry.buffKind,
    buffKey: entry.buffKey,
    attrKey: entry.attrKey,
    applyType: entry.applyType,
  };
};

const toSkillEffectList = (raw: SkillDefConfig['effects']): SkillEffect[] => {
  if (!Array.isArray(raw)) return [];
  const effects: SkillEffect[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    effects.push({ ...(entry as SkillEffect) });
  }
  return effects;
};

const collectMonsterPhaseEffects = (monster: MonsterDefConfig): SkillEffect[] => {
  const triggers = Array.isArray(monster.ai_profile?.phase_triggers)
    ? monster.ai_profile.phase_triggers
    : [];
  const effects: SkillEffect[] = [];
  for (const trigger of triggers) {
    if (!Array.isArray(trigger.effects)) continue;
    for (const entry of trigger.effects) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      effects.push({ ...(entry as SkillEffect) });
    }
  }
  return effects;
};

const collectStructuredBuffEntries = (): TechniqueBuffCatalogEntry[] => {
  const entries: TechniqueBuffCatalogEntry[] = [];
  const skillEffects = getStaticSkillDefinitions()
    .filter((skill) => skill.enabled !== false)
    .flatMap((skill) => toSkillEffectList(skill.effects));
  const monsterEffects = getStaticMonsterDefinitions()
    .filter((monster) => monster.enabled !== false)
    .flatMap((monster) => collectMonsterPhaseEffects(monster));

  for (const effect of [...skillEffects, ...monsterEffects]) {
    if (effect.type !== 'buff' && effect.type !== 'debuff') continue;
    const buffKind = normalizeBuffKind(effect.buffKind);
    if (!buffKind || !SUPPORTED_BUFF_KIND_SET.has(buffKind)) continue;
    const buffKey = toNonEmptyText(effect.buffKey);
    if (!buffKey) continue;

    const entry: TechniqueBuffCatalogEntry = {
      type: effect.type,
      buffKind,
      buffKey,
    };

    if (buffKind === 'attr') {
      const attrKey = normalizeBuffAttrKey(effect.attrKey);
      if (!attrKey) continue;
      entry.attrKey = attrKey;

      const applyType = normalizeBuffApplyType(effect.applyType);
      if (applyType) {
        entry.applyType = applyType;
      }
    }

    entries.push(entry);
  }
  return entries;
};

const collectBuiltInTechniqueBuffEntries = (): TechniqueBuffCatalogEntry[] => {
  const builtInAttrEntries = BUILT_IN_AURA_ATTR_KEY_LIST.flatMap((attrKey) => {
    const attrKeyToken = attrKey.replace(/_/g, '-');
    return [
      {
        type: 'buff' as const,
        buffKind: 'attr',
        buffKey: `buff-${attrKeyToken}-up`,
        attrKey,
      },
      {
        type: 'debuff' as const,
        buffKind: 'attr',
        buffKey: `debuff-${attrKeyToken}-down`,
        attrKey,
      },
    ];
  });

  return [
    {
      type: 'debuff',
      buffKind: 'heal_forbid',
      buffKey: 'debuff-heal-forbid',
    },
    {
      type: 'buff',
      buffKind: 'next_skill_bonus',
      buffKey: 'buff-next-skill-chaos',
    },
    {
      type: 'buff',
      buffKind: 'aura',
      buffKey: 'buff-aura',
    },
    {
      type: 'debuff',
      buffKind: 'aura',
      buffKey: 'debuff-aura',
    },
    ...builtInAttrEntries,
  ];
};

const buildTechniqueBuffCatalogCache = (): TechniqueBuffCatalogCache => {
  const entries = [
    ...collectStructuredBuffEntries(),
    ...collectBuiltInTechniqueBuffEntries(),
  ];
  const kindSet = new Set<string>();
  const attrKeySet = new Set<string>();
  const buffKeySetByType = {
    buff: new Set<string>(),
    debuff: new Set<string>(),
  };
  const exampleByTypeAndKind: TechniqueBuffCatalogCache['exampleByTypeAndKind'] = {
    buff: {},
    debuff: {},
  };

  for (const entry of entries) {
    kindSet.add(entry.buffKind);
    if (entry.attrKey) {
      attrKeySet.add(entry.attrKey);
    }
    buffKeySetByType[entry.type].add(entry.buffKey);
    if (!exampleByTypeAndKind[entry.type][entry.buffKind]) {
      exampleByTypeAndKind[entry.type][entry.buffKind] = cloneCatalogEntry(entry);
    }
  }

  const kindEnum = Array.from(kindSet).sort();
  const attrKeyEnum = Array.from(attrKeySet).sort();
  const buffKeyEnumByType = {
    buff: Array.from(buffKeySetByType.buff).sort(),
    debuff: Array.from(buffKeySetByType.debuff).sort(),
  };

  return {
    kindEnum,
    attrKeyEnum,
    buffKeyEnumByType,
    exampleByTypeAndKind,
    kindSet: new Set<string>(kindEnum),
    attrKeySet: new Set<string>(attrKeyEnum),
    buffKeySetByType: {
      buff: new Set<string>(buffKeyEnumByType.buff),
      debuff: new Set<string>(buffKeyEnumByType.debuff),
    },
  };
};

const getTechniqueBuffCatalogCache = (): TechniqueBuffCatalogCache => {
  if (techniqueBuffCatalogCache) return techniqueBuffCatalogCache;
  techniqueBuffCatalogCache = buildTechniqueBuffCatalogCache();
  return techniqueBuffCatalogCache;
};

export const getTechniqueStructuredBuffCatalog = (): TechniqueStructuredBuffCatalog => {
  const catalog = getTechniqueBuffCatalogCache();
  return {
    kindEnum: [...catalog.kindEnum],
    attrKeyEnum: [...catalog.attrKeyEnum],
    buffKeyEnumByType: {
      buff: [...catalog.buffKeyEnumByType.buff],
      debuff: [...catalog.buffKeyEnumByType.debuff],
    },
    exampleByTypeAndKind: {
      buff: Object.fromEntries(
        Object.entries(catalog.exampleByTypeAndKind.buff).map(([kind, entry]) => [kind, cloneCatalogEntry(entry!)]),
      ),
      debuff: Object.fromEntries(
        Object.entries(catalog.exampleByTypeAndKind.debuff).map(([kind, entry]) => [kind, cloneCatalogEntry(entry!)]),
      ),
    },
    applyTypeEnum: BUFF_APPLY_TYPE_LIST,
  };
};

export const validateTechniqueStructuredBuffEffect = (
  effect: SkillEffect,
): TechniqueStructuredBuffValidationResult => {
  if (effect.type !== 'buff' && effect.type !== 'debuff') {
    return { success: false, reason: '仅支持校验 buff/debuff 效果' };
  }

  const catalog = getTechniqueBuffCatalogCache();
  const buffKind = normalizeBuffKind(effect.buffKind);
  if (!buffKind) {
    return { success: false, reason: '缺少合法 buffKind' };
  }
  if (!catalog.kindSet.has(buffKind)) {
    return { success: false, reason: `buffKind 不在预定义允许列表中: ${buffKind}` };
  }

  const buffKey = toNonEmptyText(effect.buffKey);
  if (!buffKey) {
    return { success: false, reason: '缺少合法 buffKey' };
  }
  if (!catalog.buffKeySetByType[effect.type].has(buffKey)) {
    return { success: false, reason: `buffKey 不在预定义允许列表中: ${buffKey}` };
  }

  if (buffKind === 'attr') {
    const attrKey = normalizeBuffAttrKey(effect.attrKey);
    if (!attrKey) {
      return { success: false, reason: 'buffKind=attr 时缺少合法 attrKey' };
    }
    if (!catalog.attrKeySet.has(attrKey)) {
      return { success: false, reason: `attrKey 不在预定义允许列表中: ${attrKey}` };
    }
    if (effect.applyType) {
      const applyType = normalizeBuffApplyType(effect.applyType);
      if (!applyType) {
        return { success: false, reason: `applyType 非法: ${String(effect.applyType)}` };
      }
    }
  }

  return { success: true };
};
