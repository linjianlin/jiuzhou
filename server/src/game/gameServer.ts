/**
 * 九州修仙录 - boardgame.io 服务器集成
 */
import { Server as HttpServer } from "http";
import { Server as SocketServer, Socket } from "socket.io";
import { randomUUID } from "crypto";
import type { CharacterAttributes } from "./gameState.js";
import { dbToCharacterAttributes } from "./gameState.js";
import { query } from "../config/database.js";
import { verifyToken, verifySession } from "../services/authService.js";
import { applyStaminaRecoveryByUserId } from "../services/staminaService.js";
import {
  getCharacterComputedByUserId,
  invalidateCharacterComputedCacheByUserId,
} from "../services/characterComputedService.js";
import { getRemainingCooldown } from "../services/battle/cooldownManager.js";
import { syncBattleStateOnReconnect } from "../services/battle/index.js";

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

const ONLINE_PLAYERS_EMIT_INTERVAL_MS = 3000;
const CHARACTER_PUSH_DEBOUNCE_MS = 80;

// 游戏服务器类
class GameServer {
  private io: SocketServer;
  private sessions: Map<string, PlayerSession> = new Map();
  private userSocketMap: Map<number, string> = new Map();
  private onlinePlayersEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private onlinePlayersEmitQueued = false;
  private onlinePlayersLastEmitAt = 0;
  /** 上次广播时的在线玩家快照，用于计算增量 */
  private lastBroadcastedPlayers: Map<number, OnlinePlayerDto> = new Map();
  private characterPushTimers: Map<number, ReturnType<typeof setTimeout>> =
    new Map();
  private characterPushInFlight: Set<number> = new Set();
  private characterPushQueued: Set<number> = new Set();

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
      // 玩家认证并加入游戏
      socket.on("game:auth", async (token: string) => {
        try {
          const { valid, decoded } = verifyToken(token);
          if (!valid || !decoded) {
            socket.emit("game:error", { message: "认证失败" });
            return;
          }

          const userId = decoded.id;
          const sessionToken = decoded.sessionToken;

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

          // 同步战斗冷却状态（重连时）
          if (character) {
            await this.syncBattleCooldownOnReconnect(socket, character.id);
          }

          // 同步战斗状态（重连时）
          await syncBattleStateOnReconnect(userId);

          this.scheduleEmitOnlinePlayers(true);
        } catch (error) {
          console.error("游戏认证错误:", error);
          socket.emit("game:error", { message: "服务器错误" });
        }
      });

      socket.on("game:onlinePlayers:request", () => {
        socket.emit("game:onlinePlayers", this.buildOnlinePlayersFullPayload());
      });

      socket.on(
        "chat:send",
        async (payload: {
          channel?: unknown;
          content?: unknown;
          clientId?: unknown;
          pmTargetCharacterId?: unknown;
        }) => {
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

          const now = Date.now();
          const message = {
            id: randomUUID(),
            clientId,
            channel,
            content,
            timestamp: now,
            senderUserId: session.userId,
            senderCharacterId: session.character.id,
            senderName: session.character.nickname,
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
        },
      );

      // 加点请求
      socket.on(
        "game:addPoint",
        async (data: {
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

          const success = await this.saveAttributePoints(
            session.userId,
            attribute,
            amount,
          );
          if (success) {
            // 重新加载角色数据
            const updatedCharacter = await this.loadCharacter(session.userId);
            session.character = updatedCharacter;
            session.lastUpdate = Date.now();

            // 广播更新（全量）
            socket.emit("game:character", {
              type: "full",
              character: updatedCharacter,
            });
          } else {
            socket.emit("game:error", { message: "加点失败" });
          }
        },
      );

      // 请求刷新角色数据
      socket.on("game:refresh", async () => {
        const session = this.sessions.get(socket.id);
        if (!session) {
          socket.emit("game:error", { message: "未认证" });
          return;
        }

        const character = await this.loadCharacter(session.userId);
        session.character = character;
        session.lastUpdate = Date.now();
        socket.emit("game:character", { type: "full", character });
      });

      // 断开连接
      socket.on("disconnect", () => {
        const session = this.sessions.get(socket.id);
        if (session) {
          void this.touchCharacterLastOfflineAt(session.userId);
          this.cancelQueuedCharacterPush(session.userId);
          this.userSocketMap.delete(session.userId);
          this.sessions.delete(socket.id);
          this.scheduleEmitOnlinePlayers(true);
        }
      });
    });
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

  private shouldRefreshOnlinePlayers(
    prev: CharacterAttributes | null,
    next: CharacterAttributes | null,
  ): boolean {
    if (!prev && !next) return false;
    if (!prev || !next) return true;
    return (
      prev.nickname !== next.nickname ||
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
  ): Promise<CharacterAttributes | null> {
    try {
      await applyStaminaRecoveryByUserId(userId);
      const computed = await getCharacterComputedByUserId(userId);
      if (!computed) return null;
      return dbToCharacterAttributes(
        computed as unknown as Record<string, unknown>,
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
    for (const session of this.sessions.values()) {
      if (session.character?.id === characterId) return session.socketId;
    }
    return null;
  }

  // 保存加点
  private async saveAttributePoints(
    userId: number,
    attribute: "jing" | "qi" | "shen",
    amount: number,
  ): Promise<boolean> {
    try {
      const updateSQL = `
        UPDATE characters 
        SET ${attribute} = ${attribute} + $1,
            attribute_points = attribute_points - $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $2 AND attribute_points >= $1
        RETURNING *
      `;
      const result = await query(updateSQL, [amount, userId]);
      if (result.rows.length > 0) {
        await invalidateCharacterComputedCacheByUserId(userId);
      }
      return result.rows.length > 0;
    } catch (error) {
      console.error("保存加点失败:", error);
      return false;
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
    const delta: Record<string, unknown> = {};
    let changed = false;
    for (const k of keys) {
      if (prev[k] !== next[k]) {
        delta[k] = next[k];
        changed = true;
      }
    }
    if (!changed) return null;
    return delta as Partial<CharacterAttributes>;
  }

  private async flushCharacterPush(userId: number): Promise<void> {
    if (this.characterPushInFlight.has(userId)) {
      this.characterPushQueued.add(userId);
      return;
    }

    this.characterPushInFlight.add(userId);
    try {
      const socketId = this.userSocketMap.get(userId);
      if (!socketId) return;

      const session = this.sessions.get(socketId);
      const prevCharacter = session?.character ?? null;
      const character = await this.loadCharacter(userId);
      if (session) {
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

  public emitToUser<T = any>(userId: number, event: string, data: T): boolean {
    const socketId = this.userSocketMap.get(userId);
    if (!socketId) return false;
    this.io.to(socketId).emit(event, data);
    return true;
  }

  public isUserOnline(userId: number): boolean {
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
  public emitToCharacter<T = any>(
    characterId: number,
    event: string,
    data: T,
  ): boolean {
    // 查找角色对应的 session
    const session = Array.from(this.sessions.values()).find(
      (s) => s.character?.id === characterId,
    );

    if (!session) return false;

    const socket = this.io.sockets.sockets.get(session.socketId);
    if (!socket) return false;

    socket.emit(event, data);
    return true;
  }

  // 踢出指定用户
  public kickUser(
    userId: number,
    reason: string = "账号已在其他设备登录",
  ): void {
    const socketId = this.userSocketMap.get(userId);
    if (!socketId) return;
    void this.touchCharacterLastOfflineAt(userId);
    this.cancelQueuedCharacterPush(userId);

    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit("game:kicked", { message: reason });
      socket.disconnect();
    }

    this.sessions.delete(socketId);
    this.userSocketMap.delete(userId);
    this.scheduleEmitOnlinePlayers(true);
  }

  // 获取IO实例
  public getIO(): SocketServer {
    return this.io;
  }

  /**
   * 处理断线重连时的冷却状态同步
   */
  private async syncBattleCooldownOnReconnect(
    socket: Socket,
    characterId: number,
  ): Promise<void> {
    const remaining = getRemainingCooldown(characterId);
    if (remaining > 0) {
      socket.emit("battle:cooldown-sync", {
        characterId,
        remainingMs: remaining,
        timestamp: Date.now(),
      });
    }
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
