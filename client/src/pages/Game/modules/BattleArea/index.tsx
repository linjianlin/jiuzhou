import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { App, Button, Tag } from 'antd';
import {
  abandonBattle,
  battleAction,
  getBattleState,
  startPVEBattle,
  type BattleLogEntryDto,
  type BattleRewardsDto,
  type BattleStateDto,
} from '../../../../services/api';
import { gameSocket } from '../../../../services/gameSocket';
import { translateBuffName, translateBuffNames, translateControlName } from './logNameMap';
import './index.scss';

export type BattleUnit = {
  id: string;
  name: string;
  tag?: string;
  hp: number;
  maxHp: number;
  qi: number;
  maxQi: number;
  isPlayer?: boolean;
};

interface BattleAreaProps {
  enemies: BattleUnit[];
  allies: BattleUnit[];
  onEscape?: () => void;
  onTurnChange?: (turnCount: number, turnSide: 'enemy' | 'ally', actionKey: string, activeUnitId: string | null) => void;
  onBindSkillCaster?: (caster: (skillId: string, targetType?: string) => Promise<boolean>) => void;
  externalBattleId?: string | null;
  allowAutoNext?: boolean;
  onAppendBattleLines?: (lines: string[]) => void;
  onNext?: () => Promise<void>;
  nextLabel?: string;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const toPercent = (value: number, total: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return clamp((value / total) * 100, 0, 100);
};

type BattleResult = 'idle' | 'running' | 'win' | 'lose' | 'draw';
type FloatText = { id: string; unitId: string; value: number; dx: number; createdAt: number };

const createFloatId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const pickAlive = (units: BattleUnit[]) => units.filter((u) => (Number(u.hp) || 0) > 0);

const calcTeamInfoFromState = (state: BattleStateDto | null | undefined): { isTeamBattle: boolean; teamMemberCount: number } => {
  const count = (state?.teams?.attacker?.units ?? []).filter((u) => u.type === 'player').length;
  const teamMemberCount = Math.max(1, Math.floor(Number(count) || 1));
  return { isTeamBattle: teamMemberCount > 1, teamMemberCount };
};

const StatBar: React.FC<{
  value: number;
  total: number;
  tone: 'hp' | 'qi';
}> = ({ value, total, tone }) => {
  const percent = toPercent(value, total);
  return (
    <div className={`battle-bar battle-bar-${tone}`}>
      <div className="battle-bar-track">
        <div className="battle-bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="battle-bar-text">
        {Math.max(0, Math.floor(value))}/{Math.max(0, Math.floor(total))}
      </div>
    </div>
  );
};

const UnitCard: React.FC<{
  unit: BattleUnit;
  active?: boolean;
  floats?: FloatText[];
  selected?: boolean;
  onClick?: () => void;
}> = ({ unit, active, floats, selected, onClick }) => {
  const dead = (Number(unit.hp) || 0) <= 0;
  return (
    <div
      className={`battle-unit-card ${active ? 'active' : ''} ${selected ? 'selected' : ''} ${dead ? 'dead' : ''}`}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onClick();
      }}
    >
      <div className="battle-floats">
        {(floats ?? []).map((f) => (
          <div
            key={f.id}
            className={`battle-float ${f.value < 0 ? 'neg' : 'pos'}`}
            style={{ '--dx': `${f.dx}px` } as CSSProperties}
          >
            {f.value < 0 ? `${f.value}` : `+${f.value}`}
          </div>
        ))}
      </div>
      <div className="battle-unit-head">
        <div className="battle-unit-name" title={unit.name}>
          {unit.name}
          {unit.isPlayer ? <Tag color="blue" style={{ marginLeft: 4, fontSize: 10 }}>队友</Tag> : null}
        </div>
        <div className="battle-unit-tag">{unit.tag || '凡人'}</div>
      </div>
      <div className="battle-unit-bars">
        <StatBar value={unit.hp} total={unit.maxHp} tone="hp" />
        <StatBar value={unit.qi} total={unit.maxQi} tone="qi" />
      </div>
    </div>
  );
};

const toClientUnit = (u: {
  id: string;
  name: string;
  qixue: number;
  lingqi: number;
  currentAttrs: { max_qixue: number; max_lingqi: number; realm?: string };
  type: string;
}): BattleUnit => {
  return {
    id: u.id,
    name: u.name,
    tag: u.currentAttrs?.realm || (u.type === 'monster' ? '凡兽' : '凡人'),
    hp: Number(u.qixue) || 0,
    maxHp: Number(u.currentAttrs?.max_qixue) || 0,
    qi: Number(u.lingqi) || 0,
    maxQi: Number(u.currentAttrs?.max_lingqi) || 0,
    isPlayer: u.type === 'player',
  };
};

const getCurrentUnitId = (state: BattleStateDto | null): string | null => {
  if (!state) return null;
  const team = state.teams[state.currentTeam];
  const alive = (team?.units ?? []).filter((u) => u.isAlive);
  const u = alive[state.currentUnitIndex];
  return u?.id ?? null;
};

const getPhaseRank = (phase: BattleStateDto['phase']): number => {
  if (phase === 'roundStart') return 1;
  if (phase === 'action') return 2;
  if (phase === 'roundEnd') return 3;
  if (phase === 'finished') return 4;
  return 0;
};

const isNewerBattleState = (next: BattleStateDto, current: BattleStateDto | null): boolean => {
  if (!current) return true;
  if (next.battleId !== current.battleId) return true;

  if (current.phase === 'finished' && next.phase !== 'finished') return false;

  const nextLogs = next.logs?.length ?? 0;
  const currentLogs = current.logs?.length ?? 0;
  if (nextLogs !== currentLogs) return nextLogs > currentLogs;

  if (next.phase === 'finished' && current.phase !== 'finished') return true;

  const nextRound = Number(next.roundCount) || 0;
  const currentRound = Number(current.roundCount) || 0;
  if (nextRound !== currentRound) return nextRound > currentRound;

  const nextRank = getPhaseRank(next.phase);
  const currentRank = getPhaseRank(current.phase);
  if (nextRank !== currentRank) return nextRank > currentRank;

  const nextIndex = Number(next.currentUnitIndex) || 0;
  const currentIndex = Number(current.currentUnitIndex) || 0;
  if (nextIndex !== currentIndex) return nextIndex > currentIndex;

  const nextTeam = String(next.currentTeam || '');
  const currentTeam = String(current.currentTeam || '');
  return nextTeam === currentTeam;
};

const stableHash = (seed: string): number => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const pickVariant = (seed: string, variants: readonly string[]): string => {
  if (variants.length === 0) return '';
  const index = stableHash(seed) % variants.length;
  return variants[index] ?? variants[0] ?? '';
};

const TRANSIENT_BATTLE_ACTION_ERRORS = new Set([
  '当前不是玩家行动回合',
  '不是玩家方的回合',
  '不是该单位的行动回合',
  '目标不是有效的敌方单位',
  '目标不是有效的友方单位',
]);

const isTransientBattleActionError = (msg: unknown): boolean => {
  const text = String(msg ?? '').trim();
  if (!text) return false;
  if (TRANSIENT_BATTLE_ACTION_ERRORS.has(text)) return true;
  return text.includes('目标不是有效的') || text.includes('行动回合');
};

const BattleArea: React.FC<BattleAreaProps> = ({
  enemies,
  onEscape,
  onTurnChange,
  onBindSkillCaster,
  externalBattleId,
  allowAutoNext,
  onAppendBattleLines,
  onNext,
  nextLabel,
}) => {
  const { message } = App.useApp();
  const resolvedExternalBattleId = externalBattleId ?? null;
  const resolvedAllowAutoNext = allowAutoNext ?? true;
  const [battleState, setBattleState] = useState<BattleStateDto | null>(null);
  const [battleId, setBattleId] = useState<string | null>(null);
  const [selectedEnemyId, setSelectedEnemyId] = useState<string | null>(null);
  const [selectedAllyId, setSelectedAllyId] = useState<string | null>(null);
  const [floats, setFloats] = useState<FloatText[]>([]);
  const [result, setResult] = useState<BattleResult>('idle');
  const [isTeamBattle, setIsTeamBattle] = useState(false);
  const [teamMemberCount, setTeamMemberCount] = useState(1);
  const [nexting, setNexting] = useState(false);
  const floatTimerSetRef = useRef<Set<number>>(new Set());
  const nextingRef = useRef(false);
  const battleIdRef = useRef<string | null>(null);
  const battleStateRef = useRef<BattleStateDto | null>(null);
  const lastLogIndexRef = useRef(0);
  const lastChatLogIndexRef = useRef(0);
  const announcedBattleIdRef = useRef<string | null>(null);
  const announcedBattleEndIdRef = useRef<string | null>(null);
  const announcedBattleDropsIdRef = useRef<string | null>(null);
  const onAppendBattleLinesRef = useRef<((lines: string[]) => void) | null>(null);
  const lastMonsterIdsRef = useRef<string[]>([]);
  const autoNextTimerRef = useRef<number | null>(null);
  const announcedAutoNextBattleIdRef = useRef<string | null>(null);
  const startingBattleRef = useRef(false);
  const lastSocketBattleUpdateAtRef = useRef(0);
  const pollInFlightRef = useRef(false);

  useEffect(() => {
    onAppendBattleLinesRef.current = onAppendBattleLines ?? null;
  }, [onAppendBattleLines]);

  const clearFloatTimers = useCallback(() => {
    floatTimerSetRef.current.forEach((t) => window.clearTimeout(t));
    floatTimerSetRef.current.clear();
  }, []);

  const clearAutoNextTimer = useCallback(() => {
    if (autoNextTimerRef.current) {
      window.clearTimeout(autoNextTimerRef.current);
      autoNextTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    battleIdRef.current = battleId;
  }, [battleId]);

  useEffect(() => {
    nextingRef.current = nexting;
  }, [nexting]);

  useEffect(() => {
    battleStateRef.current = battleState;
  }, [battleState]);

  const pushBattleLines = useCallback((lines: string[]) => {
    const fn = onAppendBattleLinesRef.current;
    if (!fn) return;
    const list = (lines ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
    if (list.length === 0) return;
    fn(list);
  }, []);

  const buildRewardSummaryLines = useCallback(
    (state: BattleStateDto | null | undefined, rewards: BattleRewardsDto | null | undefined): string[] => {
      if (!state || state.phase !== 'finished') return [];
      if (!rewards) return ['【斗法所得】暂无收获'];

      const totalExp = Math.max(0, Math.floor(Number(rewards.totalExp ?? rewards.exp) || 0));
      const totalSilver = Math.max(0, Math.floor(Number(rewards.totalSilver ?? rewards.silver) || 0));
      const participantCount = Math.max(1, Math.floor(Number(rewards.participantCount) || 1));

      const playerNameByCharacterId = new Map<number, string>();
      for (const u of state.teams?.attacker?.units ?? []) {
        if (u.type !== 'player') continue;
        const m = /^player-(\d+)$/.exec(String(u.id || ''));
        const characterId = m ? Number(m[1]) : null;
        if (!characterId || !Number.isFinite(characterId)) continue;
        const name = String(u.name || '').trim();
        if (name) playerNameByCharacterId.set(characterId, name);
      }

      const per = rewards.perPlayerRewards ?? [];
      if (Array.isArray(per) && per.length > 0) {
        const totalLine =
          participantCount > 1
            ? `【斗法所得】队伍共得 修为+${totalExp} 银两+${totalSilver}（${participantCount}人）`
            : `【斗法所得】修为+${totalExp} 银两+${totalSilver}`;
        const perLines = per
          .map((r) => {
            const name = playerNameByCharacterId.get(r.characterId) || `角色${r.characterId}`;
            const exp = Math.max(0, Math.floor(Number(r.exp) || 0));
            const silver = Math.max(0, Math.floor(Number(r.silver) || 0));
            return `【斗法所得】${name} 分得 修为+${exp} 银两+${silver}`;
          })
          .filter(Boolean);
        return [totalLine, ...perLines];
      }

      return [`【斗法所得】修为+${totalExp} 银两+${totalSilver}`];
    },
    [],
  );

  const buildDropLines = useCallback((state: BattleStateDto | null | undefined, rewards: BattleRewardsDto | null | undefined): string[] => {
    const items = rewards?.items ?? [];
    if (!state || items.length === 0) return [];

    const playerNameByCharacterId = new Map<number, string>();
    for (const u of state.teams?.attacker?.units ?? []) {
      if (u.type !== 'player') continue;
      const m = /^player-(\d+)$/.exec(String(u.id || ''));
      const characterId = m ? Number(m[1]) : null;
      if (!characterId || !Number.isFinite(characterId)) continue;
      const name = String(u.name || '').trim();
      if (name) playerNameByCharacterId.set(characterId, name);
    }

    return items
      .map((it) => {
        const receiverName = playerNameByCharacterId.get(it.receiverId) || `角色${it.receiverId}`;
        const itemName = String(it.name || it.itemDefId || '').trim();
        if (!itemName) return null;
        const qty = Math.max(1, Math.floor(Number(it.quantity) || 0));
        return `【战利分配】${receiverName} 取走 ${itemName}×${qty}`;
      })
      .filter((x): x is string => Boolean(x));
  }, []);

  const ensureBattleDropsAnnounced = useCallback(
    (state: BattleStateDto | null | undefined, rewards: BattleRewardsDto | null | undefined) => {
      const battleId = state?.battleId;
      if (!battleId) return;
      if (announcedBattleDropsIdRef.current === battleId) return;
      const lines = [...buildRewardSummaryLines(state, rewards), ...buildDropLines(state, rewards)];
      if (lines.length === 0) return;
      announcedBattleDropsIdRef.current = battleId;
      pushBattleLines(lines);
    },
    [buildDropLines, buildRewardSummaryLines, pushBattleLines],
  );

  const formatLogToLine = useCallback((log: BattleLogEntryDto): string | null => {
    if (!log) return null;
    if (log.type === 'round_start') {
      const title = pickVariant(`round_start:${log.round}`, [
        '斗法再起',
        '灵潮再涌',
        '战势重开',
        '气机复转',
        '真元再聚',
        '双方再度交锋',
        '法诀再鸣',
        '剑意复燃',
        '杀机再现',
        '战局续开',
        '灵压再起',
        '阵势重启',
      ]);
      return `——【第${log.round}回合】${title}——`;
    }
    if (log.type === 'round_end') {
      const title = pickVariant(`round_end:${log.round}`, [
        '回合落定',
        '攻守暂歇',
        '气机稍定',
        '双方收势',
        '余劲渐平',
        '战线暂稳',
        '法力回流',
        '杀势略缓',
        '招意既尽',
        '胜负未决',
        '场势稍静',
        '心法归位',
      ]);
      return `——【第${log.round}回合】${title}——`;
    }
    if (log.type === 'dot') {
      const damage = Math.floor(log.damage);
      const buffName = translateBuffName(log.buffName);
      return pickVariant(`dot:${log.round}:${log.unitId}:${log.buffName}:${damage}`, [
        `第${log.round}回合 ${log.unitName} 受【${buffName}】蚀体，气血-${damage}`,
        `第${log.round}回合 ${log.unitName} 遭【${buffName}】侵脉，损血-${damage}`,
        `第${log.round}回合 【${buffName}】反噬${log.unitName}，受创-${damage}`,
        `第${log.round}回合 ${log.unitName} 被【${buffName}】折磨，气血-${damage}`,
        `第${log.round}回合 ${log.unitName} 受【${buffName}】余劲灼身，损血-${damage}`,
        `第${log.round}回合 【${buffName}】持续发作，${log.unitName} 气血-${damage}`,
        `第${log.round}回合 ${log.unitName} 经脉受【${buffName}】牵制，受创-${damage}`,
        `第${log.round}回合 ${log.unitName} 被【${buffName}】缠身，气血-${damage}`,
        `第${log.round}回合 ${log.unitName} 遭【${buffName}】压迫，气机受损${damage}`,
        `第${log.round}回合 【${buffName}】侵蚀未止，${log.unitName} 气血再失${damage}`,
        `第${log.round}回合 ${log.unitName} 在【${buffName}】影响下伤势加重，气血-${damage}`,
        `第${log.round}回合 ${log.unitName} 受【${buffName}】牵引，血线下跌${damage}`,
      ]);
    }
    if (log.type === 'hot') {
      const heal = Math.floor(log.heal);
      const buffName = translateBuffName(log.buffName);
      return pickVariant(`hot:${log.round}:${log.unitId}:${log.buffName}:${heal}`, [
        `第${log.round}回合 ${log.unitName} 得【${buffName}】温养，气血+${heal}`,
        `第${log.round}回合 ${log.unitName} 受【${buffName}】回元，回春+${heal}`,
        `第${log.round}回合 ${log.unitName} 借【${buffName}】疗伤，调息+${heal}`,
        `第${log.round}回合 【${buffName}】生效，${log.unitName} 气血回升${heal}`,
        `第${log.round}回合 ${log.unitName} 在【${buffName}】护持下恢复${heal}点气血`,
        `第${log.round}回合 ${log.unitName} 受【${buffName}】滋养，回元+${heal}`,
        `第${log.round}回合 【${buffName}】持续修复，${log.unitName} 气血+${heal}`,
        `第${log.round}回合 ${log.unitName} 得【${buffName}】扶持，生机回复${heal}`,
        `第${log.round}回合 ${log.unitName} 藉由【${buffName}】稳住伤势，气血+${heal}`,
        `第${log.round}回合 ${log.unitName} 被【${buffName}】润养，血量回补${heal}`,
        `第${log.round}回合 ${log.unitName} 于【${buffName}】加持下疗伤${heal}`,
        `第${log.round}回合 ${log.unitName} 经【${buffName}】调理，气血回升${heal}`,
      ]);
    }
    if (log.type === 'buff_expire') {
      const buffName = translateBuffName(log.buffName);
      return pickVariant(`buff_expire:${log.round}:${log.unitId}:${log.buffName}`, [
        `第${log.round}回合 ${log.unitName} 身上的【${buffName}】灵效散去`,
        `第${log.round}回合 ${log.unitName} 的【${buffName}】加持消退`,
        `第${log.round}回合 ${log.unitName} 的【${buffName}】余韵尽散`,
        `第${log.round}回合 ${log.unitName} 失去【${buffName}】护持`,
        `第${log.round}回合 ${log.unitName} 身上的【${buffName}】到此为止`,
        `第${log.round}回合 ${log.unitName} 的【${buffName}】效果终止`,
        `第${log.round}回合 ${log.unitName} 的【${buffName}】已然消隐`,
        `第${log.round}回合 ${log.unitName} 与【${buffName}】的连结中断`,
        `第${log.round}回合 ${log.unitName} 身上的【${buffName}】彻底消散`,
        `第${log.round}回合 ${log.unitName} 体内【${buffName}】之力归于沉寂`,
        `第${log.round}回合 ${log.unitName} 再无【${buffName}】加持`,
        `第${log.round}回合 ${log.unitName} 的【${buffName}】光华褪尽`,
      ]);
    }
    if (log.type === 'death') {
      const killer = log.killerName?.trim();
      if (killer) {
        return pickVariant(`death-by:${log.round}:${log.unitId}:${killer}`, [
          `第${log.round}回合 ${log.unitName} 被 ${killer} 斩落`,
          `第${log.round}回合 ${log.unitName} 在 ${killer} 攻势下败退倒地`,
          `第${log.round}回合 ${log.unitName} 被 ${killer} 一式击溃`,
          `第${log.round}回合 ${log.unitName} 受 ${killer} 重击，失去战力`,
          `第${log.round}回合 ${log.unitName} 未挡住 ${killer} 的杀招，当场倒下`,
          `第${log.round}回合 ${log.unitName} 被 ${killer} 破开防线，颓然倒地`,
          `第${log.round}回合 ${log.unitName} 在 ${killer} 连招压制下力竭`,
          `第${log.round}回合 ${log.unitName} 被 ${killer} 当场击倒`,
          `第${log.round}回合 ${log.unitName} 遭 ${killer} 终结一击`,
          `第${log.round}回合 ${log.unitName} 不敌 ${killer}，战意尽失`,
          `第${log.round}回合 ${log.unitName} 被 ${killer} 逼至绝境后倒下`,
          `第${log.round}回合 ${log.unitName} 在 ${killer} 强压下彻底失势`,
        ]);
      }
      return pickVariant(`death-self:${log.round}:${log.unitId}`, [
        `第${log.round}回合 ${log.unitName} 灵力溃散，倒地不起`,
        `第${log.round}回合 ${log.unitName} 真元尽竭，失去战力`,
        `第${log.round}回合 ${log.unitName} 气机断续，难再起身`,
        `第${log.round}回合 ${log.unitName} 力竭而倒，无法再战`,
        `第${log.round}回合 ${log.unitName} 伤势过重，当场倒下`,
        `第${log.round}回合 ${log.unitName} 经脉紊乱，战斗不能`,
        `第${log.round}回合 ${log.unitName} 真气散乱，颓然倒地`,
        `第${log.round}回合 ${log.unitName} 失去支撑，已无再战之力`,
        `第${log.round}回合 ${log.unitName} 护体尽破，战线崩溃`,
        `第${log.round}回合 ${log.unitName} 气血见底，倒在阵前`,
        `第${log.round}回合 ${log.unitName} 战意与灵力同时告竭`,
        `第${log.round}回合 ${log.unitName} 再难维持身形，倒地不支`,
      ]);
    }
    if (log.type === 'action') {
      const targets = (log.targets ?? [])
        .map((t, index) => {
          const targetSeed = `${log.round}:${log.actorId}:${log.skillId}:${t.targetId}:${index}`;
          const pickTargetVariant = (kind: string, variants: readonly string[]) => pickVariant(`${targetSeed}:${kind}`, variants);
          const parts: string[] = [];
          if (t.isMiss) {
            parts.push(
              pickTargetVariant('miss', [
                '一击落空',
                '此击未中',
                '被身法避开',
                '擦身而过',
                '招式偏离要害',
                '闪身躲过',
                '被轻巧避过',
                '攻势未能命中',
                '出手扑空',
                '对手避其锋芒',
              ]),
            );
          }
          if (t.isParry) {
            parts.push(
              pickTargetVariant('parry', [
                '招式被格',
                '攻势被架开',
                '被对手卸去锋芒',
                '刀势被拦下',
                '出手被稳稳挡住',
                '攻击遭格挡',
                '被正面招架',
                '劲道被化开',
                '进攻被截断',
                '来势被封住',
              ]),
            );
          }
          if (t.isCrit) {
            parts.push(
              pickTargetVariant('crit', [
                '会心一击',
                '命中要害',
                '重击得手',
                '一击破势',
                '锐势贯体',
                '狠击入肉',
                '招式直中命门',
                '这一击尤为凶猛',
                '灵力暴发命中',
                '重招击实',
              ]),
            );
          }
          if (t.isElementBonus) {
            parts.push(
              pickTargetVariant('element', [
                '五行克制',
                '借五行之势占优',
                '属性压制',
                '行属相克',
                '灵根克制生效',
                '五行相胜',
                '对位相克',
                '属性优势显现',
                '克制之势成形',
                '五行压制到位',
              ]),
            );
          }
          if (t.controlResisted) {
            parts.push(
              pickTargetVariant('resist', [
                '稳住心神',
                '强行破开控制',
                '以灵识抗下',
                '定神抵住压制',
                '心法护住神台',
                '凭意志挣脱',
                '迅速稳住气机',
                '抗住控制冲击',
                '神识未乱',
                '化去控制之力',
              ]),
            );
          }
          if (t.controlApplied) {
            const controlName = translateControlName(t.controlApplied);
            parts.push(
              pickTargetVariant(`control:${controlName}`, [
                `受${controlName}`,
                `陷入${controlName}`,
                `被施以${controlName}`,
                `遭${controlName}束缚`,
                `身中${controlName}`,
                `状态转为${controlName}`,
                `被${controlName}命中`,
                `受${controlName}影响`,
                `当场进入${controlName}`,
                `行动受${controlName}牵制`,
              ]),
            );
          }
          if (t.shieldAbsorbed && t.shieldAbsorbed > 0) {
            const value = Math.floor(t.shieldAbsorbed);
            parts.push(
              pickTargetVariant(`shield:${value}`, [
                `护体化解${value}`,
                `护盾抵消${value}`,
                `罡气卸去${value}`,
                `外层护罩吸收${value}`,
                `护身灵光挡下${value}`,
                `护体真气吞掉${value}`,
                `护盾拦截${value}`,
                `守势化去${value}`,
                `防护层承受${value}`,
                `护身屏障吸纳${value}`,
              ]),
            );
          }
          if (t.damage && t.damage > 0) {
            const value = Math.floor(t.damage);
            parts.push(
              pickTargetVariant(`damage:${value}`, [
                `气血-${value}`,
                `受创-${value}`,
                `损血-${value}`,
                `伤势-${value}`,
                `血量下跌${value}`,
                `气机受损${value}`,
                `被打掉${value}点气血`,
                `这一击造成${value}伤害`,
                `受到${value}点伤害`,
                `身受${value}伤`,
              ]),
            );
          }
          if (t.heal && t.heal > 0) {
            const value = Math.floor(t.heal);
            parts.push(
              pickTargetVariant(`heal:${value}`, [
                `气血+${value}`,
                `回春+${value}`,
                `调息+${value}`,
                `回元+${value}`,
                `伤势恢复${value}`,
                `气血回升${value}`,
                `恢复${value}点气血`,
                `疗伤${value}`,
                `生机回复${value}`,
                `血量回补${value}`,
              ]),
            );
          }
          const buffsApplied = translateBuffNames(t.buffsApplied);
          if (buffsApplied.length > 0) {
            const value = buffsApplied.join('、');
            parts.push(
              pickTargetVariant(`buffsApplied:${value}`, [
                `得${value}`,
                `获${value}加持`,
                `身附${value}`,
                `气机转得${value}`,
                `增益转入${value}`,
                `被赋予${value}`,
                `状态获得${value}`,
                `身上新增${value}`,
                `受${value}护持`,
                `获得${value}效果`,
              ]),
            );
          }
          const buffsRemoved = translateBuffNames(t.buffsRemoved);
          if (buffsRemoved.length > 0) {
            const value = buffsRemoved.join('、');
            parts.push(
              pickTargetVariant(`buffsRemoved:${value}`, [
                `${value}被破`,
                `${value}散去`,
                `${value}遭驱散`,
                `${value}被化解`,
                `${value}已剥离`,
                `${value}不复存在`,
                `${value}被清除`,
                `${value}被打散`,
                `${value}效果终止`,
                `${value}被抹去`,
              ]),
            );
          }
          return parts.length > 0 ? `${t.targetName}（${parts.join('，')}）` : t.targetName;
        })
        .filter(Boolean);
      const actionHead = pickVariant(`action-head:${log.round}:${log.actorId}:${log.skillId}`, [
        `第${log.round}回合 ${log.actorName} 掐诀施展【${log.skillName}】`,
        `第${log.round}回合 ${log.actorName} 运转灵力，催动【${log.skillName}】`,
        `第${log.round}回合 ${log.actorName} 起手一式【${log.skillName}】`,
        `第${log.round}回合 ${log.actorName} 法诀既成，放出【${log.skillName}】`,
        `第${log.round}回合 ${log.actorName} 真元奔涌，祭出【${log.skillName}】`,
        `第${log.round}回合 ${log.actorName} 借势发招【${log.skillName}】`,
        `第${log.round}回合 ${log.actorName} 掌心凝光，施放【${log.skillName}】`,
        `第${log.round}回合 ${log.actorName} 凝神出手，催发【${log.skillName}】`,
        `第${log.round}回合 ${log.actorName} 灵力激荡，打出【${log.skillName}】`,
        `第${log.round}回合 ${log.actorName} 顺势追击，施展【${log.skillName}】`,
        `第${log.round}回合 ${log.actorName} 心法流转，贯出【${log.skillName}】`,
        `第${log.round}回合 ${log.actorName} 借阵势之力，引动【${log.skillName}】`,
      ]);
      if (targets.length === 0) return actionHead;
      const targetPrefix = pickVariant(`action-target:${log.round}:${log.actorId}:${log.skillId}`, [
        '波及',
        '直取',
        '劲势扫向',
        '杀机锁定',
        '锋芒压向',
        '灵压笼罩',
        '气劲直逼',
        '招意覆盖',
        '攻势席卷',
        '当头落向',
        '余波震向',
        '法势倾轧向',
      ]);
      return `${actionHead}，${targetPrefix} ${targets.join('；')}`;
    }
    return null;
  }, []);

  const formatNewLogs = useCallback(
    (prevIndex: number, nextLogs: BattleLogEntryDto[]) => {
      if (!Array.isArray(nextLogs) || nextLogs.length === 0) return [];
      const safePrev = Math.max(0, Math.min(prevIndex, nextLogs.length));
      return nextLogs
        .slice(safePrev)
        .map((log) => formatLogToLine(log))
        .filter((x): x is string => Boolean(x && x.trim()));
    },
    [formatLogToLine],
  );

  const ensureBattleStartAnnounced = useCallback(
    (state: BattleStateDto) => {
      if (!state?.battleId) return;
      if (announcedBattleIdRef.current === state.battleId) return;
      announcedBattleIdRef.current = state.battleId;
      announcedBattleEndIdRef.current = null;
      announcedBattleDropsIdRef.current = null;
      announcedAutoNextBattleIdRef.current = null;
      lastChatLogIndexRef.current = 0;

      const attacker = state.teams?.attacker?.units ?? [];
      const defender = state.teams?.defender?.units ?? [];
      const attackerText = attacker.map((u) => u.name).filter(Boolean).join('、') || '未知';
      const defenderText = defender.map((u) => u.name).filter(Boolean).join('、') || '未知';
      const playerCount = attacker.filter((u) => u.type === 'player').length;
      const teamHint = playerCount > 1 ? `（同门${playerCount}人）` : '';
      pushBattleLines([`【斗法开启】我方：${attackerText}；敌方：${defenderText}${teamHint}`]);
    },
    [pushBattleLines],
  );

  const ensureBattleEndAnnounced = useCallback(
    (state: BattleStateDto) => {
      if (!state?.battleId) return;
      if (state.phase !== 'finished') return;
      if (announcedBattleEndIdRef.current === state.battleId) return;
      announcedBattleEndIdRef.current = state.battleId;
      const resultText =
        state.result === 'attacker_win' ? '得胜' : state.result === 'defender_win' ? '落败' : state.result === 'draw' ? '平局' : '落幕';
      const attackerAlive = (state.teams?.attacker?.units ?? []).filter((u) => u.isAlive).map((u) => u.name).filter(Boolean).join('、');
      const defenderAlive = (state.teams?.defender?.units ?? []).filter((u) => u.isAlive).map((u) => u.name).filter(Boolean).join('、');
      const aliveText = `我方尚存：${attackerAlive || '无'}；敌方尚存：${defenderAlive || '无'}`;
      pushBattleLines([`【斗法落幕】${resultText}，历经${state.roundCount}回合；${aliveText}`]);
    },
    [pushBattleLines],
  );

  const addFloat = useCallback((unitId: string, value: number) => {
    const id = createFloatId();
    const dx = clamp((Math.random() - 0.5) * 26, -13, 13);
    const createdAt = Date.now();
    setFloats((prev) => [...prev, { id, unitId, value, dx, createdAt }]);
    const t = window.setTimeout(() => {
      floatTimerSetRef.current.delete(t);
      setFloats((prev) => prev.filter((f) => f.id !== id));
    }, 800);
    floatTimerSetRef.current.add(t);
  }, []);

  useEffect(() => {
    return () => {
      clearFloatTimers();
      clearAutoNextTimer();
    };
  }, [clearAutoNextTimer, clearFloatTimers]);

  const applyLogsToFloats = useCallback(
    (prevIndex: number, nextLogs: BattleLogEntryDto[]) => {
      if (!Array.isArray(nextLogs) || nextLogs.length === 0) return;
      const slice = nextLogs.slice(Math.max(0, prevIndex));
      for (const log of slice) {
        if (log.type === 'action') {
          for (const t of log.targets ?? []) {
            if (t.damage && t.damage > 0) addFloat(t.targetId, -Math.floor(t.damage));
            if (t.heal && t.heal > 0) addFloat(t.targetId, Math.floor(t.heal));
          }
        } else if (log.type === 'dot') {
          if (log.damage > 0) addFloat(log.unitId, -Math.floor(log.damage));
        } else if (log.type === 'hot') {
          if (log.heal > 0) addFloat(log.unitId, Math.floor(log.heal));
        }
      }
    },
    [addFloat],
  );

  const startBattle = useCallback(
    async (monsterIds: string[]): Promise<void> => {
      if (startingBattleRef.current) return;
      startingBattleRef.current = true;
      clearAutoNextTimer();

      setSelectedEnemyId(null);
      clearFloatTimers();
      setFloats([]);
      lastLogIndexRef.current = 0;
      lastChatLogIndexRef.current = 0;
      announcedBattleIdRef.current = null;
      announcedBattleEndIdRef.current = null;
      announcedBattleDropsIdRef.current = null;
      announcedAutoNextBattleIdRef.current = null;
      setIsTeamBattle(false);
      setTeamMemberCount(1);

      if (monsterIds.length === 0) {
        setBattleId(null);
        setBattleState(null);
        setResult('idle');
        pushBattleLines(['【战斗结束】战斗取消']);
        startingBattleRef.current = false;
        return;
      }

      try {
        const res = await startPVEBattle(monsterIds);
        if (!res?.success || !res.data?.battleId || !res.data?.state) {
          message.error(res?.message || '战斗发起失败');
          setBattleId(null);
          setBattleState(null);
          setResult('idle');
          startingBattleRef.current = false;
          return;
        }
        setBattleId(res.data.battleId);
        setBattleState(res.data.state);
        setIsTeamBattle(res.data.isTeamBattle ?? false);
        setTeamMemberCount(res.data.teamMemberCount ?? 1);
        lastLogIndexRef.current = res.data.state.logs?.length ?? 0;
        ensureBattleStartAnnounced(res.data.state);
        const nextLines = formatNewLogs(lastChatLogIndexRef.current, res.data.state.logs ?? []);
        lastChatLogIndexRef.current = res.data.state.logs?.length ?? lastChatLogIndexRef.current;
        pushBattleLines(nextLines);
        ensureBattleEndAnnounced(res.data.state);
        const nextResult: BattleResult =
          res.data.state.phase === 'finished'
            ? res.data.state.result === 'attacker_win'
              ? 'win'
              : res.data.state.result === 'defender_win'
                ? 'lose'
                : 'draw'
            : 'running';
        setResult(nextResult);
      } catch (e) {
        message.error((e as { message?: string })?.message || '战斗发起失败');
        setBattleId(null);
        setBattleState(null);
        setResult('idle');
        pushBattleLines(['【战斗结束】战斗发起失败']);
      } finally {
        startingBattleRef.current = false;
      }
    },
    [clearAutoNextTimer, clearFloatTimers, ensureBattleEndAnnounced, ensureBattleStartAnnounced, formatNewLogs, message, pushBattleLines],
  );

  useEffect(() => {
    if (resolvedExternalBattleId) return;
    const firstMonster = (enemies ?? []).find((u) => u.id.startsWith('monster-'))?.id ?? '';
    const rawMonsterId = firstMonster.startsWith('monster-') ? firstMonster.slice('monster-'.length) : '';
    const baseMonsterId = rawMonsterId.split('-敌')[0]?.trim() ?? '';
    const monsterIds = baseMonsterId ? [baseMonsterId] : [];
    lastMonsterIdsRef.current = monsterIds;
    void startBattle(monsterIds);
  }, [enemies, resolvedExternalBattleId, startBattle]);

  useEffect(() => {
    if (!resolvedExternalBattleId) return;
    if (battleIdRef.current === resolvedExternalBattleId) return;
    clearAutoNextTimer();
    clearFloatTimers();
    setFloats([]);
    lastLogIndexRef.current = 0;
    lastChatLogIndexRef.current = 0;
    announcedBattleIdRef.current = null;
    announcedBattleEndIdRef.current = null;
    announcedBattleDropsIdRef.current = null;
    announcedAutoNextBattleIdRef.current = null;
    setSelectedEnemyId(null);
    setIsTeamBattle(false);
    setTeamMemberCount(1);
    setBattleId(resolvedExternalBattleId);
    setBattleState(null);
    setResult('running');
    void (async () => {
      const res = await getBattleState(resolvedExternalBattleId);
      if (!res?.success || !res.data?.state) return;
      const teamInfo = calcTeamInfoFromState(res.data.state);
      setIsTeamBattle(teamInfo.isTeamBattle);
      setTeamMemberCount(teamInfo.teamMemberCount);
      lastLogIndexRef.current = res.data.state.logs?.length ?? 0;
      ensureBattleStartAnnounced(res.data.state);
      const nextLines = formatNewLogs(lastChatLogIndexRef.current, res.data.state.logs ?? []);
      lastChatLogIndexRef.current = res.data.state.logs?.length ?? lastChatLogIndexRef.current;
      pushBattleLines(nextLines);
      ensureBattleEndAnnounced(res.data.state);
      ensureBattleDropsAnnounced(res.data.state, res.data.rewards ?? null);
      setBattleState(res.data.state);
    })();
  }, [
    clearAutoNextTimer,
    clearFloatTimers,
    ensureBattleDropsAnnounced,
    ensureBattleEndAnnounced,
    ensureBattleStartAnnounced,
    formatNewLogs,
    pushBattleLines,
    resolvedExternalBattleId,
  ]);

  useEffect(() => {
    if (!battleState) return;
    const nextResult: BattleResult =
      battleState.phase === 'finished'
        ? battleState.result === 'attacker_win'
          ? 'win'
          : battleState.result === 'defender_win'
            ? 'lose'
            : 'draw'
        : 'running';
    setResult(nextResult);
  }, [battleState]);

  useEffect(() => {
    if (!resolvedAllowAutoNext) return;
    if (!battleState || battleState.phase !== 'finished') {
      clearAutoNextTimer();
      announcedAutoNextBattleIdRef.current = null;
      return;
    }
    const currentBattleId = battleId;
    if (!currentBattleId) return;

    if (announcedAutoNextBattleIdRef.current === currentBattleId) return;
    announcedAutoNextBattleIdRef.current = currentBattleId;
    clearAutoNextTimer();
    if (onNext) {
      message.info('战斗结束，等待2秒后继续推进', 2);
      autoNextTimerRef.current = window.setTimeout(() => {
        if (battleIdRef.current !== currentBattleId) return;
        if (nextingRef.current) return;
        nextingRef.current = true;
        setNexting(true);
        Promise.resolve()
          .then(() => onNext())
          .finally(() => {
            nextingRef.current = false;
            setNexting(false);
          });
      }, 2000);
      return;
    }

    if (resolvedExternalBattleId) return;

    message.info('战斗结束，等待3秒后开启下一场', 3);
    autoNextTimerRef.current = window.setTimeout(() => {
      if (battleIdRef.current !== currentBattleId) return;
      void startBattle(lastMonsterIdsRef.current);
    }, 3000);
  }, [battleId, battleState, clearAutoNextTimer, message, onNext, resolvedAllowAutoNext, resolvedExternalBattleId, startBattle]);

  const pollBattleState = useCallback(async () => {
    const id = battleIdRef.current;
    if (!id) return;
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const res = await getBattleState(id);
      if (!res?.success || !res.data?.state) return;
      const next = res.data.state;
      const current = battleStateRef.current;
      if (!isNewerBattleState(next, current)) return;
      const prevIndex = lastLogIndexRef.current;
      applyLogsToFloats(prevIndex, next.logs ?? []);
      lastLogIndexRef.current = next.logs?.length ?? prevIndex;
      ensureBattleStartAnnounced(next);
      const prevChatIndex = lastChatLogIndexRef.current;
      const nextLines = formatNewLogs(prevChatIndex, next.logs ?? []);
      lastChatLogIndexRef.current = next.logs?.length ?? prevChatIndex;
      pushBattleLines(nextLines);
      ensureBattleEndAnnounced(next);
      ensureBattleDropsAnnounced(next, res.data.rewards ?? null);
      setBattleState(next);
      const teamInfo = calcTeamInfoFromState(next);
      setIsTeamBattle(teamInfo.isTeamBattle);
      setTeamMemberCount(teamInfo.teamMemberCount);
    } finally {
      pollInFlightRef.current = false;
    }
  }, [applyLogsToFloats, ensureBattleDropsAnnounced, ensureBattleEndAnnounced, ensureBattleStartAnnounced, formatNewLogs, pushBattleLines]);

  useEffect(() => {
    if (!battleId) return;
    if (battleState?.phase === 'finished') return;
    let running = true;
    const t = window.setInterval(() => {
      if (!running) return;
      if (Date.now() - lastSocketBattleUpdateAtRef.current < 2000) return;
      void pollBattleState();
    }, 3000);
    return () => {
      running = false;
      window.clearInterval(t);
    };
  }, [battleId, battleState?.phase, pollBattleState]);

  useEffect(() => {
    gameSocket.connect();
    const unsub = gameSocket.onBattleUpdate((raw) => {
      const data = raw as {
        kind?: unknown;
        battleId?: unknown;
        state?: BattleStateDto;
        rewards?: BattleRewardsDto | null;
        data?: { state?: BattleStateDto; rewards?: BattleRewardsDto } | null;
        logStart?: unknown;
        logDelta?: unknown;
      };
      const kind = String(data?.kind || '');
      const incomingBattleId = String(data?.battleId || '');
      const currentId = battleIdRef.current;
      if (!incomingBattleId) return;
      if (currentId && incomingBattleId !== currentId) return;
      lastSocketBattleUpdateAtRef.current = Date.now();

      if (kind === 'battle_started' && !currentId) {
        setBattleId(incomingBattleId);
        const nextState = data?.state as BattleStateDto | undefined;
        if (nextState) {
          lastChatLogIndexRef.current = 0;
          announcedBattleIdRef.current = null;
          announcedBattleEndIdRef.current = null;
          announcedBattleDropsIdRef.current = null;
          lastLogIndexRef.current = nextState.logs?.length ?? 0;
          ensureBattleStartAnnounced(nextState);
          const nextLines = formatNewLogs(lastChatLogIndexRef.current, nextState.logs ?? []);
          lastChatLogIndexRef.current = nextState.logs?.length ?? lastChatLogIndexRef.current;
          pushBattleLines(nextLines);
          ensureBattleEndAnnounced(nextState);
          setBattleState(nextState);
          const teamInfo = calcTeamInfoFromState(nextState);
          setIsTeamBattle(teamInfo.isTeamBattle);
          setTeamMemberCount(teamInfo.teamMemberCount);
        }
        return;
      }

      if (kind === 'battle_state') {
        let next = data?.state as BattleStateDto | undefined;
        if (!next) return;
        const current = battleStateRef.current;
        const logDelta = Boolean(data?.logDelta);
        const logStart = Math.floor(Number(data?.logStart));
        if (logDelta && Number.isFinite(logStart) && logStart >= 0) {
          const currentLogs = current?.logs ?? [];
          const deltaLogs = next.logs ?? [];
          const baseLogs = currentLogs.length >= logStart ? currentLogs.slice(0, logStart) : currentLogs;
          const mergedLogs = baseLogs.concat(deltaLogs);
          next = { ...next, logs: mergedLogs };
        }

        if (!isNewerBattleState(next, current)) return;
        const prevIndex = lastLogIndexRef.current;
        applyLogsToFloats(prevIndex, next.logs ?? []);
        lastLogIndexRef.current = next.logs?.length ?? prevIndex;
        ensureBattleStartAnnounced(next);
        const prevChatIndex = lastChatLogIndexRef.current;
        const nextLines = formatNewLogs(prevChatIndex, next.logs ?? []);
        lastChatLogIndexRef.current = next.logs?.length ?? prevChatIndex;
        pushBattleLines(nextLines);
        ensureBattleEndAnnounced(next);
        setBattleState(next);
        const teamInfo = calcTeamInfoFromState(next);
        setIsTeamBattle(teamInfo.isTeamBattle);
        setTeamMemberCount(teamInfo.teamMemberCount);
        return;
      }

      if (kind === 'battle_finished') {
        const rewards = data?.data?.rewards ?? data?.rewards ?? null;
        const next = (data?.data?.state || data?.state) as BattleStateDto | undefined;
        if (next) {
          const current = battleStateRef.current;
          if (!isNewerBattleState(next, current)) return;
          ensureBattleStartAnnounced(next);
          const prevChatIndex = lastChatLogIndexRef.current;
          const nextLines = formatNewLogs(prevChatIndex, next.logs ?? []);
          lastChatLogIndexRef.current = next.logs?.length ?? prevChatIndex;
          pushBattleLines(nextLines);
          ensureBattleEndAnnounced(next);
          ensureBattleDropsAnnounced(next, rewards);
          setBattleState(next);
          const teamInfo = calcTeamInfoFromState(next);
          setIsTeamBattle(teamInfo.isTeamBattle);
          setTeamMemberCount(teamInfo.teamMemberCount);
        }
        return;
      }

      if (kind === 'battle_abandoned') {
        if (announcedBattleEndIdRef.current !== incomingBattleId) {
          announcedBattleEndIdRef.current = incomingBattleId;
          pushBattleLines(['【斗法落幕】已遁离战场']);
        }
        setBattleId(null);
        setBattleState(null);
        setResult('idle');
        return;
      }
    });
    return () => unsub();
  }, [applyLogsToFloats, ensureBattleDropsAnnounced, ensureBattleEndAnnounced, ensureBattleStartAnnounced, formatNewLogs, pushBattleLines]);

  const activeUnitId = useMemo(() => getCurrentUnitId(battleState), [battleState]);
  const turnCount = battleState?.roundCount ?? 0;
  const turnSide: 'enemy' | 'ally' = battleState?.currentTeam === 'defender' ? 'enemy' : 'ally';
  const actionKey = useMemo(() => {
    if (!battleState) return 'idle';
    return `${battleState.battleId}-${battleState.roundCount}-${battleState.currentTeam}-${battleState.currentUnitIndex}-${activeUnitId ?? ''}`;
  }, [activeUnitId, battleState]);

  useEffect(() => {
    onTurnChange?.(turnCount, turnSide, actionKey, activeUnitId);
  }, [actionKey, activeUnitId, onTurnChange, turnCount, turnSide]);

  const enemyUnits = useMemo(() => {
    const units = battleState?.teams?.defender?.units ?? [];
    return units.map((u) => toClientUnit(u));
  }, [battleState]);

  const allyUnits = useMemo(() => {
    const units = battleState?.teams?.attacker?.units ?? [];
    return units.map((u) => toClientUnit(u));
  }, [battleState]);

  const enemyAliveCount = useMemo(() => pickAlive(enemyUnits).length, [enemyUnits]);
  const allyAliveCount = useMemo(() => pickAlive(allyUnits).length, [allyUnits]);

  const statusText = useMemo(() => {
    const teamTag = isTeamBattle ? `[组队${teamMemberCount}人] ` : '';
    const base = `${teamTag}敌方 ${enemyAliveCount}/${enemyUnits.length} · 我方 ${allyAliveCount}/${allyUnits.length}`;
    const sideText = turnSide === 'enemy' ? '敌方行动' : '我方行动';
    if (result === 'running') return `${base} · ${sideText}`;
    if (result === 'win') return `${base} · ${sideText} · 胜利`;
    if (result === 'lose') return `${base} · ${sideText} · 失败`;
    if (result === 'draw') return `${base} · ${sideText} · 平局`;
    return '等待目标';
  }, [allyAliveCount, allyUnits.length, enemyAliveCount, enemyUnits.length, isTeamBattle, result, teamMemberCount, turnSide]);

  const handleEscape = useCallback(() => {
    const id = battleIdRef.current;
    if (id) {
      void abandonBattle(id);
    }
    if (id && announcedBattleEndIdRef.current !== id) {
      announcedBattleEndIdRef.current = id;
      pushBattleLines(['【战斗结束】已撤退']);
    }
    clearAutoNextTimer();
    setBattleId(null);
    setBattleState(null);
    setResult('idle');
    setIsTeamBattle(false);
    setTeamMemberCount(1);
    lastLogIndexRef.current = 0;
    lastChatLogIndexRef.current = 0;
    announcedBattleIdRef.current = null;
    announcedBattleEndIdRef.current = id ?? null;
    announcedBattleDropsIdRef.current = id ?? null;
    announcedAutoNextBattleIdRef.current = id ?? null;
    onEscape?.();
  }, [clearAutoNextTimer, onEscape, pushBattleLines]);

  const handleNext = useCallback(async () => {
    if (!onNext) return;
    if (nexting) return;
    setNexting(true);
    try {
      await onNext();
    } finally {
      setNexting(false);
    }
  }, [nexting, onNext]);

  const castSkill = useCallback(
    async (skillId: string, targetType?: string): Promise<boolean> => {
      const id = battleIdRef.current;
      const state = battleStateRef.current;
      if (!id || !state) return false;
      if (state.phase === 'finished') return false;
      if (state.currentTeam !== 'attacker') return false;
      const currentUnitId = getCurrentUnitId(state);
      if (!currentUnitId) return false;
      const myCharacterId = gameSocket.getCharacter()?.id;
      if (!myCharacterId) return false;
      if (currentUnitId !== `player-${myCharacterId}`) return false;
      const currentUnit = (state.teams.attacker.units ?? []).find((u) => u.id === currentUnitId);
      if (!currentUnit || currentUnit.type !== 'player') return false;

      const aliveEnemyIds = (state.teams.defender.units ?? []).filter((u) => u.isAlive).map((u) => u.id);
      const aliveAllyIds = (state.teams.attacker.units ?? []).filter((u) => u.isAlive).map((u) => u.id);

      const tt = String(targetType ?? '').trim();
      let targets: string[] = [];
      if (tt === 'self') {
        targets = [currentUnitId];
      } else if (tt === 'single_ally') {
        const picked = selectedAllyId && aliveAllyIds.includes(selectedAllyId) ? selectedAllyId : aliveAllyIds[0];
        if (!picked) return false;
        targets = [picked];
      } else if (tt === 'all_ally' || tt === 'random_ally') {
        targets = [];
      } else if (tt === 'all_enemy' || tt === 'random_enemy') {
        targets = [];
      } else {
        const picked = selectedEnemyId && aliveEnemyIds.includes(selectedEnemyId) ? selectedEnemyId : aliveEnemyIds[0];
        if (!picked) return false;
        targets = [picked];
      }

      const actualSkillId = skillId === 'basic_attack' ? 'skill-normal-attack' : skillId;
      const res = await battleAction(id, actualSkillId, targets);
      if (!res?.success || !res.data?.state) {
        if (isTransientBattleActionError(res?.message)) {
          // 自动战斗/组队并发时可能命中旧回合或旧目标，静默刷新状态即可。
          void pollBattleState();
          return false;
        }
        message.error(res?.message || '释放失败');
        return false;
      }
      const next = res.data.state;
      const prevIndex = lastLogIndexRef.current;
      applyLogsToFloats(prevIndex, next.logs ?? []);
      lastLogIndexRef.current = next.logs?.length ?? prevIndex;
      ensureBattleStartAnnounced(next);
      const prevChatIndex = lastChatLogIndexRef.current;
      const nextLines = formatNewLogs(prevChatIndex, next.logs ?? []);
      lastChatLogIndexRef.current = next.logs?.length ?? prevChatIndex;
      pushBattleLines(nextLines);
      ensureBattleEndAnnounced(next);
      ensureBattleDropsAnnounced(next, res.data.rewards ?? null);
      setBattleState(next);
      const nextMe = (next.teams?.attacker?.units ?? []).find((u) => u.id === currentUnitId);
      if (nextMe) {
        gameSocket.updateCharacterLocal({
          lingqi: Number(nextMe.lingqi) || 0,
          qixue: Number(nextMe.qixue) || 0,
          maxLingqi: Number(nextMe.currentAttrs?.max_lingqi) || 0,
          maxQixue: Number(nextMe.currentAttrs?.max_qixue) || 0,
        });
      }
      return true;
    },
    [
      applyLogsToFloats,
      ensureBattleDropsAnnounced,
      ensureBattleEndAnnounced,
      ensureBattleStartAnnounced,
      formatNewLogs,
      message,
      pollBattleState,
      pushBattleLines,
      selectedAllyId,
      selectedEnemyId,
    ],
  );

  useEffect(() => {
    if (!onBindSkillCaster) return;
    onBindSkillCaster(castSkill);
    return () => {
      onBindSkillCaster(async () => false);
    };
  }, [castSkill, onBindSkillCaster]);

  const floatsByUnit = useMemo(() => {
    const now = Date.now();
    const valid = floats.filter((f) => now - f.createdAt < 1200);
    const map: Record<string, FloatText[]> = {};
    valid.forEach((f) => {
      (map[f.unitId] ||= []).push(f);
    });
    return map;
  }, [floats]);

  return (
    <div className="battle-area">
      <div className="battle-area-topbar">
        <div className="battle-top-left">
          <div className="battle-top-round">回合数：{turnCount}</div>
          <div className="battle-top-status">战斗情况：{statusText}</div>
        </div>
        <div className="battle-top-right">
          {battleState?.phase === 'finished' && onNext ? (
            <Button size="small" type="primary" loading={nexting} onClick={handleNext}>
              {nextLabel || '继续'}
            </Button>
          ) : null}
          {onEscape ? (
            <Button size="small" onClick={handleEscape}>
              逃跑
            </Button>
          ) : null}
        </div>
      </div>

      <div className="battle-area-panels">
        <section className="battle-panel battle-panel-enemy">
          <div className="battle-panel-inner">
            <div className="battle-units">
              {(enemyUnits ?? []).map((u) => (
                <UnitCard
                  key={u.id}
                  unit={u}
                  active={activeUnitId === u.id}
                  selected={selectedEnemyId === u.id}
                  floats={floatsByUnit[u.id]}
                  onClick={() => setSelectedEnemyId((prev) => (prev === u.id ? null : u.id))}
                />
              ))}
              {(enemyUnits ?? []).length === 0 ? <div className="battle-empty">暂无敌方目标</div> : null}
            </div>
          </div>
        </section>

        <div className="battle-divider" />

        <section className="battle-panel battle-panel-ally">
          <div className="battle-panel-inner">
            <div className="battle-units">
              {(allyUnits ?? []).map((u) => (
                <UnitCard
                  key={u.id}
                  unit={u}
                  active={activeUnitId === u.id}
                  selected={selectedAllyId === u.id}
                  floats={floatsByUnit[u.id]}
                  onClick={() => setSelectedAllyId((prev) => (prev === u.id ? null : u.id))}
                />
              ))}
              {(allyUnits ?? []).length === 0 ? <div className="battle-empty">暂无我方单位</div> : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default BattleArea;
