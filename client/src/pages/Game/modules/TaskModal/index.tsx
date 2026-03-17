import { App, Button, Input, Modal, Segmented, Tag } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_ICON as coin01 } from '../../shared/resolveIcon';
import {
  claimTaskReward,
  getBountyTaskOverview,
  getTaskOverview,
  setTaskTracked,
  submitTaskToNpc,
  submitBountyMaterials,
} from '../../../../services/api';
import { getMainQuestProgress, type MainQuestProgressDto } from '../../../../services/mainQuestApi';
import { useIsMobile } from '../../shared/responsive';
import { getRealmRankFromLiteral as getRealmRank } from '../../shared/realm';
import { formatTaskRewardsToText } from '../../shared/taskRewardText';
import MainQuestPanel from './MainQuestPanel';
import {
  TASK_CATEGORY_KEYS,
  TASK_CATEGORY_LABELS,
  TASK_CATEGORY_SHORT_LABELS,
  TASK_STATUS_COLOR,
  TASK_STATUS_TEXT,
  createEmptyTaskLoadedState,
  createEmptyTaskRowsByCategory,
  isTaskListCategory,
  mapBountyTaskOverviewRows,
  mapTaskOverviewRows,
  type TaskCategory,
  type TaskItem,
  type TaskListCategory,
  type TaskStatus,
} from './taskModalShared';
import './index.scss';
import './MainQuestPanel.scss';

const formatRewardAmount = (amount: number, amountMax?: number): string => {
  const min = Math.max(0, Math.floor(Number(amount) || 0));
  const maxRaw = Number(amountMax);
  const hasRange = Number.isFinite(maxRaw) && maxRaw > min;
  if (!hasRange) return `×${min.toLocaleString()}`;
  return `×${min.toLocaleString()}~${Math.floor(maxRaw).toLocaleString()}`;
};

interface TaskModalProps {
  open: boolean;
  onClose: () => void;
  onTrackedChange?: () => void;
  onTaskCompletedChange?: () => void;
}

const TaskModal: React.FC<TaskModalProps> = ({ open, onClose, onTrackedChange, onTaskCompletedChange }) => {
  const { message } = App.useApp();
  const taskCategoryKeys = useMemo(() => TASK_CATEGORY_KEYS, []);
  const taskCategoryOptions = useMemo(
    () => taskCategoryKeys.map((k) => ({ label: TASK_CATEGORY_SHORT_LABELS[k], value: k })),
    [taskCategoryKeys],
  );
  const isMobile = useIsMobile();
  const [mobilePane, setMobilePane] = useState<'list' | 'detail'>('list');
  const [category, setCategory] = useState<TaskCategory>('main');
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string>('');
  const [loadingByCategory, setLoadingByCategory] = useState<Record<TaskCategory, boolean>>(() => createEmptyTaskLoadedState());
  const [submittingTaskId, setSubmittingTaskId] = useState<string>('');
  const [taskRowsByCategory, setTaskRowsByCategory] = useState<Record<TaskListCategory, TaskItem[]>>(() => createEmptyTaskRowsByCategory());
  const [bountyTasks, setBountyTasks] = useState<TaskItem[]>([]);
  const [mainQuestProgress, setMainQuestProgress] = useState<MainQuestProgressDto | null>(null);
  const [nowTs, setNowTs] = useState<number>(() => Date.now());
  const lastExpireRefreshAtRef = useRef<number>(0);
  const loadedByCategoryRef = useRef<Record<TaskCategory, boolean>>(createEmptyTaskLoadedState());
  const inflightRequestsRef = useRef<Record<TaskCategory, Promise<void> | null>>({
    main: null,
    side: null,
    daily: null,
    event: null,
    bounty: null,
  });

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

  const setCategoryLoading = useCallback((targetCategory: TaskCategory, nextLoading: boolean) => {
    setLoadingByCategory((prev) => (
      prev[targetCategory] === nextLoading ? prev : { ...prev, [targetCategory]: nextLoading }
    ));
  }, []);

  const setCategoryLoaded = useCallback((targetCategory: TaskCategory, nextLoaded: boolean) => {
    loadedByCategoryRef.current[targetCategory] = nextLoaded;
  }, []);

  const runCategoryRequest = useCallback(async (targetCategory: TaskCategory, requestFactory: () => Promise<void>): Promise<void> => {
    const inflightRequest = inflightRequestsRef.current[targetCategory];
    if (inflightRequest) return inflightRequest;

    const request = requestFactory().finally(() => {
      inflightRequestsRef.current[targetCategory] = null;
    });
    inflightRequestsRef.current[targetCategory] = request;
    return request;
  }, []);

  const loadMainQuestProgress = useCallback(async (forceRefresh: boolean): Promise<void> => {
    if (!forceRefresh && loadedByCategoryRef.current.main) return;

    await runCategoryRequest('main', async () => {
      setCategoryLoading('main', true);
      setCategoryLoaded('main', false);
      try {
        const response = await getMainQuestProgress();
        if (!response.success || !response.data) return;
        setMainQuestProgress(response.data);
        setCategoryLoaded('main', true);
      } finally {
        setCategoryLoading('main', false);
      }
    });
  }, [runCategoryRequest, setCategoryLoaded, setCategoryLoading]);

  const loadTaskCategory = useCallback(async (targetCategory: TaskListCategory, forceRefresh: boolean): Promise<void> => {
    if (!forceRefresh && loadedByCategoryRef.current[targetCategory]) return;

    await runCategoryRequest(targetCategory, async () => {
      setCategoryLoading(targetCategory, true);
      setCategoryLoaded(targetCategory, false);
      try {
        const response = await getTaskOverview(targetCategory);
        if (!response.success || !response.data) return;
        const nextRows = mapTaskOverviewRows(response.data.tasks || []);
        setTaskRowsByCategory((prev) => ({ ...prev, [targetCategory]: nextRows }));
        setCategoryLoaded(targetCategory, true);
      } finally {
        setCategoryLoading(targetCategory, false);
      }
    });
  }, [runCategoryRequest, setCategoryLoaded, setCategoryLoading]);

  const loadBountyTaskOverview = useCallback(async (forceRefresh: boolean): Promise<void> => {
    if (!forceRefresh && loadedByCategoryRef.current.bounty) return;

    await runCategoryRequest('bounty', async () => {
      setCategoryLoading('bounty', true);
      setCategoryLoaded('bounty', false);
      try {
        const response = await getBountyTaskOverview();
        if (!response.success || !response.data) return;
        setBountyTasks(mapBountyTaskOverviewRows(response.data.tasks || []));
        setCategoryLoaded('bounty', true);
      } finally {
        setCategoryLoading('bounty', false);
      }
    });
  }, [runCategoryRequest, setCategoryLoaded, setCategoryLoading]);

  const ensureCategoryLoaded = useCallback(async (targetCategory: TaskCategory): Promise<void> => {
    if (targetCategory === 'main') {
      await loadMainQuestProgress(false);
      return;
    }
    if (targetCategory === 'bounty') {
      await loadBountyTaskOverview(false);
      return;
    }
    await loadTaskCategory(targetCategory, false);
  }, [loadBountyTaskOverview, loadMainQuestProgress, loadTaskCategory]);

  const refreshCategory = useCallback(async (targetCategory: TaskCategory): Promise<void> => {
    if (targetCategory === 'main') {
      await loadMainQuestProgress(true);
      return;
    }
    if (targetCategory === 'bounty') {
      await loadBountyTaskOverview(true);
      return;
    }
    await loadTaskCategory(targetCategory, true);
  }, [loadBountyTaskOverview, loadMainQuestProgress, loadTaskCategory]);

  const markCategoriesStale = useCallback((categories: TaskCategory[]) => {
    for (const targetCategory of categories) {
      loadedByCategoryRef.current[targetCategory] = false;
    }
  }, []);

  const updateTaskInCategory = useCallback((targetCategory: TaskCategory, taskId: string, updater: (task: TaskItem) => TaskItem) => {
    if (targetCategory === 'bounty') {
      setBountyTasks((prev) => prev.map((task) => (task.id === taskId ? updater(task) : task)));
      return;
    }
    if (!isTaskListCategory(targetCategory)) return;
    setTaskRowsByCategory((prev) => ({
      ...prev,
      [targetCategory]: prev[targetCategory].map((task) => (task.id === taskId ? updater(task) : task)),
    }));
  }, []);

  useEffect(() => {
    if (!open) return;
    markCategoriesStale(TASK_CATEGORY_KEYS);
    setCategory('main');
    setQuery('');
    setActiveId('');
    setMobilePane('list');
    void refreshCategory('main');
  }, [markCategoriesStale, open, refreshCategory]);

  useEffect(() => {
    if (!open) return;
    void ensureCategoryLoaded(category);
  }, [category, ensureCategoryLoaded, open]);

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
    if (loadingByCategory.bounty) return;

    const hasExpiredDaily = bountyTasks.some((t) => {
      if (t.sourceType !== 'daily') return false;
      if (!t.expiresAt) return false;
      return (getRemainingSeconds(t.expiresAt) ?? 0) <= 0;
    });
    if (!hasExpiredDaily) return;

    const now = Date.now();
    if (now - lastExpireRefreshAtRef.current < 5000) return;
    lastExpireRefreshAtRef.current = now;
    void refreshCategory('bounty');
  }, [bountyTasks, category, getRemainingSeconds, loadingByCategory.bounty, open, refreshCategory]);

  const loading = loadingByCategory[category];
  const currentTasks = useMemo(() => {
    if (category === 'bounty') return bountyTasks;
    if (!isTaskListCategory(category)) return [];
    return taskRowsByCategory[category];
  }, [bountyTasks, category, taskRowsByCategory]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = currentTasks
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
  }, [category, currentTasks, getRemainingSeconds, query]);

  const safeActiveId = useMemo(() => {
    if (activeId && filtered.some((t) => t.id === activeId)) return activeId;
    return filtered[0]?.id ?? '';
  }, [activeId, filtered]);

  const activeTask = useMemo(() => filtered.find((t) => t.id === safeActiveId) ?? null, [filtered, safeActiveId]);
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
      updateTaskInCategory(activeTask.category, activeTask.id, (task) => ({ ...task, tracked: nextTracked }));
      message.success(nextTracked ? '已追踪' : '已取消追踪');
      onTrackedChange?.();
    } catch {
      void 0;
    }
  }, [activeTask, message, onTrackedChange, updateTaskInCategory]);

  const claimReward = useCallback(async (task: TaskItem | null) => {
    if (!task?.id) return;
    try {
      const res = await claimTaskReward(task.id);
      message.success('领取成功');
      const rewardText = formatTaskRewardsToText(res.data?.rewards);
      appendSystemChat(`【任务】领取奖励：${task.title}${rewardText ? `（${rewardText}）` : ''}`);
      await refreshCategory(task.category);
      onTaskCompletedChange?.();
    } catch {
      void 0;
    }
  }, [appendSystemChat, message, onTaskCompletedChange, refreshCategory]);

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
        await refreshCategory(task.category);
        onTaskCompletedChange?.();
        return;
      }

      message.success('完成成功');
      appendSystemChat(`【任务】已完成：${task.title}`);
      await refreshCategory(task.category);
      onTaskCompletedChange?.();
    } catch {
      void 0;
    }
  }, [appendSystemChat, message, onTaskCompletedChange, refreshCategory]);

  const submitMaterials = useCallback(
    async (task: TaskItem | null) => {
      if (!task?.id) return;
      setSubmittingTaskId(task.id);
      try {
        await submitBountyMaterials(task.id);
        message.success('提交成功');
        appendSystemChat(`【悬赏】已提交材料：${task.title}`);
        await refreshCategory('bounty');
      } catch {
        void 0;
      } finally {
        setSubmittingTaskId('');
      }
    },
    [appendSystemChat, message, refreshCategory],
  );

  const refreshMainQuestProgress = useCallback(async () => {
    await refreshCategory('main');
    markCategoriesStale(['side', 'daily', 'event']);
  }, [markCategoriesStale, refreshCategory]);

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
                  {TASK_CATEGORY_LABELS[k]}
                </Button>
              ))}
            </div>
          )}
        </div>

        <div className="task-modal-right">
          {category === 'main' ? (
            <div className="task-main-wrap">
              <MainQuestPanel
                onClose={onClose}
                progress={mainQuestProgress}
                onProgressChange={setMainQuestProgress}
                onRefresh={refreshMainQuestProgress}
                onTrackChange={onTrackedChange}
              />
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
                        <Tag color={TASK_STATUS_COLOR[t.status]}>{TASK_STATUS_TEXT[t.status]}</Tag>
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
                          <Tag color={TASK_STATUS_COLOR[activeTask.status]}>{TASK_STATUS_TEXT[activeTask.status]}</Tag>
                          <Tag color="default">推荐境界 {activeTask.realm}</Tag>
                          {activeTask.category === 'bounty' && activeTask.sourceType === 'daily' && activeTask.expiresAt ? (
                            <Tag color="volcano">剩余 {formatCountdown(getRemainingSeconds(activeTask.expiresAt) ?? 0)}</Tag>
                          ) : null}
                        </div>
                      </div>
                      <div className="task-detail-desc">{activeTask.desc}</div>
                      <div className="task-section-title">目标</div>
                      <div className="task-objectives">
                        {activeTask.objectives.map((o) => (
                          <div key={o.text} className="task-objective">
                            <div className="task-objective-body">
                              <div className="task-objective-text">{o.text}</div>
                              {o.mapName ? (
                                <Tag className="task-objective-map-tag" color={o.mapNameType === 'dungeon' ? 'purple' : 'cyan'}>{o.mapName}</Tag>
                              ) : null}
                            </div>
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
