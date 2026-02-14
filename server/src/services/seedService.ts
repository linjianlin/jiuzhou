/**
 * 种子数据加载服务
 *
 * 当前项目已切换为静态 JSON 配置直读：
 * - 不再执行任何配置入库 SQL
 * - 仅在初始化时输出各静态配置条目数量
 */
import { pathToFileURL } from 'url';
import {
  getAchievementDefinitions,
  getAchievementPointsRewardDefinitions,
  getAffixPoolDefinitions,
  getBattlePassStaticConfig,
  getBountyDefinitions,
  getDialogueDefinitions,
  getDropPoolDefinitions,
  getDungeonDefinitions,
  getEnabledItemDefinitions,
  getItemRecipeDefinitions,
  getItemSetDefinitions,
  getMainQuestChapterDefinitions,
  getMainQuestSectionDefinitions,
  getMapDefinitions,
  getMonsterDefinitions,
  getMonthCardDefinitions,
  getNpcDefinitions,
  getSkillDefinitions,
  getSpawnRuleDefinitions,
  getTaskDefinitions,
  getTalkTreeDefinitions,
  getTechniqueDefinitions,
  getTechniqueLayerDefinitions,
  getTitleDefinitions,
} from './staticConfigLoader.js';

const countEnabled = <T extends { enabled?: boolean }>(entries: T[]): number => {
  return entries.filter((entry) => entry.enabled !== false).length;
};

const getItemAndEquipCounts = (): { itemCount: number; equipCount: number } => {
  const enabledItemDefs = getEnabledItemDefinitions();
  const equipCount = enabledItemDefs.filter((entry) => String(entry.category || '').trim() === 'equipment').length;
  const itemCount = Math.max(0, enabledItemDefs.length - equipCount);
  return { itemCount, equipCount };
};

const getBattlePassCounts = (): { rewardCount: number; taskCount: number } => {
  const config = getBattlePassStaticConfig();
  if (!config) return { rewardCount: 0, taskCount: 0 };
  return {
    rewardCount: config.rewards.length,
    taskCount: countEnabled(config.tasks),
  };
};

const getMainQuestCounts = (): { chapters: number; sections: number; dialogues: number } => {
  return {
    chapters: countEnabled(getMainQuestChapterDefinitions()),
    sections: countEnabled(getMainQuestSectionDefinitions()),
    dialogues: countEnabled(getDialogueDefinitions()),
  };
};

// 加载所有种子（仅统计输出）
export const loadAllSeeds = async (): Promise<void> => {
  console.log('--- 加载种子数据 ---');

  const { itemCount, equipCount } = getItemAndEquipCounts();
  console.log(`  物品定义: ${itemCount} 条（静态JSON，跳过入库）`);
  console.log(`  装备定义: ${equipCount} 条（静态JSON，跳过入库）`);

  console.log(`  词条池: ${countEnabled(getAffixPoolDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  套装定义: ${countEnabled(getItemSetDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  配方: ${countEnabled(getItemRecipeDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  NPC定义: ${countEnabled(getNpcDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  对话树定义: ${countEnabled(getTalkTreeDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  怪物定义: ${countEnabled(getMonsterDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  掉落池: ${countEnabled(getDropPoolDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  刷新规则: ${countEnabled(getSpawnRuleDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  地图定义: ${countEnabled(getMapDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  任务定义: ${countEnabled(getTaskDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  悬赏定义: ${countEnabled(getBountyDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  成就定义: ${countEnabled(getAchievementDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  称号定义: ${countEnabled(getTitleDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  成就点奖励: ${countEnabled(getAchievementPointsRewardDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  月卡定义: ${countEnabled(getMonthCardDefinitions())} 条（静态JSON，跳过入库）`);

  const { rewardCount: battlePassRewardCount, taskCount: battlePassTaskCount } = getBattlePassCounts();
  console.log(`  战令奖励: ${battlePassRewardCount} 条（静态JSON，跳过入库）`);
  console.log(`  战令任务: ${battlePassTaskCount} 条（静态JSON，跳过入库）`);

  console.log(`  秘境定义: ${countEnabled(getDungeonDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  功法定义: ${countEnabled(getTechniqueDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  技能定义: ${countEnabled(getSkillDefinitions())} 条（静态JSON，跳过入库）`);
  console.log(`  功法层级: ${countEnabled(getTechniqueLayerDefinitions())} 条（静态JSON，跳过入库）`);

  const mainQuest = getMainQuestCounts();
  console.log(`  主线任务: ${mainQuest.chapters} 章, ${mainQuest.sections} 节（对话${mainQuest.dialogues}条使用静态JSON）`);

  console.log('✓ 种子数据加载完成');
};

const isDirectRun = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  return import.meta.url === pathToFileURL(arg).href;
})();

if (isDirectRun) {
  void (async () => {
    try {
      await loadAllSeeds();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  })();
}
