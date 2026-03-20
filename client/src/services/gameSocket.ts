/**
 * 游戏Socket服务 - 实时数据同步
 */
import { io, Socket } from "socket.io-client";
import { SERVER_BASE } from "./api";
import type {
  GameTimeSnapshotDto,
  MailUnreadResponse,
  PartnerFusionStatusResponse,
  PartnerRecruitStatusResponse,
  TechniqueResearchStatusResponse,
} from "./api";
import {
  type BattleRealtimePayload,
  type BattleRealtimeStatePayload,
  type BattleRealtimeWirePayload,
  normalizeBattleRealtimePayload,
} from "./battleRealtime";
import type { CharacterFeatureCode } from "./feature";

const isLoopbackHostname = (hostname: string): boolean => {
  const h = String(hostname || "")
    .trim()
    .toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
};

const normalizeBaseUrl = (raw: string): string => {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.replace(/\/+$/, "");
};

const resolveGameSocketUrl = (): string => {
  const fromEnv = normalizeBaseUrl(
    (import.meta.env.VITE_SOCKET_URL as string | undefined) ?? "",
  );
  const fromApi = normalizeBaseUrl(SERVER_BASE);

  if (typeof window === "undefined" || !window.location) {
    return fromEnv || fromApi || "http://localhost:6011";
  }

  const protocol = window.location.protocol || "http:";
  const hostname = window.location.hostname;

  // 生产环境使用同域名，开发环境使用 6011 端口
  const isDev = isLoopbackHostname(hostname);
  const runtimeDefault = isDev
    ? `${protocol}//${hostname}:6011`
    : `${protocol}//${hostname}`;

  const base = fromEnv || fromApi || runtimeDefault;

  try {
    const url = new URL(base);
    if (isLoopbackHostname(url.hostname) && !isLoopbackHostname(hostname)) {
      url.hostname = hostname;
      return normalizeBaseUrl(url.toString());
    }
    return normalizeBaseUrl(url.toString());
  } catch {
    if (base.startsWith("/"))
      return normalizeBaseUrl(`${window.location.origin}${base}`);
    return base;
  }
};

const GAME_SOCKET_URL = resolveGameSocketUrl();

// 角色属性接口
export interface CharacterData {
  id: number;
  userId: number;
  nickname: string;
  monthCardActive: boolean;
  title: string;
  gender: string;
  avatar: string | null;
  autoCastSkills: boolean;
  autoDisassembleEnabled: boolean;
  dungeonNoStaminaCost: boolean;
  spiritStones: number;
  silver: number;
  stamina: number;
  staminaMax: number;
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
  jianbaoshang: number;
  jianfantan: number;
  kangbao: number;
  zengshang: number;
  zhiliao: number;
  jianliao: number;
  xixue: number;
  lengque: number;
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
  featureUnlocks: CharacterFeatureCode[];
}

type CharacterListener = (character: CharacterData | null) => void;
type ErrorListener = (error: { message: string }) => void;
type KickedListener = (data: { message: string }) => void;
type TeamUpdateListener = (data: unknown) => void;
type AuthReadyListener = () => void;
export interface SectIndicatorPayload {
  joined: boolean;
  myPendingApplicationCount: number;
  sectPendingApplicationCount: number;
  canManageApplications: boolean;
}
type BattleUpdateListener = (data: BattleRealtimePayload) => void;
export type BattleCooldownState =
  | {
      kind: "sync";
      characterId: number;
      remainingMs: number;
      timestamp: number;
      active: true;
    }
  | {
      kind: "ready";
      characterId: number;
      remainingMs: 0;
      timestamp: number;
      active: false;
    };
type BattleCooldownListener = (data: BattleCooldownState) => void;
type ArenaUpdateListener = (data: unknown) => void;
type SectUpdateListener = (data: SectIndicatorPayload) => void;
export type ChatChannel = "world" | "team" | "sect" | "private" | "battle";

export interface ChatMessageDto {
  id: string;
  clientId?: string;
  channel: ChatChannel;
  content: string;
  timestamp: number;
  senderUserId: number;
  senderCharacterId: number;
  senderName: string;
  senderMonthCardActive: boolean;
  senderTitle: string;
  pmTargetCharacterId?: number;
}

type ChatMessageListener = (message: ChatMessageDto) => void;
type ChatErrorListener = (error: { message: string }) => void;

// ============================================
// 挂机战斗 Socket 事件类型
// ============================================

/**
 * idle:update — 每场战斗完成后服务端推送的收益摘要
 * 复用点：useIdleBattle Hook 订阅此事件更新实时状态
 */
export interface IdleUpdatePayload {
  sessionId: string;
  batchIndex: number;
  result: "attacker_win" | "defender_win" | "draw";
  expGained: number;
  silverGained: number;
  itemsGained: Array<{ itemDefId: string; itemName: string; quantity: number }>;
  roundCount: number;
}

/**
 * idle:finished — 挂机会话结束时推送（时长超限/用户停止）
 */
export interface IdleFinishedPayload {
  sessionId: string;
  reason: "duration_exceeded" | "user_stopped" | "session_not_found";
}

type IdleUpdateListener = (data: IdleUpdatePayload) => void;
type IdleFinishedListener = (data: IdleFinishedPayload) => void;
export type MailIndicatorPayload = NonNullable<MailUnreadResponse["data"]>;
type MailUpdateListener = (data: MailIndicatorPayload) => void;
export interface AchievementUpdatePayload {
  characterId: number;
  claimableCount: number;
}
type LatestEventReplayOptions = {
  emitCurrent?: boolean;
};
type AchievementUpdateListener = (data: AchievementUpdatePayload) => void;
export type TaskOverviewScope = "task" | "bounty";
export interface TaskOverviewUpdatePayload {
  characterId: number;
  scopes: TaskOverviewScope[];
}
type TaskOverviewUpdateListener = (data: TaskOverviewUpdatePayload) => void;
export type GameTimeSyncPayload = GameTimeSnapshotDto;
type GameTimeSyncListener = (data: GameTimeSyncPayload) => void;

export interface TechniqueResearchResultPayload {
  characterId: number;
  generationId: string;
  status: 'generated_draft' | 'failed';
  hasUnreadResult: true;
  message: string;
  preview?: {
    aiSuggestedName: string;
    quality: '黄' | '玄' | '地' | '天';
    type: string;
    maxLayer: number;
  };
  errorMessage?: string;
}

type TechniqueResearchResultListener = (data: TechniqueResearchResultPayload) => void;
export type TechniqueResearchStatusPayload = {
  characterId: number;
  status: NonNullable<TechniqueResearchStatusResponse["data"]>;
};
type TechniqueResearchStatusListener = (
  data: TechniqueResearchStatusPayload,
) => void;

export interface PartnerRecruitResultPayload {
  characterId: number;
  generationId: string;
  status: 'generated_draft' | 'failed';
  hasUnreadResult: true;
  message: string;
  preview?: {
    name: string;
    quality: '黄' | '玄' | '地' | '天';
    role: string;
    element: string;
  };
  errorMessage?: string;
}

type PartnerRecruitResultListener = (data: PartnerRecruitResultPayload) => void;
export type PartnerRecruitStatusPayload = {
  characterId: number;
  status: NonNullable<PartnerRecruitStatusResponse["data"]>;
};
type PartnerRecruitStatusListener = (data: PartnerRecruitStatusPayload) => void;

export interface PartnerFusionResultPayload {
  characterId: number;
  fusionId: string;
  status: 'generated_preview' | 'failed';
  hasUnreadResult: true;
  message: string;
  preview?: {
    name: string;
    quality: '黄' | '玄' | '地' | '天';
    role: string;
    element: string;
  };
  errorMessage?: string;
}

type PartnerFusionResultListener = (data: PartnerFusionResultPayload) => void;
export type PartnerFusionStatusPayload = {
  characterId: number;
  status: NonNullable<PartnerFusionStatusResponse["data"]>;
};
type PartnerFusionStatusListener = (data: PartnerFusionStatusPayload) => void;

export interface OnlinePlayerDto {
  id: number;
  nickname: string;
  monthCardActive: boolean;
  title: string;
  realm: string;
}

export interface OnlinePlayersPayloadDto {
  total: number;
  players: OnlinePlayerDto[];
}

type OnlinePlayersListener = (payload: OnlinePlayersPayloadDto) => void;

class GameSocketService {
  private socket: Socket | null = null;
  private characterListeners: Set<CharacterListener> = new Set();
  private errorListeners: Set<ErrorListener> = new Set();
  private kickedListeners: Set<KickedListener> = new Set();
  private teamUpdateListeners: Set<TeamUpdateListener> = new Set();
  private authReadyListeners: Set<AuthReadyListener> = new Set();
  private sectUpdateListeners: Set<SectUpdateListener> = new Set();
  private battleUpdateListeners: Set<BattleUpdateListener> = new Set();
  private battleCooldownListeners: Set<BattleCooldownListener> = new Set();
  private arenaUpdateListeners: Set<ArenaUpdateListener> = new Set();
  private chatMessageListeners: Set<ChatMessageListener> = new Set();
  private chatErrorListeners: Set<ChatErrorListener> = new Set();
  private onlinePlayersListeners: Set<OnlinePlayersListener> = new Set();
  private idleUpdateListeners: Set<IdleUpdateListener> = new Set();
  private idleFinishedListeners: Set<IdleFinishedListener> = new Set();
  private mailUpdateListeners: Set<MailUpdateListener> = new Set();
  private achievementUpdateListeners: Set<AchievementUpdateListener> = new Set();
  private taskOverviewUpdateListeners: Set<TaskOverviewUpdateListener> = new Set();
  private gameTimeSyncListeners: Set<GameTimeSyncListener> = new Set();
  private techniqueResearchResultListeners: Set<TechniqueResearchResultListener> = new Set();
  private techniqueResearchStatusListeners: Set<TechniqueResearchStatusListener> =
    new Set();
  private partnerRecruitResultListeners: Set<PartnerRecruitResultListener> = new Set();
  private partnerRecruitStatusListeners: Set<PartnerRecruitStatusListener> =
    new Set();
  private partnerFusionResultListeners: Set<PartnerFusionResultListener> = new Set();
  private partnerFusionStatusListeners: Set<PartnerFusionStatusListener> =
    new Set();
  private currentCharacter: CharacterData | null = null;
  private currentSectIndicator: SectIndicatorPayload | null = null;
  private currentOnlinePlayers: OnlinePlayersPayloadDto | null = null;
  private currentMailIndicator: MailIndicatorPayload | null = null;
  private currentAchievementUpdate: AchievementUpdatePayload | null = null;
  private currentGameTimeSync: GameTimeSyncPayload | null = null;
  private currentTechniqueResearchStatus: TechniqueResearchStatusPayload | null =
    null;
  private currentPartnerRecruitStatus: PartnerRecruitStatusPayload | null = null;
  private currentPartnerFusionStatus: PartnerFusionStatusPayload | null = null;
  private currentBattleUpdate: BattleRealtimePayload | null = null;
  private currentBattleCooldownState: BattleCooldownState | null = null;
  /** 本地在线玩家索引，用于增量合并 delta 消息 */
  private onlinePlayersMap: Map<number, OnlinePlayerDto> = new Map();
  private isConnected = false;

  // 连接游戏服务器
  connect(): void {
    const token = localStorage.getItem("token");
    if (!token) {
      if (this.socket) this.disconnect();
      console.warn("未登录，无法连接游戏服务器");
      return;
    }

    if (this.socket) {
      if (this.socket.connected) return;
      this.socket.connect();
      return;
    }

    this.socket = io(GAME_SOCKET_URL, {
      path: "/game-socket",
      transports: ["websocket", "polling"],
      autoConnect: false,
    });

    this.socket.on("connect", () => {
      console.log("游戏服务器已连接");
      this.isConnected = true;
      // 发送认证
      const latestToken = localStorage.getItem("token");
      if (latestToken) this.socket?.emit("game:auth", latestToken);
    });

    this.socket.on("disconnect", () => {
      console.log("游戏服务器已断开");
      this.isConnected = false;
      this.currentSectIndicator = null;
      this.currentOnlinePlayers = null;
      this.currentMailIndicator = null;
      this.currentAchievementUpdate = null;
      this.currentGameTimeSync = null;
      this.currentTechniqueResearchStatus = null;
      this.currentPartnerRecruitStatus = null;
      this.currentPartnerFusionStatus = null;
      this.currentBattleUpdate = null;
      this.currentBattleCooldownState = null;
    });

    this.socket.on(
      "game:character",
      (data: {
        type?: "full" | "delta";
        character?: CharacterData | null;
        delta?: Partial<CharacterData> & { id: number };
      }) => {
        if (data.type === "delta" && data.delta && this.currentCharacter) {
          // 增量合并：仅更新变化字段
          this.currentCharacter = { ...this.currentCharacter, ...data.delta };
        } else {
          // 全量替换（含 type="full" 及无 type 的兼容场景）
          this.currentCharacter = data.character ?? null;
        }
        this.notifyCharacterListeners(this.currentCharacter);
      },
    );

    this.socket.on("game:error", (error: { message: string }) => {
      console.error("游戏错误:", error.message);
      this.notifyErrorListeners(error);
    });

    // 被踢出处理
    this.socket.on("game:kicked", (data: { message: string }) => {
      console.warn("被踢出:", data.message);
      this.notifyKickedListeners(data);
    });

    this.socket.on("team:update", (data: unknown) => {
      this.notifyTeamUpdateListeners(data);
    });

    this.socket.on("game:auth-ready", () => {
      this.notifyAuthReadyListeners();
    });

    this.socket.on(
      "sect:update",
      (data: {
        joined?: boolean;
        myPendingApplicationCount?: number;
        sectPendingApplicationCount?: number;
        canManageApplications?: boolean;
      }) => {
        const normalizeCount = (value: number | undefined): number => {
          const next = Number(value);
          if (!Number.isFinite(next)) return 0;
          return Math.max(0, Math.floor(next));
        };
        const payload: SectIndicatorPayload = {
          joined: Boolean(data.joined),
          myPendingApplicationCount: normalizeCount(data.myPendingApplicationCount),
          sectPendingApplicationCount: normalizeCount(data.sectPendingApplicationCount),
          canManageApplications: Boolean(data.canManageApplications),
        };
        this.currentSectIndicator = payload;
        this.notifySectUpdateListeners(payload);
      },
    );

    this.socket.on("battle:update", (data: BattleRealtimeWirePayload) => {
      const incomingBattleId =
        typeof data.battleId === "string" ? data.battleId : "";
      const previous =
        this.currentBattleUpdate &&
        this.currentBattleUpdate.kind !== "battle_abandoned" &&
        this.currentBattleUpdate.battleId === incomingBattleId
          ? this.currentBattleUpdate
          : null;
      const normalized = normalizeBattleRealtimePayload(
        data,
        previous as BattleRealtimeStatePayload | null,
      );
      if (!normalized) return;
      this.currentBattleUpdate = normalized;
      this.notifyBattleUpdateListeners(normalized);
    });

    this.socket.on("arena:update", (data: unknown) => {
      this.notifyArenaUpdateListeners(data);
    });

    this.socket.on("idle:update", (data: IdleUpdatePayload) => {
      this.notifyIdleUpdateListeners(data);
    });

    this.socket.on("idle:finished", (data: IdleFinishedPayload) => {
      this.notifyIdleFinishedListeners(data);
    });

    this.socket.on("mail:update", (data: MailIndicatorPayload) => {
      this.currentMailIndicator = data;
      this.notifyMailUpdateListeners(data);
    });

    this.socket.on("achievement:update", (data: AchievementUpdatePayload) => {
      this.currentAchievementUpdate = data;
      this.notifyAchievementUpdateListeners(data);
    });

    this.socket.on("task:update", (data: TaskOverviewUpdatePayload) => {
      this.notifyTaskOverviewUpdateListeners(data);
    });

    this.socket.on("game:time-sync", (data: GameTimeSyncPayload) => {
      this.currentGameTimeSync = data;
      this.notifyGameTimeSyncListeners(data);
    });

    this.socket.on("techniqueResearchResult", (data: TechniqueResearchResultPayload) => {
      this.notifyTechniqueResearchResultListeners(data);
    });

    this.socket.on(
      "techniqueResearch:update",
      (data: TechniqueResearchStatusPayload) => {
        this.currentTechniqueResearchStatus = data;
        this.notifyTechniqueResearchStatusListeners(data);
      },
    );

    this.socket.on("partnerRecruitResult", (data: PartnerRecruitResultPayload) => {
      this.notifyPartnerRecruitResultListeners(data);
    });

    this.socket.on(
      "partnerRecruit:update",
      (data: PartnerRecruitStatusPayload) => {
        this.currentPartnerRecruitStatus = data;
        this.notifyPartnerRecruitStatusListeners(data);
      },
    );

    this.socket.on("partnerFusionResult", (data: PartnerFusionResultPayload) => {
      this.notifyPartnerFusionResultListeners(data);
    });

    this.socket.on(
      "partnerFusion:update",
      (data: PartnerFusionStatusPayload) => {
        this.currentPartnerFusionStatus = data;
        this.notifyPartnerFusionStatusListeners(data);
      },
    );

    this.socket.on("chat:message", (data: ChatMessageDto) => {
      if (!data || typeof data !== "object") return;
      this.notifyChatMessageListeners(data);
    });

    this.socket.on("chat:error", (error: { message: string }) => {
      this.notifyChatErrorListeners(error);
    });

    this.socket.on("game:onlinePlayers", (payload: unknown) => {
      const isRecord = (v: unknown): v is Record<string, unknown> =>
        !!v && typeof v === "object" && !Array.isArray(v);
      const toStringSafe = (v: unknown): string =>
        typeof v === "string" ? v : String(v ?? "");
      const toNumberSafe = (v: unknown): number | null => {
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v === "string") {
          const s = v.trim();
          if (!s) return null;
          const n = Number(s);
          return Number.isFinite(n) ? n : null;
        }
        return null;
      };
      const parsePlayerDto = (item: unknown): OnlinePlayerDto | null => {
        if (!isRecord(item)) return null;
        const id = toNumberSafe(item.id);
        if (!id || id <= 0) return null;
        const nickname = toStringSafe(item.nickname).trim();
        if (!nickname) return null;
        const monthCardActive = item.monthCardActive === true;
        const title = toStringSafe(item.title).trim();
        const realm = toStringSafe(item.realm).trim();
        return { id, nickname, monthCardActive, title, realm };
      };

      if (!isRecord(payload)) return;
      const totalRaw = toNumberSafe(payload.total);
      const type = typeof payload.type === "string" ? payload.type : "full";

      if (type === "delta") {
        // 增量合并：joined / left / updated
        const joinedRaw = Array.isArray(payload.joined) ? payload.joined : [];
        const leftRaw = Array.isArray(payload.left) ? payload.left : [];
        const updatedRaw = Array.isArray(payload.updated)
          ? payload.updated
          : [];

        for (const raw of leftRaw) {
          const id = toNumberSafe(raw);
          if (id && id > 0) this.onlinePlayersMap.delete(id);
        }
        for (const raw of joinedRaw) {
          const dto = parsePlayerDto(raw);
          if (dto) this.onlinePlayersMap.set(dto.id, dto);
        }
        for (const raw of updatedRaw) {
          const dto = parsePlayerDto(raw);
          if (dto) this.onlinePlayersMap.set(dto.id, dto);
        }
      } else {
        // 全量替换
        this.onlinePlayersMap.clear();
        const playersRaw = Array.isArray(payload.players)
          ? payload.players
          : [];
        for (const raw of playersRaw) {
          const dto = parsePlayerDto(raw);
          if (dto) this.onlinePlayersMap.set(dto.id, dto);
        }
      }

      const players = Array.from(this.onlinePlayersMap.values()).sort((a, b) =>
        a.nickname.localeCompare(b.nickname, "zh-Hans-CN"),
      );
      this.currentOnlinePlayers = {
        total: totalRaw ?? players.length,
        players,
      };
      this.notifyOnlinePlayersListeners(this.currentOnlinePlayers);
    });

    // 战斗冷却结束推送
    this.socket.on(
      "battle:cooldown-ready",
      (data: { characterId: number; timestamp: number }) => {
        const payload: BattleCooldownState = {
          kind: "ready",
          characterId: data.characterId,
          remainingMs: 0,
          timestamp: data.timestamp,
          active: false,
        };
        this.currentBattleCooldownState = payload;
        this.notifyBattleCooldownListeners(payload);
      },
    );

    // 重连时的冷却状态同步
    this.socket.on(
      "battle:cooldown-sync",
      (data: {
        characterId: number;
        remainingMs: number;
        timestamp: number;
      }) => {
        const payload: BattleCooldownState = {
          kind: "sync",
          characterId: data.characterId,
          remainingMs: Math.max(0, Math.floor(data.remainingMs)),
          timestamp: data.timestamp,
          active: true,
        };
        this.currentBattleCooldownState = payload;
        this.notifyBattleCooldownListeners(payload);
      },
    );

    this.socket.connect();
  }

  // 断开连接
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
      this.currentCharacter = null;
      this.currentSectIndicator = null;
      this.currentOnlinePlayers = null;
      this.currentMailIndicator = null;
      this.currentAchievementUpdate = null;
      this.currentGameTimeSync = null;
      this.currentTechniqueResearchStatus = null;
      this.currentPartnerRecruitStatus = null;
      this.currentPartnerFusionStatus = null;
      this.currentBattleUpdate = null;
      this.currentBattleCooldownState = null;
      this.onlinePlayersMap.clear();
    }
  }

  // 请求刷新角色数据
  refreshCharacter(): void {
    if (this.socket?.connected) {
      this.socket.emit("game:refresh");
    }
  }

  // 加点请求
  addPoint(attribute: "jing" | "qi" | "shen", amount: number = 1): void {
    if (this.socket?.connected) {
      this.socket.emit("game:addPoint", { attribute, amount });
    }
  }

  // 订阅角色数据变化
  onCharacterUpdate(listener: CharacterListener): () => void {
    this.characterListeners.add(listener);
    // 立即发送当前数据
    if (this.currentCharacter) {
      listener(this.currentCharacter);
    }
    return () => this.characterListeners.delete(listener);
  }

  // 订阅错误
  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  // 订阅被踢出事件
  onKicked(listener: KickedListener): () => void {
    this.kickedListeners.add(listener);
    return () => this.kickedListeners.delete(listener);
  }

  onTeamUpdate(listener: TeamUpdateListener): () => void {
    this.teamUpdateListeners.add(listener);
    return () => this.teamUpdateListeners.delete(listener);
  }

  onAuthReady(listener: AuthReadyListener): () => void {
    this.authReadyListeners.add(listener);
    return () => this.authReadyListeners.delete(listener);
  }

  onSectUpdate(listener: SectUpdateListener): () => void {
    this.sectUpdateListeners.add(listener);
    if (this.currentSectIndicator) {
      listener(this.currentSectIndicator);
    }
    return () => this.sectUpdateListeners.delete(listener);
  }

  onBattleUpdate(listener: BattleUpdateListener): () => void {
    this.battleUpdateListeners.add(listener);
    if (this.currentBattleUpdate) {
      listener(this.currentBattleUpdate);
    }
    return () => this.battleUpdateListeners.delete(listener);
  }

  onBattleCooldown(listener: BattleCooldownListener): () => void {
    this.battleCooldownListeners.add(listener);
    if (this.currentBattleCooldownState) {
      listener(this.currentBattleCooldownState);
    }
    return () => this.battleCooldownListeners.delete(listener);
  }

  getLatestBattleUpdate(battleId?: string): BattleRealtimePayload | null {
    if (!this.currentBattleUpdate) return null;
    if (!battleId) return this.currentBattleUpdate;
    return this.currentBattleUpdate.battleId === battleId
      ? this.currentBattleUpdate
      : null;
  }

  getLatestBattleCooldown(): BattleCooldownState | null {
    return this.currentBattleCooldownState;
  }

  requestBattleSync(battleId: string): void {
    const normalizedBattleId = String(battleId ?? "").trim();
    if (!normalizedBattleId || !this.socket?.connected) return;
    this.socket.emit("battle:sync", { battleId: normalizedBattleId });
  }

  onArenaUpdate(listener: ArenaUpdateListener): () => void {
    this.arenaUpdateListeners.add(listener);
    return () => this.arenaUpdateListeners.delete(listener);
  }

  onIdleUpdate(listener: IdleUpdateListener): () => void {
    this.idleUpdateListeners.add(listener);
    return () => this.idleUpdateListeners.delete(listener);
  }

  onIdleFinished(listener: IdleFinishedListener): () => void {
    this.idleFinishedListeners.add(listener);
    return () => this.idleFinishedListeners.delete(listener);
  }

  onMailUpdate(listener: MailUpdateListener): () => void {
    this.mailUpdateListeners.add(listener);
    if (this.currentMailIndicator) {
      listener(this.currentMailIndicator);
    }
    return () => this.mailUpdateListeners.delete(listener);
  }

  onAchievementUpdate(
    listener: AchievementUpdateListener,
    options?: LatestEventReplayOptions,
  ): () => void {
    this.achievementUpdateListeners.add(listener);
    if (options?.emitCurrent !== false && this.currentAchievementUpdate) {
      listener(this.currentAchievementUpdate);
    }
    return () => this.achievementUpdateListeners.delete(listener);
  }

  onGameTimeSync(listener: GameTimeSyncListener): () => void {
    this.gameTimeSyncListeners.add(listener);
    if (this.currentGameTimeSync) {
      listener(this.currentGameTimeSync);
    }
    return () => this.gameTimeSyncListeners.delete(listener);
  }

  onTaskOverviewUpdate(listener: TaskOverviewUpdateListener): () => void {
    this.taskOverviewUpdateListeners.add(listener);
    return () => this.taskOverviewUpdateListeners.delete(listener);
  }

  onTechniqueResearchResult(listener: TechniqueResearchResultListener): () => void {
    this.techniqueResearchResultListeners.add(listener);
    return () => this.techniqueResearchResultListeners.delete(listener);
  }

  onTechniqueResearchStatusUpdate(
    listener: TechniqueResearchStatusListener,
  ): () => void {
    this.techniqueResearchStatusListeners.add(listener);
    if (this.currentTechniqueResearchStatus) {
      listener(this.currentTechniqueResearchStatus);
    }
    return () => this.techniqueResearchStatusListeners.delete(listener);
  }

  onPartnerRecruitResult(listener: PartnerRecruitResultListener): () => void {
    this.partnerRecruitResultListeners.add(listener);
    return () => this.partnerRecruitResultListeners.delete(listener);
  }

  onPartnerRecruitStatusUpdate(
    listener: PartnerRecruitStatusListener,
  ): () => void {
    this.partnerRecruitStatusListeners.add(listener);
    if (this.currentPartnerRecruitStatus) {
      listener(this.currentPartnerRecruitStatus);
    }
    return () => this.partnerRecruitStatusListeners.delete(listener);
  }

  onPartnerFusionResult(listener: PartnerFusionResultListener): () => void {
    this.partnerFusionResultListeners.add(listener);
    return () => this.partnerFusionResultListeners.delete(listener);
  }

  onPartnerFusionStatusUpdate(
    listener: PartnerFusionStatusListener,
  ): () => void {
    this.partnerFusionStatusListeners.add(listener);
    if (this.currentPartnerFusionStatus) {
      listener(this.currentPartnerFusionStatus);
    }
    return () => this.partnerFusionStatusListeners.delete(listener);
  }

  onChatMessage(listener: ChatMessageListener): () => void {
    this.chatMessageListeners.add(listener);
    return () => this.chatMessageListeners.delete(listener);
  }

  onChatError(listener: ChatErrorListener): () => void {
    this.chatErrorListeners.add(listener);
    return () => this.chatErrorListeners.delete(listener);
  }

  onOnlinePlayersUpdate(listener: OnlinePlayersListener): () => void {
    this.onlinePlayersListeners.add(listener);
    if (this.currentOnlinePlayers) {
      listener(this.currentOnlinePlayers);
    } else if (this.socket?.connected) {
      this.socket.emit("game:onlinePlayers:request");
    }
    return () => this.onlinePlayersListeners.delete(listener);
  }

  requestOnlinePlayers(): void {
    if (!this.socket?.connected) return;
    this.socket.emit("game:onlinePlayers:request");
  }

  sendChatMessage(payload: {
    channel: ChatChannel;
    content: string;
    clientId: string;
    pmTargetCharacterId?: number;
  }): void {
    if (!this.socket?.connected) return;
    this.socket.emit("chat:send", payload);
  }

  // 获取当前角色数据
  getCharacter(): CharacterData | null {
    return this.currentCharacter;
  }

  updateCharacterLocal(patch: Partial<CharacterData>): void {
    if (!this.currentCharacter) return;
    const entries = Object.entries(patch) as Array<
      [keyof CharacterData, CharacterData[keyof CharacterData] | undefined]
    >;
    if (entries.length === 0) return;

    const assignCharacterField = <K extends keyof CharacterData>(
      target: CharacterData,
      key: K,
      value: CharacterData[K],
    ) => {
      target[key] = value;
    };

    let changed = false;
    const nextCharacter: CharacterData = { ...this.currentCharacter };
    for (const [key, nextValue] of entries) {
      if (nextValue === undefined) continue;
      const prevValue = this.currentCharacter[key];
      if (Object.is(prevValue, nextValue)) continue;
      assignCharacterField(
        nextCharacter,
        key,
        nextValue as CharacterData[typeof key],
      );
      changed = true;
    }

    if (!changed) return;
    this.currentCharacter = nextCharacter;
    this.notifyCharacterListeners(nextCharacter);
  }

  // 是否已连接
  isSocketConnected(): boolean {
    return this.isConnected;
  }

  private notifyCharacterListeners(character: CharacterData | null): void {
    this.characterListeners.forEach((listener) => listener(character));
  }

  private notifyErrorListeners(error: { message: string }): void {
    this.errorListeners.forEach((listener) => listener(error));
  }

  private notifyKickedListeners(data: { message: string }): void {
    this.kickedListeners.forEach((listener) => listener(data));
  }

  private notifyTeamUpdateListeners(data: unknown): void {
    this.teamUpdateListeners.forEach((listener) => listener(data));
  }

  private notifyAuthReadyListeners(): void {
    this.authReadyListeners.forEach((listener) => listener());
  }

  private notifySectUpdateListeners(data: SectIndicatorPayload): void {
    this.sectUpdateListeners.forEach((listener) => listener(data));
  }

  private notifyBattleUpdateListeners(data: BattleRealtimePayload): void {
    this.battleUpdateListeners.forEach((listener) => listener(data));
  }

  private notifyBattleCooldownListeners(data: BattleCooldownState): void {
    this.battleCooldownListeners.forEach((listener) => listener(data));
  }

  private notifyArenaUpdateListeners(data: unknown): void {
    this.arenaUpdateListeners.forEach((listener) => listener(data));
  }

  private notifyIdleUpdateListeners(data: IdleUpdatePayload): void {
    this.idleUpdateListeners.forEach((listener) => listener(data));
  }

  private notifyIdleFinishedListeners(data: IdleFinishedPayload): void {
    this.idleFinishedListeners.forEach((listener) => listener(data));
  }

  private notifyMailUpdateListeners(data: MailIndicatorPayload): void {
    this.mailUpdateListeners.forEach((listener) => listener(data));
  }

  private notifyAchievementUpdateListeners(
    data: AchievementUpdatePayload,
  ): void {
    this.achievementUpdateListeners.forEach((listener) => listener(data));
  }

  private notifyTaskOverviewUpdateListeners(
    data: TaskOverviewUpdatePayload,
  ): void {
    this.taskOverviewUpdateListeners.forEach((listener) => listener(data));
  }

  private notifyGameTimeSyncListeners(data: GameTimeSyncPayload): void {
    this.gameTimeSyncListeners.forEach((listener) => listener(data));
  }

  private notifyTechniqueResearchResultListeners(data: TechniqueResearchResultPayload): void {
    this.techniqueResearchResultListeners.forEach((listener) => listener(data));
  }

  private notifyTechniqueResearchStatusListeners(
    data: TechniqueResearchStatusPayload,
  ): void {
    this.techniqueResearchStatusListeners.forEach((listener) => listener(data));
  }

  private notifyPartnerRecruitResultListeners(data: PartnerRecruitResultPayload): void {
    this.partnerRecruitResultListeners.forEach((listener) => listener(data));
  }

  private notifyPartnerRecruitStatusListeners(
    data: PartnerRecruitStatusPayload,
  ): void {
    this.partnerRecruitStatusListeners.forEach((listener) => listener(data));
  }

  private notifyPartnerFusionResultListeners(data: PartnerFusionResultPayload): void {
    this.partnerFusionResultListeners.forEach((listener) => listener(data));
  }

  private notifyPartnerFusionStatusListeners(
    data: PartnerFusionStatusPayload,
  ): void {
    this.partnerFusionStatusListeners.forEach((listener) => listener(data));
  }

  private notifyChatMessageListeners(message: ChatMessageDto): void {
    this.chatMessageListeners.forEach((listener) => listener(message));
  }

  private notifyChatErrorListeners(error: { message: string }): void {
    this.chatErrorListeners.forEach((listener) => listener(error));
  }

  private notifyOnlinePlayersListeners(payload: OnlinePlayersPayloadDto): void {
    this.onlinePlayersListeners.forEach((listener) => listener(payload));
  }
}

// 单例
export const gameSocket = new GameSocketService();

export default gameSocket;
