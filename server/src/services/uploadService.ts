/**
 * 头像上传服务
 */
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query } from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 上传目录
const UPLOAD_DIR = path.join(__dirname, '../../uploads/avatars');

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 文件过滤器
const fileFilter = (
  _req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('只支持 JPG、PNG、GIF、WEBP 格式的图片'));
  }
};

// 存储配置
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `avatar-${uniqueSuffix}${ext}`);
  },
});

// Multer 实例
export const avatarUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB
  },
});

// 更新用户头像
export const updateAvatar = async (
  userId: number,
  filename: string
): Promise<{ success: boolean; message: string; avatarUrl?: string }> => {
  try {
    // 获取旧头像路径
    const oldResult = await query('SELECT avatar FROM characters WHERE user_id = $1', [userId]);
    const oldAvatar = oldResult.rows[0]?.avatar;

    // 更新数据库
    const avatarUrl = `/uploads/avatars/${filename}`;
    await query(
      'UPDATE characters SET avatar = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
      [avatarUrl, userId]
    );

    // 删除旧头像文件
    if (oldAvatar) {
      const oldPath = path.join(__dirname, '../..', oldAvatar);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    return { success: true, message: '头像更新成功', avatarUrl };
  } catch (error) {
    console.error('更新头像失败:', error);
    return { success: false, message: '更新头像失败' };
  }
};

// 删除头像
export const deleteAvatar = async (
  userId: number
): Promise<{ success: boolean; message: string }> => {
  try {
    const result = await query('SELECT avatar FROM characters WHERE user_id = $1', [userId]);
    const avatar = result.rows[0]?.avatar;

    if (avatar) {
      const avatarPath = path.join(__dirname, '../..', avatar);
      if (fs.existsSync(avatarPath)) {
        fs.unlinkSync(avatarPath);
      }
    }

    await query(
      'UPDATE characters SET avatar = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1',
      [userId]
    );

    return { success: true, message: '头像删除成功' };
  } catch (error) {
    console.error('删除头像失败:', error);
    return { success: false, message: '删除头像失败' };
  }
};

