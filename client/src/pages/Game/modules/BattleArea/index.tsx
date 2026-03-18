import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { App, Button, Tag } from 'antd';
import {
  abandonBattle,
  battleAction,
  getBattleState,
  getUnifiedApiErrorMessage,
  toUnifiedApiError,
  startPVEBattle,
  type BattleStartResponse,
  type BattleLogEntryDto,
  type BattleRewardsDto,
  type BattleStateDto,
} from '../../../../services/api';
import { gameSocket } from '../../../../services/gameSocket';
import {
  FAST_BATTLE_LOG_SYSTEM_LINES,
  buildBattleEndLineFast,
  buildBattleStartLineFast,
  buildDropLinesFast,
  buildRewardSummaryLinesFast,
  formatBattleLogLineFast,
} from './logFormatterFast';
import {
  resolveLocalBattleMonsterIds,
  shouldAutoStartLocalBattle,
} from './localStartResolver';
import { resolveFinishedBattleAdvanceMode } from './autoNextPolicy';
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
  /**
   * 是否允许 BattleArea 在无 externalBattleId 时走本地 PVE 自动开战流程。
   * - true：根据 enemies 自动调用 startPVEBattle（普通地图怪物攻击场景）。
   * - false：禁止本地自动开战，仅等待 externalBattleId（秘境/竞技场/重连场景）。
   */
  allowLocalStart: boolean;
  onEscape?: () => void;
  onTurnChange?: (turnCount: number, turnSide: 'enemy' | 'ally', actionKey: string, activeUnitId: string | null, phase: string | null) => void;
  onBindSkillCaster?: (caster: (skillId: string, targetType?: string) => Promise<boolean>) => void;
  externalBattleId?: string | null;
  allowAutoNext?: boolean;
  onAppendBattleLines?: (lines: string[]) => void;
  onNext?: () => Promise<void>;
  nextLabel?: string;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const DEFAULT_BATTLE_START_COOLDOWN_MS = 3000;

/**
 * 低于此阈值的 retryAfterMs 视为"无意义冷却"，直接静默重试，不显示冷却提示。
 * 场景：auto-next 定时器触发 startBattle 时，客户端计时精度/网络延迟导致服务端冷却
 * 仅剩极小时间（如 50ms），此时显示"冷却中，0.05秒后自动重试"没有实际意义。
 */
const MINIMUM_MEANINGFUL_COOLDOWN_DISPLAY_MS = 200;

const toPositiveInt = (value: unknown): number | null => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

type BattleCooldownMetaLike = {
  battleStartCooldownMs?: unknown;
  retryAfterMs?: unknown;
  nextBattleAvailableAt?: unknown;
};

type StartBattleOptions = {
  retryOnCooldown?: boolean;
  silentCooldown?: boolean;
};

type BattleTeamMeta = {
  isTeamBattle?: boolean;
  teamMemberCount?: number;
};

type BattleStartFailurePayload = BattleStartResponse['data'];

const getBattleStartFailurePayload = (
  error: ReturnType<typeof toUnifiedApiError>,
): BattleStartFailurePayload | null => {
  const raw = error.raw;
  if (!raw || typeof raw !== 'object') return null;
  const response = (raw as { response?: { data?: { data?: BattleStartFailurePayload } } }).response;
  const payload = response?.data?.data;
  if (!payload || typeof payload !== 'object') return null;
  return payload;
};

const toPercent = (value: number, total: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return clamp((value / total) * 100, 0, 100);
};

type BattleResult = 'idle' | 'running' | 'win' | 'lose' | 'draw';
type BattleStartupStatus = 'none' | 'preparing' | 'cooldown';
type FloatText = { id: string; unitId: string; value: number; dx: number; createdAt: number };

let floatIdSeed = 0;
const createFloatId = () => {
  floatIdSeed += 1;
  return `float-${Date.now()}-${floatIdSeed}`;
};
const FLOAT_DX_PATTERN = [-10, -5, 0, 5, 10] as const;

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
  type: 'player' | 'monster' | 'npc' | 'summon' | 'partner';
}): BattleUnit => {
  return {
    id: u.id,
    name: u.name,
    tag: u.currentAttrs?.realm || (u.type === 'monster' ? '凡兽' : u.type === 'partner' ? '伙伴' : '凡人'),
    hp: Number(u.qixue) || 0,
    maxHp: Number(u.currentAttrs?.max_qixue) || 0,
    qi: Number(u.lingqi) || 0,
    maxQi: Number(u.currentAttrs?.max_lingqi) || 0,
    isPlayer: u.type === 'player',
  };
};

const getCurrentUnitId = (state: BattleStateDto | null): string | null => {
  if (!state) return null;
  // 直接读服务端维护的 currentUnitId，不再用下标推算，避免客户端与服务端状态不一致
  return state.currentUnitId ?? null;
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

  const nextIndex = next.currentUnitId ?? '';
  const currentIndex = current.currentUnitId ?? '';
  if (nextIndex !== currentIndex) return true;

  const nextTeam = String(next.currentTeam || '');
  const currentTeam = String(current.currentTeam || '');
  if (nextTeam !== currentTeam) return true;
  return false;
};

const TRANSIENT_BATTLE_ACTION_ERRORS = new Set([
  '当前不是玩家行动回合',
  '不是玩家方的回合',
  '不是该单位的行动回合',
  '被控制无法使用技能',
  '目标不是有效的敌方单位',
  '目标不是有效的友方单位',
]);

const SILENT_BATTLE_ACTION_REQUEST_CONFIG = { meta: { autoErrorToast: false } } as const;
const SILENT_BATTLE_START_REQUEST_CONFIG = { meta: { autoErrorToast: false } } as const;

const isTransientBattleActionError = (msg: unknown): boolean => {
  const text = String(msg ?? '').trim();
  if (!text) return false;
  if (TRANSIENT_BATTLE_ACTION_ERRORS.has(text)) return true;
  // 战斗结束瞬间 auto-release 可能命中服务端技能冷却检查，属于瞬态错误
  return text.includes('目标不是有效的') || text.includes('行动回合') || text.includes('冷却中');
};

const isBattleMissingError = (msg: unknown): boolean => {
  const text = String(msg ?? '').trim();
  return text === '战斗不存在' || text === '战斗不存在或已结束';
};

const canAutoRestartMissingLocalBattle = (params: {
  allowLocalStart: boolean;
  externalBattleId: string | null;
  allowAutoNext: boolean;
  finishedBattleAdvanceMode: ReturnType<typeof resolveFinishedBattleAdvanceMode>;
  monsterIds: string[];
  lastKnownBattleState: BattleStateDto | null;
}): boolean => {
  if (!params.allowLocalStart) return false;
  if (params.externalBattleId) return false;
  if (!params.allowAutoNext) return false;
  if (params.finishedBattleAdvanceMode !== 'use_local_retry') return false;
  if (params.monsterIds.length <= 0) return false;
  return params.lastKnownBattleState?.phase === 'finished'
    && params.lastKnownBattleState.result === 'attacker_win';
};

const canAdoptIncomingStartedBattle = (
  currentBattleId: string | null,
  currentBattleState: BattleStateDto | null,
  incomingBattleId: string,
): boolean => {
  if (!incomingBattleId) return false;
  if (!currentBattleId) return true;
  if (incomingBattleId === currentBattleId) return true;
  return currentBattleState?.phase === 'finished';
};

const BattleArea: React.FC<BattleAreaProps> = ({
  enemies,
  allowLocalStart,
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
  const finishedBattleAdvanceMode = useMemo(
    () => resolveFinishedBattleAdvanceMode({
      externalBattleId: resolvedExternalBattleId,
      hasOnNext: typeof onNext === 'function',
    }),
    [onNext, resolvedExternalBattleId],
  );
  const [battleState, setBattleState] = useState<BattleStateDto | null>(null);
  const [battleId, setBattleId] = useState<string | null>(null);
  const [selectedEnemyId, setSelectedEnemyId] = useState<string | null>(null);
  const [selectedAllyId, setSelectedAllyId] = useState<string | null>(null);
  const [floats, setFloats] = useState<FloatText[]>([]);
  const [result, setResult] = useState<BattleResult>('idle');
  const [startupStatus, setStartupStatus] = useState<BattleStartupStatus>('none');
  const [isTeamBattle, setIsTeamBattle] = useState(false);
  const [teamMemberCount, setTeamMemberCount] = useState(1);
  const [nexting, setNexting] = useState(false);
  const [waitingForCooldown, setWaitingForCooldown] = useState(false);
  const floatDxIndexRef = useRef(0);
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
  const battleStartCooldownMsRef = useRef(DEFAULT_BATTLE_START_COOLDOWN_MS);
  const nextBattleAvailableAtRef = useRef<number | null>(null);
  const startBattleRef = useRef<(monsterIds: string[], options?: StartBattleOptions) => Promise<void>>(async () => {});
  const localBattleMonsterIds = useMemo(
    () => resolveLocalBattleMonsterIds(enemies),
    [enemies],
  );

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

  /**
   * 统一重置战斗展示层的瞬时状态。
   *
   * 作用：
   * - 把“切到新战斗前必须清空的展示状态”收口到单一入口；
   * - 避免外部 battleId 切换、socket 收到新 battle_started、主动开战三处各自复制同一套 reset 逻辑。
   *
   * 输入/输出：
   * - 输入：无。
   * - 输出：无，直接重置本组件的展示态。
   *
   * 数据流/状态流：
   * - 新战斗开始前 -> resetBattlePresentationState -> applyBattleStateSnapshot / setBattleId。
   *
   * 关键边界条件与坑点：
   * 1) 这里只重置展示态，不负责清掉服务端 battle，也不负责切换 externalBattleId。
   * 2) 必须同步清空日志游标与公告去重标记，否则跨波次会出现旧日志串到新战斗的问题。
   */
  const resetBattlePresentationState = useCallback(() => {
    clearAutoNextTimer();
    clearFloatTimers();
    setWaitingForCooldown(false);
    setFloats([]);
    floatDxIndexRef.current = 0;
    lastLogIndexRef.current = 0;
    lastChatLogIndexRef.current = 0;
    announcedBattleIdRef.current = null;
    announcedBattleEndIdRef.current = null;
    announcedBattleDropsIdRef.current = null;
    announcedAutoNextBattleIdRef.current = null;
    setSelectedEnemyId(null);
    setSelectedAllyId(null);
    setIsTeamBattle(false);
    setTeamMemberCount(1);
  }, [clearAutoNextTimer, clearFloatTimers]);

  const resetBattleRuntimeState = useCallback((endedBattleId?: string | null) => {
    const normalizedEndedBattleId =
      typeof endedBattleId === 'string' && endedBattleId.length > 0
        ? endedBattleId
        : null;
    clearAutoNextTimer();
    setWaitingForCooldown(false);
    setBattleId(null);
    setBattleState(null);
    setResult('idle');
    setStartupStatus('none');
    setIsTeamBattle(false);
    setTeamMemberCount(1);
    setNexting(false);
    battleIdRef.current = null;
    battleStateRef.current = null;
    nextingRef.current = false;
    lastLogIndexRef.current = 0;
    lastChatLogIndexRef.current = 0;
    announcedBattleIdRef.current = null;
    announcedBattleEndIdRef.current = normalizedEndedBattleId;
    announcedBattleDropsIdRef.current = normalizedEndedBattleId;
    announcedAutoNextBattleIdRef.current = normalizedEndedBattleId;
  }, [clearAutoNextTimer]);

  const handleMissingBattle = useCallback((messageText?: string): void => {
    const currentBattleId = battleIdRef.current;
    const shouldAutoRestartLocalBattle = canAutoRestartMissingLocalBattle({
      allowLocalStart,
      externalBattleId: resolvedExternalBattleId,
      allowAutoNext: resolvedAllowAutoNext,
      finishedBattleAdvanceMode,
      monsterIds: lastMonsterIdsRef.current,
      lastKnownBattleState: battleStateRef.current,
    });

    if (currentBattleId && messageText) {
      onAppendBattleLinesRef.current?.([`【斗法中断】${messageText}`]);
    }

    resetBattlePresentationState();
    resetBattleRuntimeState(currentBattleId);

    if (shouldAutoRestartLocalBattle) {
      message.info('当前战斗已失效，正在重新接敌');
      void startBattleRef.current(lastMonsterIdsRef.current, {
        retryOnCooldown: true,
        silentCooldown: true,
      });
      return;
    }

    onEscape?.();
  }, [
    allowLocalStart,
    finishedBattleAdvanceMode,
    message,
    onEscape,
    resetBattlePresentationState,
    resetBattleRuntimeState,
    resolvedAllowAutoNext,
    resolvedExternalBattleId,
  ]);

  const getRemainingBattleCooldownMs = useCallback((): number => {
    const nextAvailableAt = nextBattleAvailableAtRef.current;
    if (nextAvailableAt == null) return 0;
    const remainingMs = Math.max(0, nextAvailableAt - Date.now());
    if (remainingMs <= 0) {
      nextBattleAvailableAtRef.current = null;
      return 0;
    }
    return remainingMs;
  }, []);

  /**
   * 统一进入“等待战斗冷却结束后再开战”的状态。
   *
   * 作用：
   * - 把冷却等待、提示文案、自动重试定时器收口到单一入口
   * - 避免 BattleArea 在多个分支各自 setTimeout / setStartupStatus，导致连续战斗撞冷却后中断
   *
   * 输入/输出：
   * - 输入：monsterIds、remainingMs、silent
   * - 输出：无返回值，直接更新冷却状态并安排下一次 startBattle
   *
   * 数据流：
   * - 服务端返回 retryAfterMs / nextBattleAvailableAt，或客户端已知 deadline -> 本函数 -> 定时器 -> startBattleRef.current(...)
   *
   * 关键边界条件与坑点：
   * 1) 这里只负责“等待再开战”，不清空当前 finished 战斗画面，避免连续战斗期间视觉闪断。
   * 2) 必须先 clearAutoNextTimer，再重建定时器，避免多次冷却同步叠多个自动开战任务。
   */
  const scheduleBattleStartAfterCooldown = useCallback(
    (monsterIds: string[], remainingMs: number, silent: boolean): void => {
      const delayMs = Math.max(0, Math.floor(remainingMs));
      nextBattleAvailableAtRef.current = Date.now() + delayMs;
      clearAutoNextTimer();
      setWaitingForCooldown(true);
      setStartupStatus('cooldown');
      if (!silent && delayMs >= MINIMUM_MEANINGFUL_COOLDOWN_DISPLAY_MS) {
        message.info(`冷却中，${(delayMs / 1000).toFixed(2)}秒后自动重试`, Math.max(1, Math.ceil(delayMs / 1000)));
      }
      autoNextTimerRef.current = window.setTimeout(() => {
        void startBattleRef.current(monsterIds, { retryOnCooldown: true, silentCooldown: true });
      }, delayMs);
    },
    [clearAutoNextTimer, message],
  );

  const syncBattleCooldownMeta = useCallback((raw: BattleCooldownMetaLike | null | undefined) => {
    if (!raw || typeof raw !== 'object') return;
    const cooldownMs = toPositiveInt(raw.battleStartCooldownMs);
    if (cooldownMs != null) {
      battleStartCooldownMsRef.current = cooldownMs;
    }

    const nextAvailableAt = toPositiveInt(raw.nextBattleAvailableAt);
    if (nextAvailableAt != null) {
      nextBattleAvailableAtRef.current = nextAvailableAt;
      return;
    }

    const retryAfterMs = toPositiveInt(raw.retryAfterMs);
    if (retryAfterMs != null) {
      nextBattleAvailableAtRef.current = Date.now() + retryAfterMs;
    }
  }, []);

  const getAutoNextDelayMs = useCallback((): number => {
    // 优先使用服务端同步的冷却时长（相对值），避免客户端/服务端时钟偏差导致延迟不准
    return Math.max(DEFAULT_BATTLE_START_COOLDOWN_MS, battleStartCooldownMsRef.current);
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

  const ensureBattleDropsAnnounced = useCallback(
    (state: BattleStateDto | null | undefined, rewards: BattleRewardsDto | null | undefined) => {
      const battleId = state?.battleId;
      if (!battleId) return;
      if (state.phase === 'finished' && !rewards) return;
      if (announcedBattleDropsIdRef.current === battleId) return;
      const lines = [...buildRewardSummaryLinesFast(state, rewards), ...buildDropLinesFast(state, rewards)];
      if (lines.length === 0) return;
      announcedBattleDropsIdRef.current = battleId;
      pushBattleLines(lines);
    },
    [pushBattleLines],
  );

  const formatNewLogs = useCallback((prevIndex: number, nextLogs: BattleLogEntryDto[]) => {
    if (!Array.isArray(nextLogs) || nextLogs.length === 0) return [];
    const safePrev = Math.max(0, Math.min(prevIndex, nextLogs.length));
    return nextLogs
      .slice(safePrev)
      .map((log) => formatBattleLogLineFast(log))
      .filter((x): x is string => Boolean(x && x.trim()));
  }, []);

  const ensureBattleStartAnnounced = useCallback(
    (state: BattleStateDto) => {
      if (!state?.battleId) return;
      if (announcedBattleIdRef.current === state.battleId) return;
      announcedBattleIdRef.current = state.battleId;
      announcedBattleEndIdRef.current = null;
      announcedBattleDropsIdRef.current = null;
      announcedAutoNextBattleIdRef.current = null;
      lastChatLogIndexRef.current = 0;
      pushBattleLines([buildBattleStartLineFast(state)]);
    },
    [pushBattleLines],
  );

  const ensureBattleEndAnnounced = useCallback(
    (state: BattleStateDto) => {
      if (!state?.battleId) return;
      if (state.phase !== 'finished') return;
      if (announcedBattleEndIdRef.current === state.battleId) return;
      announcedBattleEndIdRef.current = state.battleId;
      pushBattleLines([buildBattleEndLineFast(state)]);
    },
    [pushBattleLines],
  );

  const syncBattleTeamInfo = useCallback(
    (state: BattleStateDto, teamMeta?: BattleTeamMeta) => {
      const normalizedTeamMemberCount = toPositiveInt(teamMeta?.teamMemberCount);
      const fallbackTeamInfo = calcTeamInfoFromState(state);
      const teamMemberCount = normalizedTeamMemberCount ?? fallbackTeamInfo.teamMemberCount;
      const isTeamBattle = typeof teamMeta?.isTeamBattle === 'boolean'
        ? teamMeta.isTeamBattle
        : teamMemberCount > 1;
      setIsTeamBattle(isTeamBattle);
      setTeamMemberCount(teamMemberCount);
    },
    [],
  );

  const resolveBattleResult = useCallback((state: BattleStateDto): BattleResult => {
    if (state.phase !== 'finished') return 'running';
    if (state.result === 'attacker_win') return 'win';
    if (state.result === 'defender_win') return 'lose';
    return 'draw';
  }, []);

  const addFloat = useCallback((unitId: string, value: number) => {
    const id = createFloatId();
    const dx = FLOAT_DX_PATTERN[floatDxIndexRef.current] ?? 0;
    floatDxIndexRef.current = (floatDxIndexRef.current + 1) % FLOAT_DX_PATTERN.length;
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
            for (const hit of t.hits) {
              if (hit.damage > 0) addFloat(t.targetId, -Math.floor(hit.damage));
            }
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

  /**
   * 统一应用服务端下发的战斗状态快照。
   *
   * 作用：
   * - 将“浮字、战况聊天、开战/结束/掉落公告、队伍信息、战斗结果”集中到单一入口
   * - 避免 start/poll/socket/action 各自复制一套状态同步，导致日志游标和公告状态漂移
   *
   * 输入/输出：
   * - 输入：最新战斗 state，以及可选 battleId / rewards / teamMeta
   * - 输出：无返回值，直接同步 BattleArea 的本地展示状态
   *
   * 数据流：
   * - API/socket -> BattleStateDto -> 本函数 -> 战斗浮字/聊天日志/UI
   *
   * 关键边界条件与坑点：
   * 1) 本函数不负责“新旧状态判定”，调用前必须先用 isNewerBattleState 过滤。
   * 2) 日志只能基于 lastLogIndexRef / lastChatLogIndexRef 追加，不能在别处分段重置，否则短战斗会丢日志或重复日志。
   */
  const applyBattleStateSnapshot = useCallback(
    (
      nextState: BattleStateDto,
      options?: {
        battleId?: string;
        rewards?: BattleRewardsDto | null;
        teamMeta?: BattleTeamMeta;
      },
    ): void => {
      const resolvedBattleId = options?.battleId ?? nextState.battleId;
      battleIdRef.current = resolvedBattleId;
      battleStateRef.current = nextState;
      const prevIndex = lastLogIndexRef.current;
      applyLogsToFloats(prevIndex, nextState.logs ?? []);
      lastLogIndexRef.current = nextState.logs?.length ?? prevIndex;
      ensureBattleStartAnnounced(nextState);
      const prevChatIndex = lastChatLogIndexRef.current;
      const nextLines = formatNewLogs(prevChatIndex, nextState.logs ?? []);
      lastChatLogIndexRef.current = nextState.logs?.length ?? prevChatIndex;
      pushBattleLines(nextLines);
      ensureBattleEndAnnounced(nextState);
      ensureBattleDropsAnnounced(nextState, options?.rewards ?? null);
      setBattleId(resolvedBattleId);
      setBattleState(nextState);
      setStartupStatus('none');
      syncBattleTeamInfo(nextState, options?.teamMeta);
      setResult(resolveBattleResult(nextState));
    },
    [
      applyLogsToFloats,
      ensureBattleDropsAnnounced,
      ensureBattleEndAnnounced,
      ensureBattleStartAnnounced,
      formatNewLogs,
      pushBattleLines,
      resolveBattleResult,
      syncBattleTeamInfo,
    ],
  );

  const applyStartedBattleState = useCallback(
    (
      nextBattleId: string,
      nextState: BattleStateDto,
      teamMeta?: BattleTeamMeta,
    ): void => {
      applyBattleStateSnapshot(nextState, {
        battleId: nextBattleId,
        teamMeta,
      });
    },
    [applyBattleStateSnapshot],
  );

  const startBattle = useCallback(
    async (monsterIds: string[], options?: StartBattleOptions): Promise<void> => {
      const shouldRetryOnCooldown = options?.retryOnCooldown ?? false;
      const isSilentCooldown = options?.silentCooldown ?? false;
      const remainingCooldownMs = getRemainingBattleCooldownMs();

      if (shouldRetryOnCooldown && remainingCooldownMs > 0) {
        scheduleBattleStartAfterCooldown(monsterIds, remainingCooldownMs, isSilentCooldown);
        return;
      }

      if (startingBattleRef.current) return;
      startingBattleRef.current = true;
      resetBattlePresentationState();
      setWaitingForCooldown(false);
      // 先清空旧战斗状态，防止 auto-next useEffect 在 await 期间
      // 看到旧的 finished state + 已清空的 announcedAutoNextBattleIdRef 而误弹提示
      setBattleState(null);
      setBattleId(null);
      setStartupStatus('preparing');

      if (monsterIds.length === 0) {
        setBattleId(null);
        setBattleState(null);
        setResult('idle');
        setStartupStatus('none');
        startingBattleRef.current = false;
        return;
      }

      try {
        const res = await startPVEBattle(monsterIds, SILENT_BATTLE_START_REQUEST_CONFIG);
        syncBattleCooldownMeta(res?.data);
        if (!res?.success || !res.data?.battleId || !res.data?.state) {
          const failMessage = getUnifiedApiErrorMessage(res, '发起战斗失败');
          message.error(failMessage);
          setBattleId(null);
          setBattleState(null);
          setResult('idle');
          setStartupStatus('none');
          onEscape?.();
          startingBattleRef.current = false;
          return;
        }
        applyStartedBattleState(res.data.battleId, res.data.state, {
          isTeamBattle: res.data.isTeamBattle,
          teamMemberCount: res.data.teamMemberCount,
        });
      } catch (e) {
        const normalizedError = toUnifiedApiError(e, '发起战斗失败');
        const payload = getBattleStartFailurePayload(normalizedError);
        const reason = String(payload?.reason ?? '').trim();
        const retryAfterMs = toPositiveInt(payload?.retryAfterMs);
        const inBattleBattleId = typeof payload?.battleId === 'string' ? payload.battleId : '';
        const inBattleState = payload?.state;

        if (reason === 'character_in_battle' && inBattleBattleId && inBattleState) {
          applyStartedBattleState(inBattleBattleId, inBattleState, {
            isTeamBattle: payload?.isTeamBattle,
            teamMemberCount: payload?.teamMemberCount,
          });
          return;
        }

        if (reason === 'battle_start_cooldown' && shouldRetryOnCooldown && retryAfterMs != null) {
          scheduleBattleStartAfterCooldown(monsterIds, retryAfterMs, isSilentCooldown);
          setBattleId(null);
          setBattleState(null);
          setResult('idle');
          return;
        }

        setBattleId(null);
        setBattleState(null);
        setResult('idle');
        setStartupStatus('none');
        message.error(normalizedError.message);
        pushBattleLines([`【斗法落幕】${normalizedError.message}`]);
        onEscape?.();
      } finally {
        startingBattleRef.current = false;
      }
    },
    [
      applyStartedBattleState,
      getRemainingBattleCooldownMs,
      message,
      onEscape,
      pushBattleLines,
      resetBattlePresentationState,
      scheduleBattleStartAfterCooldown,
      syncBattleCooldownMeta,
    ],
  );

  useEffect(() => {
    startBattleRef.current = startBattle;
  }, [startBattle]);

  useEffect(() => {
    // 外部战斗上下文（秘境/竞技场/重连）必须依赖 externalBattleId 驱动，
    // 禁止回退到本地 startPVEBattle，避免误命中“目标不在当前房间”并触发错误退出。
    if (localBattleMonsterIds.length > 0) {
      lastMonsterIdsRef.current = localBattleMonsterIds;
    }
    if (!shouldAutoStartLocalBattle({
      allowLocalStart,
      externalBattleId: resolvedExternalBattleId,
      monsterIds: localBattleMonsterIds,
      currentBattleId: battleIdRef.current,
      currentBattlePhase: battleStateRef.current?.phase ?? null,
      isStartingBattle: startingBattleRef.current,
    })) {
      return;
    }
    void startBattle(localBattleMonsterIds, { retryOnCooldown: true, silentCooldown: true });
  }, [allowLocalStart, localBattleMonsterIds, resolvedExternalBattleId, startBattle]);

  // 监听服务端冷却结束推送
  useEffect(() => {
    const handleCooldownReady = (event: Event) => {
      const customEvent = event as CustomEvent<{ characterId: number; timestamp: number }>;
      const myCharacterId = gameSocket.getCharacter()?.id;
      const currentState = battleStateRef.current;
      const isFinishedWin = currentState?.phase === 'finished' && currentState.result === 'attacker_win';

      if (customEvent.detail.characterId === myCharacterId) {
        nextBattleAvailableAtRef.current = null;
        clearAutoNextTimer();
        setWaitingForCooldown(false);
        setStartupStatus('none');

        // 自动触发下一场战斗
        if (resolvedAllowAutoNext && finishedBattleAdvanceMode === 'use_local_retry' && isFinishedWin) {
          void startBattle(lastMonsterIdsRef.current, { retryOnCooldown: true, silentCooldown: true });
        }
      }
    };

    const handleCooldownSync = (event: Event) => {
      const customEvent = event as CustomEvent<{ characterId: number; remainingMs: number; timestamp: number }>;
      const myCharacterId = gameSocket.getCharacter()?.id;
      const currentState = battleStateRef.current;
      const isFinishedWin = currentState?.phase === 'finished' && currentState.result === 'attacker_win';

      if (customEvent.detail.characterId === myCharacterId && customEvent.detail.remainingMs > 0) {
        const remainingMs = Math.max(0, Math.floor(customEvent.detail.remainingMs));
        nextBattleAvailableAtRef.current = Date.now() + remainingMs;
        if (resolvedAllowAutoNext && finishedBattleAdvanceMode === 'use_local_retry' && isFinishedWin) {
          scheduleBattleStartAfterCooldown(lastMonsterIdsRef.current, remainingMs, true);
          return;
        }
        setWaitingForCooldown(true);
        setStartupStatus('cooldown');
      }
    };

    window.addEventListener('battle:cooldown-ready', handleCooldownReady);
    window.addEventListener('battle:cooldown-sync', handleCooldownSync);

    return () => {
      window.removeEventListener('battle:cooldown-ready', handleCooldownReady);
      window.removeEventListener('battle:cooldown-sync', handleCooldownSync);
    };
  }, [
    clearAutoNextTimer,
    finishedBattleAdvanceMode,
    resolvedAllowAutoNext,
    scheduleBattleStartAfterCooldown,
    startBattle,
  ]);

  useEffect(() => {
    if (!resolvedExternalBattleId) return;
    if (battleIdRef.current === resolvedExternalBattleId) return;
    resetBattlePresentationState();
    setStartupStatus('preparing');
    setBattleId(resolvedExternalBattleId);
    setBattleState(null);
    setResult('running');
    void (async () => {
      const res = await getBattleState(resolvedExternalBattleId);
      if (!res?.success || !res.data?.state) {
        if (isBattleMissingError(res?.message)) {
          handleMissingBattle(res.message);
          return;
        }
        setStartupStatus('none');
        return;
      }
      applyBattleStateSnapshot(res.data.state, {
        battleId: resolvedExternalBattleId,
        rewards: res.data.rewards ?? null,
      });
    })();
  }, [
    applyBattleStateSnapshot,
    handleMissingBattle,
    resetBattlePresentationState,
    resolvedExternalBattleId,
  ]);

  useEffect(() => {
    if (!battleState) return;
    setStartupStatus('none');
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
      if (startupStatus !== 'cooldown') {
        clearAutoNextTimer();
      }
      announcedAutoNextBattleIdRef.current = null;
      return;
    }
    const currentBattleId = battleId;
    if (!currentBattleId) return;

    if (finishedBattleAdvanceMode === 'wait_on_next') {
      clearAutoNextTimer();
      return;
    }

    if (announcedAutoNextBattleIdRef.current === currentBattleId) return;
    announcedAutoNextBattleIdRef.current = currentBattleId;
    clearAutoNextTimer();

    // 普通地图自动连战：等待冷却结束后直接重开下一场。
    if (finishedBattleAdvanceMode === 'use_local_retry') {
      const remainingCooldownMs = getRemainingBattleCooldownMs();
      if (remainingCooldownMs > 0) {
        scheduleBattleStartAfterCooldown(lastMonsterIdsRef.current, remainingCooldownMs, true);
        return;
      }
      setWaitingForCooldown(true);
      setStartupStatus('cooldown');
      return;
    }

    // 外部战斗（如秘境）已具备 onNext：使用前端定时器推进下一波。
    const delayMs = getAutoNextDelayMs();
    const delaySec = (delayMs / 1000).toFixed(1);
    const shouldShowMessage = delayMs >= MINIMUM_MEANINGFUL_COOLDOWN_DISPLAY_MS;

    if (shouldShowMessage) {
      message.info(`战斗结束，等待${delaySec}秒后继续推进`, Math.max(1, Math.ceil(delayMs / 1000)));
    }
    autoNextTimerRef.current = window.setTimeout(() => {
      if (battleIdRef.current !== currentBattleId) return;
      if (nextingRef.current) return;
      if (!onNext) return;
      nextingRef.current = true;
      setNexting(true);
      Promise.resolve()
        .then(() => onNext())
        .finally(() => {
          nextingRef.current = false;
          setNexting(false);
        });
    }, delayMs);
  }, [
    battleId,
    battleState,
    clearAutoNextTimer,
    finishedBattleAdvanceMode,
    getAutoNextDelayMs,
    message,
    onNext,
    resolvedAllowAutoNext,
    resolvedExternalBattleId,
    getRemainingBattleCooldownMs,
    scheduleBattleStartAfterCooldown,
    startupStatus,
  ]);

  const pollBattleState = useCallback(async () => {
    const id = battleIdRef.current;
    if (!id) return;
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const res = await getBattleState(id);
      if (!res?.success || !res.data?.state) {
        if (isBattleMissingError(res?.message)) {
          handleMissingBattle(res.message);
        }
        return;
      }
      const next = res.data.state;
      const current = battleStateRef.current;
      if (!isNewerBattleState(next, current)) return;
      applyBattleStateSnapshot(next, {
        rewards: res.data.rewards ?? null,
      });
    } finally {
      pollInFlightRef.current = false;
    }
  }, [applyBattleStateSnapshot, handleMissingBattle]);

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
      if (kind !== 'battle_started' && currentId && incomingBattleId !== currentId) return;
      lastSocketBattleUpdateAtRef.current = Date.now();

      if (kind === 'battle_started') {
        if (!canAdoptIncomingStartedBattle(currentId, battleStateRef.current, incomingBattleId)) return;
        if (incomingBattleId !== currentId) {
          resetBattlePresentationState();
        }

        const nextState = data?.state as BattleStateDto | undefined;
        if (nextState) {
          const current = battleStateRef.current;
          if (incomingBattleId === currentId && current && !isNewerBattleState(nextState, current)) return;
          applyStartedBattleState(incomingBattleId, nextState);
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
        applyBattleStateSnapshot(next);
        return;
      }

      if (kind === 'battle_finished') {
        syncBattleCooldownMeta(data as BattleCooldownMetaLike);
        syncBattleCooldownMeta(data?.data as BattleCooldownMetaLike | null | undefined);
        const rewards = data?.data?.rewards ?? data?.rewards ?? null;
        const next = (data?.data?.state || data?.state) as BattleStateDto | undefined;
        if (next) {
          applyBattleStateSnapshot(next, { rewards });
        }
        return;
      }

      if (kind === 'battle_abandoned') {
        syncBattleCooldownMeta(data as BattleCooldownMetaLike);
        syncBattleCooldownMeta(data?.data as BattleCooldownMetaLike | null | undefined);
        if (announcedBattleEndIdRef.current !== incomingBattleId) {
          announcedBattleEndIdRef.current = incomingBattleId;
          pushBattleLines([FAST_BATTLE_LOG_SYSTEM_LINES.abandoned]);
        }
        setBattleId(null);
        setBattleState(null);
        setResult('idle');
        setStartupStatus('none');
        return;
      }
    });
    return () => unsub();
  }, [
    applyBattleStateSnapshot,
    applyStartedBattleState,
    ensureBattleDropsAnnounced,
    pushBattleLines,
    resetBattlePresentationState,
    syncBattleCooldownMeta,
  ]);

  const activeUnitId = useMemo(() => getCurrentUnitId(battleState), [battleState]);
  const turnCount = battleState?.roundCount ?? 0;
  const turnSide: 'enemy' | 'ally' = battleState?.currentTeam === 'defender' ? 'enemy' : 'ally';
  const actionKey = useMemo(() => {
    if (!battleState) return 'idle';
    return `${battleState.battleId}-${battleState.roundCount}-${battleState.currentTeam}-${battleState.currentUnitId ?? ''}-${activeUnitId ?? ''}`;
  }, [activeUnitId, battleState]);

  const battlePhase = battleState?.phase ?? null;

  useEffect(() => {
    onTurnChange?.(turnCount, turnSide, actionKey, activeUnitId, battlePhase);
  }, [actionKey, activeUnitId, battlePhase, onTurnChange, turnCount, turnSide]);

  const enemyUnits = useMemo<BattleUnit[]>(() => {
    const units = battleState?.teams?.defender?.units;
    if (Array.isArray(units)) {
      return units.map((u) => toClientUnit(u));
    }
    return [];
  }, [battleState]);

  const allyUnits = useMemo<BattleUnit[]>(() => {
    const units = battleState?.teams?.attacker?.units;
    if (Array.isArray(units)) {
      return units.map((u) => toClientUnit(u));
    }
    return [];
  }, [battleState]);
  const enemyAliveCount = useMemo(() => pickAlive(enemyUnits).length, [enemyUnits]);
  const allyAliveCount = useMemo(() => pickAlive(allyUnits).length, [allyUnits]);

  const statusText = useMemo(() => {
    if (!battleState && startupStatus === 'preparing') {
      return '正在接敌...';
    }
    if (waitingForCooldown || (!battleState && startupStatus === 'cooldown')) {
      return '战斗间隔冷却中，等待服务端通知...';
    }
    const teamTag = isTeamBattle ? `[组队${teamMemberCount}人] ` : '';
    const base = `${teamTag}敌方 ${enemyAliveCount}/${enemyUnits.length} · 我方 ${allyAliveCount}/${allyUnits.length}`;
    const sideText = turnSide === 'enemy' ? '敌方行动' : '我方行动';
    if (result === 'running') return `${base} · ${sideText}`;
    if (result === 'win') return `${base} · ${sideText} · 胜利`;
    if (result === 'lose') return `${base} · ${sideText} · 失败`;
    if (result === 'draw') return `${base} · ${sideText} · 平局`;
    return '等待目标';
  }, [allyAliveCount, allyUnits.length, battleState, enemyAliveCount, enemyUnits.length, isTeamBattle, result, startupStatus, teamMemberCount, turnSide, waitingForCooldown]);

  const isPreparingView = !battleState && (startupStatus !== 'none' || (Boolean(resolvedExternalBattleId) && result === 'running'));
  const enemyEmptyText = isPreparingView ? '正在锁定敌方目标...' : '暂无敌方目标';
  const allyEmptyText = isPreparingView ? '正在同步我方单位...' : '暂无我方单位';

  const handleEscape = useCallback(() => {
    const id = battleIdRef.current;
    if (id) {
      void abandonBattle(id);
    }
    if (id && announcedBattleEndIdRef.current !== id) {
      announcedBattleEndIdRef.current = id;
      pushBattleLines([FAST_BATTLE_LOG_SYSTEM_LINES.escaped]);
    }
    resetBattlePresentationState();
    resetBattleRuntimeState(id);
    onEscape?.();
  }, [onEscape, pushBattleLines, resetBattlePresentationState, resetBattleRuntimeState]);

  const handleNext = useCallback(async () => {
    if (!onNext) return;
    if (nextingRef.current) return;
    clearAutoNextTimer();
    nextingRef.current = true;
    setNexting(true);
    try {
      await onNext();
    } finally {
      nextingRef.current = false;
      setNexting(false);
    }
  }, [clearAutoNextTimer, onNext]);

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
        const picked = selectedAllyId && aliveAllyIds.includes(selectedAllyId) ? selectedAllyId : null;
        targets = picked ? [picked] : [];
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
      const res = await battleAction(id, actualSkillId, targets, SILENT_BATTLE_ACTION_REQUEST_CONFIG).catch((error) => {
        const errorText = getUnifiedApiErrorMessage(error, '行动失败');
        if (isBattleMissingError(errorText)) {
          handleMissingBattle(errorText);
          return null;
        }
        if (isTransientBattleActionError(errorText)) {
          void pollBattleState();
        }
        return null;
      });
      if (!res) {
        return false;
      }

      if (!res?.success || !res.data?.state) {
        if (isBattleMissingError(res?.message)) {
          handleMissingBattle(res.message);
          return false;
        }
        if (isTransientBattleActionError(res?.message)) {
          // 自动战斗/组队并发时可能命中旧回合或旧目标，静默刷新状态即可。
          void pollBattleState();
          return false;
        }
        // 检查是否是状态不同步错误，如果是则直接使用返回的最新状态
        const resData = res?.data as any;
        if (resData?.reason === 'state_mismatch' && resData?.state) {
          const nextState = resData.state;
          applyBattleStateSnapshot(nextState);
          return false;
        }
        void 0;
        return false;
      }
      syncBattleCooldownMeta(res.data);
      const next = res.data.state;
      applyBattleStateSnapshot(next, {
        rewards: res.data.rewards ?? null,
      });
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
      applyBattleStateSnapshot,
      handleMissingBattle,
      message,
      pollBattleState,
      selectedAllyId,
      selectedEnemyId,
      syncBattleCooldownMeta,
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
            <Button size="small" type="primary" className="battle-top-action" loading={nexting} onClick={handleNext}>
              {nextLabel || '继续'}
            </Button>
          ) : null}
          {onEscape ? (
            <Button size="small" className="battle-top-action" onClick={handleEscape}>
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
              {(enemyUnits ?? []).length === 0 ? <div className="battle-empty">{enemyEmptyText}</div> : null}
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
              {(allyUnits ?? []).length === 0 ? <div className="battle-empty">{allyEmptyText}</div> : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default BattleArea;
