#!/usr/bin/env tsx
/**
 * AI 领悟模型联调脚本
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：读取环境变量中的模型服务配置，调用模型生成一份功法草稿，并打印到控制台；支持可选 seed 复现结果。
 * 2) 不做什么：不写数据库、不创建生成任务、不扣除研修点，仅做模型联调验证。
 *
 * 输入/输出：
 * - 输入：CLI 参数（可选）：`--quality <黄|玄|地|天>`、`--seed <正整数>`。
 * - 输出：控制台打印模型响应、结构化 JSON、功法摘要。
 *
 * 数据流/状态流：
 * 解析参数 -> 读取环境变量 -> 组装 prompt -> 请求模型 -> 解析 JSON -> 打印结果。
 *
 * 关键边界条件与坑点：
 * 1) 若 AI_TECHNIQUE_MODEL_URL / AI_TECHNIQUE_MODEL_KEY 缺失，脚本会直接失败退出。
 * 2) 模型可能返回非纯 JSON 文本，脚本会尝试从文本中提取第一个 JSON 对象。
 */
import '../src/bootstrap/installConsoleLogger.js';
import dotenv from 'dotenv';
import { generateTechniqueSkillIconMap } from '../src/services/shared/techniqueSkillImageGenerator.js';
import {
  parseTechniqueTextModelJsonObject,
} from '../src/services/shared/techniqueTextModelShared.js';
import { callConfiguredTextModel } from '../src/services/ai/openAITextClient.js';
import { readTextModelConfig } from '../src/services/ai/modelConfig.js';
import {
  buildTechniqueGeneratorPromptInput,
  GENERATED_TECHNIQUE_TYPE_LIST,
  TECHNIQUE_EFFECT_TYPE_LIST,
  TECHNIQUE_EFFECT_UNSUPPORTED_FIELDS,
  TECHNIQUE_PASSIVE_KEY_POOL_BY_TYPE,
  TECHNIQUE_PROMPT_SYSTEM_MESSAGE,
  isSupportedTechniquePassiveKey,
  type GeneratedTechniqueType,
} from '../src/services/shared/techniqueGenerationConstraints.js';

dotenv.config();

type TechniqueQuality = '黄' | '玄' | '地' | '天';

type ArgMap = Record<string, string | undefined>;

const QUALITY_RANDOM_WEIGHT: Array<{ quality: TechniqueQuality; weight: number }> = [
  { quality: '黄', weight: 55 },
  { quality: '玄', weight: 30 },
  { quality: '地', weight: 12 },
  { quality: '天', weight: 3 },
];

const QUALITY_MAX_LAYER: Record<TechniqueQuality, number> = {
  黄: 3,
  玄: 5,
  地: 7,
  天: 9,
};

const EFFECT_TYPE_SET = new Set<string>(TECHNIQUE_EFFECT_TYPE_LIST);

const sanitizeSkillEffect = (raw: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...raw };
  for (const field of TECHNIQUE_EFFECT_UNSUPPORTED_FIELDS) {
    if (field in next) delete next[field];
  }
  return next;
};

const resolveTechniqueTypeByRandom = (): GeneratedTechniqueType => {
  const index = Math.floor(Math.random() * GENERATED_TECHNIQUE_TYPE_LIST.length);
  return GENERATED_TECHNIQUE_TYPE_LIST[index]!;
};

const normalizeParsedLayers = (
  parsed: Record<string, unknown>,
  techniqueType: GeneratedTechniqueType,
): Record<string, unknown> => {
  const technique = parsed.technique && typeof parsed.technique === 'object' && !Array.isArray(parsed.technique)
    ? (parsed.technique as Record<string, unknown>)
    : null;
  const passivePool = TECHNIQUE_PASSIVE_KEY_POOL_BY_TYPE[techniqueType];
  const layers = Array.isArray(parsed.layers) ? parsed.layers : [];
  const normalizedLayers = layers.map((layerRaw) => {
    if (!layerRaw || typeof layerRaw !== 'object' || Array.isArray(layerRaw)) return layerRaw;
    const layer = layerRaw as Record<string, unknown>;
    const layerNo = Math.max(1, Math.floor(Number(layer.layer) || 1));
    const rawPassives = Array.isArray(layer.passives) ? layer.passives : [];
    const normalizedPassives = rawPassives
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const row = entry as Record<string, unknown>;
        const key = asString(row.key);
        const value = Number(row.value);
        if (!isSupportedTechniquePassiveKey(key) || !Number.isFinite(value)) return null;
        return { key, value };
      })
      .filter((entry): entry is { key: string; value: number } => Boolean(entry));
    const fallbackPassive = passivePool[(layerNo - 1) % passivePool.length] ?? passivePool[0];
    const passives = normalizedPassives.length > 0
      ? normalizedPassives
      : (fallbackPassive ? [{ key: fallbackPassive.key, value: 0.01 }] : []);

    return {
      ...layer,
      costMaterials: [],
      passives,
    };
  });

  return {
    ...parsed,
    technique: technique ? { ...technique, type: techniqueType } : technique,
    skills: Array.isArray(parsed.skills)
      ? parsed.skills.map((skillRaw) => {
          if (!skillRaw || typeof skillRaw !== 'object' || Array.isArray(skillRaw)) return skillRaw;
          const skill = skillRaw as Record<string, unknown>;
          const effects = Array.isArray(skill.effects)
            ? skill.effects
                .map((effectRaw) => {
                  if (!effectRaw || typeof effectRaw !== 'object' || Array.isArray(effectRaw)) return null;
                  const effect = sanitizeSkillEffect(effectRaw as Record<string, unknown>);
                  const effectType = asString(effect.type);
                  if (!EFFECT_TYPE_SET.has(effectType)) return null;
                  return effect;
                })
                .filter((effect): effect is Record<string, unknown> => Boolean(effect))
            : [];
          return {
            ...skill,
            effects,
          };
        })
      : [],
    layers: normalizedLayers,
  };
};

const parseArgMap = (argv: string[]): ArgMap => {
  const map: ArgMap = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') continue;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      map[key] = 'true';
      continue;
    }
    map[key] = next;
    i += 1;
  }
  return map;
};

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const resolveQualityByWeight = (): TechniqueQuality => {
  const totalWeight = QUALITY_RANDOM_WEIGHT.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) return '黄';
  const roll = Math.random() * totalWeight;
  let cursor = 0;
  for (const row of QUALITY_RANDOM_WEIGHT) {
    cursor += row.weight;
    if (roll <= cursor) return row.quality;
  }
  return '黄';
};

const resolveQualityArg = (raw: string | undefined): TechniqueQuality => {
  const text = asString(raw);
  if (text === '黄' || text === '玄' || text === '地' || text === '天') return text;
  return resolveQualityByWeight();
};

const resolveSeedArg = (raw: string | undefined): number | undefined => {
  const text = asString(raw);
  if (!text) return undefined;
  const seed = Number(text);
  if (!Number.isInteger(seed) || seed <= 0) {
    throw new Error('CLI 参数 --seed 必须是正整数');
  }
  return seed;
};

const parseModelJson = (content: string): Record<string, unknown> => {
  const parsedResult = parseTechniqueTextModelJsonObject(content);
  if (!parsedResult.success) {
    if (parsedResult.reason === 'empty_content') {
      throw new Error('模型返回内容为空');
    }
    throw new Error('模型返回不是合法 JSON');
  }
  return parsedResult.data as Record<string, unknown>;
};

const isSkillImageGenEnabled = (): boolean => {
  const endpoint = asString(process.env.AI_TECHNIQUE_IMAGE_MODEL_URL);
  const apiKey = asString(process.env.AI_TECHNIQUE_IMAGE_MODEL_KEY);
  return endpoint.length > 0 && apiKey.length > 0;
};

const attachGeneratedSkillIcons = async (
  normalized: Record<string, unknown>,
): Promise<{ next: Record<string, unknown>; generatedCount: number }> => {
  const technique = normalized.technique;
  if (!technique || typeof technique !== 'object' || Array.isArray(technique)) {
    return { next: normalized, generatedCount: 0 };
  }
  const tech = technique as Record<string, unknown>;

  const rawSkills = Array.isArray(normalized.skills) ? normalized.skills : [];
  if (rawSkills.length <= 0) return { next: normalized, generatedCount: 0 };

  const inputs = rawSkills.flatMap((entry, idx) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const skill = entry as Record<string, unknown>;
    const skillId = asString(skill.id) || `skill_${idx + 1}`;
    const skillName = asString(skill.name);
    if (!skillName) return [];
    return [{
      skillId,
      techniqueName: asString(tech.name) || '未知功法',
      techniqueType: asString(tech.type) || '武技',
      techniqueQuality: asString(tech.quality) || '黄',
      techniqueElement: asString(tech.attributeElement) || 'none',
      skillName,
      skillDescription: asString(skill.description),
      skillEffects: Array.isArray(skill.effects) ? skill.effects : [],
    }];
  });

  if (inputs.length <= 0) return { next: normalized, generatedCount: 0 };

  const iconMap = await generateTechniqueSkillIconMap(inputs);
  if (iconMap.size <= 0) return { next: normalized, generatedCount: 0 };

  const nextSkills = rawSkills.map((entry, idx) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const skill = entry as Record<string, unknown>;
    const skillId = asString(skill.id) || `skill_${idx + 1}`;
    const generatedIcon = iconMap.get(skillId);
    if (!generatedIcon) return entry;
    return {
      ...skill,
      icon: generatedIcon,
    };
  });

  return {
    next: {
      ...normalized,
      skills: nextSkills,
    },
    generatedCount: iconMap.size,
  };
};

const main = async (): Promise<void> => {
  const args = parseArgMap(process.argv.slice(2));
  const quality = resolveQualityArg(args.quality);
  const techniqueType = resolveTechniqueTypeByRandom();
  const seed = resolveSeedArg(args.seed);
  const modelConfig = readTextModelConfig();
  const promptInput = buildTechniqueGeneratorPromptInput({
    techniqueType,
    quality,
    maxLayer: QUALITY_MAX_LAYER[quality],
    effectTypeEnum: [...TECHNIQUE_EFFECT_TYPE_LIST],
  });

  if (!modelConfig) {
    throw new Error('缺少环境变量 AI_TECHNIQUE_MODEL_URL');
  }
  const response = await callConfiguredTextModel({
    systemMessage: TECHNIQUE_PROMPT_SYSTEM_MESSAGE,
    userMessage: JSON.stringify(promptInput),
    seed,
    timeoutMs: 300_000,
  });
  if (!response) {
    throw new Error('缺少环境变量 AI_TECHNIQUE_MODEL_KEY');
  }
  const parsed = parseModelJson(response.content);
  const normalized = normalizeParsedLayers(parsed, techniqueType);
  const imageEnabled = isSkillImageGenEnabled();
  const withIcons = imageEnabled
    ? await attachGeneratedSkillIcons(normalized)
    : { next: normalized, generatedCount: 0 };

  const finalOutput = withIcons.next;
  const technique = finalOutput.technique as Record<string, unknown> | undefined;
  const techniqueName = asString(technique?.name) || '未知功法';
  const techniqueType = asString(technique?.type) || '未知类型';
  const skills = Array.isArray(finalOutput.skills) ? finalOutput.skills : [];
  const layers = Array.isArray(finalOutput.layers) ? finalOutput.layers : [];

  console.log('\n=== AI 领悟模型联调结果 ===');
  console.log(`SDK BaseURL: ${modelConfig.baseURL}`);
  console.log(`模型: ${response.modelName}`);
  console.log(`品质: ${quality}`);
  console.log(`功法: ${techniqueName}（${techniqueType}）`);
  console.log(`技能数量: ${skills.length}`);
  console.log(`层级数量: ${layers.length}`);
  console.log(`技能绘图: ${imageEnabled ? `已启用（生成${withIcons.generatedCount}张）` : '未启用（缺少 AI_TECHNIQUE_IMAGE_MODEL_URL/KEY）'}`);
  console.log('\n--- 归一化后结构化输出(JSON) ---');
  console.log(JSON.stringify(finalOutput, null, 2));
};

void main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[test-technique-model] ${msg}`);
  process.exit(1);
});
