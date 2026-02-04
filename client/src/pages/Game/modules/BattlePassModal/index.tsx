import { App, Button, Modal, Progress, Spin, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import coin01 from '../../../../assets/images/ui/sh_icon_0006_jinbi_02.png';
import {
  getBattlePassTasks,
  getBattlePassStatus,
  getBattlePassRewards,
  claimBattlePassReward,
  type BattlePassStatusDto,
  type BattlePassRewardDto,
} from '../../../../services/api';
import './index.scss';

interface BattlePassModalProps {
  open: boolean;
  onClose: () => void;
}

type BattlePassTab = 'rewards' | 'daily' | 'weekly';

type BattlePassTask = {
  id: string;
  title: string;
  desc: string;
  exp: number;
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const dateKey = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const weekKey = (d: Date) => {
  const date = new Date(d.getTime());
  date.setHours(0, 0, 0, 0);
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day + 3);
  const firstThursday = new Date(date.getFullYear(), 0, 4);
  firstThursday.setHours(0, 0, 0, 0);
  const firstDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
};

const readJson = <T,>(key: string, fallback: T): T => {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const storageKeys = {
  dailyDone: 'battlepass_daily_done',
  weeklyDone: 'battlepass_weekly_done',
};

const BattlePassModal: React.FC<BattlePassModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();

  const [loading, setLoading] = useState(false);
  const [taskLoading, setTaskLoading] = useState(false);
  const [claimingLevel, setClaimingLevel] = useState<number | null>(null);

  const [status, setStatus] = useState<BattlePassStatusDto | null>(null);
  const [rewards, setRewards] = useState<BattlePassRewardDto[]>([]);
  const [dailyTasks, setDailyTasks] = useState<BattlePassTask[]>([]);
  const [weeklyTasks, setWeeklyTasks] = useState<BattlePassTask[]>([]);

  const [tab, setTab] = useState<BattlePassTab>('rewards');
  const [dailyDone, setDailyDone] = useState<Record<string, string>>({});
  const [weeklyDone, setWeeklyDone] = useState<Record<string, string>>({});
  const [todayKey, setTodayKey] = useState('');
  const [curWeekKey, setCurWeekKey] = useState('');

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
      const toTask = (t: { id: string; name: string; description: string; rewardExp: number }): BattlePassTask => ({
        id: String(t.id || ''),
        title: String(t.name || ''),
        desc: String(t.description || ''),
        exp: Number.isFinite(Number(t.rewardExp)) ? Number(t.rewardExp) : 0,
      });
      setDailyTasks((res.data.daily ?? []).map(toTask));
      setWeeklyTasks((res.data.weekly ?? []).map(toTask));
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '加载战令任务失败');
      setDailyTasks([]);
      setWeeklyTasks([]);
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
    const now = new Date();
    setTodayKey(dateKey(now));
    setCurWeekKey(weekKey(now));
    setDailyDone(readJson<Record<string, string>>(storageKeys.dailyDone, {}));
    setWeeklyDone(readJson<Record<string, string>>(storageKeys.weeklyDone, {}));
    setTab('rewards');
    void refreshAll();
  }, [open, refreshAll]);

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

  const addExp = (delta: number) => {
    if (!status) return;
    const newExp = clamp(exp + delta, 0, expPerLevel * maxLevel);
    setStatus({ ...status, exp: newExp, level: Math.min(Math.floor(newExp / expPerLevel) + 1, maxLevel) });
  };

  const completeDailyTask = (task: BattlePassTask) => {
    if (dailyDone[task.id] === todayKey) return;
    const next = { ...dailyDone, [task.id]: todayKey };
    localStorage.setItem(storageKeys.dailyDone, JSON.stringify(next));
    setDailyDone(next);
    addExp(task.exp);
  };

  const completeWeeklyTask = (task: BattlePassTask) => {
    if (weeklyDone[task.id] === curWeekKey) return;
    const next = { ...weeklyDone, [task.id]: curWeekKey };
    localStorage.setItem(storageKeys.weeklyDone, JSON.stringify(next));
    setWeeklyDone(next);
    addExp(task.exp);
  };

  const leftItems = useMemo(
    () => [
      { key: 'rewards' as const, label: '战令奖励' },
      { key: 'daily' as const, label: '每日任务' },
      { key: 'weekly' as const, label: '每周任务' },
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
            <Spin tip="加载中..." />
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

  const renderTaskList = (title: string, tasks: BattlePassTask[], doneMap: Record<string, string>, doneKey: string, onFinish: (t: BattlePassTask) => void) => (
    <div className="bp-pane">
      {renderHeader()}
      <div className="bp-pane-body">
        <div className="bp-section">
          <div className="bp-section-title">{title}</div>
          <div className="bp-task-list">
            {tasks.map((t) => {
              const done = doneMap[t.id] === doneKey;
              return (
                <div key={t.id} className="bp-task">
                  <div className="bp-task-main">
                    <div className="bp-task-title">{t.title}</div>
                    <div className="bp-task-desc">{t.desc}</div>
                  </div>
                  <div className="bp-task-right">
                    <Tag color="blue">+{t.exp} 经验</Tag>
                    <Button size="small" type="primary" disabled={done} onClick={() => onFinish(t)}>
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
    if (tab === 'daily') return renderTaskList('每日任务', dailyTasks, dailyDone, todayKey, completeDailyTask);
    return renderTaskList('每周任务', weeklyTasks, weeklyDone, curWeekKey, completeWeeklyTask);
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
        </div>
        <div className="bp-right">{panelContent()}</div>
      </div>
    </Modal>
  );
};

export default BattlePassModal;
