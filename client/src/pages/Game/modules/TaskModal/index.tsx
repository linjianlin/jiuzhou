import { App, Button, Input, Modal, Segmented, Tag } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveIconUrl, DEFAULT_ICON as coin01 } from '../../shared/resolveIcon';
import { IMG_LINGSHI as lingshiIcon, IMG_TONGQIAN as tongqianIcon } from '../../shared/imageAssets';
import {
  claimTaskReward,
  getBountyTaskOverview,
  getDungeonWeeklyTargets,
  getTaskOverview,
  setTaskTracked,
  submitTaskToNpc,
  submitBountyMaterials,
  type DungeonWeeklyTargetDto,
} from '../../../../services/api';
import { useIsMobile } from '../../shared/responsive';
import { getRealmRankFromLiteral as getRealmRank } from '../../shared/realm';
import MainQuestPanel from './MainQuestPanel';
import './index.scss';
import './MainQuestPanel.scss';

type TaskCategory = 'main' | 'side' | 'daily' | 'event' | 'bounty';

type TaskStatus = 'ongoing' | 'turnin' | 'claimable' | 'completed';

type TaskReward = { id: string; name: string; icon: string; amount: number; amountMax?: number };

type TaskObjective = { text: string; done: number; total: number };

type TaskItem = {
  id: string;
  category: TaskCategory;
  title: string;
  realm: string;
  giverNpcId?: string | null;
  status: TaskStatus;
  tracked: boolean;
  desc: string;
  objectives: TaskObjective[];
  rewards: TaskReward[];
  expiresAt?: string | null;
  sourceType?: 'daily' | 'player';
  remainingSeconds?: number | null;
};

const resolveRewardIcon = resolveIconUrl;

const formatRewardAmount = (amount: number, amountMax?: number): string => {
  const min = Math.max(0, Math.floor(Number(amount) || 0));
  const maxRaw = Number(amountMax);
  const hasRange = Number.isFinite(maxRaw) && maxRaw > min;
  if (!hasRange) return `×${min.toLocaleString()}`;
  return `×${min.toLocaleString()}~${Math.floor(maxRaw).toLocaleString()}`;
};

const categoryLabels: Record<TaskCategory, string> = {
  main: '主线任务',
  side: '支线任务',
  daily: '日常任务',
  event: '活动任务',
  bounty: '悬赏任务',
};

const categoryShortLabels: Record<TaskCategory, string> = {
  main: '主线',
  side: '支线',
  daily: '日常',
  event: '活动',
  bounty: '悬赏',
};

const statusText: Record<TaskStatus, string> = {
  ongoing: '进行中',
  turnin: '可提交',
  claimable: '可领取',
  completed: '已完成',
};

const statusColor: Record<TaskStatus, string> = {
  ongoing: 'blue',
  turnin: 'purple',
  claimable: 'gold',
  completed: 'default',
};

interface TaskModalProps {
  open: boolean;
  onClose: () => void;
  onTrackedChange?: () => void;
}

const TaskModal: React.FC<TaskModalProps> = ({ open, onClose, onTrackedChange }) => {
  const { message } = App.useApp();
  const taskCategoryKeys = useMemo(() => Object.keys(categoryLabels) as TaskCategory[], []);
  const taskCategoryOptions = useMemo(
    () => taskCategoryKeys.map((k) => ({ label: categoryShortLabels[k], value: k })),
    [taskCategoryKeys],
  );
  const isMobile = useIsMobile();
  const [mobilePane, setMobilePane] = useState<'list' | 'detail'>('list');
  const [category, setCategory] = useState<TaskCategory>('main');
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [submittingTaskId, setSubmittingTaskId] = useState<string>('');
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [weeklyTargets, setWeeklyTargets] = useState<DungeonWeeklyTargetDto[]>([]);
  const [weeklySummary, setWeeklySummary] = useState<{ totalClears: number; targetClears: number } | null>(null);
  const [weeklyPeriod, setWeeklyPeriod] = useState<{ weekStart: string; weekEnd: string } | null>(null);
  const [nowTs, setNowTs] = useState<number>(() => Date.now());
  const lastExpireRefreshAtRef = useRef<number>(0);

  const appendSystemChat = useCallback((content: string) => {
    const text = String(content || '').trim();
    if (!text) return;
    window.dispatchEvent(
      new CustomEvent('chat:append', {
        detail: {
          channel: 'system',
          content: text,
          senderName: '系统',
          senderTitle: '',
          timestamp: Date.now(),
        },
      }),
    );
  }, []);

  const formatTaskRewardsToText = useCallback((rewards: unknown): string => {
    const list = Array.isArray(rewards) ? rewards : [];
    const parts: string[] = [];
    for (const r of list) {
      const type = (r as { type?: unknown })?.type;
      if (type === 'silver') {
        const amount = Math.max(0, Math.floor(Number((r as { amount?: unknown })?.amount) || 0));
        if (amount > 0) parts.push(`银两 +${amount.toLocaleString()}`);
      } else if (type === 'spirit_stones') {
        const amount = Math.max(0, Math.floor(Number((r as { amount?: unknown })?.amount) || 0));
        if (amount > 0) parts.push(`灵石 +${amount.toLocaleString()}`);
      } else if (type === 'item') {
        const itemDefId = String((r as { itemDefId?: unknown })?.itemDefId ?? '').trim();
        const qty = Math.max(1, Math.floor(Number((r as { qty?: unknown })?.qty) || 1));
        if (itemDefId) parts.push(`物品(${itemDefId}) ×${qty.toLocaleString()}`);
      }
    }
    return parts.join('，');
  }, []);

  const getRemainingSeconds = useCallback((expiresAt?: string | null): number | null => {
    if (!expiresAt) return null;
    const ms = Date.parse(expiresAt);
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.floor((ms - nowTs) / 1000));
  }, [nowTs]);

  const formatCountdown = useCallback((seconds: number): string => {
    const s = Math.max(0, Math.floor(seconds));
    if (s <= 0) return '已过期';
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const hh = hours % 24;
      return `${days}天${String(hh).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [res, bountyRes, weeklyRes] = await Promise.all([getTaskOverview(), getBountyTaskOverview(), getDungeonWeeklyTargets()]);
      if (!res.data) throw new Error('加载任务失败');

      const mapped: TaskItem[] = (res.data.tasks || [])
        .map((t) => {
          const rewards: TaskReward[] = (t.rewards || []).map((r) => {
            if (r.type === 'item') {
              const amount = Number.isFinite(Number(r.amount)) ? Number(r.amount) : 1;
              const amountMaxRaw = Number((r as { amountMax?: unknown }).amountMax);
              const amountMax = Number.isFinite(amountMaxRaw) && amountMaxRaw > amount ? amountMaxRaw : undefined;
              return {
                id: r.itemDefId,
                name: r.name || r.itemDefId,
                icon: resolveRewardIcon(r.icon),
                amount,
                ...(amountMax ? { amountMax } : {}),
              };
            }
            return {
              id: `${t.id}:${r.type}`,
              name: r.name || (r.type === 'silver' ? '银两' : '灵石'),
              icon: r.type === 'silver' ? tongqianIcon : lingshiIcon,
              amount: Number.isFinite(Number(r.amount)) ? Number(r.amount) : 0,
            };
          });

          const objectives: TaskObjective[] = (t.objectives || [])
            .map((o) => ({
              text: String(o.text || ''),
              done: Number.isFinite(Number(o.done)) ? Number(o.done) : 0,
              total: Number.isFinite(Number(o.target)) ? Number(o.target) : 1,
            }))
            .filter((o) => o.text);

          return {
            id: String(t.id || ''),
            category: (t.category || 'main') as TaskCategory,
            title: String(t.title || ''),
            realm: typeof t.realm === 'string' && t.realm.trim() ? t.realm.trim() : '凡人',
            giverNpcId: typeof t.giverNpcId === 'string' && t.giverNpcId.trim() ? t.giverNpcId.trim() : null,
            status: (t.status || 'ongoing') as TaskStatus,
            tracked: Boolean(t.tracked),
            desc: String(t.description || ''),
            objectives,
            rewards,
          };
        })
        .filter((x) => x.id);

      const mappedBounty: TaskItem[] = (bountyRes?.success && bountyRes.data ? bountyRes.data.tasks || [] : [])
        .map((t): TaskItem => {
          const rawRemaining = Number((t as { remainingSeconds?: unknown })?.remainingSeconds);
          const remainingSeconds = Number.isFinite(rawRemaining) ? Math.max(0, Math.floor(rawRemaining)) : null;
          const rawExpiresAt = typeof (t as { expiresAt?: unknown })?.expiresAt === 'string' ? String((t as { expiresAt?: unknown }).expiresAt) : null;
          const expiresAt = rawExpiresAt || (remainingSeconds !== null ? new Date(Date.now() + remainingSeconds * 1000).toISOString() : null);
          const sourceTypeRaw = String((t as { sourceType?: unknown })?.sourceType ?? '').trim();
          const sourceType = sourceTypeRaw === 'player' ? 'player' : 'daily';

          const rewards: TaskReward[] = (t.rewards || []).map((r) => {
            if (r.type === 'item') {
              const amount = Number.isFinite(Number(r.amount)) ? Number(r.amount) : 1;
              const amountMaxRaw = Number((r as { amountMax?: unknown }).amountMax);
              const amountMax = Number.isFinite(amountMaxRaw) && amountMaxRaw > amount ? amountMaxRaw : undefined;
              return {
                id: r.itemDefId,
                name: r.name || r.itemDefId,
                icon: resolveRewardIcon(r.icon),
                amount,
                ...(amountMax ? { amountMax } : {}),
              };
            }
            return {
              id: `${t.id}:${r.type}`,
              name: r.name || (r.type === 'silver' ? '银两' : '灵石'),
              icon: r.type === 'silver' ? tongqianIcon : lingshiIcon,
              amount: Number.isFinite(Number(r.amount)) ? Number(r.amount) : 0,
            };
          });

          const objectives: TaskObjective[] = (t.objectives || [])
            .map((o) => ({
              text: String(o.text || ''),
              done: Number.isFinite(Number(o.done)) ? Number(o.done) : 0,
              total: Number.isFinite(Number(o.target)) ? Number(o.target) : 1,
            }))
            .filter((o) => o.text);

          return {
            id: String(t.id || ''),
            category: 'bounty',
            title: String(t.title || ''),
            realm: typeof t.realm === 'string' && t.realm.trim() ? t.realm.trim() : '凡人',
            giverNpcId: typeof t.giverNpcId === 'string' && t.giverNpcId.trim() ? t.giverNpcId.trim() : null,
            status: (t.status || 'ongoing') as TaskStatus,
            tracked: Boolean(t.tracked),
            desc: String(t.description || ''),
            objectives,
            rewards,
            expiresAt,
            sourceType,
            remainingSeconds,
          };
        })
        .filter((x) => x.id);

      const bountyTaskIds = new Set(mappedBounty.map((x) => x.id));
      const mappedNoOverlap = mapped.filter((t) => !bountyTaskIds.has(t.id));
      setTasks([...mappedNoOverlap, ...mappedBounty]);

      if (weeklyRes?.success && weeklyRes.data) {
        setWeeklyTargets(Array.isArray(weeklyRes.data.targets) ? weeklyRes.data.targets : []);
        setWeeklySummary(weeklyRes.data.summary || null);
        setWeeklyPeriod(weeklyRes.data.period || null);
      } else {
        setWeeklyTargets([]);
        setWeeklySummary(null);
        setWeeklyPeriod(null);
      }
    } catch (e: unknown) {
      void 0;
      setTasks([]);
      setWeeklyTargets([]);
      setWeeklySummary(null);
      setWeeklyPeriod(null);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (!open) return;
    setCategory('main');
    setQuery('');
    setActiveId('');
    setMobilePane('list');
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    if (category !== 'bounty') return;
    setNowTs(Date.now());
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [category, open]);

  useEffect(() => {
    if (!open) return;
    if (category !== 'bounty') return;
    if (loading) return;

    const hasExpiredDaily = tasks.some((t) => {
      if (t.category !== 'bounty') return false;
      if (t.sourceType !== 'daily') return false;
      if (!t.expiresAt) return false;
      return (getRemainingSeconds(t.expiresAt) ?? 0) <= 0;
    });
    if (!hasExpiredDaily) return;

    const now = Date.now();
    if (now - lastExpireRefreshAtRef.current < 5000) return;
    lastExpireRefreshAtRef.current = now;
    void refresh();
  }, [category, getRemainingSeconds, loading, open, refresh, tasks]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = tasks
      .filter((t) => t.category === category)
      .filter((t) => {
        if (category !== 'bounty') return true;
        if (t.sourceType !== 'daily') return true;
        if (!t.expiresAt) return true;
        return (getRemainingSeconds(t.expiresAt) ?? 0) > 0;
      });
    const searched = q ? list.filter((t) => t.title.toLowerCase().includes(q)) : list;
    const rank: Record<TaskStatus, number> = { claimable: 0, turnin: 1, ongoing: 2, completed: 3 };
    return [...searched].sort(
      (a, b) => rank[a.status] - rank[b.status] || getRealmRank(a.realm) - getRealmRank(b.realm) || a.id.localeCompare(b.id),
    );
  }, [category, getRemainingSeconds, query, tasks]);

  const safeActiveId = useMemo(() => {
    if (activeId && filtered.some((t) => t.id === activeId)) return activeId;
    return filtered[0]?.id ?? '';
  }, [activeId, filtered]);

  const activeTask = useMemo(() => filtered.find((t) => t.id === safeActiveId) ?? null, [filtered, safeActiveId]);
  const weeklyPeriodText = useMemo(() => {
    if (!weeklyPeriod) return '';
    const start = weeklyPeriod.weekStart ? weeklyPeriod.weekStart.slice(0, 10) : '';
    const end = weeklyPeriod.weekEnd ? weeklyPeriod.weekEnd.slice(0, 10) : '';
    if (!start && !end) return '';
    return `${start || '--'} ~ ${end || '--'}`;
  }, [weeklyPeriod]);
  const isMobileTaskPane = isMobile && category !== 'main';
  const handleCategoryChange = useCallback((nextCategory: TaskCategory) => {
    setCategory(nextCategory);
    setActiveId('');
    setMobilePane('list');
  }, []);

  const toggleTrack = useCallback(async () => {
    if (!activeTask?.id) return;
    const nextTracked = !activeTask.tracked;
    try {
      await setTaskTracked(activeTask.id, nextTracked);
      setTasks((prev) => prev.map((t) => (t.id === activeTask.id ? { ...t, tracked: nextTracked } : t)));
      message.success(nextTracked ? '已追踪' : '已取消追踪');
      onTrackedChange?.();
    } catch (e: unknown) {
      void 0;
    }
  }, [activeTask?.id, activeTask?.tracked, message, onTrackedChange]);

  const claimReward = useCallback(async (task: TaskItem | null) => {
    if (!task?.id) return;
    try {
      const res = await claimTaskReward(task.id);
      message.success('领取成功');
      const rewardText = formatTaskRewardsToText(res.data?.rewards);
      appendSystemChat(`【任务】领取奖励：${task.title}${rewardText ? `（${rewardText}）` : ''}`);
      await refresh();
    } catch (e: unknown) {
      void 0;
    }
  }, [appendSystemChat, formatTaskRewardsToText, message, refresh]);

  const completeTask = useCallback(async (task: TaskItem | null) => {
    if (!task?.id) return;
    if (task.category !== 'daily' && task.category !== 'event') return;
    const needSubmitToNpc = task.status === 'turnin';
    const npcId = String(task.giverNpcId ?? '').trim();
    if (needSubmitToNpc && !npcId) {
      message.error('该任务缺少发布NPC，无法完成');
      return;
    }
    try {
      if (needSubmitToNpc) {
        await submitTaskToNpc(npcId, task.id);
      }

      if (task.category === 'daily') {
        const rewardRes = await claimTaskReward(task.id);
        const rewardText = formatTaskRewardsToText(rewardRes.data?.rewards);
        message.success('完成成功');
        appendSystemChat(`【任务】已完成并领取奖励：${task.title}${rewardText ? `（${rewardText}）` : ''}`);
        await refresh();
        return;
      }

      message.success('完成成功');
      appendSystemChat(`【任务】已完成：${task.title}`);
      await refresh();
    } catch (e: unknown) {
      void 0;
    }
  }, [appendSystemChat, formatTaskRewardsToText, message, refresh]);

  const submitMaterials = useCallback(
    async (task: TaskItem | null) => {
      if (!task?.id) return;
      setSubmittingTaskId(task.id);
      try {
        await submitBountyMaterials(task.id);
        message.success('提交成功');
        appendSystemChat(`【悬赏】已提交材料：${task.title}`);
        await refresh();
      } catch (e: unknown) {
        void 0;
      } finally {
        setSubmittingTaskId('');
      }
    },
    [appendSystemChat, message, refresh],
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={1080}
      className="task-modal"
      destroyOnHidden
      maskClosable
    >
      <div className="task-modal-shell">
        <div className="task-modal-left">
          <div className="task-left-title">
            <img className="task-left-icon" src={coin01} alt="任务" />
            <div className="task-left-name">任务</div>
          </div>
          {isMobile ? (
            <div className="task-left-segmented-wrap">
              <Segmented
                className="task-left-segmented"
                value={category}
                options={taskCategoryOptions}
                onChange={(value) => {
                  if (typeof value !== 'string') return;
                  if (!taskCategoryKeys.includes(value as TaskCategory)) return;
                  handleCategoryChange(value as TaskCategory);
                }}
              />
            </div>
          ) : (
            <div className="task-left-list">
              {taskCategoryKeys.map((k) => (
                <Button
                  key={k}
                  type={category === k ? 'primary' : 'default'}
                  className="task-left-item"
                  onClick={() => handleCategoryChange(k)}
                >
                  {categoryLabels[k]}
                </Button>
              ))}
            </div>
          )}
        </div>

        <div className="task-modal-right">
          {category === 'main' ? (
            <div className="task-main-wrap">
              <MainQuestPanel onClose={onClose} />
            </div>
          ) : (
          <div className="task-pane">
            <div className="task-pane-top">
              <div className="task-search">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  allowClear
                  placeholder="搜索任务"
                  prefix={<SearchOutlined />}
                />
              </div>
              {isMobileTaskPane ? (
                <div className="task-mobile-pane-switch">
                  <Segmented
                    className="task-mobile-pane-segmented"
                    value={mobilePane}
                    options={[
                      { label: '任务列表', value: 'list' },
                      { label: '任务详情', value: 'detail', disabled: !activeTask },
                    ]}
                    onChange={(value) => {
                      if (value === 'list' || value === 'detail') {
                        setMobilePane(value);
                      }
                    }}
                  />
                </div>
              ) : null}
            </div>

            <div className={`task-pane-body ${isMobileTaskPane ? `is-mobile-${mobilePane}` : ''}`}>
              <div className="task-list">
                {filtered.map((t) => (
                  <div
                    key={t.id}
                    className={`task-item ${t.id === safeActiveId ? 'is-active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setActiveId(t.id);
                      if (isMobileTaskPane) setMobilePane('detail');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        setActiveId(t.id);
                        if (isMobileTaskPane) setMobilePane('detail');
                      }
                    }}
                  >
                    <div className="task-item-top">
                      <div className="task-item-title">{t.title}</div>
                      <Tag color={statusColor[t.status]}>{statusText[t.status]}</Tag>
                    </div>
                    <div className="task-item-meta">
                      <span>推荐境界 {t.realm}</span>
                      <span>目标 {t.objectives.length} 项</span>
                      {t.category === 'bounty' && t.sourceType === 'daily' ? (
                        <span>剩余 {formatCountdown(getRemainingSeconds(t.expiresAt ?? null) ?? 0)}</span>
                      ) : null}
                    </div>
                  </div>
                ))}
                {loading ? <div className="task-empty">加载中...</div> : null}
                {!loading && filtered.length === 0 ? <div className="task-empty">暂无任务</div> : null}
              </div>

              <div className="task-detail">
                {activeTask ? (
                  <>
                    {isMobileTaskPane ? (
                      <Button className="task-mobile-back-btn" onClick={() => setMobilePane('list')}>
                        返回任务列表
                      </Button>
                    ) : null}
                    <div className="task-detail-header">
                      <div className="task-detail-title">{activeTask.title}</div>
                      <div className="task-detail-tags">
                        <Tag color={statusColor[activeTask.status]}>{statusText[activeTask.status]}</Tag>
                        <Tag color="default">推荐境界 {activeTask.realm}</Tag>
                        {activeTask.category === 'bounty' && activeTask.sourceType === 'daily' && activeTask.expiresAt ? (
                          <Tag color="volcano">剩余 {formatCountdown(getRemainingSeconds(activeTask.expiresAt) ?? 0)}</Tag>
                        ) : null}
                      </div>
                    </div>
                    <div className="task-detail-desc">{activeTask.desc}</div>
                    {activeTask.category === 'event' ? (
                      <div className="task-weekly-card">
                        <div className="task-weekly-header">
                          <div className="task-weekly-title">秘境周目标</div>
                          {weeklySummary ? (
                            <Tag color="blue">
                              本周通关 {weeklySummary.totalClears} / 目标 {weeklySummary.targetClears}
                            </Tag>
                          ) : null}
                        </div>
                        {weeklyPeriodText ? <div className="task-weekly-period">周期：{weeklyPeriodText}</div> : null}
                        <div className="task-weekly-targets">
                          {weeklyTargets.length > 0 ? (
                            weeklyTargets.map((target) => (
                              <div className="task-weekly-target" key={target.id}>
                                <div className="task-weekly-target-main">
                                  <div className="task-weekly-target-name">{target.title}</div>
                                  <div className="task-weekly-target-desc">{target.description}</div>
                                </div>
                                <div className={`task-weekly-target-progress ${target.done ? 'is-done' : ''}`}>
                                  {target.current}/{target.target}
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="task-empty">暂无周目标</div>
                          )}
                        </div>
                      </div>
                    ) : null}
                    <div className="task-section-title">目标</div>
                    <div className="task-objectives">
                      {activeTask.objectives.map((o) => (
                        <div key={o.text} className="task-objective">
                          <div className="task-objective-text">{o.text}</div>
                          <div className="task-objective-progress">
                            {o.done}/{o.total}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="task-section-title">奖励</div>
                    <div className="task-rewards">
                      {activeTask.rewards.map((r) => (
                        <div key={r.id} className="task-reward">
                          <div className="task-reward-icon-wrap">
                            <img className="task-reward-icon" src={r.icon} alt={r.name} />
                            <div className="task-reward-amount">{formatRewardAmount(r.amount, r.amountMax)}</div>
                          </div>
                          <div className="task-reward-name">{r.name}</div>
                        </div>
                      ))}
                    </div>
                    <div className="task-detail-actions">
                      <Button className="task-action" type={activeTask.tracked ? 'primary' : 'default'} onClick={toggleTrack} disabled={loading}>
                        {activeTask.tracked ? '取消追踪' : '追踪'}
                      </Button>
                      {activeTask.status === 'turnin' && activeTask.objectives.some((o) => o.text.includes('提交材料')) ? (
                        <Button
                          className="task-action"
                          type="primary"
                          disabled={loading || submittingTaskId === activeTask.id}
                          loading={submittingTaskId === activeTask.id}
                          onClick={() => submitMaterials(activeTask)}
                        >
                          提交材料
                        </Button>
                      ) : null}
                      <Button
                        className="task-action"
                        type="primary"
                        disabled={
                          loading
                          || (
                            activeTask.status !== 'claimable'
                            && !((activeTask.category === 'daily' || activeTask.category === 'event') && activeTask.status === 'turnin')
                          )
                        }
                        onClick={() => {
                          if (activeTask.category === 'daily' && (activeTask.status === 'turnin' || activeTask.status === 'claimable')) {
                            void completeTask(activeTask);
                            return;
                          }
                          if (activeTask.status === 'claimable') {
                            void claimReward(activeTask);
                            return;
                          }
                          if ((activeTask.category === 'daily' || activeTask.category === 'event') && activeTask.status === 'turnin') {
                            void completeTask(activeTask);
                          }
                        }}
                      >
                        {activeTask.category === 'daily' && (activeTask.status === 'turnin' || activeTask.status === 'claimable')
                          ? '完成'
                          : (activeTask.category === 'event' && activeTask.status !== 'claimable' ? '完成' : '领取')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="task-empty">请选择任务</div>
                )}
              </div>
            </div>
          </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default TaskModal;
