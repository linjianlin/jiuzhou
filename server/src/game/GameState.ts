/**
 * 九州修仙录 - boardgame.io 游戏状态定义
 */

// 角色属性接口
export interface CharacterAttributes {
  id: number;
  userId: number;
  nickname: string;
  title: string;
  gender: string;
  avatar: string | null;
  autoCastSkills: boolean;
  autoDisassembleEnabled: boolean;
  autoDisassembleMaxQualityRank: number;
  spiritStones: number;
  silver: number;
  stamina: number;
  realm: string;
  subRealm: string | null;
  exp: number;
  attributePoints: number;
  jing: number;
  qi: number;
  shen: number;
  attributeType: string;
  attributeElement: string;
  qixue: number;
  maxQixue: number;
  lingqi: number;
  maxLingqi: number;
  wugong: number;
  fagong: number;
  wufang: number;
  fafang: number;
  mingzhong: number;
  shanbi: number;
  zhaojia: number;
  baoji: number;
  baoshang: number;
  kangbao: number;
  zengshang: number;
  zhiliao: number;
  jianliao: number;
  xixue: number;
  lengque: number;
  shuxingShuzhi: number;
  kongzhiKangxing: number;
  jinKangxing: number;
  muKangxing: number;
  shuiKangxing: number;
  huoKangxing: number;
  tuKangxing: number;
  qixueHuifu: number;
  lingqiHuifu: number;
  sudu: number;
  fuyuan: number;
  currentMapId: string;
  currentRoomId: string;
}

// 数据库字段到驼峰命名的转换
export const dbToCharacterAttributes = (dbRow: Record<string, unknown>): CharacterAttributes => ({
  id: dbRow.id as number,
  userId: dbRow.user_id as number,
  nickname: dbRow.nickname as string,
  title: dbRow.title as string,
  gender: dbRow.gender as string,
  avatar: dbRow.avatar as string | null,
  autoCastSkills: dbRow.auto_cast_skills == null ? true : Boolean(dbRow.auto_cast_skills),
  autoDisassembleEnabled: dbRow.auto_disassemble_enabled == null ? false : Boolean(dbRow.auto_disassemble_enabled),
  autoDisassembleMaxQualityRank: (() => {
    const n = Number(dbRow.auto_disassemble_max_quality_rank);
    if (!Number.isInteger(n)) return 1;
    return Math.max(1, Math.min(4, n));
  })(),
  spiritStones: Number(dbRow.spirit_stones) || 0,
  silver: Number(dbRow.silver) || 0,
  stamina: Number(dbRow.stamina) || 0,
  realm: dbRow.realm as string,
  subRealm: dbRow.sub_realm as string | null,
  exp: Number(dbRow.exp) || 0,
  attributePoints: dbRow.attribute_points as number,
  jing: dbRow.jing as number,
  qi: dbRow.qi as number,
  shen: dbRow.shen as number,
  attributeType: dbRow.attribute_type as string,
  attributeElement: dbRow.attribute_element as string,
  qixue: dbRow.qixue as number,
  maxQixue: dbRow.max_qixue as number,
  lingqi: dbRow.lingqi as number,
  maxLingqi: dbRow.max_lingqi as number,
  wugong: dbRow.wugong as number,
  fagong: dbRow.fagong as number,
  wufang: dbRow.wufang as number,
  fafang: dbRow.fafang as number,
  mingzhong: dbRow.mingzhong as number,
  shanbi: dbRow.shanbi as number,
  zhaojia: dbRow.zhaojia as number,
  baoji: dbRow.baoji as number,
  baoshang: dbRow.baoshang as number,
  kangbao: dbRow.kangbao as number,
  zengshang: dbRow.zengshang as number,
  zhiliao: dbRow.zhiliao as number,
  jianliao: dbRow.jianliao as number,
  xixue: dbRow.xixue as number,
  lengque: dbRow.lengque as number,
  shuxingShuzhi: dbRow.shuxing_shuzhi as number,
  kongzhiKangxing: dbRow.kongzhi_kangxing as number,
  jinKangxing: dbRow.jin_kangxing as number,
  muKangxing: dbRow.mu_kangxing as number,
  shuiKangxing: dbRow.shui_kangxing as number,
  huoKangxing: dbRow.huo_kangxing as number,
  tuKangxing: dbRow.tu_kangxing as number,
  qixueHuifu: dbRow.qixue_huifu as number,
  lingqiHuifu: dbRow.lingqi_huifu as number,
  sudu: dbRow.sudu as number,
  fuyuan: dbRow.fuyuan as number,
  currentMapId: (dbRow.current_map_id as string) || 'map-qingyun-village',
  currentRoomId: (dbRow.current_room_id as string) || 'room-village-center',
});
