/**
 * 宗门管理面板。
 * 输入：权限状态、入门申请列表、管理动作回调。
 * 输出：申请审批区 + 公告/捐献/解散等管理入口。
 * 边界：只有具备管理权限时才展示审批区和高危操作按钮。
 */
import { Button, Tag } from 'antd';
import type { SectApplicationDto } from '../../../../../services/api';
import type { SectPermissionState } from '../types';

interface ManagePanelProps {
  permissions: SectPermissionState;
  applications: SectApplicationDto[];
  applicationsLoading: boolean;
  actionLoadingKey: string | null;
  onRefreshApplications: () => void;
  onHandleApplication: (applicationId: number, approve: boolean) => void;
  onOpenDonate: () => void;
  onOpenAnnouncement: () => void;
  onJumpToActivity: () => void;
  onDisband: () => void;
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

const ManagePanel: React.FC<ManagePanelProps> = ({
  permissions,
  applications,
  applicationsLoading,
  actionLoadingKey,
  onRefreshApplications,
  onHandleApplication,
  onOpenDonate,
  onOpenAnnouncement,
  onJumpToActivity,
  onDisband,
}) => {
  return (
    <div className="sect-pane">
      <div className="sect-pane-top">
        <div className="sect-pane-title-wrap">
          <div className="sect-title">宗门管理</div>
          <div className="sect-subtitle">审批入门、公告维护与高权限操作入口。</div>
        </div>
      </div>

      <div className="sect-pane-body sect-panel-scroll">
        {permissions.canManageApplications ? (
          <div className="sect-manage-section">
            <div className="sect-manage-header">
              <div className="sect-manage-title">入门申请</div>
              <Button size="small" loading={applicationsLoading} onClick={onRefreshApplications}>
                刷新
              </Button>
            </div>

            {applications.length === 0 && !applicationsLoading ? <div className="sect-empty">暂无入门申请</div> : null}

            <div className="sect-mobile-list">
              {applications.map((item: SectApplicationDto) => (
                <div key={item.id} className="sect-mobile-card">
                  <div className="sect-mobile-card-head">
                    <div className="sect-mobile-card-title">{item.nickname}</div>
                    <Tag color="cyan">{item.realm}</Tag>
                  </div>
                  <div className="sect-mobile-meta-line">
                    <span className="sect-mobile-meta-item">
                      <span className="sect-mobile-meta-k">申请时间</span>
                      <span className="sect-mobile-meta-v">{formatRelativeTime(item.createdAt)}</span>
                    </span>
                  </div>
                  {item.message ? <div className="sect-mobile-message">留言：{item.message}</div> : null}
                  <div className="sect-mobile-actions">
                    <Button
                      size="small"
                      danger
                      loading={actionLoadingKey === `app-${item.id}`}
                      onClick={() => {
                        void onHandleApplication(item.id, false);
                      }}
                    >
                      拒绝
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      loading={actionLoadingKey === `app-${item.id}`}
                      onClick={() => {
                        void onHandleApplication(item.id, true);
                      }}
                    >
                      同意
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="sect-manage-section">
            <div className="sect-empty">当前职位无审批权限。</div>
          </div>
        )}

        <div className="sect-manage-grid">
          <div className="sect-manage-card">
            <div className="sect-manage-card-title">宗门捐献</div>
            <div className="sect-manage-card-desc">捐献灵石可提升宗门资金并增加个人贡献。</div>
            <Button onClick={onOpenDonate}>立即捐献</Button>
          </div>

          <div className="sect-manage-card">
            <div className="sect-manage-card-title">公告维护</div>
            <div className="sect-manage-card-desc">更新宗门公告，统一对外展示门规与宣言。</div>
            <Button onClick={onOpenAnnouncement} disabled={!permissions.canEditAnnouncement}>
              {permissions.canEditAnnouncement ? '编辑公告' : '无权限'}
            </Button>
          </div>

          <div className="sect-manage-card">
            <div className="sect-manage-card-title">任务管理</div>
            <div className="sect-manage-card-desc">快速跳转至宗门活动页，处理任务相关内容。</div>
            <Button onClick={onJumpToActivity}>前往活动</Button>
          </div>

          <div className="sect-manage-card">
            <div className="sect-manage-card-title">解散宗门</div>
            <div className="sect-manage-card-desc">高危操作，仅宗主可执行，执行后宗门会被永久解散。</div>
            <Button danger disabled={!permissions.canDisbandSect} loading={actionLoadingKey === 'disband'} onClick={onDisband}>
              {permissions.canDisbandSect ? '解散宗门' : '仅宗主可操作'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ManagePanel;
