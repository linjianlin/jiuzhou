import { App, Button, Modal, Progress, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CharacterData } from '../../../../services/gameSocket';
import { gameSocket } from '../../../../services/gameSocket';
import {
  breakthroughToNextRealm,
  getInsightOverview,
  getRealmOverview,
  injectInsightExp,
  type InsightInjectResultDto,
  type InsightOverviewDto,
  type RealmOverviewDto,
} from '../../../../services/api';
import { resolveIconUrl, DEFAULT_ICON as coin01 } from '../../shared/resolveIcon';
import { IMG_LINGSHI as lingshiIcon, IMG_TONGQIAN as tongqianIcon } from '../../shared/imageAssets';
import { useIsMobile } from '../../shared/responsive';
import { REALM_ORDER, getRealmRankFromAlias, normalizeRealmWithAlias } from '../../shared/realm';
import InsightPanel from './InsightPanel';
import './index.scss';

interface RealmModalProps {
  open: boolean;
  onClose: () => void;
  character: CharacterData | null;
}

type RealmRank = {
  currentIdx: number;
  total: number;
  current: string;
  next: string | null;
};

type RequirementRow = {
  id: string;
  title: string;
  detail: string;
  status: 'done' | 'todo' | 'unknown';
};

type CostRow = {
  id: string;
  name: string;
  amountText: string;
  icon?: string;
};

type RewardRow = {
  id: string;
  title: string;
  detail: string;
};

type UnlockRow = {
  id: string;
  title: string;
  detail: string;
};

type RealmPaneKey = 'breakthrough' | 'insight';
type MobileSectionKey = 'requirements' | 'costs' | 'rewards' | 'unlocks';

const resolveIcon = resolveIconUrl;

const buildRealmRank = (character: CharacterData | null): RealmRank => {
  const current = normalizeRealmWithAlias(character?.realm ?? '凡人');
  const currentIdx = getRealmRankFromAlias(current);
  const next = currentIdx + 1 < REALM_ORDER.length ? REALM_ORDER[currentIdx + 1] : null;
  return { currentIdx, total: REALM_ORDER.length, current, next };
};

const getRequirementTag = (status: RequirementRow['status']) => {
  if (status === 'done') return <Tag color="green">已满足</Tag>;
  if (status === 'todo') return <Tag color="red">未满足</Tag>;
  return <Tag>未知</Tag>;
};

const INSIGHT_HOLD_INJECT_INTERVAL_MS = 160;
const INSIGHT_HOLD_REQUEST_LEVELS = 1_000_000;

const RealmModal: React.FC<RealmModalProps> = ({ open, onClose, character }) => {
  const { message } = App.useApp();

  const [overview, setOverview] = useState<RealmOverviewDto | null>(null);
  const [breakthroughLoading, setBreakthroughLoading] = useState(false);
  const [insightOverview, setInsightOverview] = useState<InsightOverviewDto | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const [insightInjecting, setInsightInjecting] = useState(false);
  const [insightHolding, setInsightHolding] = useState(false);
  const [insightHoldGainLevels, setInsightHoldGainLevels] = useState(0);
  const [insightHoldSpentExp, setInsightHoldSpentExp] = useState(0);
  const [insightHoldGainBonusPct, setInsightHoldGainBonusPct] = useState(0);
  const [activePane, setActivePane] = useState<RealmPaneKey>('breakthrough');
  const isMobile = useIsMobile();
  const [mobileSection, setMobileSection] = useState<MobileSectionKey>('requirements');
  const insightOverviewRef = useRef<InsightOverviewDto | null>(null);
  const insightHoldingRef = useRef(false);
  const insightHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshOverview = useCallback(async () => {
    if (!open) return;
    try {
      const res = await getRealmOverview();
      if (res.success && res.data) {
        setOverview(res.data);
      } else {
        setOverview(null);
        void 0;
      }
    } catch {
      setOverview(null);
      void 0;
    }
  }, [open]);

  const refreshInsightOverview = useCallback(async () => {
    if (!open) return;
    setInsightLoading(true);
    try {
      const res = await getInsightOverview();
      if (res.success && res.data) {
        setInsightOverview(res.data);
      } else {
        setInsightOverview(null);
      }
    } catch {
      setInsightOverview(null);
    } finally {
      setInsightLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      void refreshOverview();
      void refreshInsightOverview();
    } else {
      insightHoldingRef.current = false;
      if (insightHoldTimerRef.current) {
        clearTimeout(insightHoldTimerRef.current);
        insightHoldTimerRef.current = null;
      }
      setOverview(null);
      setInsightOverview(null);
      setInsightHolding(false);
      setInsightHoldGainLevels(0);
      setInsightHoldSpentExp(0);
      setInsightHoldGainBonusPct(0);
      setActivePane('breakthrough');
    }
  }, [open, refreshInsightOverview, refreshOverview]);

  useEffect(() => {
    insightOverviewRef.current = insightOverview;
  }, [insightOverview]);

  const rank = useMemo<RealmRank>(() => {
    if (overview) {
      const total = Math.max(1, overview.realmOrder.length);
      const currentIdx = Math.max(0, Number(overview.currentIndex ?? 0) || 0);
      const current = String(overview.currentRealm || '凡人');
      const next = overview.nextRealm ? String(overview.nextRealm) : null;
      return { currentIdx, total, current, next };
    }
    return buildRealmRank(character);
  }, [character, overview]);

  const plan = useMemo(() => {
    if (overview) {
      const requirements: RequirementRow[] = (overview.requirements ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        detail: r.detail,
        status: r.status,
      }));
      const costs: CostRow[] = (overview.costs ?? []).map((c) => ({
        id: c.id,
        name: c.title,
        amountText: c.detail,
        icon:
          c.type === 'item'
            ? resolveIcon(c.itemIcon)
            : c.type === 'spirit_stones'
              ? lingshiIcon
              : c.type === 'exp'
                ? tongqianIcon
                : coin01,
      }));
      return { requirements, costs };
    }
    return { requirements: [] as RequirementRow[], costs: [] as CostRow[] };
  }, [overview]);

  const outcome = useMemo(() => {
    if (overview) {
      const rewards: RewardRow[] = (overview.rewards ?? []).map((r) => ({ id: r.id, title: r.title, detail: r.detail }));
      return { rewards, unlocks: [] as UnlockRow[] };
    }
    return { rewards: [] as RewardRow[], unlocks: [] as UnlockRow[] };
  }, [overview]);

  const mobileTabs = useMemo<Array<{ key: MobileSectionKey; label: string }>>(() => {
    const tabs: Array<{ key: MobileSectionKey; label: string }> = [
      { key: 'requirements', label: '条件' },
      { key: 'costs', label: '消耗' },
      { key: 'rewards', label: '收益' },
    ];

    if (outcome.unlocks.length > 0) tabs.push({ key: 'unlocks', label: '解锁' });

    return tabs;
  }, [outcome.unlocks.length]);

  useEffect(() => {
    if (!open) {
      setMobileSection('requirements');
      return;
    }

    if (!mobileTabs.some((tab) => tab.key === mobileSection)) {
      setMobileSection(mobileTabs[0]?.key ?? 'requirements');
    }
  }, [mobileSection, mobileTabs, open]);

  const progressPercent = useMemo(() => {
    const totalSteps = Math.max(1, rank.total - 1);
    return Math.max(0, Math.min(100, (rank.currentIdx / totalSteps) * 100));
  }, [rank.currentIdx, rank.total]);

  const canBreakthrough = useMemo(() => {
    if (!rank.next) return false;
    if (overview) return !!overview.canBreakthrough;
    if (plan.requirements.length === 0) return false;
    return plan.requirements.every((r) => r.status === 'done');
  }, [overview, plan.requirements, rank.next]);

  const insightUpgradeProgressPct = useMemo(() => {
    if (!insightOverview) return 0;
    if (insightOverview.nextLevelCostExp <= 0) return 0;
    const raw = (insightOverview.characterExp / insightOverview.nextLevelCostExp) * 100;
    return Math.max(0, Math.min(100, raw));
  }, [insightOverview]);

  const insightInjectDisabled = useMemo(() => {
    return (
      !insightOverview ||
      !insightOverview.unlocked ||
      insightLoading ||
      insightOverview.characterExp < insightOverview.nextLevelCostExp
    );
  }, [insightLoading, insightOverview]);

  const displayExp = overview ? Number(overview.exp ?? 0) : Number(character?.exp ?? 0);
  const displaySpiritStones = overview ? Number(overview.spiritStones ?? 0) : Number(character?.spiritStones ?? 0);

  const handleBreakthrough = useCallback(async () => {
    if (!rank.next) return;
    setBreakthroughLoading(true);
    try {
      const res = await breakthroughToNextRealm();
      if (!res.success) {
        void 0;
        return;
      }
      message.success(res.message || '突破成功');
      gameSocket.refreshCharacter();
      void refreshOverview();
    } catch {
      void 0;
    } finally {
      setBreakthroughLoading(false);
    }
  }, [message, rank.next, refreshOverview]);

  const handleInjectInsight = useCallback(
    async (levels: number, options?: { silent?: boolean }): Promise<InsightInjectResultDto | null> => {
      if (!insightOverview || !insightOverview.unlocked) return null;
      setInsightInjecting(true);
      try {
        const res = await injectInsightExp({ levels });
        if (!res.success || !res.data) {
          if (!options?.silent) message.error(res.message || '悟道失败');
          return null;
        }

        if (!options?.silent) message.success(res.message || '悟道成功');

        gameSocket.refreshCharacter();
        await Promise.all([refreshOverview(), refreshInsightOverview()]);
        return res.data;
      } catch {
        if (!options?.silent) message.error('悟道失败');
        return null;
      } finally {
        setInsightInjecting(false);
      }
    },
    [insightOverview, message, refreshInsightOverview, refreshOverview],
  );

  /**
   * 停止长按注入并清理定时器。
   *
   * 说明：
   * - 这里只做状态机收口，不负责业务弹窗或注入请求。
   * - 被多个路径复用：鼠标抬起、触摸结束、页签切换、模态关闭。
   */
  const stopInsightHoldInject = useCallback(() => {
    insightHoldingRef.current = false;
    if (insightHoldTimerRef.current) {
      clearTimeout(insightHoldTimerRef.current);
      insightHoldTimerRef.current = null;
    }
    setInsightHolding(false);
  }, []);

  /**
   * 执行一次“长按脉冲注入”。
   *
   * 说明：
   * - 每次按固定大等级请求发起一次注入（后端按可支付等级自动截断），成功后自动安排下一次脉冲。
   * - 一旦失败或无法继续注入，立即停止长按状态，防止空转请求。
   */
  const runInsightHoldPulse = useCallback(async (): Promise<void> => {
    if (!insightHoldingRef.current) return;
    const currentOverview = insightOverviewRef.current;
    if (!currentOverview || !currentOverview.unlocked) {
      stopInsightHoldInject();
      return;
    }

    const result = await handleInjectInsight(INSIGHT_HOLD_REQUEST_LEVELS, { silent: true });
    if (!insightHoldingRef.current) return;
    if (!result || result.actualInjectedLevels <= 0) {
      stopInsightHoldInject();
      return;
    }

    setInsightHoldGainLevels((prev) => prev + result.actualInjectedLevels);
    setInsightHoldSpentExp((prev) => prev + result.spentExp);
    setInsightHoldGainBonusPct((prev) => prev + result.gainedBonusPct);

    insightHoldTimerRef.current = setTimeout(() => {
      void runInsightHoldPulse();
    }, INSIGHT_HOLD_INJECT_INTERVAL_MS);
  }, [handleInjectInsight, stopInsightHoldInject]);

  /**
   * 开始长按注入。
   *
   * 说明：
   * - 每次开始都会重置本次会话的“+XX”累计值。
   * - 当注入条件不满足时直接忽略，不触发请求。
   */
  const startInsightHoldInject = useCallback(() => {
    if (insightHoldingRef.current) return;
    if (insightInjectDisabled || insightInjecting) return;

    setInsightHoldGainLevels(0);
    setInsightHoldSpentExp(0);
    setInsightHoldGainBonusPct(0);
    setInsightHolding(true);
    insightHoldingRef.current = true;
    void runInsightHoldPulse();
  }, [insightInjectDisabled, insightInjecting, runInsightHoldPulse]);

  useEffect(() => {
    if (activePane !== 'insight') {
      stopInsightHoldInject();
    }
  }, [activePane, stopInsightHoldInject]);

  useEffect(() => {
    return () => {
      insightHoldingRef.current = false;
      if (insightHoldTimerRef.current) {
        clearTimeout(insightHoldTimerRef.current);
        insightHoldTimerRef.current = null;
      }
    };
  }, []);

  const renderRequirementList = () => (
    <div className="realm-req-list">
      {plan.requirements.map((r) => (
        <div key={r.id} className="realm-req-item">
          <div className="realm-req-main">
            <div className="realm-req-head">
              <div className="realm-req-title">{r.title}</div>
              <div className="realm-req-tag">{getRequirementTag(r.status)}</div>
            </div>
            <div className="realm-req-detail">{r.detail}</div>
          </div>
        </div>
      ))}
      {plan.requirements.length === 0 ? <div className="realm-empty">暂无条件</div> : null}
    </div>
  );

  const renderCostList = () => (
    <div className="realm-costs">
      {plan.costs.map((c) => (
        <div key={c.id} className="realm-cost">
          <img className="realm-cost-icon" src={c.icon ?? coin01} alt={c.name} />
          <div className="realm-cost-name">{c.name}</div>
          <div className="realm-cost-amount">{c.amountText}</div>
        </div>
      ))}
      {plan.costs.length === 0 ? <div className="realm-empty">暂无消耗</div> : null}
    </div>
  );

  const renderRewardList = () => (
    <div className="realm-reward-list">
      {outcome.rewards.map((r) => (
        <div key={r.id} className="realm-reward-item">
          <div className="realm-reward-title">{r.title}</div>
          <div className="realm-reward-detail">{r.detail}</div>
        </div>
      ))}
      {outcome.rewards.length === 0 ? <div className="realm-empty">暂无收益</div> : null}
    </div>
  );

  const renderUnlockList = () => (
    <div className="realm-unlock-list">
      {outcome.unlocks.map((u) => (
        <div key={u.id} className="realm-unlock-item">
          <div className="realm-unlock-title">{u.title}</div>
          <div className="realm-unlock-detail">{u.detail}</div>
        </div>
      ))}
      {outcome.unlocks.length === 0 ? <div className="realm-empty">暂无解锁</div> : null}
    </div>
  );

  const renderRealmSummary = () => (
    <>
      <div className="realm-left-card">
        <div className="realm-left-card-k">当前境界</div>
        <div className="realm-left-card-v">{rank.current}</div>
        <div className="realm-left-card-sub">
          {rank.currentIdx + 1}/{rank.total}
        </div>
        <div className="realm-left-progress">
          <Progress percent={progressPercent} showInfo={false} strokeColor="var(--primary-color)" />
        </div>
      </div>

      <div className="realm-stats">
        <div className="realm-stat">
          <div className="realm-stat-k">经验</div>
          <div className="realm-stat-v">{displayExp.toLocaleString()}</div>
        </div>
        <div className="realm-stat">
          <div className="realm-stat-k">灵石</div>
          <div className="realm-stat-v">{displaySpiritStones.toLocaleString()}</div>
        </div>
        <div className="realm-stat">
          <div className="realm-stat-k">可用属性点</div>
          <div className="realm-stat-v">{(character?.attributePoints ?? 0).toLocaleString()}</div>
        </div>
      </div>
    </>
  );

  const renderActionButtons = () => (
    <>
      <Button onClick={onClose}>关闭</Button>
      <Button
        type="primary"
        disabled={!canBreakthrough}
        loading={breakthroughLoading}
        onClick={handleBreakthrough}
      >
        {rank.next ? '突破' : '已达巅峰'}
      </Button>
    </>
  );

  const paneTabs: Array<{ key: RealmPaneKey; label: string }> = [
    { key: 'breakthrough', label: '境界突破' },
    { key: 'insight', label: '悟道' },
  ];

  const mobileSectionTitle: Record<MobileSectionKey, string> = {
    requirements: '突破条件',
    costs: '消耗预览',
    rewards: '突破收益',
    unlocks: '联动解锁',
  };

  const activeMobileSection = mobileTabs.some((tab) => tab.key === mobileSection)
    ? mobileSection
    : mobileTabs[0]?.key ?? 'requirements';

  const renderMobileSectionContent = () => {
    if (activeMobileSection === 'requirements') return renderRequirementList();
    if (activeMobileSection === 'costs') return renderCostList();
    if (activeMobileSection === 'rewards') return renderRewardList();
    return renderUnlockList();
  };

  const renderDesktopShell = () => (
    <div className="realm-shell">
      <div className="realm-left">
        <div className="realm-left-title">
          <img className="realm-left-icon" src={coin01} alt="境界" />
          <div className="realm-left-name">境界</div>
        </div>

        {renderRealmSummary()}
      </div>

      <div className="realm-right">
        <div className="realm-pane">
          <div className="realm-pane-top">
            <div className="realm-mode-tabs">
              {paneTabs.map((tab) => (
                <Button
                  key={tab.key}
                  size="small"
                  type={activePane === tab.key ? 'primary' : 'default'}
                  className="realm-mode-tab"
                  onClick={() => setActivePane(tab.key)}
                >
                  {tab.label}
                </Button>
              ))}
            </div>
            <div className="realm-title">{activePane === 'breakthrough' ? '境界突破' : '悟道修行'}</div>
            <div className="realm-subtitle">
              {activePane === 'breakthrough'
                ? rank.next
                  ? `下一境界：${rank.next}`
                  : '已达当前版本最高境界'
                : '持续消耗经验，获取全模式永久属性加成'}
            </div>
          </div>

          <div className="realm-pane-body">
            {activePane === 'breakthrough' ? (
              <>
                <div className="realm-section">
                  <div className="realm-section-title">突破条件</div>
                  {renderRequirementList()}
                </div>

                <div className="realm-section">
                  <div className="realm-section-title">消耗预览</div>
                  {renderCostList()}
                </div>

                <div className="realm-section">
                  <div className="realm-section-title">突破收益</div>
                  {renderRewardList()}
                </div>

                {outcome.unlocks.length > 0 ? (
                  <div className="realm-section">
                    <div className="realm-section-title">联动解锁</div>
                    {renderUnlockList()}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="realm-section">
                <div className="realm-section-title">悟道总览</div>
                <InsightPanel
                  overview={insightOverview}
                  holdGainLevels={insightHoldGainLevels}
                  holdSpentExp={insightHoldSpentExp}
                  holdGainBonusPct={insightHoldGainBonusPct}
                  upgradeProgressPct={insightUpgradeProgressPct}
                />
              </div>
            )}
          </div>

          {activePane === 'breakthrough' ? (
            <div className="realm-pane-footer">{renderActionButtons()}</div>
          ) : (
            <div className="realm-pane-footer">
              <Button
                type="primary"
                className={`realm-insight-hold-btn ${insightHolding ? 'is-holding' : ''}`.trim()}
                loading={insightInjecting && !insightHolding}
                disabled={insightInjectDisabled && !insightHolding}
                onMouseDown={startInsightHoldInject}
                onMouseUp={stopInsightHoldInject}
                onMouseLeave={stopInsightHoldInject}
                onTouchStart={startInsightHoldInject}
                onTouchEnd={stopInsightHoldInject}
                onTouchCancel={stopInsightHoldInject}
                onTouchMove={stopInsightHoldInject}
              >
                {insightHolding ? '注入中，松开停止' : '按住注入经验'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderMobileShell = () => (
    <div className="realm-mobile-shell">
      <div className="realm-left-title realm-mobile-title">
        <img className="realm-left-icon" src={coin01} alt="境界" />
        <div className="realm-left-name">境界</div>
      </div>

      <div className="realm-mobile-intro">
        <div className="realm-mode-tabs realm-mode-tabs-mobile">
          {paneTabs.map((tab) => (
            <Button
              key={tab.key}
              size="small"
              type={activePane === tab.key ? 'primary' : 'default'}
              className="realm-mode-tab"
              onClick={() => setActivePane(tab.key)}
            >
              {tab.label}
            </Button>
          ))}
        </div>
        <div className="realm-title">{activePane === 'breakthrough' ? '境界突破' : '悟道修行'}</div>
        <div className="realm-subtitle">
          {activePane === 'breakthrough'
            ? rank.next
              ? `下一境界：${rank.next}`
              : '已达当前版本最高境界'
            : '持续消耗经验，获取全模式永久属性加成'}
        </div>
      </div>

      {activePane === 'breakthrough' ? (
        <div className="realm-mobile-tabs" style={{ gridTemplateColumns: `repeat(${mobileTabs.length}, minmax(0, 1fr))` }}>
          {mobileTabs.map((tab) => (
            <Button
              key={tab.key}
              size="small"
              type={tab.key === activeMobileSection ? 'primary' : 'default'}
              className="realm-mobile-tab"
              onClick={() => setMobileSection(tab.key)}
            >
              {tab.label}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="realm-mobile-body">
        {activePane === 'breakthrough' ? (
          <div className="realm-section">
            <div className="realm-section-title">{mobileSectionTitle[activeMobileSection]}</div>
            {renderMobileSectionContent()}
          </div>
        ) : (
          <div className="realm-section">
            <div className="realm-section-title">悟道总览</div>
            <InsightPanel
              overview={insightOverview}
              holdGainLevels={insightHoldGainLevels}
              holdSpentExp={insightHoldSpentExp}
              holdGainBonusPct={insightHoldGainBonusPct}
              upgradeProgressPct={insightUpgradeProgressPct}
            />
          </div>
        )}
      </div>

      {activePane === 'breakthrough' ? (
        <div className="realm-mobile-footer">{renderActionButtons()}</div>
      ) : (
        <div className="realm-mobile-footer">
          <Button
            type="primary"
            className={`realm-insight-hold-btn ${insightHolding ? 'is-holding' : ''}`.trim()}
            loading={insightInjecting && !insightHolding}
            disabled={insightInjectDisabled && !insightHolding}
            onMouseDown={startInsightHoldInject}
            onMouseUp={stopInsightHoldInject}
            onMouseLeave={stopInsightHoldInject}
            onTouchStart={startInsightHoldInject}
            onTouchEnd={stopInsightHoldInject}
            onTouchCancel={stopInsightHoldInject}
            onTouchMove={stopInsightHoldInject}
          >
            {insightHolding ? '注入中，松开停止' : '按住注入经验'}
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={isMobile ? 'calc(100vw - 16px)' : 1080}
      className={`realm-modal ${isMobile ? 'is-mobile' : ''}`.trim()}
      style={isMobile ? { paddingBottom: 0 } : undefined}
      destroyOnHidden
      maskClosable
    >
      {isMobile ? renderMobileShell() : renderDesktopShell()}
    </Modal>
  );
};

export default RealmModal;
