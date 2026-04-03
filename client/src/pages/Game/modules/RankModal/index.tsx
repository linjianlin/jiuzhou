/**
 * 排行榜弹窗。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一承载角色榜单与伙伴榜单展示，复用同一左侧分类入口，避免功能菜单再拆第二个排行弹窗。
 * 2. 做什么：把伙伴榜的“等级 / 战力”维度切换收在榜单头部，保证桌面端与移动端都能在同一入口快速切换。
 * 3. 不做什么：不处理接口缓存、不决定后端排序逻辑，也不负责菜单按钮状态。
 *
 * 输入/输出：
 * - 输入：弹窗开关与关闭回调。
 * - 输出：可直接交给 Game 页面挂载的排行榜弹窗。
 *
 * 数据流/状态流：
 * Game -> RankModal -> rankShared 拉取当前榜单数据 -> 本组件按 tab / metric 渲染表格或移动卡片。
 *
 * 复用设计说明：
 * 1. 原有四类角色榜继续复用既有 Table / 卡片结构，新增伙伴榜只补独有的头像、品质和元素展示，避免整份弹窗重写。
 * 2. 伙伴身份块、等级文案和头部维度切换都收在本文件局部纯函数里，移动端与桌面端共享同一展示规则。
 * 3. 伙伴榜和角色榜仍共用同一左侧分类导航，用户只记一个“排行”入口，不产生风格割裂的新菜单路径。
 *
 * 关键边界条件与坑点：
 * 1. 伙伴榜等级维度只展示真实等级，不能把生效等级拼进文案，否则会和榜单排序口径不一致。
 * 2. 移动端头部空间很紧，伙伴维度切换必须压在榜单头部而不是左侧导航里，否则会出现横向滚动和点击目标过密。
 */
import { Button, Modal, Segmented, Table, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  ArenaRankRowDto,
  MapObjectDto,
  PartnerRankRowDto,
  RealmRankRowDto,
  SectRankRowDto,
  WealthRankRowDto,
} from '../../../../services/api';
import { resolveAvatarUrl } from '../../../../services/api';
import { IMG_COIN as rankIcon, IMG_LINGSHI as lingshiIcon, IMG_TONGQIAN as tongqianIcon } from '../../shared/imageAssets';
import PartnerPreviewOverlay from '../../shared/PartnerPreviewOverlay';
import { getElementToneClassName } from '../../shared/elementTheme';
import { getItemQualityTagClassName } from '../../shared/itemQuality';
import PlayerName from '../../shared/PlayerName';
import { formatPartnerElementLabel, resolvePartnerAvatar } from '../../shared/partnerDisplay';
import { buildPlayerInfoTarget } from '../../shared/playerInfoTarget';
import { useIsMobile } from '../../shared/responsive';
import { usePartnerPreview } from '../../shared/usePartnerPreview';
import {
  PARTNER_RANK_METRIC_KEYS,
  PARTNER_RANK_METRIC_META,
  PARTNER_RANK_METRIC_META_MAP,
  RANK_TAB_KEYS,
  RANK_TAB_META,
  RANK_TAB_META_MAP,
  useRankRows,
  type PartnerRankMetric,
  type RankTab,
} from './rankShared';
import { RankViewportPartnerAvatar, RankViewportPlayerAvatar } from './ViewportAvatar';
import './index.scss';

interface RankModalProps {
  open: boolean;
  onClose: () => void;
  onSelectPlayer?: (target: Extract<MapObjectDto, { type: 'player' }>) => void;
}

const formatPartnerRankLevelText = (row: Pick<PartnerRankRowDto, 'level'>): string => `Lv.${row.level}`;

const renderCurrencyBadge = (icon: string, alt: string, value?: number): ReactNode => (
  <span className="rank-money">
    <img className="rank-money-icon" src={icon} alt={alt} />
    {value === undefined ? null : value.toLocaleString()}
  </span>
);

type CharacterRankRow = RealmRankRowDto | WealthRankRowDto | ArenaRankRowDto;

const RankModal: React.FC<RankModalProps> = ({ open, onClose, onSelectPlayer }) => {
  const [tab, setTab] = useState<RankTab>('realm');
  const [partnerMetric, setPartnerMetric] = useState<PartnerRankMetric>('level');
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  const {
    previewPartner,
    openPartnerPreviewById,
    closePartnerPreview,
  } = usePartnerPreview();
  const {
    rankRowsByTab,
    partnerRankRowsByMetric,
    loadingByTab,
    partnerLoadingByMetric,
  } = useRankRows(open, tab, partnerMetric);

  const realmRanks: RealmRankRowDto[] = rankRowsByTab.realm;
  const sectRanks: SectRankRowDto[] = rankRowsByTab.sect;
  const wealthRanks: WealthRankRowDto[] = rankRowsByTab.wealth;
  const arenaRanks: ArenaRankRowDto[] = rankRowsByTab.arena;
  const partnerRanks: PartnerRankRowDto[] = partnerRankRowsByMetric[partnerMetric];
  const loading = tab === 'partner'
    ? partnerLoadingByMetric[partnerMetric]
    : loadingByTab[tab];

  const leftItems = useMemo(
    () => RANK_TAB_META.map((item) => ({ key: item.key, label: item.label })),
    [],
  );

  const mobileMenuOptions = useMemo(
    () => RANK_TAB_META.map((item) => ({ value: item.key, label: item.shortLabel })),
    [],
  );

  const partnerMetricOptions = useMemo(
    () => PARTNER_RANK_METRIC_META.map((item) => ({ value: item.key, label: item.label })),
    [],
  );

  useEffect(() => {
    if (!open) {
      closePartnerPreview();
    }
  }, [closePartnerPreview, open]);

  const handleOpenPartnerPreview = useCallback((partnerId: number) => {
    void openPartnerPreviewById(partnerId);
  }, [openPartnerPreviewById]);

  const handleOpenPlayerInfo = useCallback((row: CharacterRankRow) => {
    onSelectPlayer?.(buildPlayerInfoTarget({
      id: String(row.characterId),
      name: row.name,
      title: row.title,
      monthCardActive: row.monthCardActive,
      realm: row.realm,
      avatar: row.avatar,
    }));
  }, [onSelectPlayer]);

  const handlePaneBodyRef = useCallback((node: HTMLDivElement | null) => {
    setScrollRoot(node);
  }, []);

  const renderPaneTop = (
    title: string,
    subtitle: string,
    extra?: ReactNode,
  ) => (
    <div className="rank-pane-top">
      <div className="rank-top-row">
        <div className="rank-title">{title}</div>
        {extra}
      </div>
      <div className="rank-subtitle">{subtitle}</div>
    </div>
  );

  const renderPaneBody = (content: ReactNode) => (
    <div ref={handlePaneBodyRef} className="rank-pane-body">
      {content}
    </div>
  );

  const renderPartnerTags = (row: PartnerRankRowDto) => (
    <div className="rank-partner-tags">
      <Tag className={getItemQualityTagClassName(row.quality)}>{row.quality}</Tag>
      <Tag className={getElementToneClassName(row.element)}>{formatPartnerElementLabel(row.element)}</Tag>
      <span className="rank-partner-role">{row.role}</span>
    </div>
  );

  const renderPartnerIdentity = (row: PartnerRankRowDto) => {
    const avatarUrl = resolvePartnerAvatar(row.avatar);

    return (
      <div className="rank-partner-main">
        <RankViewportPartnerAvatar
          className="rank-partner-avatar"
          alt={row.partnerName}
          avatarKey={`partner:${avatarUrl}`}
          scrollRoot={scrollRoot}
          src={avatarUrl}
        />
        <div className="rank-partner-copy">
          <button
            type="button"
            className="rank-partner-name-button"
            onClick={() => handleOpenPartnerPreview(row.partnerId)}
            title={`查看${row.partnerName}详情`}
          >
            {row.partnerName}
          </button>
          {renderPartnerTags(row)}
        </div>
      </div>
    );
  };

  const renderCharacterIdentity = (row: CharacterRankRow, options?: { mobile?: boolean }) => {
    const avatarUrl = resolveAvatarUrl(row.avatar ?? undefined);

    return (
      <div className={`rank-player-main${options?.mobile ? ' rank-player-main--mobile' : ''}`}>
        <RankViewportPlayerAvatar
          avatarKey={`player:${avatarUrl ?? ''}`}
          className="rank-player-avatar"
          scrollRoot={scrollRoot}
          size={options?.mobile ? 40 : 44}
          src={avatarUrl}
        />
        <button
          type="button"
          className="rank-player-name-button"
          onClick={() => handleOpenPlayerInfo(row)}
          title={`查看${row.name}详情`}
        >
          <div className="rank-player-copy">
            <PlayerName
              name={row.name}
              monthCardActive={row.monthCardActive}
              ellipsis
              className={options?.mobile ? 'rank-mobile-name' : 'rank-player-name'}
            />
            {row.title ? <Tag className="rank-player-title-tag">{row.title}</Tag> : null}
          </div>
        </button>
      </div>
    );
  };

  const renderRealmRank = () => (
    <div className="rank-pane">
      {renderPaneTop(
        RANK_TAB_META_MAP.realm.label,
        RANK_TAB_META_MAP.realm.subtitle,
      )}
      {renderPaneBody(isMobile ? (
          <div className="rank-mobile-list">
            {loading ? <div className="rank-empty">加载中...</div> : null}
            {!loading
              ? realmRanks.map((row) => (
                  <div key={row.rank} className="rank-mobile-card">
                    <div className="rank-mobile-card-head">
                      <div className="rank-mobile-rank">#{row.rank}</div>
                      <div className="rank-mobile-player-head">
                        {renderCharacterIdentity(row, { mobile: true })}
                        <Tag color="green">{row.realm}</Tag>
                      </div>
                    </div>
                    <div className="rank-mobile-meta">
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k">战力</span>
                        <span className="rank-mobile-meta-v">{row.power.toLocaleString()}</span>
                      </span>
                    </div>
                  </div>
                ))
              : null}
            {!loading && realmRanks.length === 0 ? <div className="rank-empty">暂无排行</div> : null}
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => String(row.rank)}
            pagination={false}
            loading={loading}
            columns={[
              { title: '名次', dataIndex: 'rank', key: 'rank', width: 80, render: (v: number) => `#${v}` },
              {
                title: '玩家',
                key: 'name',
                width: 260,
                render: (_value: unknown, row: RealmRankRowDto) => (
                  renderCharacterIdentity(row)
                ),
              },
              { title: '境界', dataIndex: 'realm', key: 'realm', width: 120, render: (v: string) => <Tag color="green">{v}</Tag> },
              { title: '战力', dataIndex: 'power', key: 'power', render: (v: number) => v.toLocaleString() },
            ]}
            dataSource={realmRanks}
          />
        )
      )}
    </div>
  );

  const renderSectRank = () => (
    <div className="rank-pane">
      {renderPaneTop(
        RANK_TAB_META_MAP.sect.label,
        RANK_TAB_META_MAP.sect.subtitle,
      )}
      {renderPaneBody(isMobile ? (
          <div className="rank-mobile-list">
            {loading ? <div className="rank-empty">加载中...</div> : null}
            {!loading
              ? sectRanks.map((row) => (
                  <div key={row.rank} className="rank-mobile-card">
                    <div className="rank-mobile-card-head">
                      <div className="rank-mobile-rank">#{row.rank}</div>
                      <div className="rank-mobile-name">{row.name}</div>
                      <Tag color="blue">Lv.{row.level}</Tag>
                    </div>
                    <div className="rank-mobile-meta">
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k">宗主</span>
                        <PlayerName name={row.leader} monthCardActive={row.leaderMonthCardActive} ellipsis className="rank-mobile-meta-v" />
                      </span>
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k">成员</span>
                        <span className="rank-mobile-meta-v">{row.members}/{row.memberCap}</span>
                      </span>
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k">实力</span>
                        <span className="rank-mobile-meta-v">{row.power.toLocaleString()}</span>
                      </span>
                    </div>
                  </div>
                ))
              : null}
            {!loading && sectRanks.length === 0 ? <div className="rank-empty">暂无排行</div> : null}
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => String(row.rank)}
            pagination={false}
            loading={loading}
            columns={[
              { title: '名次', dataIndex: 'rank', key: 'rank', width: 80, render: (v: number) => `#${v}` },
              { title: '宗门', dataIndex: 'name', key: 'name', width: 180 },
              { title: '等级', dataIndex: 'level', key: 'level', width: 90, render: (v: number) => <Tag color="blue">Lv.{v}</Tag> },
              {
                title: '宗主',
                dataIndex: 'leader',
                key: 'leader',
                width: 140,
                render: (value: string, row: SectRankRowDto) => (
                  <PlayerName name={value} monthCardActive={row.leaderMonthCardActive} ellipsis />
                ),
              },
              { title: '成员', key: 'members', width: 120, render: (_value: number, row: SectRankRowDto) => `${row.members}/${row.memberCap}` },
              { title: '实力', dataIndex: 'power', key: 'power', render: (v: number) => v.toLocaleString() },
            ]}
            dataSource={sectRanks}
          />
        )
      )}
    </div>
  );

  const renderWealthRank = () => (
    <div className="rank-pane">
      {renderPaneTop(
        RANK_TAB_META_MAP.wealth.label,
        RANK_TAB_META_MAP.wealth.subtitle,
      )}
      {renderPaneBody(isMobile ? (
          <div className="rank-mobile-list">
            {loading ? <div className="rank-empty">加载中...</div> : null}
            {!loading
              ? wealthRanks.map((row) => (
                  <div key={row.rank} className="rank-mobile-card">
                    <div className="rank-mobile-card-head">
                      <div className="rank-mobile-rank">#{row.rank}</div>
                      <div className="rank-mobile-player-head">
                        {renderCharacterIdentity(row, { mobile: true })}
                        <Tag color="green">{row.realm}</Tag>
                      </div>
                    </div>
                    <div className="rank-mobile-meta">
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k rank-mobile-meta-k--icon">
                          <img className="rank-money-icon" src={lingshiIcon} alt="灵石" />
                        </span>
                        <span className="rank-mobile-meta-v">{row.spiritStones.toLocaleString()}</span>
                      </span>
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k rank-mobile-meta-k--icon">
                          <img className="rank-money-icon" src={tongqianIcon} alt="银两" />
                        </span>
                        <span className="rank-mobile-meta-v">{row.silver.toLocaleString()}</span>
                      </span>
                    </div>
                  </div>
                ))
              : null}
            {!loading && wealthRanks.length === 0 ? <div className="rank-empty">暂无排行</div> : null}
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => String(row.rank)}
            pagination={false}
            loading={loading}
            columns={[
              { title: '名次', dataIndex: 'rank', key: 'rank', width: 80, render: (v: number) => `#${v}` },
              {
                title: '玩家',
                key: 'name',
                width: 260,
                render: (_value: unknown, row: WealthRankRowDto) => (
                  renderCharacterIdentity(row)
                ),
              },
              { title: '境界', dataIndex: 'realm', key: 'realm', width: 120, render: (v: string) => <Tag color="green">{v}</Tag> },
              {
                title: renderCurrencyBadge(lingshiIcon, '灵石'),
                dataIndex: 'spiritStones',
                key: 'spiritStones',
                width: 160,
                render: (v: number) => renderCurrencyBadge(lingshiIcon, '灵石', v),
              },
              {
                title: renderCurrencyBadge(tongqianIcon, '银两'),
                dataIndex: 'silver',
                key: 'silver',
                render: (v: number) => renderCurrencyBadge(tongqianIcon, '银两', v),
              },
            ]}
            dataSource={wealthRanks}
          />
        )
      )}
    </div>
  );

  const renderArenaRank = () => (
    <div className="rank-pane">
      {renderPaneTop(
        RANK_TAB_META_MAP.arena.label,
        RANK_TAB_META_MAP.arena.subtitle,
      )}
      {renderPaneBody(isMobile ? (
          <div className="rank-mobile-list">
            {loading ? <div className="rank-empty">加载中...</div> : null}
            {!loading
              ? arenaRanks.map((row) => (
                  <div key={row.rank} className="rank-mobile-card">
                    <div className="rank-mobile-card-head">
                      <div className="rank-mobile-rank">#{row.rank}</div>
                      <div className="rank-mobile-player-head">
                        {renderCharacterIdentity(row, { mobile: true })}
                        <Tag color="green">{row.realm}</Tag>
                      </div>
                    </div>
                    <div className="rank-mobile-meta">
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k">积分</span>
                        <span className="rank-mobile-meta-v">{row.score}</span>
                      </span>
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k">胜负</span>
                        <span className="rank-mobile-meta-v">{row.winCount}/{row.loseCount}</span>
                      </span>
                    </div>
                  </div>
                ))
              : null}
            {!loading && arenaRanks.length === 0 ? <div className="rank-empty">暂无排行</div> : null}
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => String(row.rank)}
            pagination={false}
            loading={loading}
            columns={[
              { title: '名次', dataIndex: 'rank', key: 'rank', width: 80, render: (v: number) => `#${v}` },
              {
                title: '玩家',
                key: 'name',
                width: 260,
                render: (_value: unknown, row: ArenaRankRowDto) => (
                  renderCharacterIdentity(row)
                ),
              },
              { title: '境界', dataIndex: 'realm', key: 'realm', width: 120, render: (v: string) => <Tag color="green">{v}</Tag> },
              { title: '积分', dataIndex: 'score', key: 'score', width: 120, render: (v: number) => v },
              {
                title: '胜负',
                key: 'wl',
                render: (_value: number, row: ArenaRankRowDto) => `${row.winCount}/${row.loseCount}`,
              },
            ]}
            dataSource={arenaRanks}
          />
        )
      )}
    </div>
  );

  const renderPartnerRank = () => (
    <div className="rank-pane">
      {renderPaneTop(
        RANK_TAB_META_MAP.partner.label,
        PARTNER_RANK_METRIC_META_MAP[partnerMetric].subtitle,
        <Segmented
          className="rank-partner-segmented"
          value={partnerMetric}
          options={partnerMetricOptions}
          onChange={(value) => {
            if (typeof value !== 'string') return;
            if (!PARTNER_RANK_METRIC_KEYS.includes(value as PartnerRankMetric)) return;
            setPartnerMetric(value as PartnerRankMetric);
          }}
        />,
      )}
      {renderPaneBody(isMobile ? (
          <div className="rank-mobile-list">
            {loading ? <div className="rank-empty">加载中...</div> : null}
            {!loading
              ? partnerRanks.map((row) => (
                  <div key={row.partnerId} className="rank-mobile-card">
                    <div className="rank-mobile-card-head rank-mobile-card-head--partner">
                      <div className="rank-mobile-rank">#{row.rank}</div>
                      {renderPartnerIdentity(row)}
                    </div>
                    <div className="rank-mobile-meta">
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k">主人</span>
                        <PlayerName
                          name={row.ownerName}
                          monthCardActive={row.ownerMonthCardActive}
                          ellipsis
                          className="rank-mobile-meta-v"
                        />
                      </span>
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k">等级</span>
                        <span className="rank-mobile-meta-v">{formatPartnerRankLevelText(row)}</span>
                      </span>
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k">战力</span>
                        <span className="rank-mobile-meta-v">{row.power.toLocaleString()}</span>
                      </span>
                    </div>
                  </div>
                ))
              : null}
            {!loading && partnerRanks.length === 0 ? <div className="rank-empty">暂无伙伴排行</div> : null}
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => String(row.partnerId)}
            pagination={false}
            loading={loading}
            columns={[
              { title: '名次', dataIndex: 'rank', key: 'rank', width: 80, render: (v: number) => `#${v}` },
              {
                title: '伙伴',
                key: 'partner',
                width: 280,
                render: (_value: number, row: PartnerRankRowDto) => renderPartnerIdentity(row),
              },
              {
                title: '主人',
                dataIndex: 'ownerName',
                key: 'ownerName',
                width: 160,
                render: (value: string, row: PartnerRankRowDto) => (
                  <PlayerName name={value} monthCardActive={row.ownerMonthCardActive} ellipsis />
                ),
              },
              {
                title: '等级',
                key: 'level',
                width: 160,
                render: (_value: number, row: PartnerRankRowDto) => (
                  <span className="rank-partner-level">{formatPartnerRankLevelText(row)}</span>
                ),
              },
              {
                title: '战力',
                dataIndex: 'power',
                key: 'power',
                render: (value: number) => value.toLocaleString(),
              },
            ]}
            dataSource={partnerRanks}
          />
        )
      )}
    </div>
  );

  const panelContent = () => {
    if (tab === 'realm') return renderRealmRank();
    if (tab === 'sect') return renderSectRank();
    if (tab === 'wealth') return renderWealthRank();
    if (tab === 'arena') return renderArenaRank();
    return renderPartnerRank();
  };

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        footer={null}
        title={null}
        centered
        width={1080}
        className="rank-modal"
        destroyOnHidden
        maskClosable
        afterOpenChange={(visible) => {
          if (!visible) return;
          setTab('realm');
          setPartnerMetric('level');
        }}
      >
        <div className="rank-shell">
          <div className="rank-left">
            <div className="rank-left-title">
              <img className="rank-left-icon" src={rankIcon} alt="排行" />
              <div className="rank-left-name">排行</div>
            </div>
            {isMobile ? (
              <div className="rank-left-segmented-wrap">
                <Segmented
                  className="rank-left-segmented"
                  value={tab}
                  options={mobileMenuOptions}
                  onChange={(value) => {
                    if (typeof value !== 'string') return;
                    if (!RANK_TAB_KEYS.includes(value as RankTab)) return;
                    setTab(value as RankTab);
                  }}
                />
              </div>
            ) : (
              <div className="rank-left-list">
                {leftItems.map((item) => (
                  <Button
                    key={item.key}
                    type={tab === item.key ? 'primary' : 'default'}
                    className="rank-left-item"
                    onClick={() => setTab(item.key)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
          <div className="rank-right">{panelContent()}</div>
        </div>
      </Modal>
      <PartnerPreviewOverlay
        partner={previewPartner}
        isMobile={isMobile}
        onClose={closePartnerPreview}
      />
    </>
  );
};

export default RankModal;
