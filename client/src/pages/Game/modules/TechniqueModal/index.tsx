import { App, Button, Modal, Table, Tag, Tooltip } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dan01 from '../../../../assets/images/danyao/qing_ling_dan.png';
import dan02 from '../../../../assets/images/danyao/pei_yuan_dan.png';
import dan03 from '../../../../assets/images/danyao/hui_chun_dan.png';
import it01 from '../../../../assets/images/items/bai_yi_sheng_ling.png';
import it02 from '../../../../assets/images/items/bai_zhan_hu_xin_jing.png';
import coin01 from '../../../../assets/images/ui/sh_icon_0006_jinbi_02.png';
import lingshiIcon from '../../../../assets/images/ui/lingshi.png';
import tongqianIcon from '../../../../assets/images/ui/tongqian.png';
import { gameSocket } from '../../../../services/gameSocket';
import {
  equipCharacterSkill,
  equipCharacterTechnique,
  getCharacterTechniqueStatus,
  getCharacterTechniqueUpgradeCost,
  getTechniqueDetail,
  type SkillDefDto,
  type TechniqueDefDto,
  type TechniqueLayerDto,
  type TechniqueUpgradeCostResponse,
  type CharacterTechniqueDto,
  unequipCharacterSkill,
  unequipCharacterTechnique,
  upgradeCharacterTechnique,
} from '../../../../services/api';
import './index.scss';

// 动态加载所有图片资源
const ICON_GLOB = import.meta.glob('../../../../assets/images/**/*.{png,jpg,jpeg,webp,gif}', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

// 按文件名建立映射
const ICON_BY_FILENAME: Record<string, string> = Object.fromEntries(
  Object.entries(ICON_GLOB).map(([p, url]) => {
    const parts = p.split(/[/\\]/);
    return [parts[parts.length - 1] ?? p, url];
  }),
);

type TechQuality = '黄' | '玄' | '地' | '天';

type TechniqueBonus = { label: string; value: string };

type TechniqueSkill = { 
  id: string; 
  name: string; 
  icon: string;
  // 完整技能数据用于Tooltip显示
  description?: string;
  cost_lingqi?: number;
  cost_qixue?: number;
  cooldown?: number;
  target_type?: string;
  target_count?: number;
  damage_type?: string | null;
  element?: string;
  coefficient?: number;
  fixed_damage?: number;
  scale_attr?: string;
};

type TechniqueCostItem = { id: string; name: string; icon: string; amount: number };

type TechniqueLayer = {
  layer: number;
  bonuses: TechniqueBonus[];
  skills: TechniqueSkill[];
  cost: TechniqueCostItem[];
};

type Technique = {
  id: string;
  name: string;
  quality: TechQuality;
  tags: string[];
  icon: string;
  desc: string;
  layer: number;
  layers: TechniqueLayer[];
};

type TechniquePanel = 'slots' | 'learned' | 'bonus' | 'skills';

type SlotKey = 'main' | 'sub1' | 'sub2' | 'sub3';

type SkillSlot = { id: string; name: string; icon: string } | null;

type PassiveEntry = { key: string; value: number };

const qualityColor: Record<TechQuality, string> = {
  天: 'var(--rarity-tian)',
  地: 'var(--rarity-di)',
  玄: 'var(--rarity-xuan)',
  黄: 'var(--rarity-huang)',
};

const qualityText: Record<TechQuality, string> = {
  天: '天品',
  地: '地品',
  玄: '玄品',
  黄: '黄品',
};

const iconByFilename: Record<string, string> = {
  'qing_ling_dan.png': dan01,
  'pei_yuan_dan.png': dan02,
  'hui_chun_dan.png': dan03,
  'bai_yi_sheng_ling.png': it01,
  'bai_zhan_hu_xin_jing.png': it02,
};

const resolveIcon = (icon: string | null | undefined): string => {
  const raw = (icon ?? '').trim();
  if (!raw) return coin01;
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  // 处理 /assets/skills/xxx.png 格式的路径
  if (raw.startsWith('/assets/')) {
    const filename = raw.split('/').filter(Boolean).pop() ?? raw;
    return ICON_BY_FILENAME[filename] ?? iconByFilename[filename] ?? coin01;
  }
  const filename = raw.split('/').filter(Boolean).pop() ?? '';
  return ICON_BY_FILENAME[filename] ?? iconByFilename[filename] ?? coin01;
};

const mapQuality = (value: unknown): TechQuality => {
  if (value === '天' || value === '地' || value === '玄' || value === '黄') return value;
  return '黄';
};

const passiveLabel: Record<string, string> = {
  max_qixue: '气血上限',
  max_lingqi: '灵气上限',
  wugong: '物攻',
  fagong: '法攻',
  wufang: '物防',
  fafang: '法防',
  mingzhong: '命中',
  shanbi: '闪避',
  baoji: '暴击',
  baoshang: '暴伤',
  kangbao: '抗暴',
  zengshang: '增伤',
  zhiliao: '治疗',
  jianliao: '减疗',
  xixue: '吸血',
  lengque: '冷却',
  sudu: '速度',
  qixue_huifu: '气血恢复',
  lingqi_huifu: '灵气恢复',
};

// 技能目标类型中文映射
const targetTypeLabel: Record<string, string> = {
  self: '自身',
  single_enemy: '单体敌人',
  all_enemies: '全体敌人',
  single_ally: '单体友方',
  all_allies: '全体友方',
  random_enemy: '随机敌人',
  random_ally: '随机友方',
  lowest_hp_ally: '血量最低友方',
  lowest_hp_enemy: '血量最低敌人',
};

// 伤害类型中文映射
const damageTypeLabel: Record<string, string> = {
  physical: '物理伤害',
  magic: '法术伤害',
  true: '真实伤害',
  heal: '治疗',
  buff: '增益',
  debuff: '减益',
  control: '控制',
};

// 元素类型中文映射
const elementLabel: Record<string, string> = {
  none: '无',
  jin: '金',
  mu: '木',
  shui: '水',
  huo: '火',
  tu: '土',
};

// 缩放属性中文映射
const scaleAttrLabel: Record<string, string> = {
  wugong: '物攻',
  fagong: '法攻',
  wufang: '物防',
  fafang: '法防',
  max_qixue: '气血上限',
  max_lingqi: '灵气上限',
  sudu: '速度',
};

// 技能Tooltip内容渲染
const renderSkillTooltip = (skill: TechniqueSkill): React.ReactNode => {
  const items: Array<{ label: string; value: string }> = [];
  
  if (skill.description) {
    items.push({ label: '描述', value: skill.description });
  }
  if (skill.cost_lingqi && skill.cost_lingqi > 0) {
    items.push({ label: '灵气消耗', value: String(skill.cost_lingqi) });
  }
  if (skill.cost_qixue && skill.cost_qixue > 0) {
    items.push({ label: '气血消耗', value: String(skill.cost_qixue) });
  }
  if (skill.cooldown && skill.cooldown > 0) {
    items.push({ label: '冷却回合', value: `${skill.cooldown}回合` });
  }
  if (skill.target_type) {
    items.push({ label: '目标类型', value: targetTypeLabel[skill.target_type] || skill.target_type });
  }
  if (skill.target_count && skill.target_count > 0) {
    items.push({ label: '目标数量', value: String(skill.target_count) });
  }
  if (skill.damage_type) {
    items.push({ label: '伤害类型', value: damageTypeLabel[skill.damage_type] || skill.damage_type });
  }
  if (skill.element && skill.element !== 'none') {
    items.push({ label: '元素属性', value: elementLabel[skill.element] || skill.element });
  }
  if (skill.coefficient && skill.coefficient > 0) {
    const percent = (skill.coefficient / 100).toFixed(0);
    items.push({ label: '伤害系数', value: `${percent}%` });
  }
  if (skill.fixed_damage && skill.fixed_damage > 0) {
    items.push({ label: '固定伤害', value: String(skill.fixed_damage) });
  }
  if (skill.scale_attr) {
    items.push({ label: '缩放属性', value: scaleAttrLabel[skill.scale_attr] || skill.scale_attr });
  }

  return (
    <div className="skill-tooltip">
      <div className="skill-tooltip-title">{skill.name}</div>
      {items.length > 0 ? (
        <div className="skill-tooltip-content">
          {items.map((item, idx) => (
            <div key={idx} className="skill-tooltip-row">
              <span className="skill-tooltip-label">{item.label}：</span>
              <span className="skill-tooltip-value">{item.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="skill-tooltip-empty">暂无详细信息</div>
      )}
    </div>
  );
};

// 功法Tooltip内容渲染
const renderTechniqueTooltip = (t: Technique): React.ReactNode => {
  // 获取当前已解锁层的所有加成
  const unlockedBonuses = t.layers
    .slice(0, Math.max(0, Math.min(t.layer, t.layers.length)))
    .flatMap((lv) => lv.bonuses);
  
  // 获取当前已解锁的所有技能
  const unlockedSkills = t.layers
    .slice(0, Math.max(0, Math.min(t.layer, t.layers.length)))
    .flatMap((lv) => lv.skills);

  return (
    <div className="technique-tooltip">
      <div className="technique-tooltip-header">
        <span className="technique-tooltip-name">{t.name}</span>
        <span className="technique-tooltip-quality" style={{ color: qualityColor[t.quality] }}>
          {qualityText[t.quality]}
        </span>
      </div>
      <div className="technique-tooltip-layer">
        修炼进度：{t.layer}层 / {t.layers.length}层
      </div>
      {t.desc && <div className="technique-tooltip-desc">{t.desc}</div>}
      
      {unlockedBonuses.length > 0 && (
        <div className="technique-tooltip-section">
          <div className="technique-tooltip-section-title">当前加成</div>
          <div className="technique-tooltip-bonuses">
            {unlockedBonuses.map((b, idx) => (
              <div key={idx} className="technique-tooltip-bonus">
                <span className="technique-tooltip-bonus-label">{b.label}</span>
                <span className="technique-tooltip-bonus-value">{b.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {unlockedSkills.length > 0 && (
        <div className="technique-tooltip-section">
          <div className="technique-tooltip-section-title">已解锁技能</div>
          <div className="technique-tooltip-skills">
            {unlockedSkills.map((s) => (
              <div key={s.id} className="technique-tooltip-skill">
                <img className="technique-tooltip-skill-icon" src={s.icon} alt={s.name} />
                <span className="technique-tooltip-skill-name">{s.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {t.layer === 0 && (
        <div className="technique-tooltip-empty">尚未开始修炼</div>
      )}
    </div>
  );
};

const formatPassiveValue = (key: string, value: number): string => {
  const sign = value >= 0 ? '+' : '';
  const abs = Math.abs(value);
  if (key.endsWith('_huifu')) {
    const v = abs / 100;
    const fixed = Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
    return `${sign}${fixed}`;
  }
  const percent = abs / 100;
  const fixed = Number.isInteger(percent) ? String(percent) : String(Number(percent.toFixed(2)));
  return `${sign}${fixed}%`;
};

const coercePassiveEntries = (raw: unknown): PassiveEntry[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      const key = (x as { key?: unknown }).key;
      const value = (x as { value?: unknown }).value;
      if (typeof key !== 'string') return null;
      if (typeof value !== 'number') return null;
      return { key, value };
    })
    .filter((v): v is PassiveEntry => !!v);
};

const coerceMaterials = (
  raw: unknown,
): Array<{ itemId: string; qty: number; itemName?: string; itemIcon?: string | null | undefined }> => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      const itemId = (x as { itemId?: unknown }).itemId;
      const qty = (x as { qty?: unknown }).qty;
      const itemName = (x as { itemName?: unknown }).itemName;
      const itemIcon = (x as { itemIcon?: unknown }).itemIcon;
      if (typeof itemId !== 'string') return null;
      if (typeof qty !== 'number') return null;
      const out: { itemId: string; qty: number; itemName?: string; itemIcon?: string | null } = { itemId, qty };
      if (typeof itemName === 'string') out.itemName = itemName;
      if (typeof itemIcon === 'string' || itemIcon === null) out.itemIcon = itemIcon;
      return out;
    })
    .filter((v): v is { itemId: string; qty: number; itemName?: string; itemIcon?: string | null } => v !== null);
};

const buildTechniqueView = (
  ct: CharacterTechniqueDto | null,
  technique: TechniqueDefDto,
  layers: TechniqueLayerDto[],
  skills: SkillDefDto[],
): Technique => {
  const skillMap = new Map(skills.map((s) => [s.id, s]));
  return {
    id: technique.id,
    name: technique.name,
    quality: mapQuality(technique.quality),
    tags: Array.isArray(technique.tags) ? technique.tags : [],
    icon: resolveIcon(technique.icon),
    desc: technique.long_desc || technique.description || '',
    layer: Math.max(0, ct?.current_layer ?? 0),
    layers: layers.map((lv) => {
      const passives = coercePassiveEntries(lv.passives).map((p) => ({
        label: passiveLabel[p.key] || p.key,
        value: formatPassiveValue(p.key, p.value),
      }));
      const unlockSkills = (Array.isArray(lv.unlock_skill_ids) ? lv.unlock_skill_ids : []).map((id) => {
        const def = skillMap.get(id) ?? null;
        return {
          id,
          name: def?.name ?? id,
          icon: resolveIcon(def?.icon),
          // 保存完整技能数据用于Tooltip
          description: def?.description ?? undefined,
          cost_lingqi: def?.cost_lingqi ?? undefined,
          cost_qixue: def?.cost_qixue ?? undefined,
          cooldown: def?.cooldown ?? undefined,
          target_type: def?.target_type ?? undefined,
          target_count: def?.target_count ?? undefined,
          damage_type: def?.damage_type ?? undefined,
          element: def?.element ?? undefined,
          coefficient: def?.coefficient ?? undefined,
          fixed_damage: def?.fixed_damage ?? undefined,
          scale_attr: def?.scale_attr ?? undefined,
        };
      });
      const cost: TechniqueCostItem[] = [];
      if (lv.cost_spirit_stones > 0) cost.push({ id: 'spirit_stones', name: '灵石', icon: lingshiIcon, amount: lv.cost_spirit_stones });
      if (lv.cost_exp > 0) cost.push({ id: 'exp', name: '经验', icon: tongqianIcon, amount: lv.cost_exp });
      coerceMaterials(lv.cost_materials).forEach((m) => {
        cost.push({ id: m.itemId, name: m.itemName ?? m.itemId, icon: resolveIcon(m.itemIcon ?? null), amount: m.qty });
      });
      return {
        layer: lv.layer,
        bonuses: passives,
        skills: unlockSkills,
        cost,
      };
    }),
  };
};

const slotLabels: Record<SlotKey, string> = {
  main: '主功法',
  sub1: '副功法Ⅰ',
  sub2: '副功法Ⅱ',
  sub3: '副功法Ⅲ',
};

interface TechniqueModalProps {
  open: boolean;
  onClose: () => void;
}

const TechniqueModal: React.FC<TechniqueModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  const [characterId, setCharacterId] = useState<number | null>(() => gameSocket.getCharacter()?.id ?? null);
  const [panel, setPanel] = useState<TechniquePanel>('slots');
  const [activeSlot, setActiveSlot] = useState<SlotKey>('main');
  const [detailOpen, setDetailOpen] = useState(false);
  const [cultivateOpen, setCultivateOpen] = useState(false);
  const [activeTechId, setActiveTechId] = useState<string>('');
  const [detailTechnique, setDetailTechnique] = useState<Technique | null>(null);
  const [upgradeCost, setUpgradeCost] = useState<TechniqueUpgradeCostResponse['data'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [cultivateSubmitting, setCultivateSubmitting] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<TechniqueSkill[]>([]);
  const techniqueDetailCacheRef = useRef<
    Map<string, { technique: TechniqueDefDto; layers: TechniqueLayerDto[]; skills: SkillDefDto[] }>
  >(new Map());

  const [equipped, setEquipped] = useState<Record<SlotKey, string | null>>({
    main: null,
    sub1: null,
    sub2: null,
    sub3: null,
  });

  const [learned, setLearned] = useState<Technique[]>(() => []);

  const [skillSlots, setSkillSlots] = useState<SkillSlot[]>(
    Array.from({ length: 10 }).map(() => null),
  );
  const [activeSkillSlot, setActiveSkillSlot] = useState<number>(0);

  useEffect(() => {
    gameSocket.connect();
    const unsubscribe = gameSocket.onCharacterUpdate((c) => {
      setCharacterId(c?.id ?? null);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!characterId) return;
    setLoading(true);
    try {
      const statusRes = await getCharacterTechniqueStatus(characterId);
      if (!statusRes?.success || !statusRes.data) throw new Error(statusRes?.message || '获取功法状态失败');

      const techRows = statusRes.data.techniques || [];
      const techIds = techRows.map((t) => t.technique_id);

      const detailList = await Promise.all(
        techIds.map(async (id) => {
          const cached = techniqueDetailCacheRef.current.get(id);
          if (cached) return { id, detail: cached };
          const detailRes = await getTechniqueDetail(id);
          if (!detailRes?.success || !detailRes.data) return { id, detail: null };
          techniqueDetailCacheRef.current.set(id, detailRes.data);
          return { id, detail: detailRes.data };
        }),
      );
      const detailMap = new Map(detailList.map((x) => [x.id, x.detail]));

      const builtLearned = techRows
        .map((ct) => {
          const detail = detailMap.get(ct.technique_id);
          if (!detail) return null;
          return buildTechniqueView(ct, detail.technique, detail.layers, detail.skills);
        })
        .filter((v): v is Technique => !!v);

      setLearned(builtLearned);

      const nextEquipped: Record<SlotKey, string | null> = { main: null, sub1: null, sub2: null, sub3: null };
      if (statusRes.data.equippedMain) nextEquipped.main = statusRes.data.equippedMain.technique_id;
      for (const s of statusRes.data.equippedSubs || []) {
        if (s.slot_index === 1) nextEquipped.sub1 = s.technique_id;
        else if (s.slot_index === 2) nextEquipped.sub2 = s.technique_id;
        else if (s.slot_index === 3) nextEquipped.sub3 = s.technique_id;
      }
      setEquipped(nextEquipped);

      const nextSkillSlots: SkillSlot[] = Array.from({ length: 10 }).map(() => null);
      for (const s of statusRes.data.equippedSkills || []) {
        const idx = (s.slot_index || 0) - 1;
        if (idx < 0 || idx >= 10) continue;
        nextSkillSlots[idx] = {
          id: s.skill_id,
          name: s.skill_name || s.skill_id,
          icon: resolveIcon(s.skill_icon),
        };
      }
      setSkillSlots(nextSkillSlots);
      setAvailableSkills(
        (statusRes.data.availableSkills || []).map((s) => ({
          id: s.skillId,
          name: s.skillName || s.skillId,
          icon: resolveIcon(s.skillIcon),
          // 完整技能数据
          description: s.description ?? undefined,
          cost_lingqi: s.costLingqi ?? undefined,
          cost_qixue: s.costQixue ?? undefined,
          cooldown: s.cooldown ?? undefined,
          target_type: s.targetType ?? undefined,
          target_count: s.targetCount ?? undefined,
          damage_type: s.damageType ?? undefined,
          element: s.element ?? undefined,
          coefficient: s.coefficient ?? undefined,
          fixed_damage: s.fixedDamage ?? undefined,
          scale_attr: s.scaleAttr ?? undefined,
        })),
      );

      const nextEmpty = nextSkillSlots.findIndex((x) => x === null);
      if (nextEmpty !== -1) setActiveSkillSlot(nextEmpty);
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '获取功法数据失败');
      setLearned([]);
      setEquipped({ main: null, sub1: null, sub2: null, sub3: null });
      setSkillSlots(Array.from({ length: 10 }).map(() => null));
      setActiveSkillSlot(0);
      setAvailableSkills([]);
    } finally {
      setLoading(false);
    }
  }, [characterId, message]);

  useEffect(() => {
    if (!open) return;
    void refreshStatus();
  }, [open, refreshStatus]);

  const layerText = (layer: number) => `${layer}层`;

  const openDetail = useCallback(
    async (id: string) => {
      setActiveTechId(id);
      const learnedTech = learned.find((x) => x.id === id) ?? null;
      if (learnedTech) {
        setDetailTechnique(learnedTech);
        setDetailOpen(true);
        return;
      }

      const cached = techniqueDetailCacheRef.current.get(id);
      if (cached) {
        setDetailTechnique(buildTechniqueView(null, cached.technique, cached.layers, cached.skills));
        setDetailOpen(true);
        return;
      }

      try {
        const detailRes = await getTechniqueDetail(id);
        if (!detailRes?.success || !detailRes.data) throw new Error(detailRes?.message || '获取功法详情失败');
        techniqueDetailCacheRef.current.set(id, detailRes.data);
        setDetailTechnique(buildTechniqueView(null, detailRes.data.technique, detailRes.data.layers, detailRes.data.skills));
        setDetailOpen(true);
      } catch {
        message.error('获取功法详情失败');
      }
    },
    [learned, message],
  );

  const openCultivate = useCallback(
    async (id: string) => {
      setActiveTechId(id);
      setUpgradeCost(null);
      setCultivateOpen(true);
      if (!characterId) return;
      try {
        const costRes = await getCharacterTechniqueUpgradeCost(characterId, id);
        if (!costRes?.success || !costRes.data) return;
        setUpgradeCost(costRes.data);
      } catch {
        setUpgradeCost(null);
      }
    },
    [characterId],
  );

  const equippedTech = useMemo(() => {
    const map = new Map(learned.map((t) => [t.id, t]));
    return {
      main: equipped.main ? map.get(equipped.main) ?? null : null,
      sub1: equipped.sub1 ? map.get(equipped.sub1) ?? null : null,
      sub2: equipped.sub2 ? map.get(equipped.sub2) ?? null : null,
      sub3: equipped.sub3 ? map.get(equipped.sub3) ?? null : null,
    };
  }, [equipped, learned]);

  const equipToActiveSlot = async (techId: string) => {
    if (!characterId) return;
    const slotType = activeSlot === 'main' ? 'main' : 'sub';
    const slotIndex = activeSlot === 'sub1' ? 1 : activeSlot === 'sub2' ? 2 : activeSlot === 'sub3' ? 3 : undefined;
    try {
      const res = await equipCharacterTechnique(characterId, techId, slotType, slotIndex);
      if (!res?.success) throw new Error(res?.message || '运功失败');
      message.success(res.message || '运功成功');
      await refreshStatus();
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '运功失败');
    }
  };

  const removeFromSlot = async (slot: SlotKey) => {
    if (!characterId) return;
    const techId = equipped[slot];
    if (!techId) return;
    try {
      const res = await unequipCharacterTechnique(characterId, techId);
      if (!res?.success) throw new Error(res?.message || '卸下失败');
      message.success(res.message || '卸下成功');
      await refreshStatus();
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '卸下失败');
    }
  };

  const equipSkillToSlot = async (skillId: string) => {
    if (!characterId) return;
    const s = availableSkills.find((x) => x.id === skillId);
    if (!s) return;
    const idx0 = Number.isFinite(activeSkillSlot) ? activeSkillSlot : 0;
    const slotIndex = idx0 + 1;
    try {
      const res = await equipCharacterSkill(characterId, s.id, slotIndex);
      if (!res?.success) throw new Error(res?.message || '装备技能失败');
      message.success(res.message || '装备成功');
      await refreshStatus();
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '装备技能失败');
    }
  };

  const clearSkillSlot = async (idx: number) => {
    if (!characterId) return;
    const slotIndex = idx + 1;
    try {
      const res = await unequipCharacterSkill(characterId, slotIndex);
      if (!res?.success) throw new Error(res?.message || '卸下技能失败');
      message.success(res.message || '已清空');
      await refreshStatus();
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '卸下技能失败');
    }
  };

  const equippedSlotByTechId = useMemo(() => {
    const m = new Map<string, SlotKey>();
    (Object.keys(equipped) as SlotKey[]).forEach((k) => {
      const id = equipped[k];
      if (id) m.set(id, k);
    });
    return m;
  }, [equipped]);

  const leftItems: Array<{ key: TechniquePanel; label: string }> = [
    { key: 'slots', label: '功法栏' },
    { key: 'learned', label: '已学功法' },
    { key: 'bonus', label: '功法加成' },
    { key: 'skills', label: '技能配置' },
  ];

  const renderSlotsPanel = () => (
    <div className="tech-pane">
      <div className="tech-pane-top">
        <div className="tech-slots">
          {(Object.keys(slotLabels) as SlotKey[]).map((k) => {
            const t = equippedTech[k];
            return (
              <Tooltip
                key={k}
                title={t ? renderTechniqueTooltip(t) : null}
                placement="right"
                classNames={{ root: 'technique-tooltip-overlay' }}
              >
                <div
                  className={`tech-slot ${k === activeSlot ? 'is-active' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveSlot(k)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setActiveSlot(k);
                  }}
                >
                  <div className="tech-slot-label">{slotLabels[k]}</div>
                  <div className="tech-slot-card">
                    <div className="tech-slot-meta">
                      <div className="tech-slot-name">
                        {t ? `${t.name}（${layerText(t.layer)}/${layerText(t.layers.length)}）` : '未装备'}
                      </div>
                      <div className="tech-slot-tags">
                        {t ? <Tag color={qualityColor[t.quality]}>{qualityText[t.quality]}</Tag> : <Tag>未装配</Tag>}
                        {(t?.tags ?? []).slice(0, 2).map((x) => (
                          <Tag key={x} color="default">
                            {x}
                          </Tag>
                        ))}
                      </div>
                    </div>
                    <Button
                      size="small"
                      className={`tech-slot-remove ${t ? '' : 'is-placeholder'}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFromSlot(k);
                      }}
                    >
                      卸下
                    </Button>
                  </div>
                  <div className="tech-slot-hint">{t ? '点击下方功法可替换' : '点击下方功法运功装备到此栏位'}</div>
                </div>
              </Tooltip>
            );
          })}
        </div>
      </div>

      <div className="tech-pane-bottom">
        <div className="tech-subtitle">已学功法（当前栏位：{slotLabels[activeSlot]}）</div>
        <div className="tech-learned-list">
          {learned.map((t) => {
            const equippedSlot = equippedSlotByTechId.get(t.id) ?? null;
            return (
              <Tooltip key={t.id} title={renderTechniqueTooltip(t)} placement="right" classNames={{ root: 'technique-tooltip-overlay' }}>
                <div className="tech-row">
                  <div className="tech-row-main">
                    <div className="tech-row-name">{t.name}</div>
                    <div className="tech-row-tags">
                      <Tag color={qualityColor[t.quality]}>{qualityText[t.quality]}</Tag>
                      <Tag color="default">
                        {layerText(t.layer)}/{layerText(t.layers.length)}
                      </Tag>
                      {equippedSlot ? <Tag color="blue">{slotLabels[equippedSlot]}</Tag> : null}
                      {t.tags.slice(0, 2).map((x) => (
                        <Tag key={x} color="default">
                          {x}
                        </Tag>
                      ))}
                    </div>
                  </div>
                  {equippedSlot ? (
                    <Button size="small" danger onClick={() => removeFromSlot(equippedSlot)}>
                      取消运功
                    </Button>
                  ) : (
                    <Button size="small" type="primary" onClick={() => equipToActiveSlot(t.id)}>
                      运功
                    </Button>
                  )}
                </div>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );

  const renderLearnedPanel = () => (
    <div className="tech-pane">
      <div className="tech-pane-scroll">
        <div className="tech-subtitle">已学功法</div>
        <div className="tech-learned-list">
          {learned.map((t) => (
            <Tooltip key={t.id} title={renderTechniqueTooltip(t)} placement="right" classNames={{ root: 'technique-tooltip-overlay' }}>
              <div className="tech-row">
                <div className="tech-row-main">
                  <div className="tech-row-name">{t.name}</div>
                  <div className="tech-row-tags">
                    <Tag color={qualityColor[t.quality]}>{qualityText[t.quality]}</Tag>
                    <Tag color="default">
                      {layerText(t.layer)}/{layerText(t.layers.length)}
                    </Tag>
                    {t.tags.slice(0, 3).map((x) => (
                      <Tag key={x} color="default">
                        {x}
                      </Tag>
                    ))}
                  </div>
                  <div className="tech-row-desc">{t.desc}</div>
                </div>
                <div className="tech-row-actions">
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => openDetail(t.id)}
                  >
                    详情
                  </Button>
                  <Button size="small" onClick={() => openCultivate(t.id)}>
                    修炼
                  </Button>
                </div>
              </div>
            </Tooltip>
          ))}
        </div>
      </div>
    </div>
  );

  const renderBonusPanel = () => {
    const rows = learned.map((t) => {
      let role: string = '未装配';
      if (equipped.main === t.id) role = '主功法';
      if (equipped.sub1 === t.id || equipped.sub2 === t.id || equipped.sub3 === t.id) role = '副功法';
      return {
        id: t.id,
        name: t.name,
        quality: t.quality,
        role,
        bonuses: t.layers
          .slice(0, Math.max(0, Math.min(t.layer, t.layers.length)))
          .flatMap((lv) => lv.bonuses),
      };
    });

    return (
      <div className="tech-pane">
        <div className="tech-pane-scroll">
          <div className="tech-subtitle">功法加成（主功法 100%，副功法 30%）</div>
          <Table
            size="small"
            rowKey={(row) => row.id}
            pagination={false}
            className="tech-table"
            columns={[
              {
                title: '功法',
                dataIndex: 'name',
                key: 'name',
                render: (_: string, row: (typeof rows)[number]) => (
                  <div className="tech-table-name">
                    <span className="tech-table-name-text">{row.name}</span>
                    <Tag color={qualityColor[row.quality]}>{qualityText[row.quality]}</Tag>
                  </div>
                ),
              },
              {
                title: '装配',
                dataIndex: 'role',
                key: 'role',
                width: 90,
                render: (value: string) => <span className="tech-table-role">{value}</span>,
              },
              {
                title: '属性',
                dataIndex: 'bonuses',
                key: 'bonuses',
                render: (list: TechniqueBonus[]) => (
                  <div className="tech-bonus-lines">
                    {list.length ? (
                      list.map((b) => (
                        <div key={`${b.label}-${b.value}`} className="tech-bonus-line">
                          <span className="tech-bonus-k">{b.label}</span>
                          <span className="tech-bonus-v">{b.value}</span>
                        </div>
                      ))
                    ) : (
                      <div className="tech-empty">无</div>
                    )}
                  </div>
                ),
              },
            ]}
            dataSource={rows}
          />
        </div>
      </div>
    );
  };

  const renderSkillsPanel = () => (
    <div className="tech-pane">
      <div className="tech-pane-top">
        <div className="tech-subtitle">技能栏</div>
        <div className="skill-slots">
          {skillSlots.map((s, idx) => (
            <div
              key={`slot-${idx}`}
              className={`skill-slot ${idx === activeSkillSlot ? 'is-active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => setActiveSkillSlot(idx)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setActiveSkillSlot(idx);
              }}
            >
              <div className="skill-slot-index">{idx + 1}</div>
              {s ? <img className="skill-slot-icon" src={s.icon} alt={s.name} /> : <div className="skill-slot-empty" />}
              <Button
                size="small"
                className={`skill-slot-clear ${s ? '' : 'is-placeholder'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  clearSkillSlot(idx);
                }}
              >
                清空
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="tech-pane-bottom">
        <div className="tech-subtitle">技能库（点击按顺序装备）</div>
        <div className="skill-list">
          {availableSkills.map((s) => (
            <Tooltip key={s.id} title={renderSkillTooltip(s)} placement="top" classNames={{ root: 'skill-tooltip-overlay' }}>
              <div
                className="skill-item"
                role="button"
                tabIndex={0}
                onClick={() => equipSkillToSlot(s.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') equipSkillToSlot(s.id);
                }}
              >
                <img className="skill-item-icon" src={s.icon} alt={s.name} />
                <div className="skill-item-name">{s.name}</div>
              </div>
            </Tooltip>
          ))}
          {availableSkills.length === 0 ? <div className="tech-empty">暂无技能</div> : null}
        </div>
      </div>
    </div>
  );

  const panelContent = () => {
    if (loading) {
      return (
        <div className="tech-pane">
          <div className="tech-empty">加载中...</div>
        </div>
      );
    }
    if (panel === 'slots') return renderSlotsPanel();
    if (panel === 'learned') return renderLearnedPanel();
    if (panel === 'bonus') return renderBonusPanel();
    return renderSkillsPanel();
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={1080}
      className="tech-modal"
      destroyOnHidden
      maskClosable
      afterOpenChange={(visible) => {
        if (!visible) return;
        setPanel('slots');
        setActiveSlot('main');
        setDetailOpen(false);
        setCultivateOpen(false);
        setActiveTechId('');
        setDetailTechnique(null);
        setUpgradeCost(null);
      }}
    >
      <div className="tech-modal-shell">
        <div className="tech-modal-left">
          <div className="tech-left-title">
            <img className="tech-left-icon" src={coin01} alt="功法" />
            <div className="tech-left-name">功法</div>
          </div>
          <div className="tech-left-list">
            {leftItems.map((it) => (
              <Button
                key={it.key}
                type={panel === it.key ? 'primary' : 'default'}
                className="tech-left-item"
                onClick={() => setPanel(it.key)}
              >
                {it.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="tech-modal-right">{panelContent()}</div>
      </div>

      <Modal
        open={detailOpen}
        onCancel={() => setDetailOpen(false)}
        footer={null}
        title="功法详情"
        centered
        width={720}
        className="tech-submodal"
        destroyOnHidden
      >
        {(() => {
          const t = detailTechnique ?? null;
          if (!t) return <div className="tech-empty">未找到功法</div>;
          const layerRows = t.layers.map((lv) => ({
            layer: lv.layer,
            unlocked: lv.layer <= t.layer,
            bonuses: lv.bonuses,
            skills: lv.skills,
          }));
          return (
            <div className="tech-detail">
              <div className="tech-detail-header">
                <img className="tech-detail-icon" src={t.icon} alt={t.name} />
                <div className="tech-detail-meta">
                  <div className="tech-detail-name">
                    <span>{t.name}</span>
                    <Tag color={qualityColor[t.quality]}>{qualityText[t.quality]}</Tag>
                    <Tag color="default">
                      {layerText(t.layer)}/{layerText(t.layers.length)}
                    </Tag>
                  </div>
                  <div className="tech-detail-tags">
                    {t.tags.map((x) => (
                      <Tag key={x} color="default">
                        {x}
                      </Tag>
                    ))}
                  </div>
                </div>
              </div>
              <div className="tech-detail-desc">{t.desc}</div>
              <div className="tech-detail-section-title">层数加成与技能</div>
              <Table
                size="small"
                rowKey={(row) => String(row.layer)}
                pagination={false}
                className="tech-layer-table"
                columns={[
                  {
                    title: '层数',
                    dataIndex: 'layer',
                    key: 'layer',
                    width: 70,
                    render: (v: number) => `第${v}层`,
                  },
                  {
                    title: '状态',
                    dataIndex: 'unlocked',
                    key: 'unlocked',
                    width: 86,
                    render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '已解锁' : '未解锁'}</Tag>,
                  },
                  {
                    title: '加成',
                    dataIndex: 'bonuses',
                    key: 'bonuses',
                    render: (list: TechniqueBonus[]) => (
                      <div className="tech-layer-cell">
                        {list.length ? (
                          list.map((b) => (
                            <div key={`${b.label}-${b.value}`} className="tech-layer-cell-line">
                              <span className="tech-layer-cell-k">{b.label}</span>
                              <span className="tech-layer-cell-v">{b.value}</span>
                            </div>
                          ))
                        ) : (
                          <span className="tech-layer-cell-empty">无</span>
                        )}
                      </div>
                    ),
                  },
                  {
                    title: '解锁技能',
                    dataIndex: 'skills',
                    key: 'skills',
                    render: (list: TechniqueSkill[]) => (
                      <div className="tech-layer-skill-cell">
                        {list.length ? (
                          list.map((s) => (
                            <Tooltip key={s.id} title={renderSkillTooltip(s)} placement="top" classNames={{ root: 'skill-tooltip-overlay' }}>
                              <div className="tech-layer-skill-pill">
                                <img className="tech-layer-skill-pill-icon" src={s.icon} alt={s.name} />
                                <span className="tech-layer-skill-pill-name">{s.name}</span>
                              </div>
                            </Tooltip>
                          ))
                        ) : (
                          <span className="tech-layer-cell-empty">无</span>
                        )}
                      </div>
                    ),
                  },
                ]}
                dataSource={layerRows}
              />
            </div>
          );
        })()}
      </Modal>

      <Modal
        open={cultivateOpen}
        onCancel={() => setCultivateOpen(false)}
        title="功法修炼"
        centered
        width={640}
        className="tech-submodal"
        destroyOnHidden
        okText="确认修炼"
        cancelText="取消"
        onOk={async () => {
          const id = activeTechId;
          if (!id) return;
          if (!characterId) return;
          if (cultivateSubmitting) return;
          setCultivateSubmitting(true);
          try {
            const res = await upgradeCharacterTechnique(characterId, id);
            if (!res?.success) throw new Error(res?.message || '修炼失败');
            message.success(res.message || '修炼成功');
            await refreshStatus();
            const costRes = await getCharacterTechniqueUpgradeCost(characterId, id);
            if (costRes?.success && costRes.data) setUpgradeCost(costRes.data);
          } catch (error: unknown) {
            const err = error as { message?: string };
            message.error(err.message || '修炼失败');
          } finally {
            setCultivateSubmitting(false);
          }
        }}
        okButtonProps={{
          loading: cultivateSubmitting,
          disabled: (() => {
            const t = learned.find((x) => x.id === activeTechId);
            if (!t) return true;
            return t.layer >= t.layers.length;
          })(),
        }}
      >
        {(() => {
          const t = learned.find((x) => x.id === activeTechId) ?? null;
          if (!t) return <div className="tech-empty">未找到功法</div>;
          const nextLayer = Math.min(t.layer + 1, t.layers.length);
          const next = t.layers.find((lv) => lv.layer === nextLayer) ?? null;
          const maxed = t.layer >= t.layers.length;
          const unlockBonuses = next?.bonuses ?? [];
          const unlockSkills = next?.skills ?? [];
          const cost: TechniqueCostItem[] = [];
          const costData = upgradeCost;
          if (costData) {
            if (costData.spirit_stones > 0) cost.push({ id: 'spirit_stones', name: '灵石', icon: lingshiIcon, amount: costData.spirit_stones });
            if (costData.exp > 0) cost.push({ id: 'exp', name: '经验', icon: tongqianIcon, amount: costData.exp });
            (costData.materials || []).forEach((m) => {
              cost.push({ id: m.itemId, name: m.itemName ?? m.itemId, icon: resolveIcon(m.itemIcon ?? null), amount: m.qty });
            });
          } else {
            (next?.cost ?? []).forEach((c) => cost.push(c));
          }
          return (
            <div className="tech-cultivate">
              <div className="tech-cultivate-header">
                <img className="tech-cultivate-icon" src={t.icon} alt={t.name} />
                <div className="tech-cultivate-meta">
                  <div className="tech-cultivate-name">
                    <span>{t.name}</span>
                    <Tag color={qualityColor[t.quality]}>{qualityText[t.quality]}</Tag>
                  </div>
                  <div className="tech-cultivate-layer">
                    当前：{layerText(t.layer)}/{layerText(t.layers.length)} {maxed ? '（已满）' : ''}
                  </div>
                </div>
              </div>

              {!maxed ? (
                <>
                  <div className="tech-detail-section-title">升级消耗</div>
                  <div className="tech-cost-list">
                    {cost.map((c) => (
                      <div key={`${t.id}-cost-${c.id}`} className="tech-cost-item">
                        <img className="tech-cost-icon" src={c.icon} alt={c.name} />
                        <div className="tech-cost-name">{c.name}</div>
                        <div className="tech-cost-amount">×{c.amount.toLocaleString()}</div>
                      </div>
                    ))}
                    {cost.length === 0 ? <div className="tech-empty">无</div> : null}
                  </div>
                  <div className="tech-detail-section-title">本次解锁</div>
                  <div className="tech-cultivate-unlock">
                    <div className="tech-cultivate-unlock-title">加成（第 {nextLayer} 层）</div>
                    <div className="tech-layer-bonuses">
                      {unlockBonuses.map((b) => (
                        <div key={`${t.id}-unlock-${nextLayer}-${b.label}-${b.value}`} className="tech-layer-bonus">
                          <div className="tech-layer-bonus-k">{b.label}</div>
                          <div className="tech-layer-bonus-v">{b.value}</div>
                        </div>
                      ))}
                      {unlockBonuses.length === 0 ? <div className="tech-empty">无</div> : null}
                    </div>
                    <div className="tech-cultivate-unlock-title">技能（第 {nextLayer} 层）</div>
                    <div className="tech-layer-skills">
                      {unlockSkills.map((s) => (
                        <Tooltip key={`${t.id}-unlock-s-${s.id}`} title={renderSkillTooltip(s)} placement="top" classNames={{ root: 'skill-tooltip-overlay' }}>
                          <div className="tech-layer-skill">
                            <img className="tech-layer-skill-icon" src={s.icon} alt={s.name} />
                            <div className="tech-layer-skill-name">{s.name}</div>
                          </div>
                        </Tooltip>
                      ))}
                      {unlockSkills.length === 0 ? <div className="tech-empty">无</div> : null}
                    </div>
                  </div>
                </>
              ) : (
                <div className="tech-empty">已修炼至满层，无可提升内容</div>
              )}
            </div>
          );
        })()}
      </Modal>
    </Modal>
  );
};

export default TechniqueModal;
