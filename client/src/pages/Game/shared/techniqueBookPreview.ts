/**
 * 功法书预览视图构建
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把功法详情接口返回的“功法基础信息 + 技能列表”收敛为功法书预览视图，供世界广播等只需要“描述 + 可学习技能”的入口复用。
 * 2. 做什么：统一复用技能 DTO -> `TechniqueSkillDetailLike` 的映射，避免功法书预览与技能查询 Hook 各自维护一份字段转换。
 * 3. 不做什么：不处理已学功法的层数成长详情，不管理弹层状态，也不发起任何网络请求。
 *
 * 输入 / 输出：
 * - 输入：功法定义 DTO、技能 DTO 数组，以及图标解析函数。
 * - 输出：`TechniqueBookPreviewView`，包含标题、品质、描述与可直接渲染的技能列表。
 *
 * 数据流 / 状态流：
 * `getTechniqueDetail` -> 本模块归一化 -> 世界广播功法书预览 / 功法技能查询 Hook。
 *
 * 复用设计说明：
 * 1. 世界频道功法书预览与背包/坊市技能区都依赖同一份技能卡片数据结构，因此把 DTO 映射集中到这里，后续若再新增图鉴或邮件预览也无需重复改字段。
 * 2. 描述口径统一优先取 `long_desc`，与背包、坊市现有功法书展示保持一致，避免不同入口展示文本漂移。
 *
 * 关键边界条件与坑点：
 * 1. 图标字段可能为空，必须统一走调用方注入的解析器，不能在这里硬编码资源前缀，否则静态功法与生成功法会出现路径不一致。
 * 2. 技能数组允许为空，但不能因此把预览判为异常；空技能应交给展示层输出明确空态，而不是在构建层塞默认技能。
 */
import type { SkillDefDto, TechniqueDefDto } from '../../../services/api/technique';
import type { TechniqueSkillDetailLike } from '../modules/TechniqueModal/skillDetailShared';

export type TechniqueBookPreviewView = {
  id: string;
  name: string;
  quality: string;
  icon: string;
  desc: string;
  skills: TechniqueSkillDetailLike[];
};

export const mapTechniqueApiSkillToDetail = (skill: SkillDefDto): TechniqueSkillDetailLike => ({
  id: skill.id,
  name: skill.name,
  icon: skill.icon || '',
  description: skill.description || undefined,
  cost_lingqi: skill.cost_lingqi || undefined,
  cost_lingqi_rate: skill.cost_lingqi_rate || undefined,
  cost_qixue: skill.cost_qixue || undefined,
  cost_qixue_rate: skill.cost_qixue_rate || undefined,
  cooldown: skill.cooldown || undefined,
  target_type: skill.target_type || undefined,
  target_count: skill.target_count || undefined,
  damage_type: skill.damage_type || undefined,
  element: skill.element || undefined,
  effects: Array.isArray(skill.effects) ? skill.effects : undefined,
});

type BuildTechniqueBookPreviewViewOptions = {
  technique: TechniqueDefDto;
  skills: SkillDefDto[];
  resolveIcon: (icon: string | null | undefined) => string;
};

export const buildTechniqueBookPreviewView = ({
  technique,
  skills,
  resolveIcon,
}: BuildTechniqueBookPreviewViewOptions): TechniqueBookPreviewView => {
  const longDesc = typeof technique.long_desc === 'string' ? technique.long_desc.trim() : '';
  const shortDesc = typeof technique.description === 'string' ? technique.description.trim() : '';

  return {
    id: technique.id,
    name: technique.name,
    quality: technique.quality,
    icon: resolveIcon(technique.icon),
    desc: longDesc || shortDesc,
    skills: skills.map(mapTechniqueApiSkillToDetail),
  };
};
