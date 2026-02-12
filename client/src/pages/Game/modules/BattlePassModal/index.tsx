import { App, Button, Modal, Progress, Segmented, Spin, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import coin01 from '../../../../assets/images/ui/sh_icon_0006_jinbi_02.png';
import {
  getBattlePassTasks,
  getBattlePassStatus,
  getBattlePassRewards,
  claimBattlePassReward,
  completeBattlePassTask,
  type BattlePassStatusDto,
  type BattlePassRewardDto,
  type BattlePassTaskDto,
} from '../../../../services/api';
import './index.scss';

interface BattlePassModalProps {
  open: boolean;
  onClose: () => void;
}

type BattlePassTab = 'rewards' | 'daily' | 'weekly' | 'season';
const battlePassTabKeys: BattlePassTab[] = ['rewards', 'daily', 'weekly', 'season'];

type BattlePassTask = {
  id: string;
  title: string;
  desc: string;
  exp: number;
  completed: boolean;
  progressValue: number;
  targetValue: number;
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const BattlePassModal: React.FC<BattlePassModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();

  const [loading, setLoading] = useState(false);
  const [taskLoading, setTaskLoading] = useState(false);
  const [claimingLevel, setClaimingLevel] = useState<number | null>(null);
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);

  const [status, setStatus] = useState<BattlePassStatusDto | null>(null);
  const [rewards, setRewards] = useState<BattlePassRewardDto[]>([]);
  const [dailyTasks, setDailyTasks] = useState<BattlePassTask[]>([]);
  const [weeklyTasks, setWeeklyTasks] = useState<BattlePassTask[]>([]);
  const [seasonTasks, setSeasonTasks] = useState<BattlePassTask[]>([]);

  const [tab, setTab] = useState<BattlePassTab>('rewards');
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= 768;
  });

  const maxLevel = status?.maxLevel ?? 30;
  const expPerLevel = status?.expPerLevel ?? 1000;
  const exp = status?.exp ?? 0;
  const level = status?.level ?? 1;
  const claimedFreeLevels = status?.claimedFreeLevels ?? [];

  const refreshStatus = useCallback(async () => {
    try {
      const res = await getBattlePassStatus();
      if (res.success && res.data) {
        setStatus(res.data);
      }
    } catch (error) {
      console.error('获取战令状态失败:', error);
    }
  }, []);

  const refreshRewards = useCallback(async () => {
    try {
      const res = await getBattlePassRewards();
      if (res.success && res.data) {
        setRewards(res.data);
      }
    } catch (error) {
      console.error('获取战令奖励失败:', error);
    }
  }, []);

  const refreshTasks = useCallback(async () => {
    setTaskLoading(true);
    try {
      const res = await getBattlePassTasks();
      if (!res.success || !res.data) throw new Error(res.message || '加载战令任务失败');
      const toTask = (t: BattlePassTaskDto): BattlePassTask => ({
        id: String(t.id || ''),
        title: String(t.name || ''),
        desc: String(t.description || ''),
        exp: Number.isFinite(Number(t.rewardExp)) ? Number(t.rewardExp) : 0,
        completed: t.completed === true,
        progressValue: Number.isFinite(Number(t.progressValue)) ? Number(t.progressValue) : 0,
        targetValue: Number.isFinite(Number(t.targetValue)) ? Number(t.targetValue) : 1,
      });
      setDailyTasks((res.data.daily ?? []).map(toTask));
      setWeeklyTasks((res.data.weekly ?? []).map(toTask));
      setSeasonTasks((res.data.season ?? []).map(toTask));
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '加载战令任务失败');
      setDailyTasks([]);
      setWeeklyTasks([]);
      setSeasonTasks([]);
    } finally {
      setTaskLoading(false);
    }
  }, [message]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([refreshStatus(), refreshRewards(), refreshTasks()]);
    setLoading(false);
  }, [refreshStatus, refreshRewards, refreshTasks]);

  useEffect(() => {
    if (!open) return;
    setTab('rewards');
    void refreshAll();
  }, [open, refreshAll]);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const levelProgress = useMemo(() => {
    if (level >= maxLevel) return { percent: 100, current: expPerLevel, need: expPerLevel };
    const cappedExp = clamp(exp, 0, expPerLevel * maxLevel);
    const current = cappedExp % expPerLevel;
    const need = expPerLevel;
    return { percent: clamp((current / need) * 100, 0, 100), current, need };
  }, [exp, expPerLevel, level, maxLevel]);

  const claimLevel = async (lv: number) => {
    if (lv > level) return;
    if (claimedFreeLevels.includes(lv)) return;
    if (claimingLevel !== null) return;

    setClaimingLevel(lv);
    try {
      const res = await claimBattlePassReward(lv, 'free');
      if (!res.success) {
        message.error(res.message || '领取失败');
        return;
      }
      message.success(`领取成功！`);
      // 刷新状态以更新领取记录
      await refreshStatus();
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '领取失败');
    } finally {
      setClaimingLevel(null);
    }
  };

  const completeTask = async (task: BattlePassTask) => {
    if (task.completed) return;
    if (completingTaskId) return;

    setCompletingTaskId(task.id);
    try {
      const res = await completeBattlePassTask(task.id);
      if (!res.success) {
        message.error(res.message || '任务完成失败');
        return;
      }
      const gainedExp = Number(res.data?.gainedExp ?? task.exp);
      message.success(`任务完成，获得 ${gainedExp} 经验`);
      await Promise.all([refreshStatus(), refreshTasks()]);
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '任务完成失败');
    } finally {
      setCompletingTaskId(null);
    }
  };

  const leftItems = useMemo(
    () => [
      { key: 'rewards' as const, label: '战令奖励' },
      { key: 'daily' as const, label: '每日任务' },
      { key: 'weekly' as const, label: '每周任务' },
      { key: 'season' as const, label: '赛季任务' },
    ],
    [],
  );

  const mobileTabOptions = useMemo(
    () => [
      { value: 'rewards', label: '奖励' },
      { value: 'daily', label: '每日' },
      { value: 'weekly', label: '每周' },
      { value: 'season', label: '赛季' },
    ],
    [],
  );

  const formatRewardName = (reward: BattlePassRewardDto['freeRewards'][0]) => {
    if (reward.type === 'currency') {
      if (reward.currency === 'spirit_stones') return '灵石';
      if (reward.currency === 'silver') return '银两';
      return reward.currency ?? '货币';
    }
    return reward.itemDefId ?? reward.item_def_id ?? '物品';
  };

  const formatRewardAmount = (reward: BattlePassRewardDto['freeRewards'][0]) => {
    if (reward.type === 'currency') return reward.amount ?? 0;
    return reward.qty ?? 1;
  };

  const renderHeader = () => (
    <div className="bp-pane-top">
      <div className="bp-top-row">
        <div className="bp-title">战令</div>
        <div className="bp-tags">
          <Tag color="blue">满级 {maxLevel} 级</Tag>
          <Tag color="blue">{taskLoading ? '任务加载中...' : '实时任务'}</Tag>
          <Tag color="green">{status?.seasonName || '当前赛季'}</Tag>
        </div>
      </div>
      <div className="bp-progress">
        <div className="bp-progress-left">
          <div className="bp-progress-level">当前等级：{level}</div>
          <div className="bp-progress-exp">
            经验：{level >= maxLevel ? `${expPerLevel * maxLevel}` : `${levelProgress.current}`}/{levelProgress.need}
          </div>
        </div>
        <div className="bp-progress-right">
          <Progress percent={levelProgress.percent} showInfo={false} strokeColor="var(--primary-color)" />
        </div>
      </div>
    </div>
  );

  const renderRewardTrack = () => (
    <div className="bp-pane">
      {renderHeader()}
      <div className="bp-pane-body">
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin tip="加载中...">
              <div style={{ width: 120, height: 60 }} />
            </Spin>
          </div>
        ) : (
          <div className="bp-section">
            <div className="bp-section-title">1 - {maxLevel} 级奖励</div>
            <div className="bp-reward-track" role="region" aria-label="战令奖励">
              {rewards.map((r) => {
                const unlocked = level >= r.level;
                const claimed = claimedFreeLevels.includes(r.level);
                const freeReward = r.freeRewards[0];
                const rewardName = freeReward ? formatRewardName(freeReward) : '奖励';
                const rewardAmount = freeReward ? formatRewardAmount(freeReward) : 1;
                return (
                  <div key={r.level} className={`bp-reward-card ${unlocked ? 'is-unlocked' : 'is-locked'}`}>
                    <div className="bp-reward-level">Lv.{r.level}</div>
                    <img className="bp-reward-icon" src={coin01} alt={rewardName} />
                    <div className="bp-reward-name">{rewardName}</div>
                    <div className="bp-reward-amount">x{rewardAmount}</div>
                    <div className="bp-reward-meta">
                      {claimed ? <Tag color="green">已领取</Tag> : unlocked ? <Tag color="blue">可领取</Tag> : <Tag>未解锁</Tag>}
                    </div>
                    <Button
                      size="small"
                      type="primary"
                      disabled={!unlocked || claimed || claimingLevel === r.level}
                      loading={claimingLevel === r.level}
                      onClick={() => claimLevel(r.level)}
                      className="bp-reward-btn"
                    >
                      {claimed ? '已领取' : '领取'}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="bp-tip">完成任务获得经验升级，解锁并领取对应等级奖励。赛季每 2 个月刷新。</div>
      </div>
    </div>
  );

  const renderTaskList = (title: string, tasks: BattlePassTask[]) => (
    <div className="bp-pane">
      {renderHeader()}
      <div className="bp-pane-body">
        <div className="bp-section">
          <div className="bp-section-title">{title}</div>
          <div className="bp-task-list">
            {tasks.map((t) => {
              const done = t.completed;
              const progressText = `${Math.min(Math.max(0, t.progressValue), t.targetValue)}/${t.targetValue}`;
              return (
                <div key={t.id} className="bp-task">
                  <div className="bp-task-main">
                    <div className="bp-task-title">{t.title}</div>
                    <div className="bp-task-desc">
                      {t.desc}（进度 {progressText}）
                    </div>
                  </div>
                  <div className="bp-task-right">
                    <Tag color={done ? 'green' : 'blue'}>{done ? '已完成' : `+${t.exp} 经验`}</Tag>
                    <Button
                      size="small"
                      type="primary"
                      disabled={done || completingTaskId === t.id}
                      loading={completingTaskId === t.id}
                      onClick={() => {
                        void completeTask(t);
                      }}
                    >
                      {done ? '已完成' : '完成'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );

  const panelContent = () => {
    if (tab === 'rewards') return renderRewardTrack();
    if (tab === 'daily') return renderTaskList('每日任务', dailyTasks);
    if (tab === 'weekly') return renderTaskList('每周任务', weeklyTasks);
    return renderTaskList('赛季任务', seasonTasks);
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={1080}
      className="bp-modal"
      destroyOnHidden
      maskClosable
    >
      <div className="bp-shell">
        <div className="bp-left">
          <div className="bp-left-title">
            <img className="bp-left-icon" src={coin01} alt="战令" />
            <div className="bp-left-name">战令</div>
          </div>
          {isMobile ? (
            <div className="bp-left-segmented-wrap">
              <Segmented
                className="bp-left-segmented"
                value={tab}
                options={mobileTabOptions}
                onChange={(value) => {
                  if (typeof value !== 'string') return;
                  if (!battlePassTabKeys.includes(value as BattlePassTab)) return;
                  setTab(value as BattlePassTab);
                }}
              />
            </div>
          ) : (
            <div className="bp-left-list">
              {leftItems.map((it) => (
                <Button
                  key={it.key}
                  type={tab === it.key ? 'primary' : 'default'}
                  className="bp-left-item"
                  onClick={() => setTab(it.key)}
                >
                  {it.label}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="bp-right">{panelContent()}</div>
      </div>
    </Modal>
  );
};

export default BattlePassModal;
