import { Alert, Button, Modal, Spin, Tag, Tabs, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SILENT_API_REQUEST_CONFIG,
  getTowerOverview,
  getTowerRankList,
  getUnifiedApiErrorMessage,
  startTowerChallenge,
  type BattleSessionSnapshotDto,
  type BattleStateDto,
  type TowerFloorPreviewDto,
  type TowerOverviewDto,
  type TowerRankRowDto,
} from '../../../../services/api';
import './index.scss';

interface TowerModalProps {
  open: boolean;
  inTeam: boolean;
  onClose: () => void;
  onChallengeStarted: (payload: {
    session: BattleSessionSnapshotDto;
    state?: BattleStateDto;
  }) => void;
}

const FLOOR_KIND_LABEL: Record<TowerFloorPreviewDto['kind'], string> = {
  normal: '普通层',
  elite: '精英层',
  boss: '首领层',
};

const FLOOR_KIND_DESCRIPTION: Record<TowerFloorPreviewDto['kind'], string> = {
  normal: '此层守敌寻常，正可试锋。',
  elite: '此层有精英镇守，不可轻敌。',
  boss: '此层强敌坐镇，需全力破关。',
};

const FloorPreviewCard: React.FC<{
  title: string;
  preview: TowerFloorPreviewDto;
}> = ({ title, preview }) => {
  return (
    <section className="tower-preview-card">
      <div className="tower-preview-card-header">
        <div>
          <div className="tower-preview-card-eyebrow">{title}</div>
          <div className="tower-preview-card-title">第 {preview.floor} 层</div>
          <div className="tower-preview-card-subtitle">{FLOOR_KIND_DESCRIPTION[preview.kind]}</div>
        </div>
        <div className="tower-preview-card-tags">
          <Tag>{FLOOR_KIND_LABEL[preview.kind]}</Tag>
          <Tag>{preview.realm}</Tag>
        </div>
      </div>

      <div className="tower-preview-block">
        <div className="tower-preview-label">怪物</div>
        <div className="tower-preview-monsters">
          {preview.monsterNames.map((name, index) => (
            <span key={`${preview.floor}-${name}-${index}`} className="tower-preview-monster-chip">
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
};

/**
 * 千层塔入口弹窗。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中展示塔进度、下一层预览和排行榜，并把“开始/继续挑战”入口统一收在一处，避免地图入口和功能菜单各自拼业务 UI。
 * 2. 做什么：把 overview/rank/start 三个接口的请求与展示状态集中管理，减少 Game 页面散落的加载逻辑。
 * 3. 不做什么：不直接维护 BattleArea 状态；真正进入战斗仍由 Game 页统一接管。
 *
 * 输入/输出：
 * - 输入：弹窗开关、是否组队、挑战成功后的回调。
 * - 输出：点击开始后把 session/state 回传给上层，由上层切换到战斗视图。
 *
 * 数据流/状态流：
 * - open -> 拉 overview/rank -> 点击挑战 -> start 接口 -> onChallengeStarted -> Game 激活 battle view。
 *
 * 关键边界条件与坑点：
 * 1. 组队限制只在这里做前置禁用提示，真正的业务校验仍以后端返回为准，避免前后端口径漂移。
 * 2. 概览和排行共用同一弹窗，不要在切 tab 时重复清空已有数据，否则会造成移动端频繁闪烁。
 */
const TowerModal: React.FC<TowerModalProps> = ({
  open,
  inTeam,
  onClose,
  onChallengeStarted,
}) => {
  const [overview, setOverview] = useState<TowerOverviewDto | null>(null);
  const [rankRows, setRankRows] = useState<TowerRankRowDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [loadError, setLoadError] = useState('');

  const loadTowerData = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [overviewRes, rankRes] = await Promise.all([
        getTowerOverview(),
        getTowerRankList(50),
      ]);

      if (overviewRes.success && overviewRes.data) {
        setOverview(overviewRes.data);
      } else {
        throw new Error(overviewRes.message || '获取千层塔概览失败');
      }

      if (rankRes.success && rankRes.data) {
        setRankRows(rankRes.data);
      } else {
        throw new Error(rankRes.message || '获取千层塔排行失败');
      }
    } catch (error) {
      setLoadError(getUnifiedApiErrorMessage(error, '获取千层塔数据失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadTowerData();
  }, [loadTowerData, open]);

  const handleStart = useCallback(async () => {
    if (inTeam) return;
    setStarting(true);
    try {
      const res = await startTowerChallenge(SILENT_API_REQUEST_CONFIG);
      if (!res.success || !res.data?.session) {
        throw new Error(res.message || '开启千层塔挑战失败');
      }
      onChallengeStarted({
        session: res.data.session,
        state: res.data.state,
      });
      onClose();
    } catch (error) {
      Modal.error({
        title: '千层塔挑战失败',
        content: getUnifiedApiErrorMessage(error, '开启千层塔挑战失败'),
      });
    } finally {
      setStarting(false);
    }
  }, [inTeam, onChallengeStarted, onClose]);

  const challengeButtonText = useMemo(() => {
    if (!overview?.progress.currentRunId) return '开始登塔';
    if (overview.activeSession?.status === 'waiting_transition') return '重返塔中';
    return '继续登塔';
  }, [overview]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      centered
      width={920}
      destroyOnHidden
      title="千层塔（测试中，无奖励）"
      className="tower-modal"
    >
      <div className="tower-modal-shell">
        {loading ? (
          <div className="tower-modal-loading">
            <Spin />
          </div>
        ) : null}

        {!loading && loadError ? (
          <Alert
            type="error"
            showIcon
            message={loadError}
          />
        ) : null}

        {!loading && overview ? (
          <Tabs
            items={[
              {
                key: 'tower-overview',
                label: '冲层',
                children: (
                  <div className="tower-modal-pane">
                    <div className="tower-summary-panel">
                      <div className="tower-summary-head">
                        <div className="tower-summary-title-wrap">
                          <div className="tower-summary-eyebrow">无尽试炼</div>
                          <Typography.Title level={4}>千层塔</Typography.Title>
                        </div>
                        <div className="tower-summary-tip">塔中层层皆有守敌，破关方可更进一步。</div>
                      </div>

                      <div className="tower-summary-stats">
                        <div className="tower-summary-stat">
                          <span>历史最高</span>
                          <strong>{overview.progress.bestFloor}</strong>
                        </div>
                        <div className="tower-summary-stat">
                          <span>下一层数</span>
                          <strong>{overview.progress.nextFloor}</strong>
                        </div>
                      </div>

                      <div className="tower-summary-footer">
                        <div className="tower-summary-actions">
                          {inTeam ? (
                            <Alert
                              type="warning"
                              showIcon
                              message="组队状态下无法进入千层塔"
                            />
                          ) : null}
                          <Button
                            type="primary"
                            loading={starting}
                            onClick={() => void handleStart()}
                            disabled={inTeam}
                          >
                            {challengeButtonText}
                          </Button>
                        </div>
                      </div>
                    </div>

                    <div className="tower-preview-section">
                      <FloorPreviewCard title="下一层守关" preview={overview.nextFloorPreview} />
                    </div>
                  </div>
                ),
              },
              {
                key: 'tower-rank',
                label: '排行',
                children: (
                  <div className="tower-modal-pane">
                    <div className="tower-rank-list">
                      {rankRows.length > 0 ? (
                        rankRows.map((row) => (
                          <div key={`tower-rank-${row.characterId}`} className="tower-rank-row">
                            <div className="tower-rank-rank">{row.rank}</div>
                            <div className="tower-rank-main">
                              <div className="tower-rank-name">{row.name}</div>
                              <div className="tower-rank-meta">{row.realm}</div>
                            </div>
                            <div className="tower-rank-floor">第 {row.bestFloor} 层</div>
                          </div>
                        ))
                      ) : (
                        <div className="tower-rank-empty">尚无人留下登塔战绩。</div>
                      )}
                    </div>
                  </div>
                ),
              },
            ]}
          />
        ) : null}
      </div>
    </Modal>
  );
};

export default TowerModal;
