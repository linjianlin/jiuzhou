/**
 * 九州修仙录 - boardgame.io 服务器集成
 */
import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import type { CharacterAttributes } from './GameState.js';
import { dbToCharacterAttributes } from './GameState.js';
import { query } from '../config/database.js';
import { verifyToken, verifySession } from '../services/authService.js';
import { calculateTechniquePassives } from '../services/characterTechniqueService.js';
import { applyStaminaRecoveryByUserId } from '../services/staminaService.js';

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

const ONLINE_PLAYERS_EMIT_INTERVAL_MS = 500;

// 游戏服务器类
class GameServer {
  private io: SocketServer;
  private sessions: Map<string, PlayerSession> = new Map();
  private userSocketMap: Map<number, string> = new Map();
  private onlinePlayersEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private onlinePlayersEmitQueued = false;
  private onlinePlayersLastEmitAt = 0;

  constructor(
    httpServer: HttpServer,
    corsOrigin: string | string[] | ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void)
  ) {
    this.io = new SocketServer(httpServer, {
      cors: { origin: corsOrigin, credentials: true },
      path: '/game-socket',
    });

    this.setupEventHandlers();
    console.log('游戏服务器初始化完成');
  }

  private setupEventHandlers() {
    this.io.on('connection', (socket: Socket) => {
      // 玩家认证并加入游戏
      socket.on('game:auth', async (token: string) => {
        try {
          const { valid, decoded } = verifyToken(token);
          if (!valid || !decoded) {
            socket.emit('game:error', { message: '认证失败' });
            return;
          }

          const userId = decoded.id;
          const sessionToken = decoded.sessionToken;

          // 验证会话token
          const sessionResult = await verifySession(userId, sessionToken);
          if (!sessionResult.valid) {
            socket.emit('game:kicked', { message: '账号已在其他设备登录' });
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
              oldSocket.emit('game:kicked', { message: '账号已在其他设备登录' });
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

          socket.join('chat:authed');
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

          // 发送角色数据
          socket.emit('game:character', { character });
          this.scheduleEmitOnlinePlayers(true);
        } catch (error) {
          console.error('游戏认证错误:', error);
          socket.emit('game:error', { message: '服务器错误' });
        }
      });

      socket.on('game:onlinePlayers:request', () => {
        socket.emit('game:onlinePlayers', this.buildOnlinePlayersPayload());
      });

      socket.on(
        'chat:send',
        async (payload: { channel?: unknown; content?: unknown; clientId?: unknown; pmTargetCharacterId?: unknown }) => {
          const session = this.sessions.get(socket.id);
          if (!session?.character) {
            socket.emit('chat:error', { message: '未认证' });
            return;
          }

          const channel = typeof payload?.channel === 'string' ? payload.channel : '';
          const clientId = typeof payload?.clientId === 'string' ? payload.clientId : undefined;
          const content = String(payload?.content ?? '').trim();
          if (!content) return;
          if (content.length > 200) {
            socket.emit('chat:error', { message: '消息过长' });
            return;
          }

          if (channel === 'system' || channel === 'all') {
            socket.emit('chat:error', { message: channel === 'system' ? '系统频道不允许发言' : '无效频道' });
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
              payload?.pmTargetCharacterId == null ? undefined : Math.floor(Number(payload.pmTargetCharacterId)),
          };

          if (channel === 'private') {
            const targetCharacterId = message.pmTargetCharacterId;
            if (!targetCharacterId || !Number.isFinite(targetCharacterId) || targetCharacterId <= 0) {
              socket.emit('chat:error', { message: '请选择私聊对象' });
              return;
            }

            const targetSocketId = this.getSocketIdByCharacterId(targetCharacterId);
            if (!targetSocketId) {
              socket.emit('chat:error', { message: '对方不在线' });
              return;
            }

            this.io.to(`chat:character:${session.character.id}`).emit('chat:message', message);
            this.io.to(`chat:character:${targetCharacterId}`).emit('chat:message', message);
            return;
          }

          if (channel === 'team') {
            const teamId = await this.loadTeamId(session.character.id);
            if (!teamId) {
              socket.emit('chat:error', { message: '未加入队伍，无法在队伍频道发言' });
              return;
            }
            this.io.to(`chat:team:${teamId}`).emit('chat:message', message);
            return;
          }

          if (channel === 'sect') {
            const sectId = await this.loadSectId(session.character.id);
            if (!sectId) {
              socket.emit('chat:error', { message: '未加入宗门，无法在宗门频道发言' });
              return;
            }
            this.io.to(`chat:sect:${sectId}`).emit('chat:message', message);
            return;
          }

          if (channel === 'battle') {
            socket.emit('chat:error', { message: '战况频道不允许发言' });
            return;
          }

          if (channel === 'world') {
            this.io.to('chat:authed').emit('chat:message', message);
            return;
          }

          socket.emit('chat:error', { message: '无效频道' });
        },
      );

      // 加点请求
      socket.on('game:addPoint', async (data: { attribute: 'jing' | 'qi' | 'shen'; amount?: number }) => {
        const session = this.sessions.get(socket.id);
        if (!session?.character) {
          socket.emit('game:error', { message: '未找到角色' });
          return;
        }

        const { attribute, amount = 1 } = data;
        if (!['jing', 'qi', 'shen'].includes(attribute)) {
          socket.emit('game:error', { message: '无效的属性' });
          return;
        }

        if (session.character.attributePoints < amount) {
          socket.emit('game:error', { message: '属性点不足' });
          return;
        }

        try {
          const success = await this.saveAttributePoints(session.userId, attribute, amount);
          if (success) {
            // 重新加载角色数据
            const updatedCharacter = await this.loadCharacter(session.userId);
            session.character = updatedCharacter;
            session.lastUpdate = Date.now();

            // 广播更新
            socket.emit('game:character', { character: updatedCharacter });
          } else {
            socket.emit('game:error', { message: '加点失败' });
          }
        } catch (error) {
          console.error('加点错误:', error);
          socket.emit('game:error', { message: '服务器错误' });
        }
      });

      // 请求刷新角色数据
      socket.on('game:refresh', async () => {
        const session = this.sessions.get(socket.id);
        if (!session) {
          socket.emit('game:error', { message: '未认证' });
          return;
        }

        try {
          const character = await this.loadCharacter(session.userId);
          session.character = character;
          session.lastUpdate = Date.now();
          socket.emit('game:character', { character });
        } catch (error) {
          console.error('刷新角色错误:', error);
          socket.emit('game:error', { message: '服务器错误' });
        }
      });

      // 断开连接
      socket.on('disconnect', () => {
        const session = this.sessions.get(socket.id);
        if (session) {
          this.userSocketMap.delete(session.userId);
          this.sessions.delete(socket.id);
          this.scheduleEmitOnlinePlayers(true);
        }
      });
    });
  }

  private buildOnlinePlayersPayload(): { total: number; players: OnlinePlayerDto[] } {
    const players: OnlinePlayerDto[] = [];
    for (const session of this.sessions.values()) {
      const c = session.character;
      if (!c) continue;
      players.push({ id: c.id, nickname: c.nickname, title: c.title, realm: c.realm });
    }
    players.sort((a, b) => a.nickname.localeCompare(b.nickname, 'zh-Hans-CN'));
    return { total: players.length, players };
  }

  private emitOnlinePlayersNow(): void {
    const payload = this.buildOnlinePlayersPayload();
    this.io.to('chat:authed').emit('game:onlinePlayers', payload);
  }

  private scheduleEmitOnlinePlayers(force: boolean = false): void {
    if (this.onlinePlayersEmitTimer) {
      this.onlinePlayersEmitQueued = true;
      return;
    }

    const now = Date.now();
    const elapsed = now - this.onlinePlayersLastEmitAt;
    const waitMs = force ? 0 : Math.max(0, ONLINE_PLAYERS_EMIT_INTERVAL_MS - elapsed);

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

  private shouldRefreshOnlinePlayers(prev: CharacterAttributes | null, next: CharacterAttributes | null): boolean {
    if (!prev && !next) return false;
    if (!prev || !next) return true;
    return prev.nickname !== next.nickname || prev.title !== next.title || prev.realm !== next.realm;
  }

  // 加载角色数据
  private async loadCharacter(userId: number): Promise<CharacterAttributes | null> {
    try {
      await applyStaminaRecoveryByUserId(userId);
      const result = await query('SELECT * FROM characters WHERE user_id = $1', [userId]);
      if (result.rows.length === 0) return null;
      const row = result.rows[0] as any;
      const characterId = Number(row.id);
      const character = dbToCharacterAttributes(row);
      if (!Number.isFinite(characterId) || characterId <= 0) {
        return character;
      }
      const passiveRes = await calculateTechniquePassives(characterId);
      if (!passiveRes.success || !passiveRes.data) {
        return character;
      }
      const passives = passiveRes.data;
      const keys = Object.keys(passives);
      if (keys.length === 0) {
        return character;
      }
      const merged: CharacterAttributes = { ...character };
      const permyriadAdditiveKeys = new Set([
        'mingzhong',
        'shanbi',
        'zhaojia',
        'baoji',
        'baoshang',
        'kangbao',
        'zengshang',
        'zhiliao',
        'jianliao',
        'xixue',
        'lengque',
        'shuxing_shuzhi',
        'kongzhi_kangxing',
        'jin_kangxing',
        'mu_kangxing',
        'shui_kangxing',
        'huo_kangxing',
        'tu_kangxing',
        'qixue_huifu',
        'lingqi_huifu',
      ]);
      const percentMultiplyKeys = new Set(['wugong', 'fagong', 'wufang', 'fafang', 'max_qixue']);
      const scaledHundredAddKeys = new Set(['sudu', 'max_lingqi']);
      const toCamel = (k: string) => k.replace(/_([a-z])/g, (_, c) => String(c).toUpperCase());
      const mergedAny = merged as any;
      for (const key of keys) {
        const value = passives[key];
        if (typeof value !== 'number') continue;
        const camelKey = toCamel(key);
        const baseValue = typeof mergedAny[camelKey] === 'number' ? (mergedAny[camelKey] as number) : undefined;
        if (baseValue == null) continue;

        if (permyriadAdditiveKeys.has(key)) {
          mergedAny[camelKey] = baseValue + value;
          continue;
        }

        if (percentMultiplyKeys.has(key)) {
          mergedAny[camelKey] = Math.floor((baseValue * (10000 + value)) / 10000);
          continue;
        }

        if (scaledHundredAddKeys.has(key)) {
          mergedAny[camelKey] = baseValue + value / 100;
          continue;
        }

        mergedAny[camelKey] = baseValue + value;
      }
      return merged;
    } catch (error) {
      console.error('加载角色失败:', error);
      return null;
    }
  }

  private async loadTeamId(characterId: number): Promise<string | null> {
    try {
      const result = await query('SELECT team_id FROM team_members WHERE character_id = $1 LIMIT 1', [characterId]);
      if (result.rows.length === 0) return null;
      const teamId = result.rows[0]?.team_id;
      return typeof teamId === 'string' && teamId ? teamId : null;
    } catch {
      return null;
    }
  }

  private async loadSectId(characterId: number): Promise<string | null> {
    try {
      const result = await query('SELECT sect_id FROM sect_member WHERE character_id = $1 LIMIT 1', [characterId]);
      if (result.rows.length === 0) return null;
      const sectId = result.rows[0]?.sect_id;
      return typeof sectId === 'string' && sectId ? sectId : null;
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
    attribute: 'jing' | 'qi' | 'shen',
    amount: number
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
      return result.rows.length > 0;
    } catch (error) {
      console.error('保存加点失败:', error);
      return false;
    }
  }

  // 向指定用户推送角色更新
  public async pushCharacterUpdate(userId: number): Promise<void> {
    const socketId = this.userSocketMap.get(userId);
    if (!socketId) return;

    const session = this.sessions.get(socketId);
    const prevCharacter = session?.character ?? null;
    const character = await this.loadCharacter(userId);
    if (session) {
      session.character = character;
      session.lastUpdate = Date.now();
    }

    this.io.to(socketId).emit('game:character', { character });
    if (this.shouldRefreshOnlinePlayers(prevCharacter, character)) {
      this.scheduleEmitOnlinePlayers(false);
    }
  }

  public getOnlinePlayersInRoom(mapId: string, roomId: string, excludeUserId?: number): CharacterAttributes[] {
    const players: CharacterAttributes[] = [];
    for (const session of this.sessions.values()) {
      const character = session.character;
      if (!character) continue;
      if (character.currentMapId !== mapId || character.currentRoomId !== roomId) continue;
      if (excludeUserId !== undefined && session.userId === excludeUserId) continue;
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

  // 踢出指定用户
  public kickUser(userId: number, reason: string = '账号已在其他设备登录'): void {
    const socketId = this.userSocketMap.get(userId);
    if (!socketId) return;

    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('game:kicked', { message: reason });
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
}

let gameServer: GameServer | null = null;

// 初始化游戏服务器
export const initGameServer = (
  httpServer: HttpServer,
  corsOrigin: string | string[] | ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void)
): GameServer => {
  if (!gameServer) {
    gameServer = new GameServer(httpServer, corsOrigin);
  }
  return gameServer;
};

// 获取游戏服务器实例
export const getGameServer = (): GameServer => {
  if (!gameServer) {
    throw new Error('游戏服务器未初始化');
  }
  return gameServer;
};
