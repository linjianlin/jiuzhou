import { App, Button, Modal, Segmented, Table, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { IMG_COIN as coin01 } from '../../shared/imageAssets';
import {
  getArenaRanks,
  getRankOverview,
  type ArenaRankRowDto,
  type RealmRankRowDto,
  type SectRankRowDto,
  type WealthRankRowDto,
} from '../../../../services/api';
import { useIsMobile } from '../../shared/responsive';
import './index.scss';

interface RankModalProps {
  open: boolean;
  onClose: () => void;
}

type RankTab = 'realm' | 'sect' | 'wealth' | 'arena';
const rankTabKeys: RankTab[] = ['realm', 'sect', 'wealth', 'arena'];

const RankModal: React.FC<RankModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  const [tab, setTab] = useState<RankTab>('realm');
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(false);
  const [realmRanks, setRealmRanks] = useState<RealmRankRowDto[]>([]);
  const [sectRanks, setSectRanks] = useState<SectRankRowDto[]>([]);
  const [wealthRanks, setWealthRanks] = useState<WealthRankRowDto[]>([]);
  const [arenaRanks, setArenaRanks] = useState<ArenaRankRowDto[]>([]);

  const refreshRanks = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewRes, arenaRes] = await Promise.all([getRankOverview(50, 30), getArenaRanks(50)]);
      if (!overviewRes.success || !overviewRes.data) throw new Error(overviewRes.message || '加载排行榜失败');
      setRealmRanks(overviewRes.data.realm ?? []);
      setSectRanks(overviewRes.data.sect ?? []);
      setWealthRanks(overviewRes.data.wealth ?? []);
      if (arenaRes.success) setArenaRanks(arenaRes.data ?? []);
    } catch (error: unknown) {
      void 0;
      setRealmRanks([]);
      setSectRanks([]);
      setWealthRanks([]);
      setArenaRanks([]);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (!open) return;
    setTab('realm');
    void refreshRanks();
  }, [open, refreshRanks]);

  const leftItems = useMemo(
    () => [
      { key: 'realm' as const, label: '境界排行榜' },
      { key: 'sect' as const, label: '宗门排行榜' },
      { key: 'wealth' as const, label: '财富排行榜' },
      { key: 'arena' as const, label: '竞技场排行榜' },
    ],
    [],
  );

  const mobileMenuOptions = useMemo(
    () => [
      { value: 'realm', label: '境界' },
      { value: 'sect', label: '宗门' },
      { value: 'wealth', label: '财富' },
      { value: 'arena', label: '竞技' },
    ],
    [],
  );

  const renderPaneTop = (title: string, subtitle: string) => (
    <div className="rank-pane-top">
      <div className="rank-top-row">
        <div className="rank-title">{title}</div>
      </div>
      <div className="rank-subtitle">{subtitle}</div>
    </div>
  );

  const renderRealmRank = () => (
    <div className="rank-pane">
      {renderPaneTop('境界排行榜', '按境界与战力综合排序')}
      <div className="rank-pane-body">
        {isMobile ? (
          <div className="rank-mobile-list">
            {loading ? <div className="rank-empty">加载中...</div> : null}
            {!loading
              ? realmRanks.map((row) => (
                  <div key={row.rank} className="rank-mobile-card">
                    <div className="rank-mobile-card-head">
                      <div className="rank-mobile-rank">#{row.rank}</div>
                      <div className="rank-mobile-name">{row.name}</div>
                      <Tag color="green">{row.realm}</Tag>
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
              { title: '玩家', dataIndex: 'name', key: 'name', width: 180 },
              { title: '境界', dataIndex: 'realm', key: 'realm', width: 120, render: (v: string) => <Tag color="green">{v}</Tag> },
              { title: '战力', dataIndex: 'power', key: 'power', render: (v: number) => v.toLocaleString() },
            ]}
            dataSource={realmRanks}
          />
        )}
      </div>
    </div>
  );

  const renderSectRank = () => (
    <div className="rank-pane">
      {renderPaneTop('宗门排行榜', '按宗门综合实力排序')}
      <div className="rank-pane-body">
        {isMobile ? (
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
                        <span className="rank-mobile-meta-v">{row.leader}</span>
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
              { title: '宗主', dataIndex: 'leader', key: 'leader', width: 140 },
              { title: '成员', key: 'members', width: 120, render: (_: unknown, row: SectRankRowDto) => `${row.members}/${row.memberCap}` },
              { title: '实力', dataIndex: 'power', key: 'power', render: (v: number) => v.toLocaleString() },
            ]}
            dataSource={sectRanks}
          />
        )}
      </div>
    </div>
  );

  const renderWealthRank = () => (
    <div className="rank-pane">
      {renderPaneTop('财富排行榜', '按灵石与银两总量排序')}
      <div className="rank-pane-body">
        {isMobile ? (
          <div className="rank-mobile-list">
            {loading ? <div className="rank-empty">加载中...</div> : null}
            {!loading
              ? wealthRanks.map((row) => (
                  <div key={row.rank} className="rank-mobile-card">
                    <div className="rank-mobile-card-head">
                      <div className="rank-mobile-rank">#{row.rank}</div>
                      <div className="rank-mobile-name">{row.name}</div>
                      <Tag color="green">{row.realm}</Tag>
                    </div>
                    <div className="rank-mobile-meta">
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k">灵石</span>
                        <span className="rank-mobile-meta-v rank-money">
                          <img className="rank-money-icon" src={coin01} alt="灵石" />
                          {row.spiritStones.toLocaleString()}
                        </span>
                      </span>
                      <span className="rank-mobile-meta-item">
                        <span className="rank-mobile-meta-k">银两</span>
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
              { title: '玩家', dataIndex: 'name', key: 'name', width: 180 },
              { title: '境界', dataIndex: 'realm', key: 'realm', width: 120, render: (v: string) => <Tag color="green">{v}</Tag> },
              {
                title: '灵石',
                dataIndex: 'spiritStones',
                key: 'spiritStones',
                width: 160,
                render: (v: number) => (
                  <span className="rank-money">
                    <img className="rank-money-icon" src={coin01} alt="灵石" />
                    {v.toLocaleString()}
                  </span>
                ),
              },
              {
                title: '银两',
                dataIndex: 'silver',
                key: 'silver',
                render: (v: number) => v.toLocaleString(),
              },
            ]}
            dataSource={wealthRanks}
          />
        )}
      </div>
    </div>
  );

  const renderArenaRank = () => (
    <div className="rank-pane">
      {renderPaneTop('竞技场排行榜', '按竞技场积分排序')}
      <div className="rank-pane-body">
        {isMobile ? (
          <div className="rank-mobile-list">
            {loading ? <div className="rank-empty">加载中...</div> : null}
            {!loading
              ? arenaRanks.map((row) => (
                  <div key={row.rank} className="rank-mobile-card">
                    <div className="rank-mobile-card-head">
                      <div className="rank-mobile-rank">#{row.rank}</div>
                      <div className="rank-mobile-name">{row.name}</div>
                      <Tag color="green">{row.realm}</Tag>
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
              { title: '玩家', dataIndex: 'name', key: 'name', width: 180 },
              { title: '境界', dataIndex: 'realm', key: 'realm', width: 120, render: (v: string) => <Tag color="green">{v}</Tag> },
              { title: '积分', dataIndex: 'score', key: 'score', width: 120, render: (v: number) => v },
              {
                title: '胜负',
                key: 'wl',
                render: (_: unknown, row: ArenaRankRowDto) => `${row.winCount}/${row.loseCount}`,
              },
            ]}
            dataSource={arenaRanks}
          />
        )}
      </div>
    </div>
  );

  const panelContent = () => {
    if (tab === 'realm') return renderRealmRank();
    if (tab === 'sect') return renderSectRank();
    if (tab === 'wealth') return renderWealthRank();
    return renderArenaRank();
  };

  return (
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
      }}
    >
      <div className="rank-shell">
        <div className="rank-left">
          <div className="rank-left-title">
            <img className="rank-left-icon" src={coin01} alt="排行" />
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
                  if (!rankTabKeys.includes(value as RankTab)) return;
                  setTab(value as RankTab);
                }}
              />
            </div>
          ) : (
            <div className="rank-left-list">
              {leftItems.map((it) => (
                <Button
                  key={it.key}
                  type={tab === it.key ? 'primary' : 'default'}
                  className="rank-left-item"
                  onClick={() => setTab(it.key)}
                >
                  {it.label}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="rank-right">{panelContent()}</div>
      </div>
    </Modal>
  );
};

export default RankModal;
