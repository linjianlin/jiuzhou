import { App, Tooltip } from 'antd';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { getCharacterTechniqueStatus, resolveAssetUrl, type CharacterSkillSlotDto } from '../../../../services/api';
import { resolveIconUrl } from '../../shared/resolveIcon';
import { gameSocket } from '../../../../services/gameSocket';
import { readIsMobileViewport } from '../../shared/responsive';
import { formatSkillEffectLines } from '../skillEffectFormatter';
import './index.scss';

type ExpandDirection = 'left' | 'right';

type SkillItem = {
  id: string;
  name: string;
  icon: string;
  equipped: boolean;
  costLingqi: number;
  costQixue: number;
  description: string | null;
  targetType: string;
  targetCount: number;
  damageType: string;
  element: string;
  effects: unknown[];
  cooldownTurns: number;
  cooldownLeft: number;
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const FAB_SIZE_DESKTOP = 72;
const FAB_SIZE_MOBILE = 48;
const getFabSize = () => (readIsMobileViewport() ? FAB_SIZE_MOBILE : FAB_SIZE_DESKTOP);

type SkillCooldownMapDto = Record<string, unknown>;

type BattleUnitWithCooldownDto = {
  id?: unknown;
  lingqi?: unknown;
  qixue?: unknown;
  skillCooldowns?: SkillCooldownMapDto;
};

type BattleStateWithUnitsDto = {
  battleId?: unknown;
  teams?: {
    attacker?: {
      units?: unknown;
    };
  };
};

type BattleUpdatePayloadDto = {
  kind?: unknown;
  battleId?: unknown;
  state?: unknown;
  data?: { state?: unknown } | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

type AvailableSkillDto = {
  skillId: string;
  cooldown: number;
  costLingqi?: number;
  costQixue?: number;
  description?: string | null;
  targetType?: string;
  targetCount?: number;
  damageType?: string | null;
  element?: string;
  effects?: unknown[];
};

const formatDamageType = (t: string): string => {
  const v = (t || '').trim();
  if (v === 'physical') return '物理';
  if (v === 'magic') return '法术';
  if (v === 'true') return '真实';
  if (v === 'none') return '无';
  return v || '无';
};

const formatTargetType = (t: string): string => {
  const v = (t || '').trim();
  if (v === 'single_enemy') return '单体敌人';
  if (v === 'all_enemy') return '全体敌人';
  if (v === 'single_ally') return '单体友方';
  if (v === 'all_ally') return '全体友方';
  if (v === 'self') return '自身';
  return v || '未知';
};

const formatElement = (e: string): string => {
  const v = (e || '').trim();
  if (v === 'none') return '无';
  if (v === 'jin') return '金';
  if (v === 'mu') return '木';
  if (v === 'shui') return '水';
  if (v === 'huo') return '火';
  if (v === 'tu') return '土';
  return v || '无';
};

const SKILL_FAB_TOOLTIP_CLASS_NAMES = {
  root: 'skill-fab-tooltip-overlay game-tooltip-surface-root',
  container: 'skill-fab-tooltip-container game-tooltip-surface-container',
} as const;

const FALLBACK_SKILL_ICON = resolveAssetUrl('/assets/skills/icon_skill_01.png');

const resolveSkillIcon = (icon: string | null | undefined): string =>
  resolveIconUrl(icon, FALLBACK_SKILL_ICON);

const buildSkillItems = (
  equippedSkills: CharacterSkillSlotDto[],
  available: AvailableSkillDto[] | null | undefined,
  prev: SkillItem[],
): SkillItem[] => {
  const prevById = new Map(prev.map((s) => [s.id, s]));
  const cooldownBySkillId = new Map<string, number>(
    (available ?? [])
      .map((s) => [String(s?.skillId ?? '').trim(), Math.max(0, Math.floor(Number(s?.cooldown) || 0))] as const)
      .filter((x) => Boolean(x[0])),
  );
  const costBySkillId = new Map<string, { costLingqi: number; costQixue: number }>(
    (available ?? [])
      .map((s) => [
        String(s?.skillId ?? '').trim(),
        {
          costLingqi: Math.max(0, Math.floor(Number(s?.costLingqi) || 0)),
          costQixue: Math.max(0, Math.floor(Number(s?.costQixue) || 0)),
        },
      ] as const)
      .filter((x) => Boolean(x[0])),
  );
  const infoBySkillId = new Map<
    string,
    {
      description: string | null;
      targetType: string;
      targetCount: number;
      damageType: string;
      element: string;
      effects: unknown[];
    }
  >(
    (available ?? [])
      .map((s) => [
        String(s?.skillId ?? '').trim(),
        {
          description: typeof s?.description === 'string' ? s.description : null,
          targetType: String(s?.targetType ?? '').trim(),
          targetCount: Math.max(1, Math.floor(Number(s?.targetCount) || 1)),
          damageType: String(s?.damageType ?? 'none').trim(),
          element: String(s?.element ?? 'none').trim(),
          effects: Array.isArray(s?.effects) ? s.effects : [],
        },
      ] as const)
      .filter((x) => Boolean(x[0])),
  );
  const used = new Set<string>();
  const next: SkillItem[] = [];

  const prevBasic = prevById.get('basic_attack');
  next.push({
    id: 'basic_attack',
    name: '普通攻击',
    icon: resolveSkillIcon('icon_skill_01.png'),
    equipped: true,
    costLingqi: 0,
    costQixue: 0,
    description: null,
    targetType: 'single_enemy',
    targetCount: 1,
    damageType: 'physical',
    element: 'none',
    effects: [
      {
        type: 'damage',
        valueType: 'scale',
        scaleAttr: 'wugong',
        scaleRate: 1,
      },
    ],
    cooldownTurns: 0,
    cooldownLeft: prevBasic?.cooldownLeft ?? 0,
  });
  used.add('basic_attack');

  const ordered = (equippedSkills ?? []).slice().sort((a, b) => (a.slot_index ?? 0) - (b.slot_index ?? 0));
  for (const slot of ordered) {
    const id = (slot.skill_id ?? '').trim();
    if (!id) continue;
    if (used.has(id)) continue;
    used.add(id);

    const prevOne = prevById.get(id);
    const name = (slot.skill_name ?? id).trim() || id;
    const icon = resolveSkillIcon(slot.skill_icon);
    const configuredCd = cooldownBySkillId.get(id);
    const cooldownTurns = configuredCd != null ? configuredCd : (prevOne?.cooldownTurns ?? 1);
    const cost = costBySkillId.get(id);
    const info = infoBySkillId.get(id);
    next.push({
      id,
      name,
      icon,
      equipped: true,
      costLingqi: cost?.costLingqi ?? 0,
      costQixue: cost?.costQixue ?? 0,
      description: info?.description ?? null,
      targetType: info?.targetType ?? (prevOne?.targetType ?? ''),
      targetCount: info?.targetCount ?? (prevOne?.targetCount ?? 1),
      damageType: info?.damageType ?? (prevOne?.damageType ?? 'none'),
      element: info?.element ?? (prevOne?.element ?? 'none'),
      effects: info?.effects ?? (prevOne?.effects ?? []),
      cooldownTurns,
      cooldownLeft: prevOne?.cooldownLeft ?? 0,
    });
  }

  return next;
};

const syncSkillCooldownsFromMap = (prev: SkillItem[], cdMap: SkillCooldownMapDto): SkillItem[] => {
  let changed = false;
  const next = prev.map((skill) => {
    const serverSkillId = skill.id === 'basic_attack' ? 'skill-normal-attack' : skill.id;
    const serverLeft = Math.max(0, Math.floor(Number(cdMap[serverSkillId]) || 0));
    if (skill.cooldownLeft === serverLeft) return skill;
    changed = true;
    return { ...skill, cooldownLeft: serverLeft };
  });
  return changed ? next : prev;
};

type SkillFloatButtonProps = {
  turn?: number;
  turnSide?: 'enemy' | 'ally';
  isMyTurn?: boolean;
  isBattleRunning?: boolean;
  /** 当前战斗阶段，用于 auto-release 在战斗结束后立即停止施法尝试 */
  battlePhase?: string;
  actionKey?: string | number;
  autoMode?: boolean;
  onAutoModeChange?: (auto: boolean) => void;
  onCastSkill?: (skillId: string, targetType?: string) => Promise<boolean>;
};

const SkillFloatButton: React.FC<SkillFloatButtonProps> = ({
  turn,
  turnSide,
  isMyTurn = false,
  isBattleRunning = false,
  battlePhase,
  actionKey,
  autoMode = false,
  onAutoModeChange,
  onCastSkill
}) => {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [characterId, setCharacterId] = useState<number | null>(() => gameSocket.getCharacter()?.id ?? null);
  const [skills, setSkills] = useState<SkillItem[]>(() => buildSkillItems([], [], []));
  const [isCasting, setIsCasting] = useState(false);
  const [localTurn, setLocalTurn] = useState(1);
  // 自动战斗状态（使用外部传入的 autoMode）
  const autoRelease = autoMode;
  const [panelShift, setPanelShift] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1280 : window.innerWidth,
    h: typeof window === 'undefined' ? 720 : window.innerHeight,
  }));
  const [pos, setPos] = useState(() => {
    if (typeof window === 'undefined') return { x: 16, y: 160 };
    return { x: Math.max(16, window.innerWidth - getFabSize() - 16), y: Math.round(window.innerHeight * 0.55) };
  });

  const panelRef = useRef<HTMLDivElement | null>(null);
  const lastExternalTurnRef = useRef<number | null>(turn ?? null);
  const lastBattleIdRef = useRef<string | null>(null);
  const skillsRef = useRef<SkillItem[]>(skills);
  const myLingqiRef = useRef<number>(0);
  const myQixueRef = useRef<number>(0);
  const lastAutoActionKeyRef = useRef<string | null>(null);
  const lastAutoAttemptKeyRef = useRef<string | null>(null);
  const autoRetryCountRef = useRef(0);
  const autoRetryTimerRef = useRef<number | null>(null);

  const dragRef = useRef<{
    pointerId: number | null;
    startX: number;
    startY: number;
    startPosX: number;
    startPosY: number;
    moved: boolean;
  }>({ pointerId: null, startX: 0, startY: 0, startPosX: 0, startPosY: 0, moved: false });

  useEffect(() => {
    skillsRef.current = skills;
  }, [skills]);

  useEffect(() => {
    gameSocket.connect();
    const unsubscribe = gameSocket.onCharacterUpdate((c) => {
      setCharacterId(c?.id ?? null);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setViewport({ w, h });
      setPos((p) => ({
        x: clamp(p.x, 0, Math.max(0, w - getFabSize())),
        y: clamp(p.y, 0, Math.max(0, h - getFabSize())),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const expandDirection: ExpandDirection = useMemo(() => {
    return pos.x + getFabSize() / 2 >= viewport.w / 2 ? 'left' : 'right';
  }, [pos.x, viewport.w]);

  const refreshSkillConfig = useCallback(async () => {
    if (!characterId) {
      setSkills((prev) => buildSkillItems([], [], prev));
      return;
    }
    try {
      const res = await getCharacterTechniqueStatus(characterId);
      if (!res?.success || !res.data) return;
      setSkills((prev) => buildSkillItems(res.data?.equippedSkills ?? [], res.data?.availableSkills ?? [], prev));
    } catch {
      setSkills((prev) => buildSkillItems([], [], prev));
    }
  }, [characterId]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void refreshSkillConfig();
    }, 0);
    return () => window.clearTimeout(t);
  }, [refreshSkillConfig]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      void refreshSkillConfig();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, refreshSkillConfig]);

  useEffect(() => {
    if (turn == null) {
      lastExternalTurnRef.current = null;
      return;
    }
    lastExternalTurnRef.current = turn;
  }, [turn]);

  // 订阅战斗状态更新，同步技能冷却
  // 注意：此 effect 不依赖 isBattleRunning，确保 battle_started 事件不会丢失
  // 技能冷却完全依赖服务端推送的 skillCooldowns 状态
  useEffect(() => {
    const syncFromState = (state: unknown) => {
      if (!isRecord(state)) return;
      const stateLike = state as BattleStateWithUnitsDto;
      const battleId = String(stateLike.battleId ?? '');
      if (!battleId) return;
      const currentBattleId = lastBattleIdRef.current;
      if (currentBattleId && currentBattleId !== battleId) return;
      if (!currentBattleId) lastBattleIdRef.current = battleId;

      const myCharacterId = gameSocket.getCharacter()?.id;
      if (!myCharacterId) return;
      const myUnitId = `player-${myCharacterId}`;
      const attackerUnitsRaw = stateLike.teams?.attacker?.units;
      const attackerUnits: BattleUnitWithCooldownDto[] = Array.isArray(attackerUnitsRaw)
        ? (attackerUnitsRaw as BattleUnitWithCooldownDto[])
        : [];
      const myUnit = attackerUnits.find((u) => String(u?.id ?? '') === myUnitId);
      if (!myUnit) return;

      const nextLingqi = Number(myUnit?.lingqi) || 0;
      const nextQixue = Number(myUnit?.qixue) || 0;
      const lingqiChanged = myLingqiRef.current !== nextLingqi;
      const qixueChanged = myQixueRef.current !== nextQixue;
      myLingqiRef.current = nextLingqi;
      myQixueRef.current = nextQixue;

      if (lingqiChanged || qixueChanged) {
        gameSocket.updateCharacterLocal({
          lingqi: nextLingqi,
          qixue: nextQixue,
        });
      }

      // 从服务端同步技能冷却（新战斗时 skillCooldowns 为 {}，所有技能冷却会被重置为 0）
      const cdMap = (isRecord(myUnit?.skillCooldowns) ? (myUnit.skillCooldowns as SkillCooldownMapDto) : {}) as SkillCooldownMapDto;
      setSkills((prev) => syncSkillCooldownsFromMap(prev, cdMap));
    };

    gameSocket.connect();
    const unsub = gameSocket.onBattleUpdate((raw) => {
      const data = (isRecord(raw) ? (raw as BattleUpdatePayloadDto) : null) as BattleUpdatePayloadDto | null;
      const kind = String(data?.kind ?? '');
      const state = data?.state ?? data?.data?.state;
      if (!state) return;
      if (kind === 'battle_started' || kind === 'battle_state' || kind === 'battle_finished') {
        syncFromState(state);
      }
    });

    return () => unsub();
    // 故意不依赖 isBattleRunning，确保订阅持续存在，避免 battle_started 事件丢失
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 追踪战斗 ID 变化，重置自动战斗状态
  useEffect(() => {
    if (!isBattleRunning) {
      lastBattleIdRef.current = null;
      return;
    }
    const rawKey = String(actionKey ?? '').trim();
    if (!rawKey) return;

    const matches = [...rawKey.matchAll(/-(\d+)-(attacker|defender)-(\d+)-/g)];
    const last = matches[matches.length - 1];
    if (!last || last.index == null) return;
    const battleId = rawKey.slice(0, last.index);
    if (!battleId) return;
    if (lastBattleIdRef.current === battleId) return;
    // 新战斗开始：重置自动战斗相关状态
    lastBattleIdRef.current = battleId;
    lastExternalTurnRef.current = turn ?? null;
    lastAutoActionKeyRef.current = null;
    lastAutoAttemptKeyRef.current = null;
    autoRetryCountRef.current = 0;
    // 注意：技能冷却完全依赖服务端推送的 skillCooldowns，不本地重置
  }, [actionKey, isBattleRunning, turn]);

  const nextLocalTurn = useCallback(() => {
    setLocalTurn((t) => t + 1);
  }, []);

  const castSkill = useCallback(
    async (skillId: string, notify: boolean): Promise<boolean> => {
      // 防止连续点击：正在释放技能时不允许再次释放
      if (isCasting) {
        if (notify) message.warning('技能释放中，请稍候');
        return false;
      }

      // 检查是否轮到玩家行动（战斗中）
      if (turn != null && isBattleRunning && !isMyTurn) {
        if (notify) message.warning('还没轮到你的回合');
        return false;
      }

      const target = skillsRef.current.find((s) => s.id === skillId);
      if (!target) return false;
      if (target.cooldownLeft > 0) {
        if (notify) message.info(`${target.name} 冷却中：${target.cooldownLeft}回合`);
        return false;
      }

      if (turn != null && onCastSkill) {
        setIsCasting(true);
        try {
          const ok = await onCastSkill(skillId, target.targetType);
          if (!ok) {
            if (notify) message.error('当前无法释放');
            return false;
          }
          if (notify) message.success(`已释放：${target.name}`);
          return true;
        } finally {
          setIsCasting(false);
        }
      } else {
        if (notify) message.success(`已释放：${target.name}`);
        return true;
      }
    },
    [isCasting, isBattleRunning, isMyTurn, message, onCastSkill, turn],
  );

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const el = panelRef.current;
      if (!el) return;
      const padding = 8;
      const r = el.getBoundingClientRect();
      let shiftX = 0;
      let shiftY = 0;
      if (r.left < padding) shiftX += padding - r.left;
      if (r.right > viewport.w - padding) shiftX -= r.right - (viewport.w - padding);
      if (r.top < padding) shiftY += padding - r.top;
      if (r.bottom > viewport.h - padding) shiftY -= r.bottom - (viewport.h - padding);
      setPanelShift((prev) => (prev.x === shiftX && prev.y === shiftY ? prev : { x: shiftX, y: shiftY }));
    }, 0);
    return () => window.clearTimeout(t);
  }, [autoRelease, expandDirection, open, pos.x, pos.y, skills, viewport.h, viewport.w]);

  // 自动战斗逻辑：当开启自动战斗且轮到玩家回合时，自动释放技能
  // 边界：battlePhase === 'finished' 时立即停止，防止战斗结束瞬间的渲染时序窗口内
  // isBattleRunning/isMyTurn 尚未更新导致无效施法尝试
  useEffect(() => {
    const key = String(actionKey ?? `${turn ?? localTurn}-${turnSide ?? ''}`);
    if (autoRetryTimerRef.current) {
      window.clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }

    // 战斗结束后立即停止 auto-release，不产生任何多余提示
    const isBattleFinished = battlePhase === 'finished';

    if (!autoRelease || !isBattleRunning || !isMyTurn || isCasting || isBattleFinished) {
      lastAutoAttemptKeyRef.current = null;
      autoRetryCountRef.current = 0;
      return;
    }

    if (lastAutoActionKeyRef.current === key) return;
    if (lastAutoAttemptKeyRef.current !== key) {
      lastAutoAttemptKeyRef.current = key;
      autoRetryCountRef.current = 0;
    }

    let cancelled = false;

    const attempt = async () => {
      if (cancelled) return;
      if (!autoRelease || !isBattleRunning || !isMyTurn || isCasting) return;

      const equipped = skillsRef.current.filter((s) => s.equipped);
      let ok = false;
      for (const s of equipped) {
        if (s.id === 'basic_attack') continue;
        if (s.cooldownLeft > 0) continue;
        if (s.costLingqi > 0 && myLingqiRef.current < s.costLingqi) continue;
        if (s.costQixue > 0 && myQixueRef.current <= s.costQixue) continue;
        ok = await castSkill(s.id, false);
        if (ok) break;
      }
      const finalOk = ok ? true : await castSkill('basic_attack', false);

      if (finalOk) {
        lastAutoActionKeyRef.current = key;
        autoRetryCountRef.current = 0;
        return;
      }

      autoRetryCountRef.current += 1;
      if (autoRetryCountRef.current >= 3) return;

      autoRetryTimerRef.current = window.setTimeout(() => {
        void attempt();
      }, 800);
    };

    autoRetryTimerRef.current = window.setTimeout(() => {
      void attempt();
    }, 450);

    return () => {
      cancelled = true;
      if (autoRetryTimerRef.current) {
        window.clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
    };
  }, [actionKey, autoRelease, battlePhase, castSkill, isBattleRunning, isCasting, isMyTurn, localTurn, turn, turnSide]);

  const onMainPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    dragRef.current.pointerId = e.pointerId;
    dragRef.current.startX = e.clientX;
    dragRef.current.startY = e.clientY;
    dragRef.current.startPosX = pos.x;
    dragRef.current.startPosY = pos.y;
    dragRef.current.moved = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onMainPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current.pointerId !== e.pointerId) return;

    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (!dragRef.current.moved && Math.hypot(dx, dy) >= 4) dragRef.current.moved = true;

    const nextX = clamp(dragRef.current.startPosX + dx, 0, Math.max(0, viewport.w - getFabSize()));
    const nextY = clamp(dragRef.current.startPosY + dy, 0, Math.max(0, viewport.h - getFabSize()));
    setPos({ x: nextX, y: nextY });
    e.preventDefault();
  };

  const onMainPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current.pointerId !== e.pointerId) return;
    dragRef.current.pointerId = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onMainClick = () => {
    if (dragRef.current.moved) return;
    setOpen((v) => {
      const next = !v;
      if (!next) setPanelShift({ x: 0, y: 0 });
      return next;
    });
  };

  const renderPanel = () => (
    <div
      ref={panelRef}
      className={`skill-fab-panel ${expandDirection === 'left' ? 'is-left' : 'is-right'}`}
      style={
        {
          ['--skill-fab-shift-x' as string]: `${panelShift.x}px`,
          ['--skill-fab-shift-y' as string]: `${panelShift.y}px`,
        } as CSSProperties
      }
      role="group"
      aria-label="技能栏"
    >
      <button
        type="button"
        className={`skill-fab-tile skill-fab-action ${autoRelease ? 'is-on' : ''}`}
        onClick={() => onAutoModeChange?.(!autoRelease)}
      >
        <div className="skill-fab-tile-label">自动</div>
        <div className="skill-fab-tile-sub">{autoRelease ? '开启' : '关闭'}</div>
      </button>
      {skills
        .filter((s) => s.equipped)
        .map((s) => {
          // 禁用条件：冷却中、正在释放、战斗中但不是玩家回合
          const isDisabled = s.cooldownLeft > 0 || isCasting || (turn != null && isBattleRunning && !isMyTurn);
          const effectLines = formatSkillEffectLines(s.effects, {
            damageType: s.damageType,
            element: s.element,
          });
          const hasCost = s.costLingqi > 0 || s.costQixue > 0;
          const hasCooldown = s.cooldownTurns > 0;
          const elementLabel = formatElement(s.element);
          const hasElement = elementLabel !== '无';
          const targetLabel = formatTargetType(s.targetType) + (s.targetCount > 1 ? `×${s.targetCount}` : '');
          const tooltipTitle = (
            <div className="skill-fab-tooltip-content">
              <div className="skill-fab-tooltip-title">{s.name}</div>
              <div className="skill-fab-tooltip-meta">
                {hasCost && (
                  <div className="skill-fab-tooltip-row">
                    <span className="skill-fab-tooltip-label">消耗</span>
                    <span className="skill-fab-tooltip-value">
                      {s.costLingqi > 0 && <span className="skill-fab-tooltip-chip is-lingqi">灵气 {s.costLingqi}</span>}
                      {s.costQixue > 0 && <span className="skill-fab-tooltip-chip is-qixue">气血 {s.costQixue}</span>}
                    </span>
                  </div>
                )}
                {hasCooldown && (
                  <div className="skill-fab-tooltip-row">
                    <span className="skill-fab-tooltip-label">冷却</span>
                    <span className="skill-fab-tooltip-value">{s.cooldownTurns}回合</span>
                  </div>
                )}
                <div className="skill-fab-tooltip-row">
                  <span className="skill-fab-tooltip-label">类型</span>
                  <span className="skill-fab-tooltip-value">
                    <span className="skill-fab-tooltip-chip">{formatDamageType(s.damageType)}</span>
                    <span className="skill-fab-tooltip-chip">{targetLabel}</span>
                    {hasElement && <span className="skill-fab-tooltip-chip is-element">{elementLabel}</span>}
                  </span>
                </div>
              </div>
              {effectLines.length > 0 && (
                <div className="skill-fab-tooltip-effects">
                  {effectLines.map((line, idx) => (
                    <div key={`${s.id}-effect-${idx}`} className="skill-fab-tooltip-effect-line">
                      {line}
                    </div>
                  ))}
                </div>
              )}
              {s.description ? <div className="skill-fab-tooltip-desc">{s.description}</div> : null}
            </div>
          );
          return (
            <Tooltip
              key={s.id}
              title={tooltipTitle}
              placement={expandDirection === 'left' ? 'left' : 'right'}
              overlayClassName={SKILL_FAB_TOOLTIP_CLASS_NAMES.root}
              classNames={SKILL_FAB_TOOLTIP_CLASS_NAMES}
            >
              <span style={{ display: 'inline-block' }}>
                <button
                  type="button"
                  className={`skill-fab-tile skill-fab-skill-tile ${s.cooldownLeft > 0 ? 'is-cd' : ''} ${isDisabled && s.cooldownLeft === 0 ? 'is-waiting' : ''}`}
                  onClick={() => void castSkill(s.id, true)}
                  disabled={isDisabled}
                >
                  {s.icon ? <img className="skill-fab-tile-icon" src={s.icon} alt={s.name} /> : <div className="skill-fab-tile-icon" />}
                  <div className="skill-fab-tile-name">{s.name}</div>
                  {s.cooldownLeft > 0 ? <div className="skill-fab-tile-cd">{s.cooldownLeft}</div> : null}
                  {isCasting ? <div className="skill-fab-tile-casting">...</div> : null}
                </button>
              </span>
            </Tooltip>
          );
        })}
      {turn != null ? (
        <button type="button" className="skill-fab-tile skill-fab-action" disabled>
          <div className="skill-fab-tile-label">回合</div>
          <div className="skill-fab-tile-sub">{turn}</div>
        </button>
      ) : (
        <button type="button" className="skill-fab-tile skill-fab-action" onClick={nextLocalTurn}>
          <div className="skill-fab-tile-label">回合</div>
          <div className="skill-fab-tile-sub">+1（{localTurn}）</div>
        </button>
      )}
    </div>
  );

  return (
    <div
      className={`skill-fab ${open ? 'is-open' : ''} ${expandDirection === 'left' ? 'dir-left' : 'dir-right'}`}
      style={{ left: pos.x, top: pos.y }}
    >
      <button
        type="button"
        className="skill-fab-main"
        onPointerDown={onMainPointerDown}
        onPointerMove={onMainPointerMove}
        onPointerUp={onMainPointerUp}
        onPointerCancel={onMainPointerUp}
        onClick={onMainClick}
        aria-label="技能"
      >
        技
      </button>
      {open ? renderPanel() : null}
    </div>
  );
};

export default memo(SkillFloatButton);
