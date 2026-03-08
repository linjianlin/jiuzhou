/**
 * 宗门模块常量。
 * 输入：宗门职位、建筑类型、面板键值。
 * 输出：用于 UI 展示的中文文案、映射关系与菜单定义。
 * 注意：这里只放静态配置，避免和业务状态耦合。
 */
import type { AppointableSectPositionDto, SectPositionDto } from '../../../../services/api';
import type { SectPanelKey } from './types';

export const NO_SECT_PANEL_ITEMS: Array<{ key: SectPanelKey; label: string }> = [
  { key: 'hall', label: '宗门大厅' },
  { key: 'myApplications', label: '我的申请' },
];

export const JOINED_PANEL_ITEMS: Array<{ key: SectPanelKey; label: string }> = [
  { key: 'overview', label: '基础信息' },
  { key: 'members', label: '成员' },
  { key: 'buildings', label: '建筑' },
  { key: 'shop', label: '商店' },
  { key: 'activity', label: '活动' },
  { key: 'manage', label: '管理' },
];

/**
 * 宗门商店批量兑换输入上限。
 * 这里只约束前端输入控件，服务端不再做同值硬截断。
 */
export const SECT_SHOP_BATCH_BUY_INPUT_MAX = 999;

export const POSITION_LABEL_MAP: Record<SectPositionDto, string> = {
  leader: '宗主',
  vice_leader: '副宗主',
  elder: '长老',
  elite: '护法',
  disciple: '弟子',
};

export const APPOINTABLE_POSITION_OPTIONS: Array<{ value: AppointableSectPositionDto; label: string }> = [
  { value: 'vice_leader', label: '副宗主' },
  { value: 'elder', label: '长老' },
  { value: 'elite', label: '护法' },
  { value: 'disciple', label: '弟子' },
];

export const JOIN_TYPE_LABEL_MAP: Record<'open' | 'apply' | 'invite', string> = {
  open: '自由加入',
  apply: '申请加入',
  invite: '仅邀请',
};

export const QUEST_TYPE_LABEL_MAP: Record<'daily' | 'weekly' | 'special', string> = {
  daily: '日常',
  weekly: '周常',
  special: '特殊',
};

export const QUEST_STATUS_LABEL_MAP: Record<'not_accepted' | 'in_progress' | 'completed' | 'claimed', string> = {
  not_accepted: '未接取',
  in_progress: '进行中',
  completed: '可领取',
  claimed: '已领取',
};

export const QUEST_STATUS_COLOR_MAP: Record<'not_accepted' | 'in_progress' | 'completed' | 'claimed', 'default' | 'blue' | 'gold' | 'green'>
  = {
    not_accepted: 'default',
    in_progress: 'blue',
    completed: 'gold',
    claimed: 'green',
  };

export const BUILDING_META_MAP: Record<string, { name: string; desc: string }> = {
  hall: { name: '宗门大殿', desc: '宗门核心建筑，提升成员上限并解锁更多功能。' },
  library: { name: '藏经阁', desc: '存放功法典籍，提高修炼效率。' },
  training_hall: { name: '演武场', desc: '宗门弟子修炼之地，提升修炼收益。' },
  alchemy_room: { name: '炼丹房', desc: '炼制丹药，提供日常补给。' },
  forge_house: { name: '炼器房', desc: '打造灵器法宝，提升装备品质。' },
  spirit_array: { name: '聚灵阵', desc: '汇聚天地灵气，提升修炼速度。' },
  defense_array: { name: '护山大阵', desc: '守护宗门的阵法，提升宗门整体防御。' },
};

export const getBuildingEffectText = (buildingType: string, level: number): string => {
  if (buildingType === 'hall') {
    const cap = 20 + Math.max(0, level - 1) * 5;
    return `成员上限 ${cap}`;
  }
  if (buildingType === 'training_hall') return `修炼收益 +${2 + Math.max(0, level - 1)}%`;
  if (buildingType === 'library') return `功法学习效率 +${2 + Math.max(0, level - 1)}%`;
  if (buildingType === 'alchemy_room') return `炼丹成功率 +${1 + Math.max(0, level - 1)}%`;
  if (buildingType === 'forge_house') return `炼器成功率 +${1 + Math.max(0, level - 1)}%`;
  if (buildingType === 'spirit_array') return `灵气回复 +${2 + Math.max(0, level - 1)}%`;
  if (buildingType === 'defense_array') return `宗门防御 +${3 + Math.max(0, level - 1)}%`;
  return '—';
};
