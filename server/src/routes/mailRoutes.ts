import { Router, Request, Response } from 'express';
/**
 * 九州修仙录 - 邮件路由
 */
import { withRouteError } from '../middleware/routeError.js';
import { requireCharacter } from '../middleware/auth.js';
import { mailService } from '../services/mailService.js';

const router = Router();

// 兼容前端把 BIGINT 主键当成字符串传回来的情况
const parseMailId = (raw: unknown): number | null => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

router.use(requireCharacter);

// ============================================
// 获取邮件列表
// ============================================
router.get('/list', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 100);

    const result = await mailService.getMailList(userId, characterId, page, pageSize);

    return res.json({
      success: true,
      data: {
        mails: result.mails,
        total: result.total,
        unreadCount: result.unreadCount,
        unclaimedCount: result.unclaimedCount,
        page,
        pageSize
      }
    });
  } catch (error) {
    return withRouteError(res, 'mailRoutes 路由异常', error);
  }
});

// ============================================
// 获取未读数量（红点）
// ============================================
router.get('/unread', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const result = await mailService.getUnreadCount(userId, characterId);

    return res.json({
      success: true,
      data: result
    });
  } catch (error) {
    return withRouteError(res, 'mailRoutes 路由异常', error);
  }
});

// ============================================
// 阅读邮件
// ============================================
router.post('/read', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const parsedMailId = parseMailId((req.body as { mailId?: unknown })?.mailId);
    if (!parsedMailId) {
      return res.status(400).json({ success: false, message: '参数错误' });
    }

    const result = await mailService.readMail(userId, characterId, parsedMailId);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'mailRoutes 路由异常', error);
  }
});

// ============================================
// 领取附件
// ============================================
router.post('/claim', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const parsedMailId = parseMailId((req.body as { mailId?: unknown })?.mailId);
    if (!parsedMailId) {
      return res.status(400).json({ success: false, message: '参数错误' });
    }

    const result = await mailService.claimAttachments(userId, characterId, parsedMailId);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'mailRoutes 路由异常', error);
  }
});

// ============================================
// 一键领取所有附件
// ============================================
router.post('/claim-all', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const result = await mailService.claimAllAttachments(userId, characterId);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'mailRoutes 路由异常', error);
  }
});

// ============================================
// 删除邮件
// ============================================
router.post('/delete', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const parsedMailId = parseMailId((req.body as { mailId?: unknown })?.mailId);
    if (!parsedMailId) {
      return res.status(400).json({ success: false, message: '参数错误' });
    }

    const result = await mailService.deleteMail(userId, characterId, parsedMailId);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'mailRoutes 路由异常', error);
  }
});

// ============================================
// 一键删除所有邮件
// ============================================
router.post('/delete-all', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { onlyRead } = req.body;
    const result = await mailService.deleteAllMails(userId, characterId, !!onlyRead);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'mailRoutes 路由异常', error);
  }
});

// ============================================
// 标记全部已读
// ============================================
router.post('/read-all', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const result = await mailService.markAllRead(userId, characterId);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'mailRoutes 路由异常', error);
  }
});

export default router;
