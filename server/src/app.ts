import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { testConnection, pool } from './config/database.js';
import { testRedisConnection, closeRedis } from './config/redis.js';
import { initSocket } from './config/socket.js';
import { initTables } from './models/initTables.js';
import { initGameServer } from './game/gameServer.js';
import authRoutes from './routes/authRoutes.js';
import characterRoutes from './routes/characterRoutes.js';
import uploadRoutes from './routes/uploadRoutes.js';
import attributeRoutes from './routes/attributeRoutes.js';
import inventoryRoutes from './routes/inventoryRoutes.js';
import signInRoutes from './routes/signInRoutes.js';
import mailRoutes from './routes/mailRoutes.js';
import mapRoutes from './routes/mapRoutes.js';
import infoRoutes from './routes/infoRoutes.js';
import battleRoutes from './routes/battleRoutes.js';
import techniqueRoutes from './routes/techniqueRoutes.js';
import characterTechniqueRoutes from './routes/characterTechniqueRoutes.js';
import teamRoutes from './routes/teamRoutes.js';
import marketRoutes from './routes/marketRoutes.js';
import dungeonRoutes from './routes/dungeonRoutes.js';
import monthCardRoutes from './routes/monthCardRoutes.js';
import sectRoutes from './routes/sectRoutes.js';
import rankRoutes from './routes/rankRoutes.js';
import realmRoutes from './routes/realmRoutes.js';
import battlePassRoutes from './routes/battlePassRoutes.js';
import taskRoutes from './routes/taskRoutes.js';
import bountyRoutes from './routes/bountyRoutes.js';
import timeRoutes from './routes/timeRoutes.js';
import mainQuestRoutes from './routes/mainQuestRoutes.js';
import arenaRoutes from './routes/arenaRoutes.js';
import achievementRoutes from './routes/achievementRoutes.js';
import titleRoutes from './routes/titleRoutes.js';
import { initGameTimeService } from './services/gameTimeService.js';
import { recoverBattlesFromRedis } from './services/battleService.js';
import { cleanupUndefinedItemDataOnStartup } from './services/itemDataCleanupService.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

type CorsOriginFn = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void;

const parseCorsOrigins = (raw: string): string[] => {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

const buildDefaultCorsOriginOption = (): CorsOriginFn => {
  return (origin, cb) => {
    if (!origin) return cb(null, true);
    const v = String(origin ?? '').trim();
    if (!v) return cb(null, true);
    try {
      const url = new URL(v);
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      return cb(null, port === '6010');
    } catch {
      return cb(null, false);
    }
  };
};

const buildCorsOriginOption = (raw: string | undefined): string | CorsOriginFn => {
  const v = String(raw ?? '').trim();
  if (!v) return buildDefaultCorsOriginOption();
  if (v === '*') return (_origin, cb) => cb(null, true);
  const list = parseCorsOrigins(v);
  if (list.length <= 1) return list[0] ?? buildDefaultCorsOriginOption();
  return (origin, cb) => {
    if (!origin) return cb(null, true);
    return cb(null, list.includes(origin));
  };
};

const HOST = String(process.env.HOST ?? '0.0.0.0').trim() || '0.0.0.0';
const PORT = Number(process.env.PORT || 6011);
const corsOriginOption = buildCorsOriginOption(process.env.CORS_ORIGIN);

// 中间件
app.use(cors({ origin: corsOriginOption as any, credentials: true }));
app.use(express.json());

// 静态文件服务（头像）
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// 初始化Socket.io（聊天等）
initSocket(httpServer, corsOriginOption as any);

// 初始化游戏服务器（boardgame.io）
initGameServer(httpServer, corsOriginOption as any);

// 路由
app.use('/api/auth', authRoutes);
app.use('/api/character', characterRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/attribute', attributeRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/signin', signInRoutes);
app.use('/api/mail', mailRoutes);
app.use('/api/map', mapRoutes);
app.use('/api/info', infoRoutes);
app.use('/api/battle', battleRoutes);
app.use('/api/technique', techniqueRoutes);
app.use('/api/character', characterTechniqueRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/dungeon', dungeonRoutes);
app.use('/api/monthcard', monthCardRoutes);
app.use('/api/battlepass', battlePassRoutes);
app.use('/api/sect', sectRoutes);
app.use('/api/rank', rankRoutes);
app.use('/api/realm', realmRoutes);
app.use('/api/task', taskRoutes);
app.use('/api/bounty', bountyRoutes);
app.use('/api/time', timeRoutes);
app.use('/api/main-quest', mainQuestRoutes);
app.use('/api/arena', arenaRoutes);
app.use('/api/achievement', achievementRoutes);
app.use('/api/title', titleRoutes);

// 基础路由
app.get('/', (_req, res) => {
  res.json({ 
    name: '九州修仙录',
    version: '1.0.0',
    status: 'running'
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// 启动服务
const startServer = async () => {
  try {
    console.log('\n🎮 九州修仙录 服务启动中...\n');

    // 测试数据库连接
    const dbConnected = await testConnection();
    if (!dbConnected) {
      console.error('数据库连接失败，服务启动终止');
      process.exit(1);
    }

    // 测试 Redis 连接
    const redisConnected = await testRedisConnection();
    if (!redisConnected) {
      console.warn('⚠ Redis 连接失败，战斗状态将不会持久化');
    }

    // 初始化数据库表
    await initTables();

    // 启动清理：删除数据库中已不存在静态定义的物品数据
    await cleanupUndefinedItemDataOnStartup();

    // 初始化游戏时间（启动计时）
    await initGameTimeService();

    // 从 Redis 恢复活跃战斗
    if (redisConnected) {
      console.log('正在恢复战斗状态...');
      await recoverBattlesFromRedis();
    }

    // 启动HTTP服务
    httpServer.listen(PORT, HOST, () => {
      console.log(`🚀 服务已启动: http://${HOST}:${PORT} (或 http://localhost:${PORT})\n`);
    });
  } catch (error) {
    console.error('服务启动失败:', error);
    process.exit(1);
  }
};

// 优雅关闭处理
const gracefulShutdown = async (signal: string) => {
  console.log(`\n收到 ${signal} 信号，开始优雅关闭...`);

  // 停止接受新连接
  httpServer.close(() => {
    console.log('HTTP 服务已关闭');
  });

  // 等待一小段时间让最后的战斗状态保存到 Redis
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // 关闭 Redis 连接
  try {
    await closeRedis();
    console.log('Redis 连接已关闭');
  } catch (error) {
    console.error('关闭 Redis 连接失败:', error);
  }

  // 关闭数据库连接池
  try {
    await pool.end();
    console.log('数据库连接池已关闭');
  } catch (error) {
    console.error('关闭数据库连接池失败:', error);
  }

  console.log('服务已关闭');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();
