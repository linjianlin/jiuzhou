/**
 * 宗门日志面板。
 * 输入：日志列表与刷新动作，可选 `embedded`（是否以内嵌区块渲染）。
 * 输出：按时间倒序的宗门操作记录。
 * 边界：
 * 1) 日志为空时展示空态，不展示伪造占位内容；
 * 2) embedded=true 时不再输出整页容器，便于并入“基础信息”标签；
 * 3) 刷新入口使用图标按钮，减少标题区横向占用。
 */
import { ReloadOutlined } from '@ant-design/icons';
import { Button, Tag } from 'antd';
import type { SectLogDto } from '../../../../../services/api';

interface LogsPanelProps {
  loading: boolean;
  logs: SectLogDto[];
  onRefresh: () => void;
  embedded?: boolean;
}

/**
 * 后端 logType 为英文键名，这里统一翻译成中文标签。
 * 约束：未知类型直接回退原值，避免新日志类型上线后前端出现空白。
 */
const LOG_TYPE_LABEL_MAP: Record<string, string> = {
  create: '创建宗门',
  update_announcement: '更新公告',
  transfer_leader: '转让宗主',
  disband: '解散宗门',
  leave: '退出宗门',
  kick: '踢出成员',
  appoint: '任命职位',
  apply: '提交申请',
  approve: '通过申请',
  donate: '捐献',
  upgrade_building: '升级建筑',
  shop_buy: '商店购买',
  quest_submit: '任务提交',
  quest_claim: '任务领奖',
};

const formatLogType = (logType: string): string => {
  const raw = String(logType).trim();
  if (!raw) return '未知事件';
  return LOG_TYPE_LABEL_MAP[raw] ?? raw;
};

/**
 * 商店购买日志会附带内部标记（用于后端限购统计），前端展示时需要去掉。
 */
const SHOP_LOG_MARKER_PATTERN = /\s*\[shop_item:[^\]]+\]\s*$/i;

/**
 * 规范化商店购买日志内容：
 * 1) 去掉内部 marker；
 * 2) 将“名称×单次数量×购买次数”合并为“名称×总数量”，避免出现“×1×1”。
 */
const formatShopBuyContent = (content: string): string => {
  const cleaned = content.replace(SHOP_LOG_MARKER_PATTERN, '').trim();
  const prefix = '购买：';
  if (!cleaned.startsWith(prefix)) return cleaned;

  const body = cleaned.slice(prefix.length).trim();
  const matched = /^(.*?)[xX×]\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(body);
  if (!matched) return cleaned;

  const itemName = String(matched[1] ?? '').trim();
  const unitQty = Number.parseInt(matched[2] ?? '', 10);
  const buyTimes = Number.parseInt(matched[3] ?? '', 10);
  if (!Number.isFinite(unitQty) || unitQty <= 0) return cleaned;
  if (!Number.isFinite(buyTimes) || buyTimes <= 0) return cleaned;

  return `${prefix}${itemName}×${unitQty * buyTimes}`;
};

const formatLogContent = (logType: string, content: string): string => {
  const raw = String(content).trim();
  if (!raw) return '';
  if (logType === 'shop_buy') return formatShopBuyContent(raw);
  return raw;
};

const formatTime = (dateString: string): string => {
  const date = new Date(dateString);
  if (!Number.isFinite(date.getTime())) return dateString;
  const pad = (value: number) => String(value).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${y}-${m}-${d} ${hh}:${mm}`;
};

const LogsList: React.FC<{ loading: boolean; logs: SectLogDto[] }> = ({ loading, logs }) => {
  return (
    <>
      {logs.length === 0 && !loading ? <div className="sect-empty">暂无日志记录</div> : null}

      <div className="sect-log-list">
        {logs.map((row: SectLogDto) => (
          <div key={row.id} className="sect-log-card">
            <div className="sect-log-head">
              <Tag color="default">{formatLogType(row.logType)}</Tag>
              <span className="sect-log-time">{formatTime(row.createdAt)}</span>
            </div>
            <div className="sect-log-content">{formatLogContent(row.logType, row.content) || '（无内容）'}</div>
            <div className="sect-log-meta">
              {row.operatorName ? <span>操作人：{row.operatorName}</span> : null}
              {row.targetName ? <span>目标：{row.targetName}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </>
  );
};

const LogsPanel: React.FC<LogsPanelProps> = ({ loading, logs, onRefresh, embedded = false }) => {
  const refreshButton = (
    <Button
      onClick={onRefresh}
      loading={loading}
      icon={<ReloadOutlined />}
      aria-label="刷新日志"
      title="刷新日志"
    />
  );

  if (embedded) {
    return (
      <div className="sect-overview-log-section">
        <div className="sect-overview-log-top">
          <div className="sect-overview-log-title-wrap">
            <div className="sect-title">宗门日志</div>
            <div className="sect-subtitle">记录宗门管理与成员行为，便于追踪关键事件。</div>
          </div>
          <div className="sect-pane-actions">{refreshButton}</div>
        </div>
        <LogsList loading={loading} logs={logs} />
      </div>
    );
  }

  return (
    <div className="sect-pane">
      <div className="sect-pane-top">
        <div className="sect-pane-title-wrap">
          <div className="sect-title">宗门日志</div>
          <div className="sect-subtitle">记录宗门管理与成员行为，便于追踪关键事件。</div>
        </div>
        <div className="sect-pane-actions">{refreshButton}</div>
      </div>

      <div className="sect-pane-body sect-panel-scroll">
        <LogsList loading={loading} logs={logs} />
      </div>
    </div>
  );
};

export default LogsPanel;
