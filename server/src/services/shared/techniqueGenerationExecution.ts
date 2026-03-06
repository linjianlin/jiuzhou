/**
 * 洞府研修异步执行共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中封装 AI 生成功法候选、技能图标装饰、草稿预览构建这三段可复用执行逻辑。
 * 2) 做什么：作为主线程 service 与独立 worker 的共同入口，避免两边各写一套生成流水线。
 * 3) 不做什么：不处理 HTTP、路由鉴权、WebSocket 推送，也不直接写入任务状态表。
 *
 * 输入/输出：
 * - 输入：功法品质、默认技能图标、生成候选对象。
 * - 输出：带技能图标的候选对象，以及统一的草稿预览结构。
 *
 * 数据流/状态流：
 * worker/service -> generateTechniqueCandidateWithIcons -> buildTechniquePreview -> 由上层决定落库与推送。
 *
 * 关键边界条件与坑点：
 * 1) 图标生成服务可能返回空结果，此时必须回退到统一默认图标，避免前端出现空图标。
 * 2) 预览结构只抽当前任务必需字段，不提前塞入发布态或战斗态专用字段，避免共享模块职责膨胀。
 */
import { generateTechniqueSkillIconMap } from './techniqueSkillImageGenerator.js';
import type {
  TechniqueGenerationCandidate,
  TechniquePreview,
  TechniqueQuality,
} from '../techniqueGenerationService.js';

const asString = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

export const buildTechniquePreview = (
  quality: TechniqueQuality,
  candidate: TechniqueGenerationCandidate,
): TechniquePreview => ({
  draftTechniqueId: '',
  aiSuggestedName: candidate.technique.name,
  quality,
  type: candidate.technique.type,
  maxLayer: candidate.technique.maxLayer,
  description: candidate.technique.description,
  longDesc: candidate.technique.longDesc,
  skillNames: candidate.skills.map((skill) => asString(skill.name)).filter(Boolean),
  skills: candidate.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    icon: skill.icon,
    costLingqi: skill.costLingqi,
    costQixue: skill.costQixue,
    cooldown: skill.cooldown,
    targetType: skill.targetType,
    targetCount: skill.targetCount,
    damageType: skill.damageType,
    element: skill.element,
    effects: skill.effects,
  })),
});

export const generateTechniqueCandidateWithIcons = async (params: {
  quality: TechniqueQuality;
  candidate: TechniqueGenerationCandidate;
  defaultSkillIcon: string;
}): Promise<{ candidate: TechniqueGenerationCandidate; preview: TechniquePreview }> => {
  const { quality, candidate, defaultSkillIcon } = params;
  const inputs = candidate.skills.map((skill) => ({
    skillId: skill.id,
    techniqueName: candidate.technique.name,
    techniqueType: candidate.technique.type,
    techniqueQuality: candidate.technique.quality,
    techniqueElement: candidate.technique.attributeElement,
    skillName: skill.name,
    skillDescription: skill.description,
    skillEffects: skill.effects,
  }));

  const iconMap = await generateTechniqueSkillIconMap(inputs);
  const nextCandidate: TechniqueGenerationCandidate = {
    ...candidate,
    skills: candidate.skills.map((skill) => ({
      ...skill,
      icon: iconMap.get(skill.id) || skill.icon || defaultSkillIcon,
    })),
  };

  return {
    candidate: nextCandidate,
    preview: buildTechniquePreview(quality, nextCandidate),
  };
};
