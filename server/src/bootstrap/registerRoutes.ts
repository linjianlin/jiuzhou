import type { Express, Request, Response } from 'express';
import { errorHandler } from '../middleware/errorHandler.js';
import authRoutes from '../routes/authRoutes.js';
import characterRoutes from '../routes/characterRoutes.js';
import uploadRoutes from '../routes/uploadRoutes.js';
import attributeRoutes from '../routes/attributeRoutes.js';
import inventoryRoutes from '../routes/inventoryRoutes.js';
import signInRoutes from '../routes/signInRoutes.js';
import mailRoutes from '../routes/mailRoutes.js';
import mapRoutes from '../routes/mapRoutes.js';
import infoRoutes from '../routes/infoRoutes.js';
import battleRoutes from '../routes/battleRoutes.js';
import techniqueRoutes from '../routes/techniqueRoutes.js';
import characterTechniqueRoutes from '../routes/characterTechniqueRoutes.js';
import teamRoutes from '../routes/teamRoutes.js';
import marketRoutes from '../routes/marketRoutes.js';
import dungeonRoutes from '../routes/dungeonRoutes.js';
import monthCardRoutes from '../routes/monthCardRoutes.js';
import sectRoutes from '../routes/sectRoutes.js';
import rankRoutes from '../routes/rankRoutes.js';
import realmRoutes from '../routes/realmRoutes.js';
import battlePassRoutes from '../routes/battlePassRoutes.js';
import taskRoutes from '../routes/taskRoutes.js';
import bountyRoutes from '../routes/bountyRoutes.js';
import timeRoutes from '../routes/timeRoutes.js';
import mainQuestRoutes from '../routes/mainQuestRoutes.js';
import arenaRoutes from '../routes/arenaRoutes.js';
import achievementRoutes from '../routes/achievementRoutes.js';
import titleRoutes from '../routes/titleRoutes.js';
import idleRoutes from '../routes/idleRoutes.js';
import insightRoutes from '../routes/insightRoutes.js';

/**
 * 统一注册 HTTP 路由。
 * 注意：只处理“路由挂载”，不处理启动流程与依赖检查。
 */
export const registerRoutes = (app: Express): void => {
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
  app.use('/api/idle', idleRoutes);
  app.use('/api/insight', insightRoutes);

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: '九州修仙录',
      version: '1.0.0',
      status: 'running',
    });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // 全局错误处理中间件（必须注册在所有路由之后）
  app.use(errorHandler);
};
