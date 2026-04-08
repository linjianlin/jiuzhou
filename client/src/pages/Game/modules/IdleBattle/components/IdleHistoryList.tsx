/**
 * IdleHistoryList — 挂机历史记录列表
 *
 * 作用：
 *   按时间倒序展示最近 3 条挂机会话记录。
 *   点击任意记录触发 onSelectSession，由外层打开 ReplayViewer。
 *   不包含数据请求逻辑，所有数据通过 props 传入。
 *
 * 输入/输出：
 *   - history: 历史会话列表（已由 useIdleBattle 保证倒序、最多 3 条）
 *   - isLoading: 加载状态
 *   - onSelectSession: 点击记录时的回调，传入 sessionId
 *   - onRefresh: 手动刷新回调（可选）
 *
 * 数据流：
 *   useIdleBattle.history → props.history → 列表渲染
 *   用户点击 → onSelectSession(sessionId) → useIdleBattle.selectSession → ReplayViewer 打开
 *
 * 关键边界条件：
 *   1. history 为空时展示空状态，不报错
 *   2. 无
 */

import React from 'react';
import { Button, Empty, Spin, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { IdleSessionDto } from '../types';
import './IdleHistoryList.scss';

// ============================================
// 工具函数
// ============================================

/**
 * 格式化会话时长（startedAt → endedAt 或当前时间）
 * 复用点：仅此处使用，不抽到全局 util
 */
const formatDuration = (startedAt: string, endedAt: string | null): string => {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}时${m}分`;
  return `${m}分`;
};

/**
 * 格式化日期为本地短格式（MM/DD HH:mm）
 */
const formatDate = (iso: string): string => {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
};

const STATUS_LABEL: Record<IdleSessionDto['status'], string> = {
  active: '进行中',
  stopping: '停止中',
  completed: '已完成',
  interrupted: '已中断',
};

const STATUS_COLOR: Record<IdleSessionDto['status'], string> = {
  active: 'processing',
  stopping: 'warning',
  completed: 'success',
  interrupted: 'default',
};

// ============================================
// Props
// ============================================

interface IdleHistoryListProps {
  history: IdleSessionDto[];
  isLoading: boolean;
  onSelectSession: (sessionId: string) => void;
  onRefresh?: () => void;
}

// ============================================
// 组件
// ============================================

const IdleHistoryList: React.FC<IdleHistoryListProps> = ({
  history,
  isLoading,
  onSelectSession,
  onRefresh,
}) => {
  return (
    <div className="idle-history-list">
      {/* 操作栏 */}
      {onRefresh && (
        <div className="idle-history-header">
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined spin={isLoading} />}
            onClick={onRefresh}
            disabled={isLoading}
            aria-label="刷新历史记录"
            className="idle-history-refresh-btn"
          >
            刷新记录
          </Button>
        </div>
      )}

      {/* 列表主体 */}
      <div className="idle-history-body">
        <Spin spinning={isLoading}>
          {history.length === 0 ? (
            <Empty
              description="暂无挂机记录"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              className="idle-history-empty"
            />
          ) : (
            <div className="idle-history-items">
              {history.map((session) => (
                <div
                key={session.id}
                className={`idle-history-item${session.viewedAt === null ? ' is-unviewed' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => onSelectSession(session.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectSession(session.id);
                  }
                }}
              >

                {/* 第一行：状态 + 时间 */}
                <div className="idle-history-item-row">
                  <Tag
                    color={STATUS_COLOR[session.status]}
                    className="idle-history-status-tag"
                  >
                    {STATUS_LABEL[session.status]}
                  </Tag>
                  <span className="idle-history-date">{formatDate(session.startedAt)}</span>
                  <span className="idle-history-duration">
                    {formatDuration(session.startedAt, session.endedAt)}
                  </span>
                </div>

                {/* 第二行：战斗统计 */}
                <div className="idle-history-item-row idle-history-item-row--stats">
                  <span className="idle-history-stat">
                    {session.totalBattles} 场
                    <span className="idle-history-stat-detail">
                      （胜 {session.winCount} / 败 {session.loseCount}）
                    </span>
                  </span>
                  <span className="idle-history-stat idle-history-stat--exp">
                    修为+{session.totalExp.toLocaleString()}
                  </span>
                  <span className="idle-history-stat idle-history-stat--silver">
                    银两+{session.totalSilver.toLocaleString()}
                  </span>
                </div>

                {/* 背包满提示 */}
                {session.bagFullFlag && (
                  <div className="idle-history-bag-warn">背包空间不足时，部分物品已通过邮件补发</div>
                )}
              </div>
            ))}
          </div>
        )}
      </Spin>
      </div>
    </div>
  );
};

export default IdleHistoryList;
