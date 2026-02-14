/**
 * 入宗后的顶部总览。
 * 输入：宗门摘要、快捷动作回调（捐献、编辑公告）。
 * 输出：宗门基础信息 + 关键资源统计 + 快捷入口。
 * 约束：无宗门数据时不渲染任何内容。
 */
import { EditOutlined } from '@ant-design/icons';
import { Button, Tag } from 'antd';
import type { SectJoinedSummary } from '../types';

interface JoinedOverviewHeaderProps {
  summary: SectJoinedSummary | null;
  onDonate: () => void;
  onOpenAnnouncement: () => void;
  canEditAnnouncement: boolean;
}

const JoinedOverviewHeader: React.FC<JoinedOverviewHeaderProps> = ({
  summary,
  onDonate,
  onOpenAnnouncement,
  canEditAnnouncement,
}) => {
  if (!summary) return null;

  return (
    <div className="sect-overview">
      <div className="sect-card">
        <div className="sect-card-left">
          <div className="sect-card-name">{summary.name}</div>
          <div className="sect-card-meta">
            <Tag color="blue">Lv.{summary.level}</Tag>
            <Tag>宗主 {summary.leader}</Tag>
            <Tag>
              成员 {summary.members}/{summary.memberCap}
            </Tag>
          </div>
          <div className="sect-card-notice">
            {canEditAnnouncement ? (
              <button
                type="button"
                className="sect-card-notice-edit"
                onClick={onOpenAnnouncement}
                aria-label="编辑公告"
                title="编辑公告"
              >
                <EditOutlined className="sect-card-notice-icon" />
              </button>
            ) : null}
            <span className="sect-card-notice-text">{summary.notice || '暂无公告'}</span>
          </div>
        </div>
        <div className="sect-card-actions">
          <Button onClick={onDonate}>宗门捐献</Button>
        </div>
      </div>

      <div className="sect-grid">
        <div className="sect-stat">
          <div className="sect-stat-k">宗门资金</div>
          <div className="sect-stat-v">{summary.funds.toLocaleString()}</div>
        </div>
        <div className="sect-stat">
          <div className="sect-stat-k">建设点</div>
          <div className="sect-stat-v">{summary.buildPoints.toLocaleString()}</div>
        </div>
        <div className="sect-stat">
          <div className="sect-stat-k">宗门声望</div>
          <div className="sect-stat-v">{summary.reputation.toLocaleString()}</div>
        </div>
        <div className="sect-stat">
          <div className="sect-stat-k">成员规模</div>
          <div className="sect-stat-v">
            {summary.members}/{summary.memberCap}
          </div>
        </div>
      </div>
    </div>
  );
};

export default JoinedOverviewHeader;
