/**
 * 我的入门申请面板。
 * 输入：当前角色的 pending 申请列表与撤回回调。
 * 输出：申请状态卡片和撤回动作。
 * 注意：仅展示 pending，避免混入历史状态导致交互歧义。
 */
import { Button, Tag } from 'antd';
import { JOIN_TYPE_LABEL_MAP } from '../constants';
import type { SectMyApplicationDto } from '../../../../../services/api';

interface MyApplicationsPanelProps {
  loading: boolean;
  applications: SectMyApplicationDto[];
  actionLoadingKey: string | null;
  onRefresh: () => void;
  onCancel: (applicationId: number) => void;
}

const formatRelativeTime = (dateString: string): string => {
  const now = Date.now();
  const past = new Date(dateString).getTime();
  if (!Number.isFinite(past)) return '刚刚';
  const diff = now - past;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(diff / 86400000);
  return `${days}天前`;
};

const MyApplicationsPanel: React.FC<MyApplicationsPanelProps> = ({ loading, applications, actionLoadingKey, onRefresh, onCancel }) => {
  return (
    <div className="sect-pane">
      <div className="sect-pane-top">
        <div className="sect-pane-title-wrap">
          <div className="sect-title">我的申请</div>
        </div>
        <div className="sect-pane-actions">
          <Button onClick={onRefresh} loading={loading}>
            刷新
          </Button>
        </div>
      </div>

      <div className="sect-pane-body">
        {applications.length === 0 && !loading ? <div className="sect-empty">当前没有待处理申请</div> : null}
        <div className="sect-mobile-list">
          {applications.map((item) => (
            <div key={item.id} className="sect-mobile-card">
              <div className="sect-mobile-card-head">
                <div className="sect-mobile-card-title">{item.sectName}</div>
                <Tag color="blue">Lv.{item.sectLevel}</Tag>
              </div>
              <div className="sect-mobile-meta-line">
                <span className="sect-mobile-meta-item">
                  <span className="sect-mobile-meta-k">成员</span>
                  <span className="sect-mobile-meta-v">
                    {item.memberCount}/{item.maxMembers}
                  </span>
                </span>
                <span className="sect-mobile-meta-item">
                  <span className="sect-mobile-meta-k">加入方式</span>
                  <span className="sect-mobile-meta-v">{JOIN_TYPE_LABEL_MAP[item.joinType]}</span>
                </span>
                <span className="sect-mobile-meta-item">
                  <span className="sect-mobile-meta-k">申请时间</span>
                  <span className="sect-mobile-meta-v">{formatRelativeTime(item.createdAt)}</span>
                </span>
              </div>
              {item.message ? <div className="sect-mobile-message">留言：{item.message}</div> : null}
              <div className="sect-mobile-actions">
                <Button
                  danger
                  loading={actionLoadingKey === `cancel-apply-${item.id}`}
                  onClick={() => {
                    void onCancel(item.id);
                  }}
                >
                  撤回申请
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default MyApplicationsPanel;
