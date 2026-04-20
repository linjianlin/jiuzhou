import { ArrowDownOutlined, ArrowUpOutlined, CheckCircleOutlined, EditOutlined, StopOutlined } from '@ant-design/icons';
import { App, Button, Drawer, Empty, Input, InputNumber, Modal, Progress, Segmented, Skeleton, Switch, Tag, Tooltip } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  activatePartner,
  confirmPartnerFusionPreview,
  confirmPartnerTechniqueLearnPreview,
  confirmPartnerRecruitDraft,
  dismissPartner,
  discardPartnerTechniqueLearnPreview,
  discardPartnerRecruitDraft,
  generatePartnerRecruitDraft,
  getBagInventorySnapshot,
  getPartnerFusionStatus,
  getPartnerOverview,
  getPartnerReboneStatus,
  getPartnerRecruitStatus,
  getPartnerSkillPolicy,
  getPartnerTechniqueDetail,
  getPartnerTechniqueUpgradeCost,
  injectPartnerExp,
  inventoryUseItem,
  learnPartnerTechnique,
  markPartnerFusionResultViewed,
  markPartnerReboneResultViewed,
  markPartnerRecruitResultViewed,
  startPartnerFusion,
  type PartnerBookDto,
  type PartnerDetailDto,
  type PartnerFusionStatusDto,
  type PartnerOverviewDto,
  type PartnerPendingTechniqueLearnPreviewDto,
  type PartnerReboneStatusDto,
  type PartnerRecruitPreviewDto,
  type PartnerRecruitStatusDto,
  type PartnerSkillPolicyDto,
  type PartnerSkillPolicyEntryDto,
  type PartnerTechniqueDetailDto,
  type PartnerTechniqueDto,
  type PartnerTechniqueUpgradeCostDto,
  SILENT_API_REQUEST_CONFIG,
  updatePartnerSkillPolicy,
  upgradePartnerTechnique,
} from '../../../../services/api';
import { gameSocket } from '../../../../services/gameSocket';
import { getUnifiedApiErrorMessage } from '../../../../services/api';
import { DEFAULT_ICON as partnerIcon } from '../../shared/resolveIcon';
import { dispatchPartnerChangedEvent, PARTNER_CHANGED_EVENT } from '../../shared/partnerTradeEvents';
import { useIsMobile } from '../../shared/responsive';
import { findRenameCardInventoryItem } from '../../shared/renameCard';
import { renderSkillTooltip } from '../TechniqueModal/skillDetailShared';
import {
  buildPartnerCombatAttrRows,
  buildPartnerUpgradeRuleLines,
  buildPartnerSkillPolicySlots,
  buildPartnerLearnPreviewLines,
  formatPartnerElementLabel,
  formatPartnerAttrValue,
  formatPartnerLearnPreviewTitle,
  formatPartnerTechniqueLayerLabel,
  formatPartnerTechniqueUpgradeCostLines,
  formatPartnerLearnResult,
  formatPartnerLevelSummary,
  formatPartnerTechniquePassiveLines,
  getPartnerAttrLabel,
  getPartnerDisplayName,
  getPartnerEmptySlotCount,
  hasPartnerLevelLimitApplied,
  getPartnerVisibleBaseAttrs,
  groupPartnersByListQuality,
  groupPartnerSkillPolicyEntries,
  movePartnerSkillPolicyEntry,
  PARTNER_PANEL_OPTIONS,
  reorderPartnerSkillPolicyEntry,
  resolvePartnerActionLabel,
  resolvePartnerAvatar,
  resolvePartnerBookLabel,
  resolvePartnerNextSelectedId,
  resolvePartnerReboneElixirItem,
  resolvePartnerStatusTagDescriptors,
  togglePartnerSkillPolicyEntry,
  type PartnerPanelKey,
} from './partnerShared';
import { getElementTextClassName, getElementToneClassName } from '../../shared/elementTheme';
import { getItemQualityTagClassName, normalizeItemQualityName } from '../../shared/itemQuality';
import {
  buildPartnerRecruitIndicator,
  hasPartnerRecruitCustomBaseModelToken,
  resolvePartnerRecruitCooldownDisplay,
  resolvePartnerRecruitGuaranteeText,
  resolvePartnerRecruitLayoutState,
  resolvePartnerRecruitActionState,
  resolvePartnerRecruitPanelView,
  resolvePartnerRecruitQualityRateItems,
  resolvePartnerRecruitSubmitState,
} from './partnerRecruitShared';
import { usePartnerRenameCardFlow } from './usePartnerRenameCardFlow';
import {
  buildPartnerFusionIndicator,
  groupPartnersByFusionQuality,
  resolvePartnerFusionMaterialDisabledReason,
  resolvePartnerFusionPanelView,
  resolvePartnerFusionRateLines,
  resolvePartnerFusionSelectedQuality,
  togglePartnerFusionMaterialSelection,
} from './partnerFusionShared';
import {
  resolvePartnerReboneActionState,
  resolvePartnerReboneUnreadResultJob,
} from './partnerReboneShared';
import TechniqueDetailPanel from '../../shared/TechniqueDetailPanel';
import { buildPartnerTechniqueDetailView } from '../../shared/partnerTechniqueDetailView';
import { type TechniqueDetailView } from '../../shared/techniqueDetailView';
import './index.scss';

interface PartnerModalProps {
  open: boolean;
  onClose: () => void;
  onRecruitStatusChange?: (status: PartnerRecruitStatusDto | null) => void;
}

type RecruitStatusRefreshMode = 'initial' | 'background';
type TechniqueLearnOutcome = {
  learnedTechnique: PartnerTechniqueDto;
  replacedTechnique: PartnerTechniqueDto | null;
};
type PendingTechniqueLearnPreview = PartnerPendingTechniqueLearnPreviewDto;

const PARTNER_SKILL_TOOLTIP_CLASS_NAMES = {
  root: 'skill-tooltip-overlay game-tooltip-surface-root',
  container: 'skill-tooltip-overlay-container game-tooltip-surface-container',
} as const;

/**
 * 伙伴系统主弹窗。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在一个弹窗内承接伙伴总览、经验灌注、功法学习与功法升层四条主链路。
 * 2. 做什么：把伙伴数据读取与刷新集中在单一组件中，避免 Game 页面持有零散伙伴状态。
 * 3. 不做什么：不直接管理菜单解锁判断，也不处理背包总览展示。
 *
 * 输入/输出：
 * - 输入：`open`、`onClose`。
 * - 输出：伙伴系统完整交互 UI；写操作后通过 socket 刷新角色，并触发 `partner:changed` / `inventory:changed` 同步相关模块。
 *
 * 数据流/状态流：
 * open -> getPartnerOverview -> 选中伙伴 -> 激活/灌注/学习/升层 -> refreshOverview -> UI 更新。
 *
 * 关键边界条件与坑点：
 * 1. 伙伴列表和功法书列表都依赖总览接口，写操作后必须统一刷新，不能分别手动拼局部状态。
 * 2. 当前选择的伙伴在刷新后可能失效，需要在 overview 更新时自动校正到出战伙伴或首个伙伴。
 */
const PartnerModal: React.FC<PartnerModalProps> = ({ open, onClose, onRecruitStatusChange }) => {
  const { message, modal } = App.useApp();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(false);
  const [actionKey, setActionKey] = useState('');
  const [panel, setPanel] = useState<PartnerPanelKey>('overview');
  const [overview, setOverview] = useState<PartnerOverviewDto | null>(null);
  const [recruitStatus, setRecruitStatus] = useState<PartnerRecruitStatusDto | null>(null);
  const [fusionStatus, setFusionStatus] = useState<PartnerFusionStatusDto | null>(null);
  const [reboneStatus, setReboneStatus] = useState<PartnerReboneStatusDto | null>(null);
  const [skillPolicy, setSkillPolicy] = useState<PartnerSkillPolicyDto | null>(null);
  const [skillPolicyDraftEntries, setSkillPolicyDraftEntries] = useState<PartnerSkillPolicyEntryDto[]>([]);
  const [skillPolicyLoading, setSkillPolicyLoading] = useState(false);
  const [selectedPartnerId, setSelectedPartnerId] = useState<number | null>(null);
  const [draggingSkillId, setDraggingSkillId] = useState<string | null>(null);
  const [dragOverSkillId, setDragOverSkillId] = useState<string | null>(null);
  const [injectExpValue, setInjectExpValue] = useState<number | null>(null);
  const [techniqueResultText, setTechniqueResultText] = useState('');
  const [advancedRecruitEnabled, setAdvancedRecruitEnabled] = useState(false);
  const [recruitBaseModelInput, setRecruitBaseModelInput] = useState('');
  const [selectedFusionMaterialIds, setSelectedFusionMaterialIds] = useState<number[]>([]);
  const [techniqueUpgradeCosts, setTechniqueUpgradeCosts] = useState<Record<string, PartnerTechniqueUpgradeCostDto | null>>({});
  const [techniqueDetailOpen, setTechniqueDetailOpen] = useState(false);
  const [techniqueDetailLoading, setTechniqueDetailLoading] = useState(false);
  const [techniqueDetail, setTechniqueDetail] = useState<TechniqueDetailView | null>(null);
  const [pendingTechniqueLearnPreview, setPendingTechniqueLearnPreview] = useState<PendingTechniqueLearnPreview | null>(null);
  const markingRecruitViewedRef = useRef(false);
  const markingFusionViewedRef = useRef(false);
  const markingReboneViewedRef = useRef(false);
  const shownReboneResultRef = useRef<string | null>(null);
  const techniqueDetailCacheRef = useRef(new Map<string, PartnerTechniqueDetailDto>());
  const techniqueDetailRequestIdRef = useRef(0);

  const applyRecruitStatus = useCallback((status: PartnerRecruitStatusDto | null) => {
    setRecruitStatus(status);
    onRecruitStatusChange?.(status);
  }, [onRecruitStatusChange]);

  const applyFusionStatus = useCallback((status: PartnerFusionStatusDto | null) => {
    setFusionStatus(status);
  }, []);

  const applyReboneStatus = useCallback((status: PartnerReboneStatusDto | null) => {
    setReboneStatus(status);
  }, []);

  const refreshOverview = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const res = await getPartnerOverview();
      if (!res.success || !res.data) {
        throw new Error(getUnifiedApiErrorMessage(res, '获取伙伴信息失败'));
      }
      setOverview(res.data);
    } catch {
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [open]);

  const refreshRecruitStatus = useCallback(async (mode: RecruitStatusRefreshMode = 'background') => {
    if (!open) return;
    try {
      const res = await getPartnerRecruitStatus();
      if (!res.success || !res.data) {
        throw new Error(getUnifiedApiErrorMessage(res, '获取招募状态失败'));
      }
      applyRecruitStatus(res.data);
    } catch {
      if (mode === 'initial') {
        applyRecruitStatus(null);
      }
    }
  }, [applyRecruitStatus, open]);

  const refreshFusionStatus = useCallback(async (mode: RecruitStatusRefreshMode = 'background') => {
    if (!open) return;
    try {
      const res = await getPartnerFusionStatus();
      if (!res.success || !res.data) {
        throw new Error(getUnifiedApiErrorMessage(res, '获取三魂归契状态失败'));
      }
      applyFusionStatus(res.data);
    } catch {
      if (mode === 'initial') {
        applyFusionStatus(null);
      }
    }
  }, [applyFusionStatus, open]);

  const refreshReboneStatus = useCallback(async (mode: RecruitStatusRefreshMode = 'background') => {
    if (!open) return;
    try {
      const res = await getPartnerReboneStatus();
      if (!res.success || !res.data) {
        throw new Error(getUnifiedApiErrorMessage(res, '获取归元洗髓状态失败'));
      }
      applyReboneStatus(res.data);
    } catch {
      if (mode === 'initial') {
        applyReboneStatus(null);
      }
    }
  }, [applyReboneStatus, open]);

  const refreshSkillPolicy = useCallback(async (partnerId: number) => {
    if (!open) return;
    setSkillPolicyLoading(true);
    try {
      const res = await getPartnerSkillPolicy(partnerId);
      if (!res.success || !res.data) {
        throw new Error(getUnifiedApiErrorMessage(res, '获取伙伴技能策略失败'));
      }
      setSkillPolicy(res.data);
      setSkillPolicyDraftEntries(res.data.entries);
    } catch {
      setSkillPolicy(null);
      setSkillPolicyDraftEntries([]);
    } finally {
      setSkillPolicyLoading(false);
    }
  }, [open]);

  const latestRecruitResultKeyRef = useRef<string | null>(null);
  const latestFusionResultKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPanel('overview');
      setOverview(null);
      setRecruitStatus(null);
      setFusionStatus(null);
      setReboneStatus(null);
      setSkillPolicy(null);
      setSkillPolicyDraftEntries([]);
      setSkillPolicyLoading(false);
      setSelectedPartnerId(null);
      setDraggingSkillId(null);
      setDragOverSkillId(null);
      setInjectExpValue(null);
      setTechniqueResultText('');
      setAdvancedRecruitEnabled(false);
      setRecruitBaseModelInput('');
      setSelectedFusionMaterialIds([]);
      setTechniqueUpgradeCosts({});
      setTechniqueDetailOpen(false);
      setTechniqueDetailLoading(false);
      setTechniqueDetail(null);
      latestRecruitResultKeyRef.current = null;
      latestFusionResultKeyRef.current = null;
      setPendingTechniqueLearnPreview(null);
      setActionKey('');
      shownReboneResultRef.current = null;
      return;
    }
    void Promise.all([
      refreshOverview(),
      refreshRecruitStatus('initial'),
      refreshFusionStatus('initial'),
      refreshReboneStatus('initial'),
    ]);
  }, [open, refreshFusionStatus, refreshOverview, refreshReboneStatus, refreshRecruitStatus]);

  useEffect(() => {
    setSelectedPartnerId(resolvePartnerNextSelectedId(overview, selectedPartnerId));
  }, [overview, selectedPartnerId]);

  useEffect(() => {
    setPendingTechniqueLearnPreview(overview?.pendingTechniqueLearnPreview ?? null);
  }, [overview?.pendingTechniqueLearnPreview]);

  useEffect(() => {
    setSelectedFusionMaterialIds((currentIds) => currentIds.filter((partnerId) =>
      overview?.partners.some((partner) => partner.id === partnerId) ?? false));
  }, [overview]);

  useEffect(() => {
    techniqueDetailCacheRef.current.clear();
  }, [overview]);

  useEffect(() => {
    setTechniqueResultText('');
    setTechniqueUpgradeCosts({});
    setTechniqueDetailOpen(false);
    setTechniqueDetailLoading(false);
    setTechniqueDetail(null);
    techniqueDetailRequestIdRef.current += 1;
    setSkillPolicy(null);
    setSkillPolicyDraftEntries([]);
    setDraggingSkillId(null);
    setDragOverSkillId(null);
  }, [selectedPartnerId]);

  useEffect(() => {
    if (!open) return undefined;
    const handler = () => {
      void refreshOverview();
    };
    window.addEventListener(PARTNER_CHANGED_EVENT, handler);
    return () => window.removeEventListener(PARTNER_CHANGED_EVENT, handler);
  }, [open, refreshOverview]);

  const selectedPartner = useMemo<PartnerDetailDto | null>(() => {
    if (!overview || selectedPartnerId === null) return null;
    return overview.partners.find((partner) => partner.id === selectedPartnerId) ?? null;
  }, [overview, selectedPartnerId]);
  const selectedPartnerActionLocked = selectedPartner?.tradeStatus === 'market_listed'
    || selectedPartner?.fusionStatus === 'fusion_locked';
  const selectedPartnerReboneElixirItem = useMemo(
    () => resolvePartnerReboneElixirItem(selectedPartner, overview),
    [overview, selectedPartner],
  );
  const reboneActionState = useMemo(
    () => resolvePartnerReboneActionState({
      status: reboneStatus,
      partnerId: selectedPartner?.id ?? null,
      hasConsumable: Boolean(selectedPartnerReboneElixirItem),
      partnerLocked: Boolean(selectedPartnerActionLocked),
    }),
    [reboneStatus, selectedPartner?.id, selectedPartnerActionLocked, selectedPartnerReboneElixirItem],
  );
  const reboneUnreadResultJob = useMemo(
    () => resolvePartnerReboneUnreadResultJob(reboneStatus),
    [reboneStatus],
  );
  const shouldShowReboneAction = useMemo(
    () => Boolean(selectedPartnerReboneElixirItem)
      || Boolean(reboneActionState.pendingJob && selectedPartner && reboneActionState.pendingJob.partnerId === selectedPartner.id),
    [reboneActionState.pendingJob, selectedPartner, selectedPartnerReboneElixirItem],
  );
  const closeTechniqueDetail = useCallback(() => {
    techniqueDetailRequestIdRef.current += 1;
    setTechniqueDetailOpen(false);
    setTechniqueDetailLoading(false);
  }, []);
  const openTechniqueDetail = useCallback(async (technique: PartnerTechniqueDto) => {
    if (!selectedPartner) return;

    const cacheKey = `${selectedPartner.id}:${technique.techniqueId}`;
    const cached = techniqueDetailCacheRef.current.get(cacheKey) ?? null;
    const requestId = techniqueDetailRequestIdRef.current + 1;
    techniqueDetailRequestIdRef.current = requestId;
    setTechniqueDetailOpen(true);
    setTechniqueDetailLoading(true);

    if (cached) {
      setTechniqueDetail(buildPartnerTechniqueDetailView(cached));
      setTechniqueDetailLoading(false);
      return;
    }

    setTechniqueDetail(null);

    try {
      const res = await getPartnerTechniqueDetail(selectedPartner.id, technique.techniqueId);
      if (techniqueDetailRequestIdRef.current !== requestId) return;
      if (!res.success || !res.data) {
        throw new Error(getUnifiedApiErrorMessage(res, '获取伙伴功法详情失败'));
      }
      techniqueDetailCacheRef.current.set(cacheKey, res.data);
      setTechniqueDetail(buildPartnerTechniqueDetailView(res.data));
    } catch {
      if (techniqueDetailRequestIdRef.current !== requestId) return;
      setTechniqueDetail(null);
    } finally {
      if (techniqueDetailRequestIdRef.current === requestId) {
        setTechniqueDetailLoading(false);
      }
    }
  }, [selectedPartner]);
  const {
    canRenamePartner,
    renameSubmitting,
    openPartnerRename,
    renameModalNode,
  } = usePartnerRenameCardFlow({
    partner: selectedPartner,
    refresh: refreshOverview,
    onAfterSuccess: () => {
      gameSocket.refreshCharacter();
    },
  });
  const skillPolicyChanged = useMemo(() => {
    if (!skillPolicy) return false;
    const baseEntries = skillPolicy.entries;
    if (baseEntries.length !== skillPolicyDraftEntries.length) return true;
    return baseEntries.some((entry, index) => {
      const draftEntry = skillPolicyDraftEntries[index];
      if (!draftEntry) return true;
      return (
        entry.skillId !== draftEntry.skillId
        || entry.priority !== draftEntry.priority
        || entry.enabled !== draftEntry.enabled
      );
    });
  }, [skillPolicy, skillPolicyDraftEntries]);

  useEffect(() => {
    if (!open || panel !== 'skill_policy' || !selectedPartner) {
      return;
    }
    void refreshSkillPolicy(selectedPartner.id);
  }, [open, panel, refreshSkillPolicy, selectedPartner]);

  const recruitIndicator = useMemo(() => buildPartnerRecruitIndicator(recruitStatus), [recruitStatus]);
  const fusionIndicator = useMemo(() => buildPartnerFusionIndicator(fusionStatus), [fusionStatus]);
  const recruitPanelView = useMemo(() => resolvePartnerRecruitPanelView(recruitStatus), [recruitStatus]);
  const fusionPanelView = useMemo(() => resolvePartnerFusionPanelView(fusionStatus), [fusionStatus]);
  const recruitActionState = useMemo(
    () => resolvePartnerRecruitActionState(recruitStatus, advancedRecruitEnabled),
    [advancedRecruitEnabled, recruitStatus],
  );
  const recruitSubmitState = useMemo(
    () => resolvePartnerRecruitSubmitState(recruitStatus, advancedRecruitEnabled),
    [advancedRecruitEnabled, recruitStatus],
  );
  const recruitCooldownDisplay = useMemo(
    () => resolvePartnerRecruitCooldownDisplay(recruitStatus, advancedRecruitEnabled),
    [advancedRecruitEnabled, recruitStatus],
  );
  const recruitQualityRateItems = useMemo(
    () => resolvePartnerRecruitQualityRateItems(recruitStatus),
    [recruitStatus],
  );
  const recruitBaseModelInputTrimmed = recruitBaseModelInput.trim();
  const recruitBaseModelInputLength = Array.from(recruitBaseModelInputTrimmed).length;
  const hasCustomBaseModelToken = hasPartnerRecruitCustomBaseModelToken(recruitStatus);
  const customBaseModelTokenEnough = recruitSubmitState.customBaseModelTokenEnough;
  const canSubmitRecruit = recruitSubmitState.canSubmit;
  const fusionSelectedQuality = useMemo(
    () => resolvePartnerFusionSelectedQuality(overview?.partners ?? [], selectedFusionMaterialIds),
    [overview?.partners, selectedFusionMaterialIds],
  );
  const selectedFusionMaterials = useMemo(
    () => selectedFusionMaterialIds
      .map((partnerId) => overview?.partners?.find((partner) => partner.id === partnerId))
      .filter((partner): partner is PartnerDetailDto => Boolean(partner)),
    [overview?.partners, selectedFusionMaterialIds],
  );
  const fusionRateLines = useMemo(
    () => (fusionSelectedQuality ? resolvePartnerFusionRateLines(fusionSelectedQuality, selectedFusionMaterials) : []),
    [fusionSelectedQuality, selectedFusionMaterials],
  );
  const groupedPartnerList = useMemo(
    () => groupPartnersByListQuality(overview?.partners ?? []),
    [overview?.partners],
  );

  useEffect(() => {
    if (!hasCustomBaseModelToken && advancedRecruitEnabled) {
      setAdvancedRecruitEnabled(false);
    }
  }, [advancedRecruitEnabled, hasCustomBaseModelToken]);

  const characterExp = overview?.characterExp ?? 0;

  const expToNextLevel = useMemo(() => {
    if (!selectedPartner) return 0;
    return Math.max(0, selectedPartner.nextLevelCostExp - selectedPartner.progressExp);
  }, [selectedPartner]);

  const progressPercent = useMemo(() => {
    if (!selectedPartner) return 0;
    if (selectedPartner.nextLevelCostExp <= 0) return 0;
    return Math.min(100, (selectedPartner.progressExp / selectedPartner.nextLevelCostExp) * 100);
  }, [selectedPartner]);

  useEffect(() => {
    if (!selectedPartner) {
      setInjectExpValue(null);
      return;
    }
    if (characterExp <= 0) {
      setInjectExpValue(null);
      return;
    }
    const suggestedExp = expToNextLevel > 0 ? Math.min(characterExp, expToNextLevel) : Math.min(characterExp, 1);
    setInjectExpValue(suggestedExp > 0 ? suggestedExp : null);
  }, [characterExp, expToNextLevel, selectedPartner]);

  useEffect(() => {
    if (!open) return undefined;
    const unsubscribeStatus = gameSocket.onPartnerRecruitStatusUpdate((payload) => {
      const currentCharacterId = gameSocket.getCharacter()?.id ?? null;
      if (!currentCharacterId || payload.characterId !== currentCharacterId) return;
      applyRecruitStatus(payload.status);
    });
    const unsubscribeFusionStatus = gameSocket.onPartnerFusionStatusUpdate((payload) => {
      const currentCharacterId = gameSocket.getCharacter()?.id ?? null;
      if (!currentCharacterId || payload.characterId !== currentCharacterId) return;
      applyFusionStatus(payload.status);
    });
    const unsubscribeReboneStatus = gameSocket.onPartnerReboneStatusUpdate((payload) => {
      const currentCharacterId = gameSocket.getCharacter()?.id ?? null;
      if (!currentCharacterId || payload.characterId !== currentCharacterId) return;
      applyReboneStatus(payload.status);
    });
    const unsubscribe = gameSocket.onPartnerRecruitResult((payload) => {
      const currentCharacterId = gameSocket.getCharacter()?.id ?? null;
      if (!currentCharacterId || payload.characterId !== currentCharacterId) return;
      const resultKey = `${payload.generationId}:${payload.status}`;
      if (latestRecruitResultKeyRef.current === resultKey) return;
      latestRecruitResultKeyRef.current = resultKey;
      if (payload.status === 'generated_draft') {
        message.success(payload.message);
      } else {
        message.warning(payload.errorMessage || payload.message);
      }
    });
    const unsubscribeFusion = gameSocket.onPartnerFusionResult((payload) => {
      const currentCharacterId = gameSocket.getCharacter()?.id ?? null;
      if (!currentCharacterId || payload.characterId !== currentCharacterId) return;
      const resultKey = `${payload.fusionId}:${payload.status}`;
      if (latestFusionResultKeyRef.current === resultKey) return;
      latestFusionResultKeyRef.current = resultKey;
      if (payload.status === 'generated_preview') {
        message.success(payload.message);
      } else {
        message.warning(payload.errorMessage || payload.message);
      }
    });
    const unsubscribeRebone = gameSocket.onPartnerReboneResult((payload) => {
      const currentCharacterId = gameSocket.getCharacter()?.id ?? null;
      if (!currentCharacterId || payload.characterId !== currentCharacterId) return;
      const resultKey = `${payload.reboneId}:${payload.status}`;
      if (shownReboneResultRef.current === resultKey) return;
      shownReboneResultRef.current = resultKey;
      if (payload.status === 'succeeded') {
        message.success(payload.message);
      } else {
        message.warning(payload.errorMessage || payload.message);
      }
      void refreshOverview();
      dispatchPartnerChangedEvent();
      window.dispatchEvent(new Event('inventory:changed'));
    });
    return () => {
      unsubscribeStatus();
      unsubscribeFusionStatus();
      unsubscribeReboneStatus();
      unsubscribe();
      unsubscribeFusion();
      unsubscribeRebone();
    };
  }, [applyFusionStatus, applyReboneStatus, applyRecruitStatus, message, open, refreshOverview]);

  useEffect(() => {
    if (!open || panel !== 'recruit' || !recruitStatus?.hasUnreadResult || markingRecruitViewedRef.current) {
      return;
    }
    markingRecruitViewedRef.current = true;
    void (async () => {
      try {
        await markPartnerRecruitResultViewed();
        await refreshRecruitStatus();
      } catch {
        void 0;
      } finally {
        markingRecruitViewedRef.current = false;
      }
    })();
  }, [open, panel, recruitStatus?.hasUnreadResult, refreshRecruitStatus]);

  useEffect(() => {
    if (!open || panel !== 'fusion' || !fusionStatus?.hasUnreadResult || markingFusionViewedRef.current) {
      return;
    }
    markingFusionViewedRef.current = true;
    void (async () => {
      try {
        await markPartnerFusionResultViewed();
        await refreshFusionStatus();
      } catch {
        void 0;
      } finally {
        markingFusionViewedRef.current = false;
      }
    })();
  }, [fusionStatus?.hasUnreadResult, open, panel, refreshFusionStatus]);

  useEffect(() => {
    if (!open || !reboneUnreadResultJob) {
      return;
    }
    const resultMarker = `${reboneUnreadResultJob.reboneId}:${reboneUnreadResultJob.status}`;
    if (shownReboneResultRef.current !== resultMarker) {
      shownReboneResultRef.current = resultMarker;
      if (reboneUnreadResultJob.status === 'succeeded') {
        message.success('归元洗髓完成');
      } else {
        message.warning(reboneUnreadResultJob.errorMessage || '归元洗髓失败');
      }
      void refreshOverview();
      dispatchPartnerChangedEvent();
      window.dispatchEvent(new Event('inventory:changed'));
    }
    if (markingReboneViewedRef.current) {
      return;
    }
    markingReboneViewedRef.current = true;
    void (async () => {
      try {
        await markPartnerReboneResultViewed();
        await refreshReboneStatus();
      } catch {
        void 0;
      } finally {
        markingReboneViewedRef.current = false;
      }
    })();
  }, [message, open, reboneUnreadResultJob, refreshOverview, refreshReboneStatus]);

  useEffect(() => {
    if (!open || panel !== 'technique' || !selectedPartner) {
      setTechniqueUpgradeCosts({});
      return;
    }

    const upgradeableTechniques = selectedPartner.techniques.filter(
      (technique) => technique.currentLayer < technique.maxLayer,
    );
    if (upgradeableTechniques.length <= 0) {
      setTechniqueUpgradeCosts({});
      return;
    }

    let cancelled = false;
    const loadUpgradeCosts = async () => {
      try {
        const costEntries = await Promise.all(
          upgradeableTechniques.map(async (technique) => {
            const res = await getPartnerTechniqueUpgradeCost(selectedPartner.id, technique.techniqueId);
            if (!res.success || !res.data) {
              throw new Error(getUnifiedApiErrorMessage(res, '读取功法升层消耗失败'));
            }
            return [technique.techniqueId, res.data] as const;
          }),
        );
        if (cancelled) return;
        setTechniqueUpgradeCosts(Object.fromEntries(costEntries));
      } catch {
        if (cancelled) return;
        setTechniqueUpgradeCosts({});
      }
    };

    void loadUpgradeCosts();
    return () => {
      cancelled = true;
    };
  }, [open, panel, selectedPartner]);

  const handleActivate = useCallback(async (partnerId: number) => {
    setActionKey(`activate-${partnerId}`);
    try {
      const res = await activatePartner(partnerId);
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '切换出战失败'));
      message.success(res.message || '已切换出战伙伴');
      await refreshOverview();
      dispatchPartnerChangedEvent();
      gameSocket.refreshCharacter();
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [message, refreshOverview]);

  const handleDismiss = useCallback(async (partnerId: number) => {
    setActionKey(`dismiss-${partnerId}`);
    try {
      const res = await dismissPartner();
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '伙伴下阵失败'));
      message.success(res.message || '已将伙伴下阵');
      await refreshOverview();
      dispatchPartnerChangedEvent();
      gameSocket.refreshCharacter();
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [message, refreshOverview]);

  const handleOpenPartnerRename = useCallback(async () => {
    if (!selectedPartner || !canRenamePartner) {
      return;
    }

    setActionKey(`rename-open-${selectedPartner.id}`);
    try {
      const res = await getBagInventorySnapshot(SILENT_API_REQUEST_CONFIG);
      if (!res.success || !res.data) {
        throw new Error(getUnifiedApiErrorMessage(res, '读取背包失败'));
      }

      const renameCardItem = findRenameCardInventoryItem(res.data.bagItems);
      if (!renameCardItem) {
        message.warning('背包中暂无易名符');
        return;
      }

      openPartnerRename({
        itemInstanceId: renameCardItem.id,
        itemName: renameCardItem.def?.name ?? '易名符',
      });
    } catch (error) {
      message.error(getUnifiedApiErrorMessage(error, '读取易名符失败'));
    } finally {
      setActionKey('');
    }
  }, [canRenamePartner, message, openPartnerRename, selectedPartner]);

  const handleInjectExp = useCallback(async () => {
    if (!selectedPartner) return;
    const exp = Math.max(0, Math.floor(Number(injectExpValue) || 0));
    if (exp <= 0) {
      message.warning('请输入有效的灌注经验');
      return;
    }
    setActionKey(`inject-${selectedPartner.id}`);
    try {
      const res = await injectPartnerExp(selectedPartner.id, exp);
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '灌注失败'));
      message.success(res.message || '灌注成功');
      await refreshOverview();
      dispatchPartnerChangedEvent();
      gameSocket.refreshCharacter();
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [injectExpValue, message, refreshOverview, selectedPartner]);

  const handleRebonePartner = useCallback(() => {
    if (!selectedPartner || !selectedPartnerReboneElixirItem) {
      message.warning('当前没有可用的归元洗髓露');
      return;
    }
    if (reboneActionState.disabled) {
      if (reboneActionState.disabledReason) {
        message.warning(reboneActionState.disabledReason);
      }
      return;
    }
    modal.confirm({
      title: `确认对${getPartnerDisplayName(selectedPartner)}使用归元洗髓露？`,
      content: '将创建一个异步洗髓任务，按该伙伴的原始描述重生成基础属性与每级成长；头像、当前描述、名字与功法均保持不变。任务失败时会自动退回本次消耗的归元洗髓露。',
      okText: '开始洗髓',
      cancelText: '暂不使用',
      onOk: async () => {
        setActionKey(`rebone-${selectedPartner.id}`);
        try {
          const res = await inventoryUseItem({
            itemInstanceId: selectedPartnerReboneElixirItem.itemInstanceId,
            qty: 1,
            partnerId: selectedPartner.id,
          });
          if (!res.success) {
            throw new Error(getUnifiedApiErrorMessage(res, '归元洗髓失败'));
          }
          message.success(res.message || '归元洗髓任务已提交');
          await Promise.all([refreshOverview(), refreshReboneStatus()]);
          window.dispatchEvent(new Event('inventory:changed'));
        } catch (error) {
          message.error(getUnifiedApiErrorMessage(error, '归元洗髓失败'));
        } finally {
          setActionKey('');
        }
      },
    });
  }, [message, modal, reboneActionState, refreshOverview, refreshReboneStatus, selectedPartner, selectedPartnerReboneElixirItem]);

  const applyTechniqueLearnOutcome = useCallback(async (
    outcome: TechniqueLearnOutcome,
    successMessage: string,
  ) => {
    message.success(successMessage);
    setPendingTechniqueLearnPreview(null);
    setTechniqueResultText(formatPartnerLearnResult(outcome.learnedTechnique, outcome.replacedTechnique));
    await refreshOverview();
    dispatchPartnerChangedEvent();
    window.dispatchEvent(new Event('inventory:changed'));
  }, [message, refreshOverview]);

  const executeLearnTechnique = useCallback(async (book: PartnerBookDto) => {
    if (!selectedPartner) return;
    setActionKey(`learn-${book.itemInstanceId}`);
    try {
      const res = await learnPartnerTechnique(selectedPartner.id, book.itemInstanceId);
      if (!res.success || !res.data) throw new Error(getUnifiedApiErrorMessage(res, '学习失败'));
      if (res.data.mode === 'preview_replace') {
        setPendingTechniqueLearnPreview({
          book,
          preview: res.data.preview,
        });
        await refreshOverview();
        return;
      }
      await applyTechniqueLearnOutcome(res.data.result, res.message || '学习成功');
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [applyTechniqueLearnOutcome, selectedPartner]);

  const handleLearnTechnique = useCallback((book: PartnerBookDto) => {
    modal.confirm({
      title: `确认让伙伴学习${resolvePartnerBookLabel(book)}？`,
      content: '确认后会先消耗 1 本功法书；如果伙伴功法槽已满，下一步会继续展示替换预览。',
      okText: '继续学习',
      cancelText: '暂不学习',
      onOk: async () => {
        await executeLearnTechnique(book);
      },
    });
  }, [executeLearnTechnique, modal]);

  const handleConfirmTechniqueLearnPreview = useCallback(async () => {
    if (!pendingTechniqueLearnPreview) return;
    const { preview } = pendingTechniqueLearnPreview;
    setActionKey(`learn-confirm-${preview.itemInstanceId}`);
    try {
      const res = await confirmPartnerTechniqueLearnPreview(
        preview.partnerId,
        preview.itemInstanceId,
        preview.replacedTechnique.techniqueId,
      );
      if (!res.success || !res.data) throw new Error(getUnifiedApiErrorMessage(res, '确认学习失败'));
      await applyTechniqueLearnOutcome(res.data, res.message || '学习成功');
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [applyTechniqueLearnOutcome, pendingTechniqueLearnPreview]);

  const handleDiscardTechniqueLearnPreview = useCallback(async () => {
    if (!pendingTechniqueLearnPreview) return;
    const { book, preview } = pendingTechniqueLearnPreview;
    setActionKey(`learn-discard-${preview.itemInstanceId}`);
    try {
      const res = await discardPartnerTechniqueLearnPreview(preview.itemInstanceId);
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '放弃学习失败'));
      message.success(res.message || '已放弃学习');
      setPendingTechniqueLearnPreview(null);
      setTechniqueResultText(`已放弃学习：${resolvePartnerBookLabel(book)} 已被消耗`);
      await refreshOverview();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [message, pendingTechniqueLearnPreview, refreshOverview]);

  const handleUpgradeTechnique = useCallback(async (technique: PartnerTechniqueDto) => {
    if (!selectedPartner) return;
    setActionKey(`upgrade-${technique.techniqueId}`);
    try {
      const res = await upgradePartnerTechnique(selectedPartner.id, technique.techniqueId);
      if (!res.success || !res.data) throw new Error(getUnifiedApiErrorMessage(res, '升层失败'));
      message.success(res.message || '升层成功');
      setTechniqueResultText(`修炼成功：${res.data.updatedTechnique.name} 已提升至第 ${res.data.newLayer} 层`);
      await refreshOverview();
      dispatchPartnerChangedEvent();
      gameSocket.refreshCharacter();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [message, refreshOverview, selectedPartner]);

  const handleMoveSkillPolicyEntry = useCallback((
    skillId: string,
    direction: 'up' | 'down',
  ) => {
    setSkillPolicyDraftEntries((currentEntries) => movePartnerSkillPolicyEntry(currentEntries, skillId, direction));
  }, []);

  const handleToggleSkillPolicy = useCallback((skillId: string) => {
    setSkillPolicyDraftEntries((currentEntries) => togglePartnerSkillPolicyEntry(currentEntries, skillId));
  }, []);

  const clearSkillPolicyDragState = useCallback(() => {
    setDraggingSkillId(null);
    setDragOverSkillId(null);
  }, []);

  const handleReorderSkillPolicyEntry = useCallback((sourceSkillId: string, targetSkillId: string) => {
    setSkillPolicyDraftEntries((currentEntries) =>
      reorderPartnerSkillPolicyEntry(currentEntries, sourceSkillId, targetSkillId));
  }, []);

  const handleSkillPolicyDragStart = useCallback((event: DragEvent<HTMLDivElement>, skillId: string) => {
    setDraggingSkillId(skillId);
    setDragOverSkillId(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', skillId);
  }, []);

  const handleSkillPolicyDragOver = useCallback((
    event: DragEvent<HTMLDivElement>,
    targetSkillId: string,
  ) => {
    if (!draggingSkillId || draggingSkillId === targetSkillId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverSkillId(targetSkillId);
  }, [draggingSkillId]);

  const handleSkillPolicyDrop = useCallback((
    event: DragEvent<HTMLDivElement>,
    targetSkillId: string,
  ) => {
    event.preventDefault();
    const sourceSkillId = event.dataTransfer.getData('text/plain') || draggingSkillId;
    if (!sourceSkillId || sourceSkillId === targetSkillId) {
      clearSkillPolicyDragState();
      return;
    }
    handleReorderSkillPolicyEntry(sourceSkillId, targetSkillId);
    clearSkillPolicyDragState();
  }, [clearSkillPolicyDragState, draggingSkillId, handleReorderSkillPolicyEntry]);

  const handleSaveSkillPolicy = useCallback(async () => {
    if (!selectedPartner) return;
    setActionKey(`skill-policy-${selectedPartner.id}`);
    try {
      const res = await updatePartnerSkillPolicy(
        selectedPartner.id,
        buildPartnerSkillPolicySlots(skillPolicyDraftEntries),
      );
      if (!res.success || !res.data) {
        throw new Error(getUnifiedApiErrorMessage(res, '保存伙伴技能策略失败'));
      }
      setSkillPolicy(res.data);
      setSkillPolicyDraftEntries(res.data.entries);
      message.success(res.message || '伙伴技能策略已保存');
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [message, selectedPartner, skillPolicyDraftEntries]);

  const handleGenerateRecruit = useCallback(async () => {
    if (!canSubmitRecruit) return;
    setActionKey('recruit-generate');
    try {
      const res = await generatePartnerRecruitDraft({
        customBaseModelEnabled: advancedRecruitEnabled,
        requestedBaseModel: recruitBaseModelInputTrimmed || undefined,
      });
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '开始招募失败'));
      message.success(res.message || '伙伴招募已开始');
      await refreshRecruitStatus();
      gameSocket.refreshCharacter();
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [advancedRecruitEnabled, canSubmitRecruit, message, recruitBaseModelInputTrimmed, refreshRecruitStatus]);

  const handleToggleFusionMaterial = useCallback((partnerId: number) => {
    setSelectedFusionMaterialIds((currentIds) => togglePartnerFusionMaterialSelection(currentIds, partnerId));
  }, []);

  const handleStartFusion = useCallback(async () => {
    if (selectedFusionMaterialIds.length !== 3) {
      message.warning('请先选择3个同品级伙伴');
      return;
    }
    setActionKey('fusion-start');
    try {
      const res = await startPartnerFusion(selectedFusionMaterialIds);
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '开始三魂归契失败'));
      message.success(res.message || '三魂归契已开始');
      setSelectedFusionMaterialIds([]);
      await Promise.all([refreshFusionStatus(), refreshOverview()]);
      dispatchPartnerChangedEvent();
      gameSocket.refreshCharacter();
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [message, refreshFusionStatus, refreshOverview, selectedFusionMaterialIds]);

  const handleConfirmFusion = useCallback(async (fusionId: string) => {
    setActionKey(`fusion-confirm-${fusionId}`);
    try {
      const res = await confirmPartnerFusionPreview(fusionId);
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '确认三魂归契失败'));
      message.success(res.message || '已确认收下归契伙伴');
      await Promise.all([refreshFusionStatus(), refreshOverview()]);
      dispatchPartnerChangedEvent();
      gameSocket.refreshCharacter();
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [message, refreshFusionStatus, refreshOverview]);

  const handleConfirmRecruit = useCallback(async (generationId: string) => {
    setActionKey(`recruit-confirm-${generationId}`);
    try {
      const res = await confirmPartnerRecruitDraft(generationId);
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '确认招募失败'));
      message.success(res.message || '已确认招募伙伴');
      await Promise.all([refreshRecruitStatus(), refreshOverview()]);
      dispatchPartnerChangedEvent();
      gameSocket.refreshCharacter();
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [message, refreshOverview, refreshRecruitStatus]);

  const handleDiscardRecruit = useCallback(async (generationId: string) => {
    modal.confirm({
      title: '确认放弃当前伙伴招募？',
      content: '放弃后这次生成结果会立即作废，需要重新开始招募才能获得新的伙伴预览。',
      okText: '确认放弃',
      cancelText: '继续查看',
      okButtonProps: { danger: true },
      onOk: async () => {
        setActionKey(`recruit-discard-${generationId}`);
        try {
          const res = await discardPartnerRecruitDraft(generationId);
          if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '放弃失败'));
          message.success(res.message || '已放弃本次招募');
          await refreshRecruitStatus();
        } catch {
          void 0;
        } finally {
          setActionKey('');
        }
      },
    });
  }, [message, modal, refreshRecruitStatus]);

  const renderPartnerListPanel = () => {
    if (loading && !overview) {
      return (
        <div className="partner-list-card">
          <div className="partner-section-title">伙伴列表</div>
          <Skeleton active paragraph={{ rows: 3 }} />
        </div>
      );
    }

    if (!overview || overview.partners.length <= 0) {
      return (
        <div className="partner-list-card">
          <div className="partner-section-title">伙伴列表</div>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无伙伴" />
        </div>
      );
    }

    return (
      <div className="partner-list-card">
        <div className="partner-section-title">
          <span>伙伴列表</span>
          <Tag color="blue">角色可灌注经验 {characterExp.toLocaleString()}</Tag>
        </div>
        <div className="partner-list-quality-groups">
          {groupedPartnerList.map((group) => (
            <div key={group.quality} className="partner-list-quality-group">
              <div className="partner-list-quality-head">
                <Tag className={getItemQualityTagClassName(group.quality)}>{group.quality}</Tag>
                <span className="partner-meta">{group.partners.length} 位伙伴</span>
              </div>
              <div className="partner-list">
                {group.partners.map((partner) => {
                  const statusTags = resolvePartnerStatusTagDescriptors(partner, 'list');
                  return (
                    <div
                      key={partner.id}
                      className={`partner-list-item${selectedPartnerId === partner.id ? ' is-selected' : ''}${partner.isActive ? ' is-active' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedPartnerId(partner.id)}
                      onKeyDown={(event) => {
                        if (event.currentTarget !== event.target) return;
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        setSelectedPartnerId(partner.id);
                      }}
                    >
                      <img className="partner-list-thumb" src={resolvePartnerAvatar(partner.avatar)} alt={partner.name} />
                      <div className="partner-list-main">
                        <div className="partner-list-info">
                          <div className="partner-list-name">{getPartnerDisplayName(partner)}</div>
                          <div className="partner-list-desc">
                            {formatPartnerLevelSummary(partner)} · <span className={getElementTextClassName(partner.element)}>{formatPartnerElementLabel(partner.element)}</span> · {partner.role}
                          </div>
                          <div className="partner-tag-row">
                            {statusTags.map((tag) => (
                              <Tag key={tag.key} color={tag.color}>{tag.label}</Tag>
                            ))}
                            <Tag className={getItemQualityTagClassName(partner.quality)}>{partner.quality}</Tag>
                          </div>
                        </div>
                        <div className="partner-action-row partner-list-action-row">
                          <Button
                            type={partner.isActive ? 'default' : 'primary'}
                            loading={actionKey === `${partner.isActive ? 'dismiss' : 'activate'}-${partner.id}`}
                            disabled={partner.tradeStatus === 'market_listed' || partner.fusionStatus === 'fusion_locked'}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (partner.isActive) {
                                void handleDismiss(partner.id);
                                return;
                              }
                              void handleActivate(partner.id);
                            }}
                          >
                            {resolvePartnerActionLabel(partner.isActive)}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderPartnerSummaryCard = (className: string) => {
    if (!selectedPartner) {
      return (
        <div className={className}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择伙伴" />
        </div>
      );
    }

    return (
      <div className={className}>
        <div className="partner-current-top">
          <img className="partner-avatar" src={resolvePartnerAvatar(selectedPartner.avatar)} alt={selectedPartner.name} />
          <div className="partner-current-main">
            <div className="partner-name-row">
              <div className="partner-name">{getPartnerDisplayName(selectedPartner)}</div>
              <button
                type="button"
                className="partner-name-edit"
                aria-label="伙伴改名"
                title="伙伴改名"
                disabled={!canRenamePartner || selectedPartnerActionLocked || renameSubmitting || actionKey === `rename-open-${selectedPartner.id}`}
                onClick={() => {
                  void handleOpenPartnerRename();
                }}
              >
                <EditOutlined />
              </button>
            </div>
            <div className="partner-tag-row">
              {resolvePartnerStatusTagDescriptors(selectedPartner, 'summary').map((tag) => (
                <Tag key={tag.key} color={tag.color}>{tag.label}</Tag>
              ))}
              <Tag color="blue">等级 {selectedPartner.level}</Tag>
              {hasPartnerLevelLimitApplied(selectedPartner) ? (
                <Tag color="red">生效等级 {selectedPartner.currentEffectiveLevel}</Tag>
              ) : null}
              <Tag className={getItemQualityTagClassName(selectedPartner.quality)}>{normalizeItemQualityName(selectedPartner.quality)}</Tag>
              <Tag className={getElementToneClassName(selectedPartner.element)}>{formatPartnerElementLabel(selectedPartner.element)}</Tag>
              <Tag color="cyan">{selectedPartner.role}</Tag>
              <Tag color="purple">功法槽 {selectedPartner.slotCount}</Tag>
            </div>
            {selectedPartner.description ? (
              <div className="partner-meta">{selectedPartner.description}</div>
            ) : null}
            {selectedPartner.tradeStatus === 'market_listed' ? (
              <div className="partner-meta partner-meta--warning">已在坊市挂单，无法出战、灌注或修炼功法。</div>
            ) : null}
            {selectedPartner.fusionStatus === 'fusion_locked' ? (
              <div className="partner-meta partner-meta--warning">已被三魂归契占用，当前不可出战、培养或继续参与其他归契。</div>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const renderOverviewPanel = () => {
    if (!selectedPartner) return <div className="partner-empty">暂无伙伴数据</div>;
    const combatAttrs = buildPartnerCombatAttrRows(selectedPartner);

    return (
      <div className="partner-pane-card">
        {renderPartnerSummaryCard('partner-inline-summary')}
        <div className="partner-section-header">
          <div className="partner-section-title">当前战斗属性</div>
          {shouldShowReboneAction ? (
            <div className="partner-action-row partner-overview-action-row">
              <Tooltip title={reboneActionState.disabledReason || `消耗 1 份${selectedPartnerReboneElixirItem?.name || '归元洗髓露'}，创建异步洗髓任务后重新生成基础属性`}>
                <Button
                  onClick={() => {
                    handleRebonePartner();
                  }}
                  loading={actionKey === `rebone-${selectedPartner.id}`}
                  disabled={reboneActionState.disabled}
                >
                  {reboneActionState.buttonText}
                </Button>
              </Tooltip>
              {selectedPartnerReboneElixirItem ? (
                <Tag color="blue" className="partner-overview-action-tag">剩余 {selectedPartnerReboneElixirItem.qty}</Tag>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="partner-combat-grid">
          {combatAttrs.map((entry) => (
            <div key={entry.key} className="partner-stat-item">
              <div className="partner-stat-label">{entry.label}</div>
              <div className="partner-stat-value">
                {entry.valueText}
                {entry.growthText ? <span className="partner-stat-growth"> + {entry.growthText}</span> : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderUpgradePanel = () => {
    if (!selectedPartner) return <div className="partner-empty">暂无伙伴数据</div>;
    const upgradeRuleLines = buildPartnerUpgradeRuleLines(selectedPartner);

    return (
      <div className="partner-pane-card">
        {renderPartnerSummaryCard('partner-inline-summary')}
        <div className="partner-upgrade-top">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="partner-section-title">等级进度</div>
            <div className="partner-progress-meta">
              <span>当前等级：{selectedPartner.level}</span>
              <span>已灌注：{selectedPartner.progressExp.toLocaleString()} / {selectedPartner.nextLevelCostExp.toLocaleString()}</span>
              <span>升级尚需：{expToNextLevel.toLocaleString()}</span>
            </div>
            <Progress
              percent={progressPercent}
              strokeColor="var(--primary-color)"
              format={(percent) => `${Number(percent ?? 0).toFixed(2)}%`}
            />
            {hasPartnerLevelLimitApplied(selectedPartner) ? (
              <div className="partner-meta partner-meta--warning">
                当前等级已超出本境界上限，现阶段仅按 {selectedPartner.currentEffectiveLevel} 级生效。
              </div>
            ) : null}
          </div>

          <div className="partner-inject-panel">
            <div className="partner-section-title">经验灌注</div>
            <div className="partner-meta">角色可用经验：{characterExp.toLocaleString()}</div>
            <InputNumber<number>
              min={1}
              max={Math.max(1, characterExp)}
              value={injectExpValue}
              onChange={(value) => setInjectExpValue(value)}
              controls={false}
              style={{ width: '100%' }}
              placeholder="输入要灌注的经验"
            />
            <div className="partner-quick-actions">
              <Button
                onClick={() => setInjectExpValue(expToNextLevel > 0 ? Math.min(characterExp, expToNextLevel) : null)}
                disabled={characterExp <= 0 || expToNextLevel <= 0}
              >
                注满当前等级
              </Button>
              <Button onClick={() => setInjectExpValue(characterExp > 0 ? characterExp : null)} disabled={characterExp <= 0}>
                全部灌注
              </Button>
            </div>
            <Button
              type="primary"
              loading={actionKey === `inject-${selectedPartner.id}`}
              disabled={characterExp <= 0 || selectedPartnerActionLocked}
              onClick={() => {
                void handleInjectExp();
              }}
            >
              灌注经验
            </Button>
          </div>
        </div>
        <div className="partner-upgrade-rule-card">
          <div className="partner-section-title">培养规则</div>
          <div className="partner-upgrade-rule-list">
            {upgradeRuleLines.map((line) => (
              <div key={line} className="partner-meta">{line}</div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderTechniquePanel = () => {
    if (!selectedPartner) return <div className="partner-empty">暂无伙伴数据</div>;

    const emptySlotCount = getPartnerEmptySlotCount(selectedPartner);

    return (
      <div className="partner-pane-card">
        {renderPartnerSummaryCard('partner-inline-summary')}
        <div className="partner-section-title">已学功法</div>
        <div className="partner-technique-grid">
          {selectedPartner.techniques.map((technique) => {
            const passiveLines = formatPartnerTechniquePassiveLines(technique);
            const upgradeCost = techniqueUpgradeCosts[technique.techniqueId] ?? null;
            const upgradeCostLines = upgradeCost
              ? formatPartnerTechniqueUpgradeCostLines(upgradeCost)
              : [];
            const isMaxLayer = technique.currentLayer >= technique.maxLayer;
            return (
              <div key={technique.techniqueId} className="partner-technique-card">
                <div className="partner-card-body">
                  <div className="partner-technique-head">
                    <img className="partner-technique-icon" src={resolvePartnerAvatar(technique.icon)} alt={technique.name} />
                    <div className="partner-card-main">
                      <div className="partner-technique-name">{technique.name}</div>
                      <div className="partner-technique-desc">{technique.description || '暂无描述'}</div>
                    </div>
                  </div>
                  <div className="partner-tag-row">
                    <Tag color={technique.isInnate ? 'purple' : 'blue'}>{technique.isInnate ? '天生功法' : '后天功法'}</Tag>
                    <Tag color="cyan">{formatPartnerTechniqueLayerLabel(technique)}</Tag>
                    <Tag className={getItemQualityTagClassName(technique.quality)}>{technique.quality}</Tag>
                  </div>
                  <div className="partner-technique-lines">
                    {passiveLines.length > 0 ? (
                      passiveLines.map((line) => (
                        <span key={line} className="partner-technique-passive-pill">{line}</span>
                      ))
                    ) : (
                      <div>暂无被动加成</div>
                    )}
                  </div>
                  <div className="partner-technique-detail-row">
                    <span className="partner-technique-detail-count">
                      当前已解锁技能 {technique.skills.length} 个
                    </span>
                    <Button
                      type="text"
                      className="partner-technique-detail-button"
                      onClick={() => {
                        void openTechniqueDetail(technique);
                      }}
                    >
                      查看详情
                    </Button>
                  </div>
                </div>
                {!isMaxLayer ? (
                  <div className="partner-card-footer">
                    <div className="partner-technique-upgrade">
                      <div className="partner-technique-upgrade-title">升层消耗</div>
                      <div className="partner-technique-cost-lines">
                        {upgradeCostLines.length > 0 ? (
                          upgradeCostLines.map((line) => <div key={line}>{line}</div>)
                        ) : (
                          <div>正在读取升层消耗</div>
                        )}
                      </div>
                      <Button
                        type="primary"
                        loading={actionKey === `upgrade-${technique.techniqueId}`}
                        disabled={!upgradeCost || selectedPartnerActionLocked}
                        onClick={() => {
                          void handleUpgradeTechnique(technique);
                        }}
                      >
                        修炼升层
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
          {Array.from({ length: emptySlotCount }, (_, index) => (
            <div key={`empty-slot-${index}`} className="partner-empty-slot">
              <div className="partner-technique-name">空槽位</div>
              <div className="partner-empty-text">可通过功法书学习新功法</div>
            </div>
          ))}
        </div>

        {techniqueResultText ? <div className="partner-result-tip">{techniqueResultText}</div> : null}

        <div className="partner-section-title">
          <span>可用功法书</span>
          <Tag color="blue">背包中 {overview?.books.length ?? 0} 本</Tag>
        </div>
        {(overview?.books.length ?? 0) > 0 ? (
          <div className="partner-book-grid">
            {(overview?.books ?? []).map((book) => (
              <div key={book.itemInstanceId} className="partner-book-card">
                <div className="partner-card-body">
                  <div className="partner-book-head">
                    <img className="partner-book-icon" src={resolvePartnerAvatar(book.icon)} alt={book.name} />
                    <div className="partner-card-main">
                      <div className="partner-book-name">{resolvePartnerBookLabel(book)}</div>
                      <div className="partner-book-desc">剩余数量：{book.qty}</div>
                    </div>
                  </div>
                  <div className="partner-tag-row">
                    <Tag className={getItemQualityTagClassName(book.quality)}>{book.quality}</Tag>
                    <Tag color="blue">功法书</Tag>
                  </div>
                </div>
                <div className="partner-card-footer">
                  <Button
                    type="primary"
                    loading={actionKey === `learn-${book.itemInstanceId}`}
                    disabled={selectedPartnerActionLocked}
                    onClick={() => {
                      void handleLearnTechnique(book);
                    }}
                  >
                    学习此书
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="partner-empty">背包里还没有可供伙伴学习的功法书</div>
        )}
      </div>
    );
  };

  const renderRecruitPreview = (
    preview: PartnerRecruitPreviewDto,
    options?: { flat?: boolean },
  ) => {
    const visibleBaseAttrs = getPartnerVisibleBaseAttrs(preview.baseAttrs, preview.levelAttrGains);
    return (
      <div className={`partner-recruit-preview-card${options?.flat ? ' is-flat' : ''}`}>
        <div className="partner-current-top">
          <img className="partner-avatar" src={resolvePartnerAvatar(preview.avatar)} alt={preview.name} />
          <div className="partner-current-main">
            <div className="partner-name">{preview.name}</div>
            <div className="partner-tag-row">
              <Tag className={getItemQualityTagClassName(preview.quality)}>{preview.quality}</Tag>
              <Tag className={getElementToneClassName(preview.element)}>{formatPartnerElementLabel(preview.element)}</Tag>
              <Tag color="cyan">{preview.role}</Tag>
              <Tag color="purple">功法槽 {preview.slotCount}</Tag>
            </div>
            <div className="partner-meta">{preview.description}</div>
          </div>
        </div>
        <div className="partner-combat-grid">
          {visibleBaseAttrs.length > 0 ? (
            visibleBaseAttrs.map(({ key, value }) => (
              <div key={key} className="partner-stat-item">
                <div className="partner-stat-label">{getPartnerAttrLabel(key)}</div>
                <div className="partner-stat-value">{formatPartnerAttrValue(key, value)}</div>
                <div className="partner-recruit-growth-line">
                  每级 +{formatPartnerAttrValue(key, preview.levelAttrGains[key])}
                </div>
              </div>
            ))
          ) : (
            <div className="partner-empty">本次招募结果未生成有效属性</div>
          )}
        </div>
        <div className="partner-section-title">天生功法</div>
        <div className="partner-technique-grid">
          {preview.innateTechniques.map((technique) => (
            <div key={technique.techniqueId} className="partner-technique-card">
              <div className="partner-card-body">
                <div className="partner-technique-head">
                  <img className="partner-technique-icon" src={resolvePartnerAvatar(technique.icon)} alt={technique.name} />
                  <div className="partner-card-main">
                    <div className="partner-technique-name">{technique.name}</div>
                    <div className="partner-technique-desc">{technique.description || '暂无描述'}</div>
                  </div>
                </div>
                <div className="partner-tag-row">
                  <Tag className={getItemQualityTagClassName(technique.quality)}>{technique.quality}</Tag>
                  <Tag color="purple">天生功法</Tag>
                </div>
                <div className="partner-technique-lines">
                  {technique.skillNames.length > 0 ? (
                    technique.skillNames.map((skillName) => (
                      <span key={skillName} className="partner-technique-passive-pill">{skillName}</span>
                    ))
                  ) : (
                    <div>暂无显式技能</div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderTechniqueLearnPreviewModal = () => {
    if (!pendingTechniqueLearnPreview) return null;

    const { book, preview } = pendingTechniqueLearnPreview;
    const previewLines = buildPartnerLearnPreviewLines(
      preview.learnedTechnique,
      preview.replacedTechnique,
    );

    return (
      <Modal
        open
        centered
        closable={false}
        maskClosable={false}
        keyboard={false}
        title="功法替换预览"
        width="min(680px, calc(100vw - 24px))"
        className="partner-technique-preview-modal"
        okText="确认学习"
        cancelText="放弃学习"
        onOk={() => {
          void handleConfirmTechniqueLearnPreview();
        }}
        onCancel={() => {
          void handleDiscardTechniqueLearnPreview();
        }}
        okButtonProps={{ loading: actionKey === `learn-confirm-${preview.itemInstanceId}` }}
        cancelButtonProps={{
          danger: true,
          loading: actionKey === `learn-discard-${preview.itemInstanceId}`,
        }}
      >
        <div className="partner-technique-preview">
          <div className="partner-technique-preview-title">
            {formatPartnerLearnPreviewTitle(preview.learnedTechnique, preview.replacedTechnique)}
          </div>
          <div className="partner-technique-preview-book">
            当前使用功法书：{resolvePartnerBookLabel(book)}
          </div>
          <div className="partner-technique-preview-lines">
            {previewLines.map((line) => (
              <div key={line} className="partner-technique-preview-line">{line}</div>
            ))}
          </div>
          <div className="partner-technique-preview-compare">
            <div className="partner-technique-preview-card is-learn">
              <div className="partner-technique-preview-card-label">将学习</div>
              <div className="partner-technique-preview-card-main">
                <img
                  className="partner-technique-preview-card-icon"
                  src={resolvePartnerAvatar(preview.learnedTechnique.icon)}
                  alt={preview.learnedTechnique.name}
                />
                <div className="partner-technique-preview-card-copy">
                  <div className="partner-technique-preview-card-name">
                    {preview.learnedTechnique.name}
                  </div>
                  <div className="partner-technique-preview-card-meta">
                    <Tag className={getItemQualityTagClassName(preview.learnedTechnique.quality)}>
                      {preview.learnedTechnique.quality}
                    </Tag>
                    <Tag color="blue">{formatPartnerTechniqueLayerLabel(preview.learnedTechnique)}</Tag>
                    <Tag color="cyan">后天功法</Tag>
                  </div>
                </div>
              </div>
            </div>
            <div className="partner-technique-preview-arrow">→</div>
            <div className="partner-technique-preview-card is-replace">
              <div className="partner-technique-preview-card-label">将被替换</div>
              <div className="partner-technique-preview-card-main">
                <img
                  className="partner-technique-preview-card-icon"
                  src={resolvePartnerAvatar(preview.replacedTechnique.icon)}
                  alt={preview.replacedTechnique.name}
                />
                <div className="partner-technique-preview-card-copy">
                  <div className="partner-technique-preview-card-name">
                    {preview.replacedTechnique.name}
                  </div>
                  <div className="partner-technique-preview-card-meta">
                    <Tag className={getItemQualityTagClassName(preview.replacedTechnique.quality)}>
                      {preview.replacedTechnique.quality}
                    </Tag>
                    <Tag color="orange">{formatPartnerTechniqueLayerLabel(preview.replacedTechnique)}</Tag>
                    <Tag color="red">覆盖后消失</Tag>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Modal>
    );
  };

  const renderRecruitRequestedBaseModel = (requestedBaseModel: string | null) => {
    if (!requestedBaseModel) return null;
    return (
      <div className="partner-tag-row">
        <Tag color="geekblue">指定底模 {requestedBaseModel}</Tag>
      </div>
    );
  };

  const renderRecruitPanel = () => {
    const shouldShowSpiritStoneCost = Boolean(recruitStatus?.unlocked) && (recruitStatus?.spiritStoneCost ?? 0) > 0;
    const hasCustomBaseModelCapability = typeof recruitStatus?.customBaseModelMaxLength === 'number';
    const recruitLayoutState = resolvePartnerRecruitLayoutState(recruitPanelView);
    return (
      <div className="partner-pane-card">
        <div className="partner-section-title">
          <span>伙伴招募</span>
          {recruitStatus && shouldShowSpiritStoneCost ? (
            <Tag color="gold">消耗灵石 {recruitStatus.spiritStoneCost.toLocaleString()}</Tag>
          ) : null}
        </div>

        {recruitLayoutState.showMetaCards ? (
          <div className="partner-recruit-meta-grid">
            <div className="partner-recruit-meta-card partner-recruit-summary-card">
              <div className="partner-section-title">招募说明</div>
              <div className="partner-recruit-summary-list">
                <div className="partner-recruit-summary-item">
                  <div className="partner-stat-label">招募规则</div>
                  <div className="partner-meta">每次招募会生成一名专属伙伴预览，确认后才会正式入队。</div>
                  {hasCustomBaseModelCapability ? (
                    <div className="partner-meta">普通招募也可直接填写底模；高级招募令仅负责无视当前冷却并额外消耗令牌。</div>
                  ) : null}
                </div>
                <div className="partner-recruit-summary-item">
                  <div className="partner-stat-label">冷却状态</div>
                  <div className="partner-recruit-cooldown-status">{recruitCooldownDisplay.statusText}</div>
                  <div className="partner-meta">{recruitCooldownDisplay.ruleText}</div>
                </div>
              </div>
            </div>
            <div className="partner-recruit-meta-card partner-recruit-rate-card">
              <div className="partner-stat-label">品质概率</div>
              {recruitQualityRateItems.length > 0 ? (
                <div className="partner-recruit-quality-rate-list">
                  {recruitQualityRateItems.map((entry) => (
                    <div key={entry.quality} className="partner-recruit-quality-rate-item">
                      <Tag className={getItemQualityTagClassName(entry.quality)}>{entry.quality}品</Tag>
                      <span className="partner-recruit-quality-rate-text">{entry.rateText}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="partner-meta">--</div>
              )}
              <div className="partner-meta">{resolvePartnerRecruitGuaranteeText(recruitStatus)}</div>
              <div className="partner-meta">当前展示的是本次招募概率。</div>
            </div>
          </div>
        ) : null}

        {recruitPanelView.kind === 'pending' ? (
          <div className="partner-recruit-state-card">
            <div className="partner-section-title">生成中</div>
            <div className="partner-meta">
              正在推演新的伙伴灵识与天生功法，请稍候片刻。任务编号：{recruitPanelView.job.generationId}
            </div>
            {renderRecruitRequestedBaseModel(recruitPanelView.job.requestedBaseModel)}
            <Button loading disabled>
              正在招募中
            </Button>
          </div>
        ) : null}

        {recruitPanelView.kind === 'locked' ? (
          <div className="partner-recruit-state-card">
            <div className="partner-section-title">暂未开放</div>
            <div className="partner-meta">伙伴招募需达到 {recruitPanelView.unlockRealm} 后开放。</div>
          </div>
        ) : null}

        {recruitPanelView.kind === 'draft' ? (
          <div className="partner-recruit-state-card">
            <div className="partner-section-title">
              <span>生成结果</span>
              {recruitPanelView.job.previewExpireAt ? (
                <Tag color="orange">保留至 {new Date(recruitPanelView.job.previewExpireAt).toLocaleString()}</Tag>
              ) : null}
            </div>
            {renderRecruitRequestedBaseModel(recruitPanelView.job.requestedBaseModel)}
            {renderRecruitPreview(recruitPanelView.preview, { flat: recruitLayoutState.flattenPreviewCard })}
            <div className="partner-action-row partner-recruit-action-row partner-recruit-result-action-row">
              <Button
                danger
                loading={actionKey === `recruit-discard-${recruitPanelView.job.generationId}`}
                onClick={() => {
                  void handleDiscardRecruit(recruitPanelView.job.generationId);
                }}
              >
                放弃
              </Button>
              <Button
                type="primary"
                loading={actionKey === `recruit-confirm-${recruitPanelView.job.generationId}`}
                onClick={() => {
                  void handleConfirmRecruit(recruitPanelView.job.generationId);
                }}
              >
                确认招募
              </Button>
            </div>
          </div>
        ) : null}

        {recruitPanelView.kind === 'failed' ? (
          <div className="partner-recruit-state-card">
            <div className="partner-section-title">招募结果</div>
            {renderRecruitRequestedBaseModel(recruitPanelView.job.requestedBaseModel)}
            <div className="partner-meta">{recruitPanelView.errorMessage}</div>
          </div>
        ) : null}

        {recruitActionState.showGenerateButton ? (
          <div className="partner-recruit-state-card partner-recruit-operation-card">
            <div className="partner-section-title">
              <span>招募操作</span>
              {recruitBaseModelInputTrimmed ? <Tag color="geekblue">已填写指定底模</Tag> : null}
              {advancedRecruitEnabled ? <Tag color="gold">高级招募令已启用</Tag> : null}
            </div>
            <div className="partner-recruit-operation-copy">
              <div className="partner-stat-label">开始招募</div>
              <div className="partner-meta">
                {shouldShowSpiritStoneCost
                  ? '消耗灵石后异步生成伙伴形象、属性与天生功法。生成失败会通过邮件退回本次消耗。'
                  : '异步生成伙伴形象、属性与天生功法。'}
              </div>
            </div>
            {recruitStatus?.unlocked && hasCustomBaseModelCapability ? (
              <div className="partner-recruit-option-block">
                <div className="partner-recruit-option-row">
                  <div className="partner-recruit-option-copy">
                    <div className="partner-stat-label">指定底模</div>
                    <div className="partner-meta">
                      普通招募与高级招募令模式都可填写；留空则按系统随机底模生成。
                    </div>
                  </div>
                </div>
                <div className="partner-recruit-base-model-form">
                  <Input
                    value={recruitBaseModelInput}
                    onChange={(event) => setRecruitBaseModelInput(event.target.value)}
                    placeholder="留空则随机，例如：狐、龙、雪女"
                    maxLength={recruitStatus.customBaseModelMaxLength}
                    disabled={actionKey === 'recruit-generate'}
                  />
                  <div className="partner-recruit-base-model-meta">
                    <div className="partner-meta">
                      当前输入 {recruitBaseModelInputLength}/{recruitStatus.customBaseModelMaxLength}
                    </div>
                  </div>
                </div>
                <div className="partner-recruit-option-row">
                  <div className="partner-recruit-option-copy">
                    <div className="partner-stat-label">{recruitStatus.customBaseModelTokenItemName}</div>
                    <div className="partner-meta">
                      {!hasCustomBaseModelToken
                        ? `${recruitStatus.customBaseModelTokenItemName}不足，当前仅有 ${recruitStatus.customBaseModelTokenAvailableQty} 枚，无法启用无视冷却模式。`
                        : `启用后需额外消耗 ${recruitStatus.customBaseModelTokenItemName} x${recruitStatus.customBaseModelTokenCost}，本次招募无视当前冷却且不会重置或新增冷却。`}
                    </div>
                  </div>
                  <Switch
                    checked={advancedRecruitEnabled}
                    onChange={setAdvancedRecruitEnabled}
                    disabled={!hasCustomBaseModelToken}
                    checkedChildren="开"
                    unCheckedChildren="关"
                  />
                </div>
                {advancedRecruitEnabled && !customBaseModelTokenEnough ? (
                  <div className="partner-meta">
                    {recruitStatus.customBaseModelTokenItemName}不足，当前仅有 {recruitStatus.customBaseModelTokenAvailableQty} 枚。
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="partner-action-row partner-recruit-action-row">
              <Button
                type="primary"
                loading={actionKey === 'recruit-generate'}
                disabled={!canSubmitRecruit}
                onClick={() => {
                  void handleGenerateRecruit();
                }}
              >
                开始招募
              </Button>
            </div>
            {recruitSubmitState.disabledReason ? (
              <div className="partner-meta">{recruitSubmitState.disabledReason}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const renderFusionPanel = () => {
    const partners = overview?.partners ?? [];
    const groupedPartners = groupPartnersByFusionQuality(partners, fusionSelectedQuality);
    const canStartFusion = selectedFusionMaterialIds.length === 3
      && fusionPanelView.kind !== 'pending'
      && fusionPanelView.kind !== 'preview';

    return (
      <div className="partner-pane-card partner-fusion-panel">
        <div className="partner-section-title">
          <span>三魂归契</span>
          <div className="partner-tag-row">
            {fusionSelectedQuality ? <Tag className={getItemQualityTagClassName(fusionSelectedQuality)}>{fusionSelectedQuality}</Tag> : null}
            <Tag color="blue">已选 {selectedFusionMaterialIds.length} / 3</Tag>
          </div>
        </div>

        <div className="partner-fusion-summary">
          <div className="partner-fusion-summary-line">
            选择 3 个同品级伙伴进行三魂归契，先生成预览，确认后才会真正入队；发起后素材会立即进入“归契中”状态。
          </div>
          <div className="partner-fusion-rate-row">
            {fusionRateLines.length > 0 ? (
              fusionRateLines.map((line) => (
                <Tag key={line} color="default">{line}</Tag>
              ))
            ) : (
              <span className="partner-meta">先选择任意一个素材伙伴后，可查看该品级的归契概率。</span>
            )}
          </div>
        </div>

        {fusionPanelView.kind === 'pending' ? (
          <div className="partner-fusion-section partner-fusion-status">
            <div className="partner-section-title">归契进行中</div>
            <div className="partner-meta">灵契正在重铸中，请稍候片刻。任务编号：{fusionPanelView.job.fusionId}</div>
            <div className="partner-meta">素材伙伴：{fusionPanelView.job.materialPartnerIds.length} / 3 已锁定</div>
            <Button loading disabled>
              正在归契中
            </Button>
          </div>
        ) : null}

        {fusionPanelView.kind === 'preview' ? (
          <div className="partner-fusion-section partner-fusion-status">
            <div className="partner-section-title">
              <span>归契结果</span>
              {fusionPanelView.job.resultQuality ? (
                <Tag className={getItemQualityTagClassName(fusionPanelView.job.resultQuality)}>
                  结果品级 {fusionPanelView.job.resultQuality}
                </Tag>
              ) : null}
            </div>
            {renderRecruitPreview(fusionPanelView.preview, { flat: true })}
            <div className="partner-action-row partner-recruit-action-row partner-fusion-result-action-row">
              <Button
                type="primary"
                loading={actionKey === `fusion-confirm-${fusionPanelView.job.fusionId}`}
                onClick={() => {
                  void handleConfirmFusion(fusionPanelView.job.fusionId);
                }}
              >
                确认归契
              </Button>
            </div>
          </div>
        ) : null}

        {fusionPanelView.kind === 'failed' ? (
          <div className="partner-fusion-section partner-fusion-status">
            <div className="partner-section-title">归契结果</div>
            <div className="partner-meta">{fusionPanelView.errorMessage}</div>
            <div className="partner-meta">失败后素材伙伴会自动解除占用，可重新选择发起新的三魂归契。</div>
          </div>
        ) : null}

        {fusionPanelView.kind !== 'pending' && fusionPanelView.kind !== 'preview' ? (
          <div className="partner-fusion-section">
            <div className="partner-section-title">
              <span>素材选择</span>
            </div>
            {groupedPartners.length > 0 ? (
              <div className="partner-fusion-quality-groups">
                {groupedPartners.map((group) => (
                  <div key={group.quality} className="partner-fusion-quality-group">
                    <div className="partner-fusion-quality-head">
                      <Tag className={getItemQualityTagClassName(group.quality)}>{group.quality}</Tag>
                      <span className="partner-meta">可作为归契素材的伙伴</span>
                    </div>
                    <div className="partner-fusion-material-grid">
                      {group.partners.map((partner) => {
                        const isSelected = selectedFusionMaterialIds.includes(partner.id);
                        const disabledReason = isSelected
                          ? null
                          : resolvePartnerFusionMaterialDisabledReason(
                            partner,
                            fusionSelectedQuality,
                            selectedFusionMaterialIds.length,
                          );
                        const shouldShowDisabledReason = disabledReason
                          && !isSelected
                          && disabledReason !== '出战中'
                          && disabledReason !== '坊市中'
                          && disabledReason !== '归契中';
                        return (
                          <button
                            key={partner.id}
                            type="button"
                            className={`partner-fusion-material-card${isSelected ? ' is-selected' : ''}${disabledReason ? ' is-disabled' : ''}`}
                            disabled={Boolean(disabledReason) && !isSelected}
                            onClick={() => handleToggleFusionMaterial(partner.id)}
                          >
                            <img
                              className="partner-fusion-material-avatar"
                              src={resolvePartnerAvatar(partner.avatar)}
                              alt={partner.name}
                            />
                            <div className="partner-fusion-material-main">
                              <div className="partner-fusion-material-name">{getPartnerDisplayName(partner)}</div>
                              <div className="partner-fusion-material-meta">
                                {formatPartnerLevelSummary(partner)} · {partner.role}
                              </div>
                              <div className="partner-tag-row">
                                <Tag className={getItemQualityTagClassName(partner.quality)}>{partner.quality}</Tag>
                                <Tag className={getElementToneClassName(partner.element)}>
                                  {formatPartnerElementLabel(partner.element)}
                                </Tag>
                                {partner.fusionStatus === 'fusion_locked' ? <Tag color="magenta">归契中</Tag> : null}
                                {shouldShowDisabledReason ? <Tag color="default">{disabledReason}</Tag> : null}
                                {isSelected ? <Tag color="blue">已选中</Tag> : null}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="partner-empty">当前暂无可参与三魂归契的伙伴</div>
            )}
          </div>
        ) : null}

        {fusionPanelView.kind !== 'pending' && fusionPanelView.kind !== 'preview' ? (
          <>
            <div className="partner-action-row partner-recruit-action-row">
              <Button
                type="primary"
                loading={actionKey === 'fusion-start'}
                disabled={!canStartFusion}
                onClick={() => {
                  void handleStartFusion();
                }}
              >
                开始归契
              </Button>
            </div>
            {!canStartFusion ? (
              <div className="partner-meta">
                请选择 3 个同品级且未出战、未上架、未归契中的伙伴。
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    );
  };

  const renderSkillPolicyPanel = () => {
    if (!selectedPartner) return <div className="partner-empty">暂无伙伴数据</div>;

    const { enabledEntries, disabledEntries } = groupPartnerSkillPolicyEntries(skillPolicyDraftEntries);
    const renderSkillPolicyIconButton = (
      key: string,
      title: string,
      icon: React.ReactNode,
      onClick: () => void,
      disabled: boolean,
      danger = false,
    ) => {
      return (
        <Tooltip key={key} title={title} open={draggingSkillId ? false : undefined}>
          <span className="partner-skill-policy-action-wrap">
            <Button
              type="text"
              danger={danger}
              aria-label={title}
              icon={icon}
              disabled={disabled}
              className="partner-skill-policy-action-btn"
              onClick={onClick}
            />
          </span>
        </Tooltip>
      );
    };

    const renderSkillPolicyGroup = (
      title: string,
      entries: PartnerSkillPolicyEntryDto[],
      allowMove: boolean,
    ) => {
      return (
        <div className="partner-skill-policy-group">
          <div className="partner-section-title">{title}</div>
          {entries.length > 0 ? (
            <div className="partner-skill-policy-list">
              {entries.map((entry, index) => (
                <div
                  key={entry.skillId}
                  className={`partner-skill-policy-item${entry.enabled ? '' : ' is-disabled'}${allowMove && !selectedPartnerActionLocked && !isMobile ? ' is-sortable' : ''}${draggingSkillId === entry.skillId ? ' is-dragging' : ''}${dragOverSkillId === entry.skillId ? ' is-drag-over' : ''}`}
                  draggable={allowMove && !selectedPartnerActionLocked && !isMobile}
                  onDragStart={(event) => handleSkillPolicyDragStart(event, entry.skillId)}
                  onDragOver={(event) => handleSkillPolicyDragOver(event, entry.skillId)}
                  onDrop={(event) => handleSkillPolicyDrop(event, entry.skillId)}
                  onDragEnd={clearSkillPolicyDragState}
                >
                  {entry.enabled ? (
                    <span className="partner-skill-policy-priority-badge">
                      {index + 1}
                    </span>
                  ) : null}
                  <div className="partner-skill-policy-main">
                    <Tooltip
                      title={renderSkillTooltip({
                        id: entry.skillId,
                        name: entry.skillName,
                        icon: entry.skillIcon,
                        description: entry.skillDescription,
                        cost_lingqi: entry.cost_lingqi,
                        cost_lingqi_rate: entry.cost_lingqi_rate,
                        cost_qixue: entry.cost_qixue,
                        cost_qixue_rate: entry.cost_qixue_rate,
                        cooldown: entry.cooldown,
                        target_type: entry.target_type,
                        target_count: entry.target_count,
                        damage_type: entry.damage_type,
                        element: entry.element,
                        effects: entry.effects,
                      })}
                      placement="top"
                      classNames={PARTNER_SKILL_TOOLTIP_CLASS_NAMES}
                      open={draggingSkillId ? false : undefined}
                    >
                      <div className="partner-skill-policy-head">
                        <div className="partner-skill-policy-icon-wrap">
                          <img
                            className="partner-technique-icon"
                            src={resolvePartnerAvatar(entry.skillIcon)}
                            alt={entry.skillName}
                          />
                        </div>
                        <div className="partner-card-main">
                          <div className="partner-technique-name">{entry.skillName}</div>
                          {!entry.enabled ? (
                            <div className="partner-skill-policy-status">
                              <Tag color="default">已禁用</Tag>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </Tooltip>
                  </div>
                  <div className="partner-skill-policy-actions">
                    {allowMove ? (
                      <>
                        {renderSkillPolicyIconButton(
                          `${entry.skillId}-up`,
                          '上移',
                          <ArrowUpOutlined />,
                          () => handleMoveSkillPolicyEntry(entry.skillId, 'up'),
                          selectedPartnerActionLocked || index <= 0,
                        )}
                        {renderSkillPolicyIconButton(
                          `${entry.skillId}-down`,
                          '下移',
                          <ArrowDownOutlined />,
                          () => handleMoveSkillPolicyEntry(entry.skillId, 'down'),
                          selectedPartnerActionLocked || index >= entries.length - 1,
                        )}
                      </>
                    ) : null}
                    {renderSkillPolicyIconButton(
                      `${entry.skillId}-toggle`,
                      entry.enabled ? '禁用自动释放' : '重新启用',
                      entry.enabled ? <StopOutlined /> : <CheckCircleOutlined />,
                      () => handleToggleSkillPolicy(entry.skillId),
                      selectedPartnerActionLocked,
                      entry.enabled,
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="partner-empty-text">当前分组暂无技能</div>
          )}
        </div>
      );
    };

    return (
      <div className="partner-pane-card">
        {renderPartnerSummaryCard('partner-inline-summary')}
        <div className="partner-section-title">技能策略</div>
        <div className="partner-skill-policy-note">
          以下顺序会影响伙伴在所有战斗中的自动施法尝试顺序，越靠前越优先；关闭后该技能不会自动释放。
        </div>
        {skillPolicyLoading ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <div className="partner-skill-policy-layout">
            {renderSkillPolicyGroup('启用中', enabledEntries, true)}
            {renderSkillPolicyGroup('已禁用', disabledEntries, false)}
          </div>
        )}
        <div className="partner-action-row partner-skill-policy-save-row">
          <Button
            type="primary"
            className="partner-skill-policy-save-btn"
            loading={actionKey === `skill-policy-${selectedPartner.id}`}
            disabled={!skillPolicyChanged || skillPolicyLoading || selectedPartnerActionLocked}
            onClick={() => {
              void handleSaveSkillPolicy();
            }}
          >
            保存策略
          </Button>
        </div>
      </div>
    );
  };

  const renderBody = () => {
    const panelOptions = PARTNER_PANEL_OPTIONS;
    const renderPanelMenuLabel = (item: { value: PartnerPanelKey; label: string }) => {
      return (
        <span className="partner-menu-label">
          {item.label}
          {(item.value === 'recruit' && recruitIndicator.badgeDot) || (item.value === 'fusion' && fusionIndicator.badgeDot) ? (
            <span className="partner-menu-dot" />
          ) : null}
        </span>
      );
    };
    const mobilePanelOptions = panelOptions.map((item) => ({
      value: item.value,
      label: renderPanelMenuLabel(item),
    }));
    const panelContent = (() => {
      if (panel === 'partners') return renderPartnerListPanel();
      if (panel === 'overview') return renderOverviewPanel();
      if (panel === 'upgrade') return renderUpgradePanel();
      if (panel === 'technique') return renderTechniquePanel();
      if (panel === 'skill_policy') return renderSkillPolicyPanel();
      if (panel === 'fusion') return renderFusionPanel();
      return renderRecruitPanel();
    })();

    return (
      <div className="partner-modal-shell">
        <div className="partner-modal-left">
          <div className="partner-left-title">
            <img className="partner-left-icon" src={partnerIcon} alt="伙伴" />
            <div className="partner-left-name">伙伴</div>
          </div>
          {isMobile ? (
            <div className="partner-left-segmented-wrap">
              <Segmented
                className="partner-left-segmented"
                value={panel}
                options={mobilePanelOptions}
                onChange={(value) => {
                  if (typeof value !== 'string') return;
                  if (!panelOptions.some((item) => item.value === value)) return;
                  setPanel(value as PartnerPanelKey);
                }}
              />
            </div>
          ) : (
            <div className="partner-left-list">
              {panelOptions.map((item) => (
                <Button
                  key={item.value}
                  type={panel === item.value ? 'primary' : 'default'}
                  className="partner-left-item"
                  onClick={() => setPanel(item.value)}
                >
                  {renderPanelMenuLabel(item)}
                </Button>
              ))}
            </div>
          )}
        </div>

        <div className="partner-modal-right">
          {panelContent}
        </div>
      </div>
    );
  };

  const techniqueDetailModalNode = (
    <Modal
      open={techniqueDetailOpen}
      onCancel={closeTechniqueDetail}
      footer={null}
      title="功法详情"
      centered
      width="min(720px, calc(100vw - 16px))"
      className="tech-submodal tech-detail-submodal"
      destroyOnHidden
    >
      {techniqueDetailLoading ? (
        <Skeleton active paragraph={{ rows: isMobile ? 6 : 8 }} />
      ) : (
        <TechniqueDetailPanel detail={techniqueDetail} isMobile={isMobile} />
      )}
    </Modal>
  );

  if (isMobile) {
    return (
      <>
        <Drawer
          open={open}
          onClose={onClose}
          placement="bottom"
          closeIcon={null}
          title={null}
          destroyOnHidden
          className="partner-modal"
          rootClassName="partner-modal-wrap"
          styles={{ wrapper: { height: 'auto', maxHeight: 'calc(100dvh - 96px)' }, body: { padding: 0 } }}
        >
          {renderBody()}
        </Drawer>
        {techniqueDetailModalNode}
        {renameModalNode}
        {renderTechniqueLearnPreviewModal()}
      </>
    );
  }

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        footer={null}
        title={null}
        centered
        width="min(900px, calc(100vw - 16px))"
        className="partner-modal"
        wrapClassName="partner-modal-wrap"
        destroyOnHidden
        maskClosable
      >
        {renderBody()}
      </Modal>
      {techniqueDetailModalNode}
      {renameModalNode}
      {renderTechniqueLearnPreviewModal()}
    </>
  );
};

export default PartnerModal;
