/**
 * 生成功法定义持久化共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中把 `TechniqueGenerationCandidate` 写入 `generated_technique_def / generated_skill_def / generated_technique_layer`。
 * 2) 做什么：让洞府研修草稿与伙伴天生功法共用同一套落库映射，避免 SQL 与字段默认值分叉。
 * 3) 不做什么：不负责 candidate 校验、不负责任务状态更新，也不刷新缓存。
 *
 * 输入/输出：
 * - 输入：候选功法、目标 techniqueId、generationId、创建者以及发布/作用域配置。
 * - 输出：无；成功时写入三张生成表。
 *
 * 数据流/状态流：
 * 业务 candidate -> persistGeneratedTechniqueCandidateTx -> generated_technique_* -> staticConfigLoader 刷新后可见。
 *
 * 关键边界条件与坑点：
 * 1) `usage_scope` 与 `is_published` 属于业务策略，必须由调用方显式传入，不能在共享层偷偷兜底成固定口径。
 * 2) 伙伴天生功法与洞府研修草稿对 `published_at/name_locked/display_name` 的要求不同，因此这里保留参数化而不硬编码。
 */
import { query } from '../../config/database.js';
import type { TechniqueUsageScope } from './techniqueUsageScope.js';
import type { TechniqueGenerationCandidate } from '../techniqueGenerationService.js';

export const persistGeneratedTechniqueCandidateTx = async (params: {
  generationId: string;
  techniqueId: string;
  createdByCharacterId: number;
  candidate: TechniqueGenerationCandidate;
  modelName: string;
  usageScope: TechniqueUsageScope;
  isPublished: boolean;
  publishedAt: Date | null;
  nameLocked: boolean;
  techniqueIcon: string | null;
  displayName?: string | null;
  normalizedName?: string | null;
  longDescSuffix?: string | null;
  requiredRealm?: string;
}): Promise<void> => {
  const {
    generationId,
    techniqueId,
    createdByCharacterId,
    candidate,
    modelName,
    usageScope,
    isPublished,
    publishedAt,
    nameLocked,
    techniqueIcon,
    displayName,
    normalizedName,
    longDescSuffix,
    requiredRealm,
  } = params;
  const resolvedRequiredRealm = requiredRealm ?? candidate.technique.requiredRealm;
  const resolvedLongDesc = `${candidate.technique.longDesc || candidate.technique.description}${longDescSuffix ?? ''}`.trim();

  await query(
    `
      INSERT INTO generated_technique_def (
        id,
        generation_id,
        created_by_character_id,
        name,
        display_name,
        normalized_name,
        type,
        quality,
        max_layer,
        required_realm,
        attribute_type,
        attribute_element,
        usage_scope,
        tags,
        description,
        long_desc,
        model_name,
        icon,
        is_published,
        published_at,
        name_locked,
        enabled,
        version,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13,
        $14::jsonb,
        $15, $16, $17, $18,
        $19, $20, $21, true, 1, NOW(), NOW()
      )
    `,
    [
      techniqueId,
      generationId,
      createdByCharacterId,
      candidate.technique.name,
      displayName ?? null,
      normalizedName ?? null,
      candidate.technique.type,
      candidate.technique.quality,
      candidate.technique.maxLayer,
      resolvedRequiredRealm,
      candidate.technique.attributeType,
      candidate.technique.attributeElement,
      usageScope,
      JSON.stringify(candidate.technique.tags),
      candidate.technique.description,
      resolvedLongDesc || null,
      modelName,
      techniqueIcon,
      isPublished,
      publishedAt,
      nameLocked,
    ],
  );

  for (const skill of candidate.skills) {
    await query(
      `
        INSERT INTO generated_skill_def (
          id,
          generation_id,
          source_type,
          source_id,
          code,
          name,
          description,
          icon,
          cost_lingqi,
          cost_lingqi_rate,
          cost_qixue,
          cost_qixue_rate,
          cooldown,
          target_type,
          target_count,
          damage_type,
          element,
          effects,
          trigger_type,
          ai_priority,
          upgrades,
          enabled,
          version,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, 'technique', $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb,
          $18, $19, $20::jsonb, true, 1, NOW(), NOW()
        )
      `,
      [
        skill.id,
        generationId,
        techniqueId,
        skill.id,
        skill.name,
        skill.description,
        skill.icon,
        skill.costLingqi,
        skill.costLingqiRate,
        skill.costQixue,
        skill.costQixueRate,
        skill.cooldown,
        skill.targetType,
        skill.targetCount,
        skill.damageType,
        skill.element,
        JSON.stringify(skill.effects),
        skill.triggerType,
        skill.aiPriority,
        JSON.stringify(skill.upgrades),
      ],
    );
  }

  for (const layer of candidate.layers) {
    await query(
      `
        INSERT INTO generated_technique_layer (
          generation_id,
          technique_id,
          layer,
          cost_spirit_stones,
          cost_exp,
          cost_materials,
          passives,
          unlock_skill_ids,
          upgrade_skill_ids,
          required_realm,
          layer_desc,
          enabled,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6::jsonb, $7::jsonb, $8::text[], $9::text[], $10, $11, true, NOW(), NOW()
        )
      `,
      [
        generationId,
        techniqueId,
        layer.layer,
        layer.costSpiritStones,
        layer.costExp,
        JSON.stringify(layer.costMaterials),
        JSON.stringify(layer.passives),
        layer.unlockSkillIds,
        layer.upgradeSkillIds,
        resolvedRequiredRealm,
        layer.layerDesc,
      ],
    );
  }
};
