import { App, Button, Drawer, Empty, InputNumber, Modal, Progress, Skeleton, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  activatePartner,
  getPartnerOverview,
  getPartnerTechniqueUpgradeCost,
  injectPartnerExp,
  learnPartnerTechnique,
  type PartnerBookDto,
  type PartnerDetailDto,
  type PartnerOverviewDto,
  type PartnerTechniqueDto,
  type PartnerTechniqueUpgradeCostDto,
  upgradePartnerTechnique,
} from '../../../../services/api';
import { gameSocket } from '../../../../services/gameSocket';
import { getUnifiedApiErrorMessage } from '../../../../services/api';
import { DEFAULT_ICON as partnerIcon } from '../../shared/resolveIcon';
import { useIsMobile } from '../../shared/responsive';
import { getSkillCardSections } from '../TechniqueModal/skillDetailShared';
import {
  formatPartnerElementLabel,
  formatPartnerAttrValue,
  formatPartnerTechniqueLayerLabel,
  formatPartnerTechniqueSkillToggleLabel,
  formatPartnerTechniqueUpgradeCostLines,
  formatPartnerLearnResult,
  formatPartnerObtainedFromLabel,
  formatPartnerTechniquePassiveLines,
  getPartnerAttrLabel,
  getPartnerEmptySlotCount,
  getPartnerVisibleCombatAttrs,
  PARTNER_PANEL_OPTIONS,
  resolvePartnerAvatar,
  resolvePartnerBookLabel,
  type PartnerPanelKey,
} from './partnerShared';
import './index.scss';

interface PartnerModalProps {
  open: boolean;
  onClose: () => void;
}

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
 * - 输出：伙伴系统完整交互 UI；写操作后通过 socket 刷新角色，并触发 `inventory:changed` 事件同步其他模块。
 *
 * 数据流/状态流：
 * open -> getPartnerOverview -> 选中伙伴 -> 激活/灌注/学习/升层 -> refreshOverview -> UI 更新。
 *
 * 关键边界条件与坑点：
 * 1. 伙伴列表和功法书列表都依赖总览接口，写操作后必须统一刷新，不能分别手动拼局部状态。
 * 2. 当前选择的伙伴在刷新后可能失效，需要在 overview 更新时自动校正到出战伙伴或首个伙伴。
 */
const PartnerModal: React.FC<PartnerModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(false);
  const [actionKey, setActionKey] = useState('');
  const [panel, setPanel] = useState<PartnerPanelKey>('overview');
  const [overview, setOverview] = useState<PartnerOverviewDto | null>(null);
  const [selectedPartnerId, setSelectedPartnerId] = useState<number | null>(null);
  const [injectExpValue, setInjectExpValue] = useState<number | null>(null);
  const [techniqueResultText, setTechniqueResultText] = useState('');
  const [techniqueUpgradeCosts, setTechniqueUpgradeCosts] = useState<Record<string, PartnerTechniqueUpgradeCostDto | null>>({});
  const [expandedTechniqueSkills, setExpandedTechniqueSkills] = useState<Record<string, boolean>>({});

  const refreshOverview = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const res = await getPartnerOverview();
      if (!res.success || !res.data) {
        throw new Error(getUnifiedApiErrorMessage(res, '获取伙伴信息失败'));
      }
      setOverview(res.data);
    } catch (error) {
      setOverview(null);
      message.error(getUnifiedApiErrorMessage(error as { message?: string }, '获取伙伴信息失败'));
    } finally {
      setLoading(false);
    }
  }, [message, open]);

  useEffect(() => {
    if (!open) {
      setPanel('overview');
      setOverview(null);
      setSelectedPartnerId(null);
      setInjectExpValue(null);
      setTechniqueResultText('');
      setTechniqueUpgradeCosts({});
      setExpandedTechniqueSkills({});
      setActionKey('');
      return;
    }
    void refreshOverview();
  }, [open, refreshOverview]);

  useEffect(() => {
    if (!overview) {
      setSelectedPartnerId(null);
      return;
    }
    const partnerIds = overview.partners.map((partner) => partner.id);
    if (selectedPartnerId && partnerIds.includes(selectedPartnerId)) return;
    const nextSelectedPartnerId = overview.activePartnerId ?? overview.partners[0]?.id ?? null;
    setSelectedPartnerId(nextSelectedPartnerId);
  }, [overview, selectedPartnerId]);

  useEffect(() => {
    setTechniqueResultText('');
    setTechniqueUpgradeCosts({});
    setExpandedTechniqueSkills({});
  }, [selectedPartnerId]);

  const selectedPartner = useMemo<PartnerDetailDto | null>(() => {
    if (!overview || selectedPartnerId === null) return null;
    return overview.partners.find((partner) => partner.id === selectedPartnerId) ?? null;
  }, [overview, selectedPartnerId]);

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
      } catch (error) {
        if (cancelled) return;
        setTechniqueUpgradeCosts({});
        message.error(getUnifiedApiErrorMessage(error as { message?: string }, '读取功法升层消耗失败'));
      }
    };

    void loadUpgradeCosts();
    return () => {
      cancelled = true;
    };
  }, [message, open, panel, selectedPartner]);

  const handleActivate = useCallback(async (partnerId: number) => {
    setActionKey(`activate-${partnerId}`);
    try {
      const res = await activatePartner(partnerId);
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '切换出战失败'));
      message.success(res.message || '已切换出战伙伴');
      await refreshOverview();
      gameSocket.refreshCharacter();
    } catch (error) {
      message.error(getUnifiedApiErrorMessage(error as { message?: string }, '切换出战失败'));
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
      gameSocket.refreshCharacter();
    } catch (error) {
      message.error(getUnifiedApiErrorMessage(error as { message?: string }, '灌注失败'));
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
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error) {
      message.error(getUnifiedApiErrorMessage(error as { message?: string }, '学习失败'));
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
      gameSocket.refreshCharacter();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error) {
      message.error(getUnifiedApiErrorMessage(error as { message?: string }, '升层失败'));
    } finally {
      setActionKey('');
    }
  }, [message, refreshOverview, selectedPartner]);

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
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                setSelectedPartnerId(partner.id);
              }}
            >
              <img className="partner-list-thumb" src={resolvePartnerAvatar(partner.avatar)} alt={partner.name} />
              <div className="partner-list-main">
                <div className="partner-list-name">{partner.nickname || partner.name}</div>
                <div className="partner-list-desc">
                  等级 {partner.level} · {formatPartnerElementLabel(partner.element)} · {partner.role}
                </div>
                <div className="partner-tag-row">
                  <Tag color={partner.isActive ? 'green' : 'default'}>{partner.isActive ? '已出战' : '待命中'}</Tag>
                  <Tag color="gold">{partner.quality}</Tag>
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
              <Tag color="gold">{selectedPartner.quality}</Tag>
            </div>
            <div className="partner-meta">
              模板：{selectedPartner.name} · 来源：{formatPartnerObtainedFromLabel(selectedPartner.obtainedFrom)}
            </div>
            <div className="partner-role-line">
              {formatPartnerElementLabel(selectedPartner.element)} · {selectedPartner.role} · 功法槽 {selectedPartner.slotCount}
            </div>
          </div>
        </div>
        {!selectedPartner.isActive ? (
          <div className="partner-action-row">
            <Button
              type="primary"
              loading={actionKey === `activate-${selectedPartner.id}`}
              onClick={() => {
                void handleActivate(selectedPartner.id);
              }}
            >
              设为出战
            </Button>
          </div>
        ) : null}
      </div>
    );
  };

  const renderOverviewPanel = () => {
    if (!selectedPartner) return <div className="partner-empty">暂无伙伴数据</div>;
    const combatAttrs = getPartnerVisibleCombatAttrs(selectedPartner.computedAttrs);

    return (
      <div className="partner-pane-card">
        {renderPartnerSummaryCard('partner-inline-summary')}
        <div className="partner-section-title">当前战斗属性</div>
        <div className="partner-combat-grid">
          {combatAttrs.map((entry) => (
            <div key={entry.key} className="partner-stat-item">
              <div className="partner-stat-label">{getPartnerAttrLabel(entry.key)}</div>
              <div className="partner-stat-value">{formatPartnerAttrValue(entry.key, entry.value)}</div>
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
              disabled={characterExp <= 0}
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
                    <Tag color="gold">{technique.quality}</Tag>
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
                                      sections.summaryItems.slice(0, 2).map((item, index) => (
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
                        disabled={!upgradeCost}
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
                    <Tag color="gold">{book.quality}</Tag>
                    <Tag color="blue">功法书</Tag>
                  </div>
                </div>
                <div className="partner-card-footer">
                  <Button
                    type="primary"
                    loading={actionKey === `learn-${book.itemInstanceId}`}
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

  const renderBody = () => {
    const panelContent = (() => {
      if (panel === 'partners') return renderPartnerListPanel();
      if (panel === 'overview') return renderOverviewPanel();
      if (panel === 'upgrade') return renderUpgradePanel();
      return renderTechniquePanel();
    })();

    return (
      <div className="partner-modal-shell">
        <div className="partner-modal-left">
          <div className="partner-left-title">
            <img className="partner-left-icon" src={partnerIcon} alt="伙伴" />
            <div className="partner-left-name">伙伴</div>
          </div>
          {isMobile ? (
            <div className="partner-mobile-menu">
              {PARTNER_PANEL_OPTIONS.map((item) => (
                <Button
                  key={item.value}
                  type={panel === item.value ? 'primary' : 'default'}
                  className="partner-left-item partner-mobile-menu-item"
                  onClick={() => setPanel(item.value)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          ) : (
            <div className="partner-left-list">
              {PARTNER_PANEL_OPTIONS.map((item) => (
                <Button
                  key={item.value}
                  type={panel === item.value ? 'primary' : 'default'}
                  className="partner-left-item"
                  onClick={() => setPanel(item.value)}
                >
                  {item.label}
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
    );
  }

  return (
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
  );
};

export default PartnerModal;
