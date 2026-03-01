/**
 * 角色领域门面
 * 包含角色基础与角色功法子域导出。
 */
export * from '../../services/characterService.js';
export { characterTechniqueService } from '../../services/characterTechniqueService.js';
export type { CharacterTechnique, CharacterSkillSlot, TechniquePassive, UpgradeCost, ServiceResult } from '../../services/characterTechniqueService.js';

