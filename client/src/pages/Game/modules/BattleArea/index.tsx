import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'antd';
import {
  BATTLE_AVATAR_VISIBILITY_EVENT_NAME,
  getStoredBattleAvatarVisibility,
} from '../../../../constants/battleDisplay';
import {
  abandonBattle,
  battleAction,
  getUnifiedApiErrorMessage,
  SILENT_API_REQUEST_CONFIG,
  startPveBattleSession,
  toUnifiedApiError,
  type BattleUnitDto,
  type BattleSessionSnapshotDto,
  type BattleStartResponse,
  type BattleLogEntryDto,
  type BattleRewardsDto,
  type BattleStateDto,
} from '../../../../services/api';
import type { BattleRealtimePayload } from '../../../../services/battleRealtime';
import { gameSocket, type BattleCooldownState } from '../../../../services/gameSocket';
import { normalizeBattleSessionFromRealtime } from '../../shared/battleSessionRealtime';
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
import { isCooldownDrivenAdvanceMode, type BattleAdvanceMode } from './autoNextPolicy';
import { BattleTeamPanel } from './BattleTeamPanel';
import type { BattleFloatText, BattleUnit } from './types';
export type { BattleUnit } from './types';
import './index.scss';

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
  escapeLabel?: string;
  statusTextOverride?: string;
  advanceMode?: BattleAdvanceMode;
  onSessionChange?: (session: BattleSessionSnapshotDto | null) => void;
  onNotify: (type: 'info' | 'error', content: string, durationSeconds?: number) => void;
}

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

type PendingCooldownAction =
  | { kind: 'restart_local'; monsterIds: string[] }
  | { kind: 'advance_session' };

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
  const payloadFromAxios = response?.data?.data;
  if (payloadFromAxios && typeof payloadFromAxios === 'object') {
    return payloadFromAxios;
  }
  const payloadFromBusiness = (raw as { raw?: { data?: BattleStartFailurePayload } }).raw?.data;
  const payload = payloadFromBusiness;
  if (!payload || typeof payload !== 'object') return null;
  return payload;
};

type BattleResult = 'idle' | 'running' | 'win' | 'lose' | 'draw';
type BattleStartupStatus = 'none' | 'preparing' | 'cooldown';

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

const toClientUnit = (u: BattleUnitDto): BattleUnit => {
  return {
    id: u.id,
    name: u.name,
    unitType: u.type,
    avatar: u.avatar ?? null,
    tag: u.currentAttrs?.realm || (u.type === 'monster' ? '凡兽' : u.type === 'partner' ? '伙伴' : '凡人'),
    hp: Number(u.qixue) || 0,
    maxHp: Number(u.currentAttrs?.max_qixue) || 0,
    qi: Number(u.lingqi) || 0,
    maxQi: Number(u.currentAttrs?.max_lingqi) || 0,
    isPlayer: u.type === 'player',
    monthCardActive: u.monthCardActive,
    buffs: u.buffs,
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

const isNewerBattleState = (
  next: BattleStateDto,
  current: BattleStateDto | null,
  nextLogCount: number,
  currentLogCount: number,
): boolean => {
  if (!current) return true;
  if (next.battleId !== current.battleId) return true;

  if (current.phase === 'finished' && next.phase !== 'finished') return false;

  if (nextLogCount !== currentLogCount) return nextLogCount > currentLogCount;

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

const isBattleMissingError = (msg: unknown): boolean => {
  const text = String(msg ?? '').trim();
  return text === '战斗不存在' || text === '战斗不存在或已结束';
};

const canAutoRestartMissingLocalBattle = (params: {
  allowLocalStart: boolean;
  externalBattleId: string | null;
  allowAutoNext: boolean;
  finishedBattleAdvanceMode: BattleAdvanceMode;
  monsterIds: string[];
  lastKnownBattleState: BattleStateDto | null;
}): boolean => {
  if (!params.allowLocalStart) return false;
  if (params.externalBattleId) return false;
  if (!params.allowAutoNext) return false;
  if (params.finishedBattleAdvanceMode !== 'auto_local_retry') return false;
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

const isBattleCooldownReadyForMeta = (
  cooldownState: BattleCooldownState | null,
  characterId: number | null,
  nextBattleAvailableAt: number | null,
): boolean => {
  if (!cooldownState || cooldownState.active) return false;
  if (!characterId || cooldownState.characterId !== characterId) return false;
  if (nextBattleAvailableAt == null) return false;
  return cooldownState.timestamp >= nextBattleAvailableAt;
};

const BattleAreaComponent: React.FC<BattleAreaProps> = ({
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
  escapeLabel,
  statusTextOverride,
  advanceMode,
  onSessionChange,
  onNotify,
}) => {
  const resolvedExternalBattleId = externalBattleId ?? null;
  const resolvedAllowAutoNext = allowAutoNext ?? true;
  const finishedBattleAdvanceMode = advanceMode ?? 'none';
  const [battleState, setBattleState] = useState<BattleStateDto | null>(null);
  const [battleLogs, setBattleLogs] = useState<BattleLogEntryDto[]>([]);
  const [battleId, setBattleId] = useState<string | null>(null);
  const [showAvatarBackground, setShowAvatarBackground] = useState<boolean>(() => getStoredBattleAvatarVisibility());
  const [selectedEnemyId, setSelectedEnemyId] = useState<string | null>(null);
  const [selectedAllyId, setSelectedAllyId] = useState<string | null>(null);
  const [floats, setFloats] = useState<BattleFloatText[]>([]);
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
  const battleLogsRef = useRef<BattleLogEntryDto[]>([]);
  const lastLogIndexRef = useRef(0);
  const lastChatLogIndexRef = useRef(0);
  const announcedBattleIdRef = useRef<string | null>(null);
  const announcedBattleEndIdRef = useRef<string | null>(null);
  const announcedBattleDropsIdRef = useRef<string | null>(null);
  const onAppendBattleLinesRef = useRef<((lines: string[]) => void) | null>(null);
  const lastMonsterIdsRef = useRef<string[]>([]);
  const pendingCooldownActionRef = useRef<PendingCooldownAction | null>(null);
  const announcedAutoNextBattleIdRef = useRef<string | null>(null);
  const startingBattleRef = useRef(false);
  const battleStartCooldownMsRef = useRef(DEFAULT_BATTLE_START_COOLDOWN_MS);
  const battleCooldownActiveRef = useRef(false);
  const startBattleRef = useRef<(monsterIds: string[], options?: StartBattleOptions) => Promise<void>>(async () => {});
  const localBattleMonsterIds = useMemo(
    () => resolveLocalBattleMonsterIds(enemies),
    [enemies],
  );

  useEffect(() => {
    const handleBattleAvatarVisibilityChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ visible?: boolean }>;
      if (typeof customEvent.detail?.visible === 'boolean') {
        setShowAvatarBackground(customEvent.detail.visible);
      }
    };

    window.addEventListener(BATTLE_AVATAR_VISIBILITY_EVENT_NAME, handleBattleAvatarVisibilityChange);
    return () => {
      window.removeEventListener(BATTLE_AVATAR_VISIBILITY_EVENT_NAME, handleBattleAvatarVisibilityChange);
    };
  }, []);

  useEffect(() => {
    onAppendBattleLinesRef.current = onAppendBattleLines ?? null;
  }, [onAppendBattleLines]);

  const clearFloatTimers = useCallback(() => {
    floatTimerSetRef.current.forEach((t) => window.clearTimeout(t));
    floatTimerSetRef.current.clear();
  }, []);

  const clearPendingCooldownAction = useCallback(() => {
    pendingCooldownActionRef.current = null;
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
    clearPendingCooldownAction();
    clearFloatTimers();
    setWaitingForCooldown(false);
    battleCooldownActiveRef.current = false;
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
  }, [clearFloatTimers, clearPendingCooldownAction]);

  const resetBattleRuntimeState = useCallback((endedBattleId?: string | null) => {
    const normalizedEndedBattleId =
      typeof endedBattleId === 'string' && endedBattleId.length > 0
        ? endedBattleId
        : null;
    clearPendingCooldownAction();
    setWaitingForCooldown(false);
    battleCooldownActiveRef.current = false;
    setBattleId(null);
    setBattleState(null);
    setBattleLogs([]);
    setResult('idle');
    setStartupStatus('none');
    setIsTeamBattle(false);
    setTeamMemberCount(1);
    setNexting(false);
    battleIdRef.current = null;
    battleStateRef.current = null;
    battleLogsRef.current = [];
    nextingRef.current = false;
    lastLogIndexRef.current = 0;
    lastChatLogIndexRef.current = 0;
    announcedBattleIdRef.current = null;
    announcedBattleEndIdRef.current = normalizedEndedBattleId;
    announcedBattleDropsIdRef.current = normalizedEndedBattleId;
    announcedAutoNextBattleIdRef.current = normalizedEndedBattleId;
  }, [clearPendingCooldownAction]);

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
    onSessionChange?.(null);

    if (shouldAutoRestartLocalBattle) {
      onNotify('info', '当前战斗已失效，正在重新接敌');
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
    onEscape,
    onNotify,
    onSessionChange,
    resetBattlePresentationState,
    resetBattleRuntimeState,
    resolvedAllowAutoNext,
    resolvedExternalBattleId,
  ]);

  /**
   * 统一记录“冷却结束后要执行的动作”，真正执行时机只认服务端 ready 推送。
   *
   * 作用：
   * - 把冷却等待 UI、冷却元数据、待执行动作收口到单一入口
   * - 避免 BattleArea 在多个分支各自 setTimeout 猜测冷却结束时刻，和服务端单一真源冲突
   *
   * 输入/输出：
   * - 输入：remainingMs、silent，以及可选的待执行动作
   * - 输出：无返回值，直接更新冷却等待状态
   *
   * 数据流：
   * - 服务端返回 retryAfterMs / nextBattleAvailableAt，或重连同步 remainingMs -> 本函数记录待执行动作 -> 服务端 `battle:cooldown-ready` 到达后真正执行
   *
   * 关键边界条件与坑点：
   * 1) 这里只记录意图，不直接推进下一场；推进动作必须等服务端 ready，避免客户端时钟误差提前开战。
   * 2) 新的冷却同步必须覆盖旧动作，避免连续收到 sync 包时保留过期的待执行动作。
   */
  const activateCooldownWait = useCallback(
    (
      remainingMs: number,
      silent: boolean,
      pendingAction: PendingCooldownAction | null,
      messageText: string,
    ): void => {
      const delayMs = Math.max(0, Math.floor(remainingMs));
      battleCooldownActiveRef.current = true;
      pendingCooldownActionRef.current = pendingAction;
      setWaitingForCooldown(true);
      setStartupStatus('cooldown');
      if (!silent && delayMs >= MINIMUM_MEANINGFUL_COOLDOWN_DISPLAY_MS) {
        onNotify('info', messageText, Math.max(1, Math.ceil(delayMs / 1000)));
      }
    },
    [onNotify],
  );

  const syncBattleCooldownMeta = useCallback((raw: BattleCooldownMetaLike | null | undefined) => {
    if (!raw || typeof raw !== 'object') return;
    const cooldownMs = toPositiveInt(raw.battleStartCooldownMs);
    if (cooldownMs != null) {
      battleStartCooldownMsRef.current = cooldownMs;
    }

    const nextAvailableAt = toPositiveInt(raw.nextBattleAvailableAt);
    if (nextAvailableAt != null) {
      const currentCharacterId = gameSocket.getCharacter()?.id ?? null;
      const latestCooldownState = gameSocket.getLatestBattleCooldown();
      if (isBattleCooldownReadyForMeta(latestCooldownState, currentCharacterId, nextAvailableAt)) {
        battleCooldownActiveRef.current = false;
        return;
      }
      battleCooldownActiveRef.current = true;
      return;
    }

    const retryAfterMs = toPositiveInt(raw.retryAfterMs);
    if (retryAfterMs != null) {
      battleCooldownActiveRef.current = true;
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

  useEffect(() => {
    battleLogsRef.current = battleLogs;
  }, [battleLogs]);

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
      clearPendingCooldownAction();
    };
  }, [clearFloatTimers, clearPendingCooldownAction]);

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
   * - 输入：最新战斗 state、完整日志，以及可选 battleId / rewards / teamMeta
   * - 输出：无返回值，直接同步 BattleArea 的本地展示状态
   *
   * 数据流：
   * - socket/cache -> BattleStateDto + BattleLogEntryDto[] -> 本函数 -> 战斗浮字/聊天日志/UI
   *
   * 关键边界条件与坑点：
   * 1) 本函数不负责“新旧状态判定”，调用前必须先用 isNewerBattleState 过滤。
   * 2) 日志只能基于 lastLogIndexRef / lastChatLogIndexRef 追加，不能在别处分段重置，否则短战斗会丢日志或重复日志。
   */
  const applyBattleStateSnapshot = useCallback(
    (
      nextState: BattleStateDto,
      nextLogs: BattleLogEntryDto[],
      options?: {
        battleId?: string;
        rewards?: BattleRewardsDto | null;
        teamMeta?: BattleTeamMeta;
      },
    ): void => {
      const resolvedBattleId = options?.battleId ?? nextState.battleId;
      battleIdRef.current = resolvedBattleId;
      battleStateRef.current = nextState;
      battleLogsRef.current = nextLogs;
      const prevIndex = lastLogIndexRef.current;
      applyLogsToFloats(prevIndex, nextLogs);
      lastLogIndexRef.current = nextLogs.length;
      ensureBattleStartAnnounced(nextState);
      const prevChatIndex = lastChatLogIndexRef.current;
      const nextLines = formatNewLogs(prevChatIndex, nextLogs);
      lastChatLogIndexRef.current = nextLogs.length;
      pushBattleLines(nextLines);
      ensureBattleEndAnnounced(nextState);
      ensureBattleDropsAnnounced(nextState, options?.rewards ?? null);
      setBattleId(resolvedBattleId);
      setBattleState(nextState);
      setBattleLogs(nextLogs);
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
      nextLogs: BattleLogEntryDto[],
      teamMeta?: BattleTeamMeta,
    ): void => {
      applyBattleStateSnapshot(nextState, nextLogs, {
        battleId: nextBattleId,
        teamMeta,
      });
    },
    [applyBattleStateSnapshot],
  );

  const adoptCachedBattleSnapshot = useCallback(
    (
      targetBattleId: string,
      options?: {
        rewards?: BattleRewardsDto | null;
        teamMeta?: BattleTeamMeta;
      },
    ): boolean => {
      const cached = gameSocket.getLatestBattleUpdate(targetBattleId);
      if (!cached || cached.kind === 'battle_abandoned' || !cached.state) return false;
      applyBattleStateSnapshot(cached.state, cached.logs, {
        battleId: targetBattleId,
        rewards: options?.rewards ?? cached.rewards ?? null,
        teamMeta: options?.teamMeta,
      });
      if (cached.session) {
        onSessionChange?.(cached.session);
      }
      return true;
    },
    [applyBattleStateSnapshot, onSessionChange],
  );

  const startBattle = useCallback(
    async (monsterIds: string[], options?: StartBattleOptions): Promise<void> => {
      const shouldRetryOnCooldown = options?.retryOnCooldown ?? false;
      const isSilentCooldown = options?.silentCooldown ?? false;

      if (startingBattleRef.current) return;
      startingBattleRef.current = true;
      resetBattlePresentationState();
      setWaitingForCooldown(false);
      // 先清空旧战斗状态，防止 auto-next useEffect 在 await 期间
      // 看到旧的 finished state + 已清空的 announcedAutoNextBattleIdRef 而误弹提示
      setBattleState(null);
      setBattleLogs([]);
      setBattleId(null);
      setStartupStatus('preparing');

      if (monsterIds.length === 0) {
        setBattleId(null);
        setBattleState(null);
        setBattleLogs([]);
        setResult('idle');
        setStartupStatus('none');
        startingBattleRef.current = false;
        return;
      }

      try {
        const res = await startPveBattleSession(monsterIds, SILENT_API_REQUEST_CONFIG);
        const session = res?.data?.session;
        const battleIdFromSession =
          typeof session?.currentBattleId === 'string' ? session.currentBattleId : '';
        if (!res?.success || !session || !battleIdFromSession) {
          const failMessage = getUnifiedApiErrorMessage(res, '发起战斗失败');
          onNotify('error', failMessage);
          setBattleId(null);
          setBattleState(null);
          setBattleLogs([]);
          setResult('idle');
          setStartupStatus('none');
          onEscape?.();
          startingBattleRef.current = false;
          return;
        }
        onSessionChange?.(session);
        setBattleId(battleIdFromSession);
        setResult('running');
        if (!adoptCachedBattleSnapshot(battleIdFromSession)) {
          gameSocket.requestBattleSync(battleIdFromSession);
        }
      } catch (e) {
        const normalizedError = toUnifiedApiError(e, '发起战斗失败');
        const payload = getBattleStartFailurePayload(normalizedError);
        const reason = String(payload?.reason ?? '').trim();
        const retryAfterMs = toPositiveInt(payload?.retryAfterMs);
        const inBattleBattleId = typeof payload?.battleId === 'string' ? payload.battleId : '';

        if (reason === 'character_in_battle' && inBattleBattleId) {
          setBattleId(inBattleBattleId);
          setResult('running');
          adoptCachedBattleSnapshot(inBattleBattleId, {
            teamMeta: {
              isTeamBattle: payload?.isTeamBattle,
              teamMemberCount: payload?.teamMemberCount,
            },
          });
          return;
        }

        if (reason === 'battle_start_cooldown' && shouldRetryOnCooldown && retryAfterMs != null) {
          activateCooldownWait(
            retryAfterMs,
            isSilentCooldown,
            { kind: 'restart_local', monsterIds: [...monsterIds] },
            `冷却中，${(retryAfterMs / 1000).toFixed(2)}秒后自动重试`,
          );
          setBattleId(null);
          setBattleState(null);
          setBattleLogs([]);
          setResult('idle');
          return;
        }

        setBattleId(null);
        setBattleState(null);
        setBattleLogs([]);
        setResult('idle');
        setStartupStatus('none');
        onNotify('error', normalizedError.message);
        pushBattleLines([`【斗法落幕】${normalizedError.message}`]);
        onEscape?.();
      } finally {
        startingBattleRef.current = false;
      }
    },
    [
      activateCooldownWait,
      adoptCachedBattleSnapshot,
      onNotify,
      onEscape,
      onSessionChange,
      pushBattleLines,
      resetBattlePresentationState,
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
    const handleCooldownEvent = (detail: BattleCooldownState) => {
      const myCharacterId = gameSocket.getCharacter()?.id;

      if (detail.characterId === myCharacterId) {
        if (detail.kind === 'sync' && detail.remainingMs > 0) {
          const currentState = battleStateRef.current;
          const isFinishedWin = currentState?.phase === 'finished' && currentState.result === 'attacker_win';
          const remainingMs = Math.max(0, Math.floor(detail.remainingMs));
          battleCooldownActiveRef.current = true;
          if (resolvedAllowAutoNext && finishedBattleAdvanceMode === 'auto_local_retry' && isFinishedWin) {
            activateCooldownWait(
              remainingMs,
              true,
              { kind: 'restart_local', monsterIds: [...lastMonsterIdsRef.current] },
              `冷却中，${(remainingMs / 1000).toFixed(2)}秒后自动重试`,
            );
            return;
          }
          if (resolvedAllowAutoNext && finishedBattleAdvanceMode === 'auto_session_cooldown' && isFinishedWin) {
            activateCooldownWait(
              remainingMs,
              true,
              null,
              `冷却中，${(remainingMs / 1000).toFixed(2)}秒后自动继续`,
            );
            return;
          }
          clearPendingCooldownAction();
          setWaitingForCooldown(true);
          setStartupStatus('cooldown');
          return;
        }

        const pendingAction = pendingCooldownActionRef.current;
        battleCooldownActiveRef.current = false;
        clearPendingCooldownAction();
        setWaitingForCooldown(false);
        setStartupStatus('none');
        if (!resolvedAllowAutoNext || !pendingAction) {
          return;
        }
        if (pendingAction.kind === 'restart_local') {
          void startBattle(pendingAction.monsterIds, { retryOnCooldown: true, silentCooldown: true });
          return;
        }
        if (pendingAction.kind === 'advance_session' && onNext && !nextingRef.current) {
          void onNext();
        }
      }
    };
    return gameSocket.onBattleCooldown(handleCooldownEvent);
  }, [
    activateCooldownWait,
    clearPendingCooldownAction,
    finishedBattleAdvanceMode,
    onNext,
    resolvedAllowAutoNext,
    startBattle,
  ]);

  useEffect(() => {
    if (!resolvedExternalBattleId) return;
    if (battleIdRef.current === resolvedExternalBattleId) return;
    resetBattlePresentationState();
    setStartupStatus('preparing');
    setBattleId(resolvedExternalBattleId);
    setBattleState(null);
    setBattleLogs([]);
    setResult('running');
    battleLogsRef.current = [];
    if (!adoptCachedBattleSnapshot(resolvedExternalBattleId)) {
      gameSocket.requestBattleSync(resolvedExternalBattleId);
    }
  }, [
    adoptCachedBattleSnapshot,
    resetBattlePresentationState,
    resolvedExternalBattleId,
  ]);

  useEffect(() => {
    return gameSocket.onAuthReady(() => {
      const currentBattleId = battleIdRef.current ?? resolvedExternalBattleId;
      if (!currentBattleId) return;
      if (!adoptCachedBattleSnapshot(currentBattleId)) {
        gameSocket.requestBattleSync(currentBattleId);
      }
    });
  }, [adoptCachedBattleSnapshot, resolvedExternalBattleId]);

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
        clearPendingCooldownAction();
      }
      announcedAutoNextBattleIdRef.current = null;
      return;
    }
    const currentBattleId = battleId;
    if (!currentBattleId) return;

    if (
      finishedBattleAdvanceMode === 'none'
      || finishedBattleAdvanceMode === 'wait_external'
      || finishedBattleAdvanceMode === 'auto_session'
      || finishedBattleAdvanceMode === 'manual_session'
    ) {
      clearPendingCooldownAction();
      return;
    }

    if (announcedAutoNextBattleIdRef.current === currentBattleId) return;
    announcedAutoNextBattleIdRef.current = currentBattleId;
    clearPendingCooldownAction();

    // 普通地图自动连战：等待冷却结束后直接重开下一场。
    if (!isCooldownDrivenAdvanceMode(finishedBattleAdvanceMode)) {
      clearPendingCooldownAction();
      return;
    }

    if (finishedBattleAdvanceMode === 'auto_local_retry') {
      if (battleCooldownActiveRef.current) {
        activateCooldownWait(
          battleStartCooldownMsRef.current,
          true,
          { kind: 'restart_local', monsterIds: [...lastMonsterIdsRef.current] },
          `冷却中，${(battleStartCooldownMsRef.current / 1000).toFixed(2)}秒后自动重试`,
        );
        return;
      }
      void startBattle(lastMonsterIdsRef.current, { retryOnCooldown: true, silentCooldown: true });
      return;
    }

    if (finishedBattleAdvanceMode === 'auto_session_cooldown') {
      if (battleCooldownActiveRef.current) {
        activateCooldownWait(
          battleStartCooldownMsRef.current,
          true,
          null,
          `冷却中，${(battleStartCooldownMsRef.current / 1000).toFixed(2)}秒后自动继续`,
        );
        return;
      }
      if (onNext && !nextingRef.current) {
        void onNext();
      }
      return;
    }

  }, [
    activateCooldownWait,
    battleId,
    battleState,
    clearPendingCooldownAction,
    finishedBattleAdvanceMode,
    resolvedAllowAutoNext,
    onNext,
    startBattle,
    startupStatus,
  ]);

  useEffect(() => {
    gameSocket.connect();
    const unsub = gameSocket.onBattleUpdate((data: BattleRealtimePayload) => {
      const kind = data.kind;
      const incomingBattleId = data.battleId;
      const session = data.session ?? null;
      const currentId = battleIdRef.current;
      if (!incomingBattleId) return;
      if (kind !== 'battle_started' && currentId && incomingBattleId !== currentId) return;

      if (kind === 'battle_started') {
        if (session) {
          onSessionChange?.(session);
        }
        if (!canAdoptIncomingStartedBattle(currentId, battleStateRef.current, incomingBattleId)) return;
        if (incomingBattleId !== currentId) {
          resetBattlePresentationState();
        }

        if (data.state) {
          const current = battleStateRef.current;
          const currentLogCount = battleLogsRef.current.length;
          if (
            !data.authoritative
            && incomingBattleId === currentId
            && current
            && !isNewerBattleState(data.state, current, data.logs.length, currentLogCount)
          ) {
            return;
          }
          applyStartedBattleState(incomingBattleId, data.state, data.logs);
        }
        return;
      }

      if (kind === 'battle_state') {
        if (session) {
          onSessionChange?.(session);
        }
        const next = data.state;
        if (!next) return;
        const current = battleStateRef.current;
        const currentLogCount = battleLogsRef.current.length;
        if (
          !data.authoritative
          && incomingBattleId === currentId
          && current
          && !isNewerBattleState(next, current, data.logs.length, currentLogCount)
        ) {
          return;
        }
        applyBattleStateSnapshot(next, data.logs);
        return;
      }

      if (kind === 'battle_finished') {
        if (session) {
          onSessionChange?.(session);
        }
        syncBattleCooldownMeta(data);
        if (data.state) {
          applyBattleStateSnapshot(data.state, data.logs, {
            rewards: data.rewards ?? null,
          });
        }
        return;
      }

      if (kind === 'battle_abandoned') {
        onSessionChange?.(normalizeBattleSessionFromRealtime({ kind, session }));
        syncBattleCooldownMeta(data);
        if (announcedBattleEndIdRef.current !== incomingBattleId) {
          announcedBattleEndIdRef.current = incomingBattleId;
          pushBattleLines([FAST_BATTLE_LOG_SYSTEM_LINES.abandoned]);
        }
        setBattleId(null);
        setBattleState(null);
        setBattleLogs([]);
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
    onSessionChange,
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
    if (statusTextOverride) {
      return statusTextOverride;
    }
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
  }, [allyAliveCount, allyUnits.length, battleState, enemyAliveCount, enemyUnits.length, isTeamBattle, result, startupStatus, statusTextOverride, teamMemberCount, turnSide, waitingForCooldown]);

  const isPreparingView = !battleState && (startupStatus !== 'none' || (Boolean(resolvedExternalBattleId) && result === 'running'));
  const enemyEmptyText = isPreparingView ? '正在锁定敌方目标...' : '暂无敌方目标';
  const allyEmptyText = isPreparingView ? '正在同步我方单位...' : '暂无我方单位';

  const handleEscape = useCallback(() => {
    const exitBattleLocally = (battleId: string | null) => {
      if (battleId && announcedBattleEndIdRef.current !== battleId) {
        announcedBattleEndIdRef.current = battleId;
        pushBattleLines([FAST_BATTLE_LOG_SYSTEM_LINES.escaped]);
      }
      resetBattlePresentationState();
      resetBattleRuntimeState(battleId);
      onEscape?.();
    };

    const id = battleIdRef.current;
    if (!id) {
      exitBattleLocally(null);
      return;
    }

    void abandonBattle(id, SILENT_API_REQUEST_CONFIG)
      .then((res) => {
        if (!res?.success) {
          if (!isBattleMissingError(res?.message)) {
            onNotify('error', res?.message || '逃跑失败');
            return;
          }
        }
        syncBattleCooldownMeta(res.data);
        exitBattleLocally(id);
      })
      .catch((error) => {
        const errorText = getUnifiedApiErrorMessage(error, '逃跑失败');
        if (!isBattleMissingError(errorText)) {
          onNotify('error', errorText);
          return;
        }
        exitBattleLocally(id);
      });
  }, [onEscape, onNotify, pushBattleLines, resetBattlePresentationState, resetBattleRuntimeState, syncBattleCooldownMeta]);

  const handleEnemyUnitToggle = useCallback((unitId: string) => {
    setSelectedEnemyId((prev) => (prev === unitId ? null : unitId));
  }, []);

  const handleAllyUnitToggle = useCallback((unitId: string) => {
    setSelectedAllyId((prev) => (prev === unitId ? null : unitId));
  }, []);

  const handleNext = useCallback(async () => {
    if (!onNext) return;
    if (nextingRef.current) return;
    clearPendingCooldownAction();
    nextingRef.current = true;
    setNexting(true);
    try {
      await onNext();
    } finally {
      nextingRef.current = false;
      setNexting(false);
    }
  }, [clearPendingCooldownAction, onNext]);

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
      const res = await battleAction(id, actualSkillId, targets, SILENT_API_REQUEST_CONFIG).catch((error) => {
        const errorText = getUnifiedApiErrorMessage(error, '行动失败');
        if (isBattleMissingError(errorText)) {
          handleMissingBattle(errorText);
          return null;
        }
        return null;
      });
      if (!res) {
        return false;
      }

      if (!res?.success) {
        if (isBattleMissingError(res?.message)) {
          handleMissingBattle(res.message);
          return false;
        }
        void 0;
        return false;
      }
      const responseData = res.data;
      syncBattleCooldownMeta(responseData);
      if (responseData?.session) {
        onSessionChange?.(responseData.session);
      }
      return true;
    },
    [
      handleMissingBattle,
      onSessionChange,
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
    const map: Record<string, BattleFloatText[]> = {};
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
          {battleState?.phase === 'finished' && finishedBattleAdvanceMode === 'manual_session' && onNext ? (
            <Button size="small" type="primary" className="battle-top-action" loading={nexting} onClick={handleNext}>
              {nextLabel || '继续'}
            </Button>
          ) : null}
          {onEscape ? (
            <Button size="small" className="battle-top-action" onClick={handleEscape}>
              {escapeLabel || '逃跑'}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="battle-area-panels">
        <BattleTeamPanel
          team="enemy"
          units={enemyUnits}
          emptyText={enemyEmptyText}
          showAvatarBackground={showAvatarBackground}
          activeUnitId={activeUnitId}
          selectedUnitId={selectedEnemyId}
          floatsByUnit={floatsByUnit}
          onToggleUnit={handleEnemyUnitToggle}
        />

        <div className="battle-divider" />

        <BattleTeamPanel
          team="ally"
          units={allyUnits}
          emptyText={allyEmptyText}
          showAvatarBackground={showAvatarBackground}
          activeUnitId={activeUnitId}
          selectedUnitId={selectedAllyId}
          floatsByUnit={floatsByUnit}
          onToggleUnit={handleAllyUnitToggle}
        />
      </div>
    </div>
  );
};

const BattleArea = memo(BattleAreaComponent);

export default BattleArea;
