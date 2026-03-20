import { ArrowDownOutlined, ArrowUpOutlined, CheckCircleOutlined, StopOutlined } from '@ant-design/icons';
import { App, Button, Drawer, Empty, Input, InputNumber, Modal, Progress, Segmented, Skeleton, Switch, Tag, Tooltip } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  activatePartner,
  confirmPartnerFusionPreview,
  confirmPartnerRecruitDraft,
  dismissPartner,
  discardPartnerRecruitDraft,
  generatePartnerRecruitDraft,
  getPartnerFusionStatus,
  getPartnerOverview,
  getPartnerRecruitStatus,
  getPartnerSkillPolicy,
  getPartnerTechniqueUpgradeCost,
  injectPartnerExp,
  learnPartnerTechnique,
  markPartnerFusionResultViewed,
  markPartnerRecruitResultViewed,
  startPartnerFusion,
  type PartnerBookDto,
  type PartnerDetailDto,
  type PartnerFusionStatusDto,
  type PartnerOverviewDto,
  type PartnerRecruitPreviewDto,
  type PartnerRecruitStatusDto,
  type PartnerSkillPolicyDto,
  type PartnerSkillPolicyEntryDto,
  type PartnerTechniqueDto,
  type PartnerTechniqueUpgradeCostDto,
  updatePartnerSkillPolicy,
  upgradePartnerTechnique,
} from '../../../../services/api';
import { gameSocket } from '../../../../services/gameSocket';
import { getUnifiedApiErrorMessage } from '../../../../services/api';
import { DEFAULT_ICON as partnerIcon } from '../../shared/resolveIcon';
import { dispatchPartnerChangedEvent, PARTNER_CHANGED_EVENT } from '../../shared/partnerTradeEvents';
import { useIsMobile } from '../../shared/responsive';
import { getSkillCardSections, renderSkillTooltip } from '../TechniqueModal/skillDetailShared';
import {
  buildPartnerCombatAttrRows,
  buildPartnerSkillPolicySlots,
  formatPartnerElementLabel,
  formatPartnerAttrValue,
  formatPartnerTechniqueLayerLabel,
  formatPartnerTechniqueSkillToggleLabel,
  formatPartnerTechniqueUpgradeCostLines,
  formatPartnerLearnResult,
  formatPartnerTechniquePassiveLines,
  getPartnerAttrLabel,
  getPartnerEmptySlotCount,
  getPartnerVisibleBaseAttrs,
  groupPartnerSkillPolicyEntries,
  movePartnerSkillPolicyEntry,
  PARTNER_PANEL_OPTIONS,
  reorderPartnerSkillPolicyEntry,
  resolvePartnerActionLabel,
  resolvePartnerAvatar,
  resolvePartnerBookLabel,
  resolvePartnerNextSelectedId,
  togglePartnerSkillPolicyEntry,
  type PartnerPanelKey,
} from './partnerShared';
import { getElementTextClassName, getElementToneClassName } from '../../shared/elementTheme';
import { getItemQualityTagClassName } from '../../shared/itemQuality';
import {
  buildPartnerRecruitIndicator,
  hasPartnerRecruitCustomBaseModelToken,
  resolvePartnerRecruitCooldownDisplay,
  resolvePartnerRecruitActionState,
  resolvePartnerRecruitPanelView,
  resolvePartnerRecruitSubmitState,
} from './partnerRecruitShared';
import {
  buildPartnerFusionIndicator,
  groupPartnersByFusionQuality,
  resolvePartnerFusionMaterialDisabledReason,
  resolvePartnerFusionPanelView,
  resolvePartnerFusionRateLines,
  resolvePartnerFusionSelectedQuality,
  togglePartnerFusionMaterialSelection,
} from './partnerFusionShared';
import './index.scss';

interface PartnerModalProps {
  open: boolean;
  onClose: () => void;
}

type RecruitStatusRefreshMode = 'initial' | 'background';

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
const PartnerModal: React.FC<PartnerModalProps> = ({ open, onClose }) => {
  const { message, modal } = App.useApp();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(false);
  const [actionKey, setActionKey] = useState('');
  const [panel, setPanel] = useState<PartnerPanelKey>('overview');
  const [overview, setOverview] = useState<PartnerOverviewDto | null>(null);
  const [recruitStatus, setRecruitStatus] = useState<PartnerRecruitStatusDto | null>(null);
  const [fusionStatus, setFusionStatus] = useState<PartnerFusionStatusDto | null>(null);
  const [skillPolicy, setSkillPolicy] = useState<PartnerSkillPolicyDto | null>(null);
  const [skillPolicyDraftEntries, setSkillPolicyDraftEntries] = useState<PartnerSkillPolicyEntryDto[]>([]);
  const [skillPolicyLoading, setSkillPolicyLoading] = useState(false);
  const [selectedPartnerId, setSelectedPartnerId] = useState<number | null>(null);
  const [draggingSkillId, setDraggingSkillId] = useState<string | null>(null);
  const [dragOverSkillId, setDragOverSkillId] = useState<string | null>(null);
  const [injectExpValue, setInjectExpValue] = useState<number | null>(null);
  const [techniqueResultText, setTechniqueResultText] = useState('');
  const [customBaseModelEnabled, setCustomBaseModelEnabled] = useState(false);
  const [recruitBaseModelInput, setRecruitBaseModelInput] = useState('');
  const [selectedFusionMaterialIds, setSelectedFusionMaterialIds] = useState<number[]>([]);
  const [techniqueUpgradeCosts, setTechniqueUpgradeCosts] = useState<Record<string, PartnerTechniqueUpgradeCostDto | null>>({});
  const [expandedTechniqueSkills, setExpandedTechniqueSkills] = useState<Record<string, boolean>>({});
  const markingRecruitViewedRef = useRef(false);
  const markingFusionViewedRef = useRef(false);

  const applyRecruitStatus = useCallback((status: PartnerRecruitStatusDto | null) => {
    setRecruitStatus(status);
  }, []);

  const applyFusionStatus = useCallback((status: PartnerFusionStatusDto | null) => {
    setFusionStatus(status);
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

  useEffect(() => {
    if (!open) {
      setPanel('overview');
      setOverview(null);
      setRecruitStatus(null);
      setFusionStatus(null);
      setSkillPolicy(null);
      setSkillPolicyDraftEntries([]);
      setSkillPolicyLoading(false);
      setSelectedPartnerId(null);
      setDraggingSkillId(null);
      setDragOverSkillId(null);
      setInjectExpValue(null);
      setTechniqueResultText('');
      setCustomBaseModelEnabled(false);
      setRecruitBaseModelInput('');
      setSelectedFusionMaterialIds([]);
      setTechniqueUpgradeCosts({});
      setExpandedTechniqueSkills({});
      setActionKey('');
      return;
    }
    void Promise.all([
      refreshOverview(),
      refreshRecruitStatus('initial'),
      refreshFusionStatus('initial'),
    ]);
  }, [open, refreshFusionStatus, refreshOverview, refreshRecruitStatus]);

  useEffect(() => {
    setSelectedPartnerId(resolvePartnerNextSelectedId(overview, selectedPartnerId));
  }, [overview, selectedPartnerId]);

  useEffect(() => {
    setSelectedFusionMaterialIds((currentIds) => currentIds.filter((partnerId) =>
      overview?.partners.some((partner) => partner.id === partnerId) ?? false));
  }, [overview]);

  useEffect(() => {
    setTechniqueResultText('');
    setTechniqueUpgradeCosts({});
    setExpandedTechniqueSkills({});
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
    () => resolvePartnerRecruitActionState(recruitStatus, customBaseModelEnabled),
    [customBaseModelEnabled, recruitStatus],
  );
  const recruitSubmitState = useMemo(
    () => resolvePartnerRecruitSubmitState(recruitStatus, customBaseModelEnabled),
    [customBaseModelEnabled, recruitStatus],
  );
  const recruitCooldownDisplay = useMemo(
    () => resolvePartnerRecruitCooldownDisplay(recruitStatus, customBaseModelEnabled),
    [customBaseModelEnabled, recruitStatus],
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
  const fusionRateLines = useMemo(
    () => (fusionSelectedQuality ? resolvePartnerFusionRateLines(fusionSelectedQuality) : []),
    [fusionSelectedQuality],
  );

  useEffect(() => {
    if (!hasCustomBaseModelToken && customBaseModelEnabled) {
      setCustomBaseModelEnabled(false);
    }
  }, [customBaseModelEnabled, hasCustomBaseModelToken]);

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
    const unsubscribe = gameSocket.onPartnerRecruitResult((payload) => {
      const currentCharacterId = gameSocket.getCharacter()?.id ?? null;
      if (!currentCharacterId || payload.characterId !== currentCharacterId) return;
      if (payload.status === 'generated_draft') {
        message.success(payload.message);
      } else {
        message.warning(payload.errorMessage || payload.message);
      }
    });
    const unsubscribeFusion = gameSocket.onPartnerFusionResult((payload) => {
      const currentCharacterId = gameSocket.getCharacter()?.id ?? null;
      if (!currentCharacterId || payload.characterId !== currentCharacterId) return;
      if (payload.status === 'generated_preview') {
        message.success(payload.message);
      } else {
        message.warning(payload.errorMessage || payload.message);
      }
    });
    return () => {
      unsubscribeStatus();
      unsubscribeFusionStatus();
      unsubscribe();
      unsubscribeFusion();
    };
  }, [applyFusionStatus, applyRecruitStatus, message, open]);

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

  const handleLearnTechnique = useCallback(async (book: PartnerBookDto) => {
    if (!selectedPartner) return;
    setActionKey(`learn-${book.itemInstanceId}`);
    try {
      const res = await learnPartnerTechnique(selectedPartner.id, book.itemInstanceId);
      if (!res.success || !res.data) throw new Error(getUnifiedApiErrorMessage(res, '学习失败'));
      message.success(res.message || '学习成功');
      setTechniqueResultText(formatPartnerLearnResult(res.data.learnedTechnique, res.data.replacedTechnique));
      await refreshOverview();
      dispatchPartnerChangedEvent();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch {
      void 0;
    } finally {
      setActionKey('');
    }
  }, [message, refreshOverview, selectedPartner]);

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
        customBaseModelEnabled,
        requestedBaseModel: customBaseModelEnabled ? recruitBaseModelInputTrimmed || undefined : undefined,
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
  }, [canSubmitRecruit, customBaseModelEnabled, message, recruitBaseModelInputTrimmed, refreshRecruitStatus]);

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

  const toggleTechniqueSkills = useCallback((techniqueId: string) => {
    setExpandedTechniqueSkills((current) => ({
      ...current,
      [techniqueId]: !current[techniqueId],
    }));
  }, []);

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
        <div className="partner-list">
          {overview.partners.map((partner) => (
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
                  <div className="partner-list-name">{partner.nickname || partner.name}</div>
                  <div className="partner-list-desc">
                    等级 {partner.level} · <span className={getElementTextClassName(partner.element)}>{formatPartnerElementLabel(partner.element)}</span> · {partner.role}
                  </div>
                  <div className="partner-tag-row">
                    <Tag color={partner.isActive ? 'green' : 'default'}>{partner.isActive ? '已出战' : '待命中'}</Tag>
                    <Tag className={getItemQualityTagClassName(partner.quality)}>{partner.quality}</Tag>
                    {partner.tradeStatus === 'market_listed' ? <Tag color="orange">坊市中</Tag> : null}
                    {partner.fusionStatus === 'fusion_locked' ? <Tag color="magenta">归契中</Tag> : null}
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
            <div className="partner-name">{selectedPartner.nickname || selectedPartner.name}</div>
            <div className="partner-tag-row">
              <Tag color={selectedPartner.isActive ? 'green' : 'default'}>{selectedPartner.isActive ? '当前出战' : '未出战'}</Tag>
              <Tag color="blue">等级 {selectedPartner.level}</Tag>
              <Tag className={getItemQualityTagClassName(selectedPartner.quality)}>{selectedPartner.quality}</Tag>
              {selectedPartner.tradeStatus === 'market_listed' ? <Tag color="orange">坊市中</Tag> : null}
              {selectedPartner.fusionStatus === 'fusion_locked' ? <Tag color="magenta">归契中</Tag> : null}
            </div>
            <div className="partner-tag-row">
              <Tag className={getElementToneClassName(selectedPartner.element)}>{formatPartnerElementLabel(selectedPartner.element)}</Tag>
              <Tag color="cyan">{selectedPartner.role}</Tag>
              <Tag color="purple">功法槽 {selectedPartner.slotCount}</Tag>
            </div>
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
        <div className="partner-section-title">当前战斗属性</div>
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
            const hasSkills = technique.skills.length > 0;
            const skillExpanded = expandedTechniqueSkills[technique.techniqueId] ?? false;
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
                  {hasSkills ? (
                    <div className="partner-technique-skill-section">
                      <Button
                        type="text"
                        className="partner-technique-skill-toggle"
                        onClick={() => toggleTechniqueSkills(technique.techniqueId)}
                      >
                        {formatPartnerTechniqueSkillToggleLabel(technique, skillExpanded)}
                      </Button>
                      {skillExpanded ? (
                        <div className="partner-technique-skill-list">
                          {technique.skills.map((skill) => {
                            const sections = getSkillCardSections(skill);
                            const compactMetaItems = [
                              ...sections.metaItems,
                              ...sections.gridItems,
                            ];
                            return (
                              <div key={skill.id} className="partner-technique-skill-item">
                                <img
                                  className="partner-technique-skill-icon"
                                  src={resolvePartnerAvatar(skill.icon)}
                                  alt={skill.name}
                                />
                                <div className="partner-technique-skill-main">
                                  <div className="partner-technique-skill-name">{skill.name}</div>
                                  {compactMetaItems.length > 0 ? (
                                    <div className="partner-technique-skill-meta">
                                      {compactMetaItems.map((item) => (
                                        <span
                                          key={`${skill.id}-${item.label}-${item.value}`}
                                          className="partner-technique-skill-meta-pill"
                                        >
                                          <span className="partner-technique-skill-meta-label">
                                            {item.label}
                                          </span>
                                          <span className="partner-technique-skill-meta-value">
                                            {item.value}
                                          </span>
                                        </span>
                                      ))}
                                    </div>
                                  ) : null}
                                  <div className="partner-technique-skill-summary">
                                    {sections.summaryItems.length > 0 ? (
                                      sections.summaryItems.map((item, index) => (
                                        <div
                                          key={`${skill.id}-${item.label}-${index}`}
                                          className={`partner-technique-skill-summary-line${item.isEffect ? ' is-effect' : ''}`}
                                        >
                                          {item.value}
                                        </div>
                                      ))
                                    ) : (
                                      <div className="partner-technique-skill-summary-line">
                                        暂无详细信息
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        null
                      )}
                    </div>
                  ) : null}
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
    return (
      <div className="partner-pane-card">
        <div className="partner-section-title">
          <span>伙伴招募</span>
          {recruitStatus && shouldShowSpiritStoneCost ? (
            <Tag color="gold">消耗灵石 {recruitStatus.spiritStoneCost.toLocaleString()}</Tag>
          ) : null}
        </div>

        <div className="partner-recruit-meta-grid">
          <div className="partner-recruit-meta-card">
            <div className="partner-stat-label">招募规则</div>
            <div className="partner-meta">每次招募会生成一名专属伙伴预览，确认后才会正式入队。</div>
            {typeof recruitStatus?.customBaseModelMaxLength === 'number' ? (
              <div className="partner-meta">自定义底模默认关闭，勾选启用后需额外消耗高级招募令。</div>
            ) : null}
          </div>
          <div className="partner-recruit-meta-card">
            <div className="partner-stat-label">冷却状态</div>
            <div className="partner-meta">{recruitCooldownDisplay.statusText}</div>
            <div className="partner-meta">{recruitCooldownDisplay.ruleText}</div>
          </div>
        </div>

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
            {renderRecruitPreview(recruitPanelView.preview)}
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

        {recruitPanelView.kind === 'empty' ? (
          <div className="partner-recruit-state-card">
            <div className="partner-section-title">开始招募</div>
            <div className="partner-meta">
              {shouldShowSpiritStoneCost
                ? '消耗灵石后异步生成伙伴形象、属性与天生功法。生成失败会自动退款。'
                : '异步生成伙伴形象、属性与天生功法。'}
            </div>
          </div>
        ) : null}

        {recruitActionState.showGenerateButton && recruitStatus?.unlocked ? (
          <div className="partner-recruit-state-card">
            <div className="partner-section-title">
              <span>自定义底模</span>
              <Switch
                checked={customBaseModelEnabled}
                onChange={setCustomBaseModelEnabled}
                disabled={!hasCustomBaseModelToken}
                checkedChildren="开"
                unCheckedChildren="关"
              />
            </div>
            {!hasCustomBaseModelToken ? (
              <div className="partner-meta">
                {recruitStatus.customBaseModelTokenItemName}不足，当前无法启用自定义底模。
              </div>
            ) : null}
            {customBaseModelEnabled ? (
              <>
                <div className="partner-meta">
                  需消耗 {recruitStatus.customBaseModelTokenItemName} x{recruitStatus.customBaseModelTokenCost}，留空则随机底模。
                </div>
                <Input
                  value={recruitBaseModelInput}
                  onChange={(event) => setRecruitBaseModelInput(event.target.value)}
                  placeholder="留空则随机，例如：狐、龙、雪女"
                  maxLength={recruitStatus.customBaseModelMaxLength}
                  disabled={!recruitActionState.canGenerate}
                />
                <div className="partner-meta">
                  当前输入 {recruitBaseModelInputLength}/{recruitStatus.customBaseModelMaxLength}
                </div>
                {!customBaseModelTokenEnough ? (
                  <div className="partner-meta">
                    {recruitStatus.customBaseModelTokenItemName}不足，当前仅有 {recruitStatus.customBaseModelTokenAvailableQty} 枚。
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {recruitActionState.showGenerateButton ? (
          <>
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
          </>
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
                              <div className="partner-fusion-material-name">{partner.nickname || partner.name}</div>
                              <div className="partner-fusion-material-meta">
                                等级 {partner.level} · {partner.role}
                              </div>
                              <div className="partner-tag-row">
                                <Tag className={getItemQualityTagClassName(partner.quality)}>{partner.quality}</Tag>
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
    </>
  );
};

export default PartnerModal;
