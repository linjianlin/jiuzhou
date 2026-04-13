/**
 * 九州修仙录 - boardgame.io 服务器集成
 */
import { Server as HttpServer } from "http";
import { Server as SocketServer, Socket } from "socket.io";
import { randomUUID } from "crypto";
import type { CharacterAttributes } from "./gameState.js";
import { dbToCharacterAttributes } from "./gameState.js";
import {
  isDatabaseAccessForbidden,
  query,
  runWithDatabaseAccessAllowed,
} from "../config/database.js";
import { verifyToken, verifySession } from "../services/authService.js";
import { applyStaminaRecoveryByUserId } from "../services/staminaService.js";
import {
  getCharacterComputedByUserId,
} from "../services/characterComputedService.js";
import { addAttributePoint } from "../services/attributeService.js";
import { withUnlockedFeatures } from "../services/featureUnlockService.js";
import {
  getBattleStartCooldownRemainingMs,
  getBattleState,
  syncBattleSnapshotToUser,
  syncBattleStateOnReconnect,
} from "../services/battle/index.js";
import {
  buildBattleAbandonedRealtimePayload,
  buildBattleFinishedRealtimePayload,
} from "../services/battle/runtime/realtime.js";
import type { BattleSessionSnapshot } from "../services/battleSession/index.js";
import { getCurrentBattleSessionDetail } from "../services/battleSession/index.js";
import { detectSensitiveWords } from "../services/sensitiveWordService.js";
import { mailService } from "../services/mailService.js";
import { notifyAchievementUpdate } from "../services/achievementPush.js";
import { notifyPartnerRecruitStatus } from "../services/partnerRecruitPush.js";
import { getSectIndicatorByCharacterId } from "../services/sect/indicator.js";
import { notifyTechniqueResearchStatus } from "../services/techniqueResearchPush.js";
import { getMonthCardActiveMapByCharacterIds } from "../services/shared/monthCardBenefits.js";
import {
  areCharacterGlobalBuffSnapshotsEqual,
  loadActiveCharacterGlobalBuffSnapshotsByCharacterIds,
} from "../services/shared/characterGlobalBuff.js";
import { assertChatPhoneBindingReady } from "../services/marketPhoneBindingService.js";
import { AsyncShutdownGate } from "../utils/asyncShutdownGate.js";
import { emitLatestGameTimeSnapshot } from "../services/gameTimeService.js";
import {
  getOnlineBattleCharacterSnapshotByUserId,
  type OnlineBattleCharacterSnapshot,
} from "../services/onlineBattleProjectionService.js";
import {
  waitForUserConnectionSlot,
} from "../shared/userConnectionSlots.js";

// 玩家会话
interface PlayerSession {
  socketId: string;
  userId: number;
  sessionToken: string;
  character: CharacterAttributes | null;
  lastUpdate: number;
}

interface OnlinePlayerDto {
  id: number;
  nickname: string;
  monthCardActive: boolean;
  title: string;
  realm: string;
}

/**
 * 全量在线玩家消息（初次连接 / 主动请求 / 变化量过大时发送）
 */
interface OnlinePlayersFullPayload {
  type: "full";
  total: number;
  players: OnlinePlayerDto[];
}

/**
 * 增量在线玩家消息（仅包含变化部分，减少带宽）
 * - joined: 新上线的玩家
 * - left: 下线玩家的 id 列表
 * - updated: 昵称/称号/境界发生变化的玩家
 */
interface OnlinePlayersDeltaPayload {
  type: "delta";
  total: number;
  joined: OnlinePlayerDto[];
  left: number[];
  updated: OnlinePlayerDto[];
}

type SocketTaskArg = string | number | boolean | null | undefined | object;
type ChatSendPayload = {
  channel?: string | null;
  content?: string | number | boolean | null;
  clientId?: string | null;
  pmTargetCharacterId?: string | number | null;
};

const assignCharacterDelta = <TKey extends keyof CharacterAttributes>(
  target: Partial<CharacterAttributes>,
  key: TKey,
  value: CharacterAttributes[TKey],
): void => {
  target[key] = value;
};

const ONLINE_PLAYERS_EMIT_INTERVAL_MS = 3000;
const CHARACTER_PUSH_DEBOUNCE_MS = 80;
const MAX_CONCURRENT_GAME_AUTH_PER_USER = 1;
const GAME_AUTH_QUEUE_WAIT_MS = 3_000;
type AsyncSocketHandler<TArgs extends SocketTaskArg[]> = (...args: TArgs) => Promise<void>;

const buildCharacterAttributesFromOnlineBattleSnapshot = (
  snapshot: OnlineBattleCharacterSnapshot,
  previousCharacter: CharacterAttributes | null,
): CharacterAttributes => {
  return dbToCharacterAttributes({
    ...snapshot.computed,
    month_card_active: previousCharacter?.monthCardActive ?? false,
    dungeon_no_stamina_cost: previousCharacter?.dungeonNoStaminaCost ?? false,
    feature_unlocks: previousCharacter?.featureUnlocks ?? [],
    global_buffs: previousCharacter?.globalBuffs ?? [],
  });
};

const mergeRuntimeResourcesFromOnlineBattleSnapshot = (
  character: CharacterAttributes,
  snapshot: OnlineBattleCharacterSnapshot | null,
): CharacterAttributes => {
  if (!snapshot || snapshot.characterId !== character.id) {
    return character;
  }

  const runtimeQixue = Math.max(
    0,
    Math.min(
      character.maxQixue,
      Math.floor(Number(snapshot.computed.qixue) || 0),
    ),
  );
  const runtimeLingqi = Math.max(
    0,
    Math.min(
      character.maxLingqi,
      Math.floor(Number(snapshot.computed.lingqi) || 0),
    ),
  );
  const runtimeStamina = Math.max(
    0,
    Math.min(
      character.staminaMax,
      Math.floor(Number(snapshot.computed.stamina) || 0),
    ),
  );
  if (
    runtimeQixue === character.qixue
    && runtimeLingqi === character.lingqi
    && runtimeStamina === character.stamina
  ) {
    return character;
  }

  return {
    ...character,
    qixue: runtimeQixue,
    lingqi: runtimeLingqi,
    stamina: runtimeStamina,
  };
};

// 游戏服务器类
class GameServer {
  private io: SocketServer;
  private sessions: Map<string, PlayerSession> = new Map();
  private userSocketMap: Map<number, string> = new Map();
  private characterSocketMap: Map<number, string> = new Map();
  private onlinePlayersEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private onlinePlayersEmitQueued = false;
  private onlinePlayersLastEmitAt = 0;
  /** 上次广播时的在线玩家快照，用于计算增量 */
  private lastBroadcastedPlayers: Map<number, OnlinePlayerDto> = new Map();
  private characterPushTimers: Map<number, ReturnType<typeof setTimeout>> =
    new Map();
  private characterPushInFlight: Set<number> = new Set();
  private characterPushQueued: Set<number> = new Set();
  private readonly shutdownGate = new AsyncShutdownGate();
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    httpServer: HttpServer,
    corsOrigin:
      | string
      | string[]
      | ((
          origin: string | undefined,
          callback: (err: Error | null, allow?: boolean) => void,
        ) => void),
  ) {
    this.io = new SocketServer(httpServer, {
      cors: { origin: corsOrigin, credentials: true },
      path: "/game-socket",
      perMessageDeflate: {
        threshold: 1024,
      },
    });

    this.setupEventHandlers();
    console.log("游戏服务器初始化完成");
  }

  private setupEventHandlers() {
    this.io.on("connection", (socket: Socket) => {
      if (this.shutdownGate.isShuttingDown()) {
        socket.disconnect(true);
        return;
      }

      // 玩家认证并加入游戏
      socket.on("game:auth", this.createSocketTask(async (token: string) => {
        const authWaitAbortController = new AbortController();
        const abortWaiting = (): void => {
          authWaitAbortController.abort();
        };
        socket.once("disconnect", abortWaiting);

        let authLease: { release: () => void } | null = null;
        try {
          const { valid, decoded } = verifyToken(token);
          if (!valid || !decoded) {
            socket.emit("game:error", { message: "认证失败" });
            return;
          }

          const userId = decoded.id;
          const sessionToken = decoded.sessionToken;

          authLease = await waitForUserConnectionSlot({
            channel: "game-auth",
            userId,
            slotId: `game-auth:${socket.id}:${randomUUID()}`,
            limit: MAX_CONCURRENT_GAME_AUTH_PER_USER,
            waitMs: GAME_AUTH_QUEUE_WAIT_MS,
            signal: authWaitAbortController.signal,
          });
          if (!authLease) {
            if (!socket.disconnected) {
              socket.emit("game:error", { message: "当前账号连接排队超时，请稍后再试" });
            }
            socket.disconnect();
            return;
          }
          socket.off("disconnect", abortWaiting);

          if (socket.disconnected) {
            authLease.release();
            authLease = null;
            return;
          }

          // 验证会话token
          const sessionResult = await verifySession(userId, sessionToken);
          if (!sessionResult.valid) {
            socket.emit("game:kicked", { message: "账号已在其他设备登录" });
            socket.disconnect();
            return;
          }

          // 检查是否有旧连接，踢出旧连接
          const oldSocketId = this.userSocketMap.get(userId);
          if (oldSocketId && oldSocketId !== socket.id) {
            if (this.userSocketMap.get(userId) === oldSocketId) {
              this.userSocketMap.delete(userId);
            }
            this.clearCharacterSocketBinding(oldSocketId);
            this.sessions.delete(oldSocketId);
            const oldSocket = this.io.sockets.sockets.get(oldSocketId);
            if (oldSocket) {
              oldSocket.emit("game:kicked", {
                message: "账号已在其他设备登录",
              });
              oldSocket.disconnect();
            }
          }

          const character = await this.loadCharacter(userId);
          const teamId = character ? await this.loadTeamId(character.id) : null;
          const sectId = character ? await this.loadSectId(character.id) : null;

          // 保存会话
          this.sessions.set(socket.id, {
            socketId: socket.id,
            userId,
            sessionToken,
            character,
            lastUpdate: Date.now(),
          });
          this.userSocketMap.set(userId, socket.id);
          this.syncCharacterSocketBinding(socket.id, null, character);

          socket.join("chat:authed");
          socket.join(`chat:user:${userId}`);
          if (character) {
            socket.join(`chat:character:${character.id}`);
          }
          if (teamId) {
            socket.join(`chat:team:${teamId}`);
          }
          if (sectId) {
            socket.join(`chat:sect:${sectId}`);
          }

          // 发送角色数据（全量）
          socket.emit("game:character", { type: "full", character });
          emitLatestGameTimeSnapshot((event, snapshot) => {
            socket.emit(event, snapshot);
          });

	          if (character) {
	            try {
	              socket.emit("sect:update", await getSectIndicatorByCharacterId(character.id));
	            } catch (error) {
	              console.error("宗门指示器同步失败:", error);
	            }

	            await Promise.all([
	              notifyAchievementUpdate(character.id, userId),
	              mailService.pushUnreadCounterUpdateToUser(userId),
	              notifyTechniqueResearchStatus(character.id, userId),
	              notifyPartnerRecruitStatus(character.id, userId),
	            ]);

	            // 重连期间可能错过 task:update，认证成功后补发一次脏通知让前端回源最新任务快照。
	            socket.emit("task:update", {
	              characterId: character.id,
	              scopes: ["task"] as const,
	            });
	          }

          // 同步战斗冷却状态（重连时）
          if (character) {
            await this.syncBattleCooldownOnReconnect(socket, userId, character.id);
          }

          // 同步战斗状态（重连时）
          await syncBattleStateOnReconnect(userId);
          await this.syncFinishedBattleOnReconnect(userId);
          socket.emit("game:auth-ready");

          this.scheduleEmitOnlinePlayers(true);
        } catch (error) {
          console.error("游戏认证错误:", error);
          socket.emit("game:error", { message: "服务器错误" });
        } finally {
          socket.off("disconnect", abortWaiting);
          if (authLease) {
            authLease.release();
          }
        }
      }));

      socket.on("game:onlinePlayers:request", () => {
        if (this.shutdownGate.isShuttingDown()) {
          return;
        }
        socket.emit("game:onlinePlayers", this.buildOnlinePlayersFullPayload());
      });

      socket.on(
        "battle:sync",
        this.createSocketTask(async (payload: { battleId?: string }) => {
          const session = this.sessions.get(socket.id);
          if (!session) {
            socket.emit("game:error", { message: "未认证" });
            return;
          }
          const battleId = String(payload?.battleId ?? "").trim();
          if (!battleId) {
            socket.emit("game:error", { message: "缺少战斗ID" });
            return;
          }
          const synced = await syncBattleSnapshotToUser(session.userId, battleId);
          if (synced) {
            return;
          }
          socket.emit(
            "battle:update",
            buildBattleAbandonedRealtimePayload({
              battleId,
              success: false,
              message: "战斗不存在或已结束",
              authoritative: true,
            }),
          );
        }),
      );

      socket.on(
        "chat:send",
        this.createSocketTask(async (payload: ChatSendPayload) => {
          const session = this.sessions.get(socket.id);
          if (!session?.character) {
            socket.emit("chat:error", { message: "未认证" });
            return;
          }

          const channel =
            typeof payload?.channel === "string" ? payload.channel : "";
          const clientId =
            typeof payload?.clientId === "string"
              ? payload.clientId
              : undefined;
          const content = String(payload?.content ?? "").trim();
          if (!content) return;
          if (content.length > 200) {
            socket.emit("chat:error", { message: "消息过长" });
            return;
          }

          if (channel === "system" || channel === "all") {
            socket.emit("chat:error", {
              message: channel === "system" ? "系统频道不允许发言" : "无效频道",
            });
            return;
          }

          if (channel === "world" || channel === "team" || channel === "sect" || channel === "private") {
            try {
              await assertChatPhoneBindingReady(session.userId);
            } catch (error) {
              const message = error instanceof Error ? error.message : "绑定手机号后才可在聊天频道发言";
              socket.emit("chat:error", { message });
              return;
            }
          }

          let chatContent = content;
          try {
            const sensitiveResult = await detectSensitiveWords(content);
            if (sensitiveResult.matched) {
              if (sensitiveResult.source !== "remote") {
                socket.emit("chat:error", { message: "消息包含敏感词，请重新发送" });
                return;
              }
              chatContent = sensitiveResult.sanitizedContent;
            }
          } catch (error) {
            console.error("聊天敏感词检测失败:", error);
            socket.emit("chat:error", { message: "敏感词检测服务暂不可用，请稍后重试" });
            return;
          }

          const now = Date.now();
      const message = {
            id: randomUUID(),
            clientId,
            channel,
            content: chatContent,
            timestamp: now,
            senderUserId: session.userId,
            senderCharacterId: session.character.id,
            senderName: session.character.nickname,
            senderMonthCardActive: session.character.monthCardActive,
            senderTitle: session.character.title,
            pmTargetCharacterId:
              payload?.pmTargetCharacterId == null
                ? undefined
                : Math.floor(Number(payload.pmTargetCharacterId)),
          };

          if (channel === "private") {
            const targetCharacterId = message.pmTargetCharacterId;
            if (
              !targetCharacterId ||
              !Number.isFinite(targetCharacterId) ||
              targetCharacterId <= 0
            ) {
              socket.emit("chat:error", { message: "请选择私聊对象" });
              return;
            }

            const targetSocketId =
              this.getSocketIdByCharacterId(targetCharacterId);
            if (!targetSocketId) {
              socket.emit("chat:error", { message: "对方不在线" });
              return;
            }

            this.io
              .to(`chat:character:${session.character.id}`)
              .emit("chat:message", message);
            this.io
              .to(`chat:character:${targetCharacterId}`)
              .emit("chat:message", message);
            return;
          }

          if (channel === "team") {
            const teamId = await this.loadTeamId(session.character.id);
            if (!teamId) {
              socket.emit("chat:error", {
                message: "未加入队伍，无法在队伍频道发言",
              });
              return;
            }
            this.io.to(`chat:team:${teamId}`).emit("chat:message", message);
            return;
          }

          if (channel === "sect") {
            const sectId = await this.loadSectId(session.character.id);
            if (!sectId) {
              socket.emit("chat:error", {
                message: "未加入宗门，无法在宗门频道发言",
              });
              return;
            }
            this.io.to(`chat:sect:${sectId}`).emit("chat:message", message);
            return;
          }

          if (channel === "battle") {
            socket.emit("chat:error", { message: "战况频道不允许发言" });
            return;
          }

          if (channel === "world") {
            this.io.to("chat:authed").emit("chat:message", message);
            return;
          }

          socket.emit("chat:error", { message: "无效频道" });
        }),
      );

      // 加点请求
      socket.on(
        "game:addPoint",
        this.createSocketTask(async (data: {
          attribute: "jing" | "qi" | "shen";
          amount?: number;
        }) => {
          const session = this.sessions.get(socket.id);
          if (!session?.character) {
            socket.emit("game:error", { message: "未找到角色" });
            return;
          }

          const { attribute, amount = 1 } = data;
          if (!["jing", "qi", "shen"].includes(attribute)) {
            socket.emit("game:error", { message: "无效的属性" });
            return;
          }

          if (session.character.attributePoints < amount) {
            socket.emit("game:error", { message: "属性点不足" });
            return;
          }

          const result = await addAttributePoint(
            session.userId,
            attribute,
            amount,
          );
          if (result.success) {
            // 重新加载角色数据
            const updatedCharacter = await this.loadCharacter(session.userId);
            this.syncCharacterSocketBinding(socket.id, session.character, updatedCharacter);
            session.character = updatedCharacter;
            session.lastUpdate = Date.now();

            // 广播更新（全量）
            socket.emit("game:character", {
              type: "full",
              character: updatedCharacter,
            });
          } else {
            socket.emit("game:error", { message: result.message });
          }
        }),
      );

      // 请求刷新角色数据
      socket.on("game:refresh", this.createSocketTask(async () => {
        const session = this.sessions.get(socket.id);
        if (!session) {
          socket.emit("game:error", { message: "未认证" });
          return;
        }

        const character = await this.loadCharacter(session.userId);
        this.syncCharacterSocketBinding(socket.id, session.character, character);
        session.character = character;
        session.lastUpdate = Date.now();
        socket.emit("game:character", { type: "full", character });
      }));

      // 断开连接
      socket.on("disconnect", () => {
        const session = this.sessions.get(socket.id);
        if (session) {
          this.scheduleCharacterLastOfflinePersistence(session.userId);
          this.cancelQueuedCharacterPush(session.userId);
          this.clearCharacterSocketBinding(socket.id);
          this.userSocketMap.delete(session.userId);
          this.sessions.delete(socket.id);
          if (!this.shutdownGate.isShuttingDown()) {
            this.scheduleEmitOnlinePlayers(true);
          }
        }
      });
    });
  }

  private createSocketTask<TArgs extends SocketTaskArg[]>(
    handler: AsyncSocketHandler<TArgs>,
  ): (...args: TArgs) => void {
    return (...args: TArgs) => {
      void this.runTrackedTask(async () => {
        await handler(...args);
      });
    };
  }

  private async runTrackedTask<T>(
    task: () => Promise<T>,
  ): Promise<T | undefined> {
    return this.shutdownGate.run(task);
  }

  /**
   * 构建当前在线玩家快照 Map（id → dto），用于 diff 计算和全量发送。
   */
  private buildCurrentOnlinePlayersMap(): Map<number, OnlinePlayerDto> {
    const map = new Map<number, OnlinePlayerDto>();
    for (const session of this.sessions.values()) {
      const c = session.character;
      if (!c) continue;
      map.set(c.id, {
        id: c.id,
        nickname: c.nickname,
        monthCardActive: c.monthCardActive,
        title: c.title,
        realm: c.realm,
      });
    }
    return map;
  }

  /**
   * 构建全量消息（用于初次连接 / 主动请求）。
   * 不更新 lastBroadcastedPlayers，因为这是单播场景。
   */
  private buildOnlinePlayersFullPayload(): OnlinePlayersFullPayload {
    const current = this.buildCurrentOnlinePlayersMap();
    const players = Array.from(current.values()).sort((a, b) =>
      a.nickname.localeCompare(b.nickname, "zh-Hans-CN"),
    );
    return { type: "full", total: players.length, players };
  }

  /**
   * 计算增量并广播给所有已认证客户端。
   *
   * 数据流：
   *   1. 构建当前快照 current
   *   2. 与 lastBroadcastedPlayers 对比，得出 joined / left / updated
   *   3. 若变化量超过总量 50%，退化为全量（此时 delta 可能比全量更大）
   *   4. 广播后更新 lastBroadcastedPlayers
   *
   * 边界条件：
   *   - 首次广播时 lastBroadcastedPlayers 为空，必定退化为全量
   *   - 若当前无任何变化（joined/left/updated 均为空），跳过广播以节省带宽
   */
  private emitOnlinePlayersNow(): void {
    if (this.shutdownGate.isShuttingDown()) {
      return;
    }

    const current = this.buildCurrentOnlinePlayersMap();
    const prev = this.lastBroadcastedPlayers;

    const joined: OnlinePlayerDto[] = [];
    const left: number[] = [];
    const updated: OnlinePlayerDto[] = [];

    // 找出新上线 & 属性变化的玩家
    for (const [id, dto] of current) {
      const old = prev.get(id);
      if (!old) {
        joined.push(dto);
      } else if (
        old.nickname !== dto.nickname ||
        old.monthCardActive !== dto.monthCardActive ||
        old.title !== dto.title ||
        old.realm !== dto.realm
      ) {
        updated.push(dto);
      }
    }

    // 找出下线的玩家
    for (const id of prev.keys()) {
      if (!current.has(id)) {
        left.push(id);
      }
    }

    const changeCount = joined.length + left.length + updated.length;

    // 无变化则跳过广播
    if (changeCount === 0) {
      return;
    }

    // 更新快照
    this.lastBroadcastedPlayers = current;

    const total = current.size;
    // 变化量超过总量 50% 或首次广播（prev 为空）→ 全量
    const useFull =
      prev.size === 0 || changeCount > Math.max(total, prev.size) * 0.5;

    if (useFull) {
      const players = Array.from(current.values()).sort((a, b) =>
        a.nickname.localeCompare(b.nickname, "zh-Hans-CN"),
      );
      const payload: OnlinePlayersFullPayload = {
        type: "full",
        total,
        players,
      };
      this.io.to("chat:authed").emit("game:onlinePlayers", payload);
    } else {
      const payload: OnlinePlayersDeltaPayload = {
        type: "delta",
        total,
        joined,
        left,
        updated,
      };
      this.io.to("chat:authed").emit("game:onlinePlayers", payload);
    }
  }

  private scheduleEmitOnlinePlayers(force: boolean = false): void {
    if (this.shutdownGate.isShuttingDown()) {
      return;
    }

    if (this.onlinePlayersEmitTimer) {
      this.onlinePlayersEmitQueued = true;
      return;
    }

    const now = Date.now();
    const elapsed = now - this.onlinePlayersLastEmitAt;
    const waitMs = force
      ? 0
      : Math.max(0, ONLINE_PLAYERS_EMIT_INTERVAL_MS - elapsed);

    this.onlinePlayersEmitTimer = setTimeout(() => {
      this.onlinePlayersEmitTimer = null;
      this.onlinePlayersLastEmitAt = Date.now();
      this.emitOnlinePlayersNow();

      if (this.onlinePlayersEmitQueued) {
        this.onlinePlayersEmitQueued = false;
        this.scheduleEmitOnlinePlayers(false);
      }
    }, waitMs);
  }

  /**
   * 异步回写角色离线时间。
   *
   * 作用（做什么 / 不做什么）：
   * 1. 做什么：把 `disconnect` / `kickUser` 的离线落库统一收口到单一后台入口，避免断链场景各自散落 fire-and-forget 写法。
   * 2. 做什么：在真正需要落库的异步子任务里显式切到 `runWithDatabaseAccessAllowed`，隔离上游 `api/battle/action` 这类禁 DB 请求上下文。
   * 3. 不做什么：不绕过事务约束，不修改离线字段语义，也不在关闭态强行补写数据库。
   *
   * 输入/输出：
   * - 输入：断线用户 ID。
   * - 输出：无同步返回；离线时间更新在后台任务中执行。
   *
   * 数据流/状态流：
   * disconnect / kickUser
   * -> 本函数进入 shutdownGate 跟踪任务
   * -> `runWithDatabaseAccessAllowed`
   * -> `touchCharacterLastOfflineAt`
   * -> characters.last_offline_at / updated_at。
   *
   * 复用设计说明：
   * - 断线与踢下线现在共用同一条允许 DB 的后台链路，避免两处分别维护上下文隔离逻辑。
   * - 高概率继续变化的是“哪些断链场景需要记录离线时间”，因此把触发与上下文切换集中到这里最容易维护。
   *
   * 关键边界条件与坑点：
   * 1. 这里只能包装已确认需要落库的后台分支，不能拿去包同步首包逻辑，否则会绕开禁 DB 约束。
   * 2. shutdown 已开始时不会再接收新任务，避免资源释放后仍继续访问数据库。
   */
  private scheduleCharacterLastOfflinePersistence(userId: number): void {
    if (this.shutdownGate.isShuttingDown()) {
      return;
    }

    void this.runTrackedTask(async () => {
      await runWithDatabaseAccessAllowed(async () => {
        await this.touchCharacterLastOfflineAt(userId);
      });
    });
  }

  private shouldRefreshOnlinePlayers(
    prev: CharacterAttributes | null,
    next: CharacterAttributes | null,
  ): boolean {
    if (!prev && !next) return false;
    if (!prev || !next) return true;
    return (
      prev.nickname !== next.nickname ||
      prev.monthCardActive !== next.monthCardActive ||
      prev.title !== next.title ||
      prev.realm !== next.realm
    );
  }

  /**
   * 更新角色最后离线时间，用于宗门成员离线时长等展示。
   * 说明：仅在连接断开时更新，字段语义始终是“离线发生时刻”。
   */
  private async touchCharacterLastOfflineAt(userId: number): Promise<void> {
    await query(
      `UPDATE characters SET last_offline_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
      [userId],
    );
  }

  // 加载角色数据
  private async loadCharacter(
    userId: number,
    options?: {
      previousCharacter?: CharacterAttributes | null;
    },
  ): Promise<CharacterAttributes | null> {
    if (this.shutdownGate.isShuttingDown()) {
      return null;
    }

    try {
      if (isDatabaseAccessForbidden()) {
        const snapshot = await getOnlineBattleCharacterSnapshotByUserId(userId);
        if (!snapshot) return null;
        return buildCharacterAttributesFromOnlineBattleSnapshot(
          snapshot,
          options?.previousCharacter ?? null,
        );
      }

      await applyStaminaRecoveryByUserId(userId);
      const computed = await getCharacterComputedByUserId(userId);
      if (!computed) return null;
      const [monthCardActiveMap, globalBuffSnapshotsByCharacterId] = await Promise.all([
        getMonthCardActiveMapByCharacterIds([computed.id]),
        loadActiveCharacterGlobalBuffSnapshotsByCharacterIds([computed.id]),
      ]);
      const characterWithUnlockedFeatures = await withUnlockedFeatures(
        {
          ...computed,
          month_card_active: monthCardActiveMap.get(computed.id) ?? false,
          global_buffs: globalBuffSnapshotsByCharacterId.get(computed.id) ?? [],
        },
      );
      const character = dbToCharacterAttributes(
        characterWithUnlockedFeatures,
      );
      const runtimeSnapshot = await getOnlineBattleCharacterSnapshotByUserId(userId);
      return mergeRuntimeResourcesFromOnlineBattleSnapshot(
        character,
        runtimeSnapshot,
      );
    } catch (error) {
      console.error("加载角色失败:", error);
      return null;
    }
  }

  private async loadTeamId(characterId: number): Promise<string | null> {
    try {
      const result = await query(
        "SELECT team_id FROM team_members WHERE character_id = $1 LIMIT 1",
        [characterId],
      );
      if (result.rows.length === 0) return null;
      const teamId = result.rows[0]?.team_id;
      return typeof teamId === "string" && teamId ? teamId : null;
    } catch {
      return null;
    }
  }

  private async loadSectId(characterId: number): Promise<string | null> {
    try {
      const result = await query(
        "SELECT sect_id FROM sect_member WHERE character_id = $1 LIMIT 1",
        [characterId],
      );
      if (result.rows.length === 0) return null;
      const sectId = result.rows[0]?.sect_id;
      return typeof sectId === "string" && sectId ? sectId : null;
    } catch {
      return null;
    }
  }

  private getSocketIdByCharacterId(characterId: number): string | null {
    if (!Number.isFinite(characterId) || characterId <= 0) return null;
    const socketId = this.characterSocketMap.get(characterId);
    if (!socketId) return null;
    if (!this.sessions.has(socketId)) {
      this.characterSocketMap.delete(characterId);
      return null;
    }
    return socketId;
  }

  private syncCharacterSocketBinding(
    socketId: string,
    previousCharacter: CharacterAttributes | null,
    nextCharacter: CharacterAttributes | null,
  ): void {
    const previousCharacterId = previousCharacter?.id ?? null;
    if (previousCharacterId !== null) {
      const currentSocketId = this.characterSocketMap.get(previousCharacterId);
      if (currentSocketId === socketId) {
        this.characterSocketMap.delete(previousCharacterId);
      }
    }

    const nextCharacterId = nextCharacter?.id ?? null;
    if (nextCharacterId !== null) {
      this.characterSocketMap.set(nextCharacterId, socketId);
    }
  }

  private clearCharacterSocketBinding(socketId: string): void {
    const session = this.sessions.get(socketId);
    const characterId = session?.character?.id ?? null;
    if (characterId === null) return;
    const currentSocketId = this.characterSocketMap.get(characterId);
    if (currentSocketId === socketId) {
      this.characterSocketMap.delete(characterId);
    }
  }

  // 向指定用户推送角色更新
  private cancelQueuedCharacterPush(userId: number): void {
    const timer = this.characterPushTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.characterPushTimers.delete(userId);
    }
    this.characterPushQueued.delete(userId);
  }

  private scheduleCharacterPush(userId: number): void {
    if (this.shutdownGate.isShuttingDown()) {
      return;
    }

    if (!Number.isFinite(userId) || userId <= 0) return;

    if (this.characterPushInFlight.has(userId)) {
      this.characterPushQueued.add(userId);
      return;
    }

    if (this.characterPushTimers.has(userId)) {
      this.characterPushQueued.add(userId);
      return;
    }

    const timer = setTimeout(() => {
      this.characterPushTimers.delete(userId);
      void this.flushCharacterPush(userId);
    }, CHARACTER_PUSH_DEBOUNCE_MS);
    this.characterPushTimers.set(userId, timer);
  }

  /**
   * 计算两个角色对象之间的增量差异。
   *
   * 作用：避免每次推送 50+ 字段全量 JSON，仅传输变化字段。
   * 输入：prev（上次推送的快照）、next（当前最新数据）
   * 输出：仅包含变化字段的 Partial 对象，若无变化返回 null
   *
   * 边界条件：
   *   - prev 为 null 时返回 null（需走全量路径）
   *   - next 为 null 时返回 null（角色被删除，需走全量路径）
   */
  private diffCharacter(
    prev: CharacterAttributes | null,
    next: CharacterAttributes | null,
  ): Partial<CharacterAttributes> | null {
    if (!prev || !next) return null;
    const keys = Object.keys(next) as (keyof CharacterAttributes)[];
    const delta: Partial<CharacterAttributes> = {};
    let changed = false;
    for (const k of keys) {
      const prevValue = prev[k];
      const nextValue = next[k];
      if (
        k === "globalBuffs"
        && areCharacterGlobalBuffSnapshotsEqual(
          prevValue as CharacterAttributes["globalBuffs"],
          nextValue as CharacterAttributes["globalBuffs"],
        )
      ) {
        continue;
      }
      const sameArray =
        Array.isArray(prevValue) &&
        Array.isArray(nextValue) &&
        prevValue.length === nextValue.length &&
        prevValue.every((item, index) => item === nextValue[index]);
      if (sameArray) {
        continue;
      }
      if (prevValue !== nextValue) {
        assignCharacterDelta(delta, k, nextValue);
        changed = true;
      }
    }
    if (!changed) return null;
    return delta as Partial<CharacterAttributes>;
  }

  private async flushCharacterPush(userId: number): Promise<void> {
    if (this.shutdownGate.isShuttingDown()) {
      return;
    }

    if (this.characterPushInFlight.has(userId)) {
      this.characterPushQueued.add(userId);
      return;
    }

    const executed = await this.runTrackedTask(async () => {
      await runWithDatabaseAccessAllowed(async () => {
        this.characterPushInFlight.add(userId);
        try {
          const socketId = this.userSocketMap.get(userId);
          if (!socketId) return;

          const session = this.sessions.get(socketId);
          const prevCharacter = session?.character ?? null;
          const character = await this.loadCharacter(userId, {
            previousCharacter: prevCharacter,
          });
          if (session) {
            this.syncCharacterSocketBinding(socketId, prevCharacter, character);
            session.character = character;
            session.lastUpdate = Date.now();
          }

          const delta = this.diffCharacter(prevCharacter, character);
          if (delta) {
            // 增量推送：仅发送变化字段 + id 用于客户端校验
            this.io.to(socketId).emit("game:character", {
              type: "delta",
              delta: { ...delta, id: character!.id },
            });
          } else {
            // 全量推送：首次加载 / 角色为 null / 无变化时也发全量确保同步
            this.io
              .to(socketId)
              .emit("game:character", { type: "full", character });
          }
          if (this.shouldRefreshOnlinePlayers(prevCharacter, character)) {
            this.scheduleEmitOnlinePlayers(false);
          }
        } finally {
          this.characterPushInFlight.delete(userId);
          if (this.characterPushQueued.has(userId)) {
            this.characterPushQueued.delete(userId);
            this.scheduleCharacterPush(userId);
          }
        }
      });
    });

    if (executed === undefined) {
      this.characterPushInFlight.delete(userId);
      this.characterPushQueued.delete(userId);
    }
  }

  public async pushCharacterUpdate(userId: number): Promise<void> {
    this.scheduleCharacterPush(userId);
  }

  public getOnlinePlayersInRoom(
    mapId: string,
    roomId: string,
    excludeUserId?: number,
  ): CharacterAttributes[] {
    const players: CharacterAttributes[] = [];
    for (const session of this.sessions.values()) {
      const character = session.character;
      if (!character) continue;
      if (
        character.currentMapId !== mapId ||
        character.currentRoomId !== roomId
      )
        continue;
      if (excludeUserId !== undefined && session.userId === excludeUserId)
        continue;
      players.push(character);
    }
    return players;
  }

  public emitToUser<T>(userId: number, event: string, data: T): boolean {
    if (this.shutdownGate.isShuttingDown()) return false;
    const socketId = this.userSocketMap.get(userId);
    if (!socketId) return false;
    this.io.to(socketId).emit(event, data);
    return true;
  }

  public getActiveCharacterIdByUserId(userId: number): number | null {
    if (this.shutdownGate.isShuttingDown()) return null;
    if (!Number.isFinite(userId) || userId <= 0) return null;
    const socketId = this.userSocketMap.get(userId);
    if (!socketId) return null;
    return this.sessions.get(socketId)?.character?.id ?? null;
  }

  public isUserOnline(userId: number): boolean {
    if (this.shutdownGate.isShuttingDown()) return false;
    if (!Number.isFinite(userId) || userId <= 0) return false;
    const socketId = this.userSocketMap.get(userId);
    if (!socketId) return false;
    if (!this.sessions.has(socketId)) return false;
    return this.io.sockets.sockets.has(socketId);
  }

  /**
   * 向指定角色推送事件
   *
   * 用于冷却管理器等服务向特定角色推送消息
   */
  public emitToCharacter<T>(
    characterId: number,
    event: string,
    data: T,
  ): boolean {
    if (this.shutdownGate.isShuttingDown()) return false;
    const socketId = this.getSocketIdByCharacterId(characterId);
    if (!socketId) return false;
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) return false;

    socket.emit(event, data);
    return true;
  }

  // 踢出指定用户
  public kickUser(
    userId: number,
    reason: string = "账号已在其他设备登录",
  ): void {
    if (this.shutdownGate.isShuttingDown()) return;
    const socketId = this.userSocketMap.get(userId);
    if (!socketId) return;
    this.cancelQueuedCharacterPush(userId);
    this.clearCharacterSocketBinding(socketId);
    this.userSocketMap.delete(userId);
    this.sessions.delete(socketId);
    this.scheduleCharacterLastOfflinePersistence(userId);

    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit("game:kicked", { message: reason });
      socket.disconnect();
    }

    this.scheduleEmitOnlinePlayers(true);
  }

  // 获取IO实例
  public getIO(): SocketServer {
    return this.io;
  }

  public async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = (async () => {
      this.shutdownGate.beginShutdown();

      if (this.onlinePlayersEmitTimer) {
        clearTimeout(this.onlinePlayersEmitTimer);
        this.onlinePlayersEmitTimer = null;
      }
      this.onlinePlayersEmitQueued = false;

      for (const timer of this.characterPushTimers.values()) {
        clearTimeout(timer);
      }
      this.characterPushTimers.clear();
      this.characterPushQueued.clear();

      await new Promise<void>((resolve) => {
        this.io.close(() => resolve());
      });
      await this.shutdownGate.waitForIdle();

      this.characterPushInFlight.clear();
      this.characterSocketMap.clear();
      this.lastBroadcastedPlayers.clear();
      this.userSocketMap.clear();
      this.sessions.clear();
    })();

    return this.shutdownPromise;
  }

  /**
   * 处理断线重连时的冷却状态同步
   */
  private async getReconnectWaitingTransitionSession(
    userId: number,
  ): Promise<BattleSessionSnapshot | null> {
    const sessionRes = await getCurrentBattleSessionDetail(userId);
    const session =
      sessionRes.success && sessionRes.data.session ? sessionRes.data.session : null;
    if (!session || !session.currentBattleId || session.status !== "waiting_transition") {
      return null;
    }
    return session;
  }

  /**
   * 处理断线重连时的冷却状态同步。
   *
   * 规则：
   * 1. 冷却仍在进行：推 `battle:cooldown-sync`
   * 2. 冷却已结束但会话还停在 waiting_transition：补一条 `battle:cooldown-ready`
   *
   * 这样客户端即使先收到 finished battle snapshot，再挂载 BattleArea，也不会永远卡在“等待服务端通知”。
   */
  private async syncBattleCooldownOnReconnect(
    socket: Socket,
    userId: number,
    characterId: number,
  ): Promise<void> {
    // 重连补发的冷却状态必须与真正开战校验共用同一真源，
    // 否则会出现“客户端已收到 ready，但 advance 仍被 battle_start_cooldown 拦截”的竞态。
    const remaining = getBattleStartCooldownRemainingMs(characterId);
    if (remaining > 0) {
      socket.emit("battle:cooldown-sync", {
        characterId,
        remainingMs: remaining,
        timestamp: Date.now(),
      });
      return;
    }

    const waitingSession = await this.getReconnectWaitingTransitionSession(userId);
    if (!waitingSession) {
      return;
    }

    socket.emit("battle:cooldown-ready", {
      characterId,
      timestamp: Date.now(),
    });
  }

  /**
   * 处理断线重连时“刚结算完成但尚未推进会话”的终态战斗同步。
   */
  private async syncFinishedBattleOnReconnect(userId: number): Promise<void> {
    const session = await this.getReconnectWaitingTransitionSession(userId);
    const battleId = session?.currentBattleId ?? null;
    if (!session || !battleId) {
      return;
    }

    const battleRes = await getBattleState(battleId);
    if (!battleRes.success) {
      return;
    }

    const payload = buildBattleFinishedRealtimePayload({
      battleId,
      battleResult: battleRes,
      session,
    });
    if (!payload) {
      return;
    }

    this.emitToUser(userId, "battle:update", payload);
  }
}

let gameServer: GameServer | null = null;

// 初始化游戏服务器
export const initGameServer = (
  httpServer: HttpServer,
  corsOrigin:
    | string
    | string[]
    | ((
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void,
      ) => void),
): GameServer => {
  if (!gameServer) {
    gameServer = new GameServer(httpServer, corsOrigin);
  }
  return gameServer;
};

// 获取游戏服务器实例
export const getGameServer = (): GameServer => {
  if (!gameServer) {
    throw new Error("游戏服务器未初始化");
  }
  return gameServer;
};

// 获取游戏服务器实例（未初始化时返回 null）
export const getGameServerIfInitialized = (): GameServer | null => {
  return gameServer;
};
