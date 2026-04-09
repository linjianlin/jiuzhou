import './bootstrap/installConsoleLogger.js';
import express from 'express';
import { createServer } from 'http';
import cors, { type CorsOptions } from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { initSocket } from './config/socket.js';
import { initGameServer } from './game/gameServer.js';
import { buildCorsOriginOption } from './bootstrap/cors.js';
import { registerRoutes } from './bootstrap/registerRoutes.js';
import { registerGracefulShutdown, startServerWithPipeline } from './bootstrap/startupPipeline.js';
import { isTransactionRollbackOnlyError } from './config/database.js';
import { isTransientPgError } from './config/databaseRuntimeError.js';
import { httpSlowRequestLogger } from './middleware/httpSlowRequestLogger.js';
import { setGameTimeSnapshotBroadcaster } from './services/gameTimeService.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

// 线上由 Caddy 反代到容器，需信任 1 层代理后才能从 X-Forwarded-For 读取真实客户端 IP。
app.set('trust proxy', 1);

const HOST = String(process.env.HOST ?? '0.0.0.0').trim() || '0.0.0.0';
const PORT = Number(process.env.PORT || 6011);
const corsOriginOption = buildCorsOriginOption(process.env.CORS_ORIGIN);
const corsOrigin = corsOriginOption as CorsOptions['origin'];

// 中间件
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());

// 静态文件服务（头像）
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// 全局 HTTP 慢请求日志（仅覆盖真实接口，不统计静态资源）
app.use(httpSlowRequestLogger);

// 初始化Socket.io（聊天等）
initSocket(httpServer, corsOriginOption);

// 初始化游戏服务器（boardgame.io）
const gameServer = initGameServer(httpServer, corsOriginOption);

setGameTimeSnapshotBroadcaster((snapshot) => {
  gameServer.getIO().to('chat:authed').emit('game:time-sync', snapshot);
});

registerRoutes(app);
registerGracefulShutdown(httpServer);

process.on('unhandledRejection', (reason) => {
  if (isTransactionRollbackOnlyError(reason)) {
    console.error('捕获未处理的事务回滚异常，已阻止进程崩溃:', reason);
    return;
  }
  if (reason instanceof Error && isTransientPgError(reason)) {
    console.error('捕获未处理的瞬时数据库异常，已阻止进程崩溃:', reason);
    return;
  }

  throw reason instanceof Error ? reason : new Error(String(reason));
});

process.on('uncaughtException', (error) => {
  if (isTransactionRollbackOnlyError(error)) {
    console.error('捕获未处理的事务回滚异常，已阻止进程崩溃:', error);
    return;
  }
  if (isTransientPgError(error)) {
    console.error('捕获未处理的瞬时数据库异常，已阻止进程崩溃:', error);
    return;
  }

  console.error('未捕获异常，服务即将退出:', error);
  process.exit(1);
});

void startServerWithPipeline({
  httpServer,
  host: HOST,
  port: PORT,
}).catch((error) => {
  console.error('服务启动失败:', error);
  process.exit(1);
});
