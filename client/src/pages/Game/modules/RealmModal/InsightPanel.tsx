/**
 * 悟道面板组件
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：承载悟道总览展示、长按注入过程中的累计增量展示、升级进度展示。
 * 2) 不做什么：不直接发起 API 请求，不处理长按事件与提交按钮行为。
 *
 * 输入/输出：
 * - 输入：悟道总览数据、长按注入累计增量、升级进度百分比。
 * - 输出：纯展示组件，无外部事件输出。
 *
 * 数据流/状态流：
 * RealmModal（注入状态机） -> InsightPanel（展示）-> 用户观察实时数值变化。
 *
 * 关键边界条件与坑点：
 * 1) 未解锁状态只展示解锁条件，不允许触发注入。
 * 2) “+XX” 增量是本次长按会话累计值，会在下一次长按开始时重置。
 */
import { Progress } from 'antd';
import type { InsightOverviewDto } from '../../../../services/api/combat-realm';
import { formatInsightPctText } from './insightShared';

interface InsightPanelProps {
  overview: InsightOverviewDto | null;
  holdGainLevels: number;
  holdSpentExp: number;
  holdGainBonusPct: number;
  upgradeProgressPct: number;
}

const InsightPanel: React.FC<InsightPanelProps> = ({
  overview,
  holdGainLevels,
  holdSpentExp,
  holdGainBonusPct,
  upgradeProgressPct,
}) => {
  if (!overview) {
    return <div className="realm-empty">悟道数据加载失败</div>;
  }

  if (!overview.unlocked) {
    return (
      <div className="realm-insight-lock">
        <div className="realm-insight-lock-title">悟道尚未解锁</div>
        <div className="realm-insight-lock-detail">需达到境界：{overview.unlockRealm}</div>
      </div>
    );
  }

  return (
    <div className="realm-insight-panel">
      <div className="realm-insight-overview-grid">
        <div className="realm-insight-overview-card">
          <div className="realm-insight-overview-k">当前悟道等级</div>
          <div className="realm-insight-value-row">
            <div className="realm-insight-overview-v">{overview.currentLevel.toLocaleString()}</div>
            <div className="realm-insight-value-delta">+{holdGainLevels.toLocaleString()}</div>
          </div>
        </div>
        <div className="realm-insight-overview-card">
          <div className="realm-insight-overview-k">当前总加成</div>
          <div className="realm-insight-value-row">
            <div className="realm-insight-overview-v">{formatInsightPctText(overview.currentBonusPct)}</div>
            <div className="realm-insight-value-delta">+{formatInsightPctText(holdGainBonusPct)}</div>
          </div>
        </div>
        <div className="realm-insight-overview-card">
          <div className="realm-insight-overview-k">下一等级消耗</div>
          <div className="realm-insight-overview-v">{overview.nextLevelCostExp.toLocaleString()}</div>
        </div>
        <div className="realm-insight-overview-card">
          <div className="realm-insight-overview-k">当前经验</div>
          <div className="realm-insight-value-row">
            <div className="realm-insight-overview-v">{overview.characterExp.toLocaleString()}</div>
            <div className="realm-insight-value-delta">+{holdSpentExp.toLocaleString()}</div>
          </div>
        </div>
      </div>

      <div className="realm-insight-inject-card">
        <div className="realm-insight-inject-head">
          <div className="realm-insight-inject-title">注入经验</div>
          <div className="realm-insight-inject-tip">按住底部按钮持续注入，松开即停止</div>
        </div>

        <div className="realm-insight-inject-metrics">
          <div className="realm-insight-inject-metric">
            <div className="realm-insight-inject-metric-k">本次注入等级</div>
            <div className="realm-insight-inject-metric-v">+{holdGainLevels.toLocaleString()}</div>
          </div>
          <div className="realm-insight-inject-metric">
            <div className="realm-insight-inject-metric-k">本次注入经验</div>
            <div className="realm-insight-inject-metric-v">+{holdSpentExp.toLocaleString()}</div>
          </div>
        </div>

        <div className="realm-insight-progress-row">
          <div className="realm-insight-progress-k">升级进度</div>
          <div className="realm-insight-progress-v">{upgradeProgressPct.toFixed(2)}%</div>
        </div>
        <Progress percent={upgradeProgressPct} showInfo={false} strokeColor="var(--primary-color)" />
      </div>
    </div>
  );
};

export default InsightPanel;
