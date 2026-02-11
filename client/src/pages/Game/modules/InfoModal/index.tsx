import { App, Avatar, Button, Form, Input, InputNumber, Modal, Select, Table, Tabs } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import {
  SERVER_BASE,
  claimBounty,
  getBountyBoard,
  getInfoTargetDetail,
  publishBounty,
  searchBountyItemDefs,
  type BountyBoardRowDto,
  type BountyItemDefSearchRowDto,
} from '../../../../services/api';
import './index.scss';

type InfoTargetType = 'npc' | 'monster' | 'item' | 'player';
type InfoActionItem = { key: string; text: string; disabled?: boolean };

const hasMessage = (value: unknown): value is { message: string } => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.message === 'string' && record.message.trim().length > 0;
};

const getErrorMessage = (err: unknown): string => {
  if (typeof err === 'string') return err;
  if (hasMessage(err)) return err.message;
  return '';
};

export type InfoTarget =
  | {
      type: 'npc';
      id: string;
      name: string;
      title?: string;
      gender?: string;
      realm?: string;
      avatar?: string | null;
      desc?: string;
      drops?: Array<{ name: string; quality: string; chance: string }>;
    }
  | {
      type: 'monster';
      id: string;
      name: string;
      title?: string;
      gender?: string;
      realm?: string;
      avatar?: string | null;
      base_attrs?: Record<string, number>;
      attr_variance?: number;
      attr_multiplier_min?: number;
      attr_multiplier_max?: number;
      stats?: Array<{ label: string; value: string | number }>;
      drops?: Array<{ name: string; quality: string; chance: string }>;
    }
  | {
      type: 'item';
      id: string;
      object_kind?: 'resource' | 'item' | 'board';
      resource?: {
        collectLimit: number;
        usedCount: number;
        remaining: number;
        cooldownSec: number;
        respawnSec: number;
        cooldownUntil?: string | null;
      };
      name: string;
      title?: string;
      gender?: string;
      realm?: string;
      avatar?: string | null;
      desc?: string;
      stats?: Array<{ label: string; value: string | number }>;
    }
  | {
      type: 'player';
      id: string;
      name: string;
      title?: string;
      gender?: string;
      realm?: string;
      avatar?: string | null;
      equipment?: Array<{ slot: string; name: string; quality: string }>;
      techniques?: Array<{ name: string; level: string; type: string }>;
    };

interface InfoModalProps {
  open: boolean;
  target: InfoTarget | null;
  onClose: () => void;
  onAction?: (action: string, target: InfoTarget) => void;
}

const resolveAvatarUrl = (avatar?: string | null) => {
  if (!avatar) return undefined;
  if (avatar.startsWith('http://') || avatar.startsWith('https://')) return avatar;
  if (avatar.startsWith('/uploads/')) return `${SERVER_BASE}${avatar}`;
  if (avatar.startsWith('/assets/')) return avatar;
  if (avatar.startsWith('/')) return avatar;
  return `${SERVER_BASE}/${avatar}`;
};

const InfoModal: React.FC<InfoModalProps> = ({ open, target, onClose, onAction }) => {
  const { message } = App.useApp();
  const typeTextMap: Record<InfoTargetType, string> = {
    npc: 'NPC',
    monster: '怪物',
    item: '物品',
    player: '玩家',
  };

  const [resolvedTarget, setResolvedTarget] = useState<InfoTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardRows, setBoardRows] = useState<BountyBoardRowDto[]>([]);
  const [boardClaimingId, setBoardClaimingId] = useState<number | null>(null);
  const [boardPool, setBoardPool] = useState<'daily' | 'player'>('daily');
  const [boardTabKey, setBoardTabKey] = useState<'daily' | 'player' | 'publish'>('daily');
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishFeePreview, setPublishFeePreview] = useState<{ spiritFee: number; silverFee: number; spiritCost: number; silverCost: number }>({
    spiritFee: 0,
    silverFee: 0,
    spiritCost: 0,
    silverCost: 0,
  });
  const requestSeqRef = useRef(0);
  const [publishForm] = Form.useForm();
  const [itemOptions, setItemOptions] = useState<BountyItemDefSearchRowDto[]>([]);
  const [itemSearching, setItemSearching] = useState(false);
  const itemSearchTimerRef = useRef<number | null>(null);
  const lastItemKeywordRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    const seq = (requestSeqRef.current += 1);

    if (!open || !target) {
      setResolvedTarget(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setResolvedTarget(target);
    if (target.type === 'item' && target.object_kind === 'resource') {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (target.type === 'item' && target.object_kind === 'board') {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (target.type === 'player') {
      const idOk = /^\d+$/.test(String(target.id || '').trim());
      if (!idOk) {
        setLoading(false);
        return () => {
          cancelled = true;
        };
      }
    }

    setLoading(true);
    getInfoTargetDetail(target.type, target.id)
      .then((res) => {
        if (cancelled) return;
        if (requestSeqRef.current !== seq) return;
        if (!res?.success || !res.data?.target) return;
        setResolvedTarget(res.data.target as unknown as InfoTarget);
      })
      .catch(() => {
        if (cancelled) return;
      })
      .finally(() => {
        if (cancelled) return;
        if (requestSeqRef.current !== seq) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, target]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    if (!open) return;
    if (!resolvedTarget || resolvedTarget.type !== 'item' || resolvedTarget.object_kind !== 'board') {
      setBoardRows([]);
      setBoardLoading(false);
      return;
    }

    setBoardPool('daily');
    setBoardTabKey('daily');
    setBoardLoading(true);
    getBountyBoard('daily')
      .then((res) => {
        if (cancelled) return;
        if (!res?.success) return;
        setBoardRows(Array.isArray(res.data?.bounties) ? res.data!.bounties : []);
      })
      .catch(() => {
        if (cancelled) return;
      })
      .finally(() => {
        if (cancelled) return;
        setBoardLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, resolvedTarget]);

  const computePublishFeePreview = (values: Record<string, unknown>) => {
    const claimPolicy = (typeof values.claimPolicy === 'string' ? values.claimPolicy : 'limited') as 'unique' | 'limited';
    const maxClaims = Number.isFinite(Number(values.maxClaims)) ? Math.max(1, Math.floor(Number(values.maxClaims))) : 1;
    const spiritReward = Number.isFinite(Number(values.spiritStonesReward)) ? Math.max(0, Math.floor(Number(values.spiritStonesReward))) : 0;
    const silverReward = Number.isFinite(Number(values.silverReward)) ? Math.max(0, Math.floor(Number(values.silverReward))) : 0;
    const multiplier = claimPolicy === 'limited' ? maxClaims : 1;
    const spiritBudget = spiritReward * multiplier;
    const silverBudget = silverReward * multiplier;
    const spiritFee = spiritBudget > 0 ? Math.ceil(spiritBudget * 0.1) : 0;
    const silverFee = silverBudget > 0 ? Math.ceil(silverBudget * 0.1) : 0;
    setPublishFeePreview({ spiritFee, silverFee, spiritCost: spiritBudget + spiritFee, silverCost: silverBudget + silverFee });
  };

  const fetchBoard = async (pool: 'daily' | 'player') => {
    setBoardLoading(true);
    try {
      const res = await getBountyBoard(pool);
      if (!res?.success) return;
      setBoardRows(Array.isArray(res.data?.bounties) ? res.data!.bounties : []);
    } finally {
      setBoardLoading(false);
    }
  };

  const searchItems = (keyword: string) => {
    const q = String(keyword || '').trim();
    lastItemKeywordRef.current = q;
    if (itemSearchTimerRef.current) window.clearTimeout(itemSearchTimerRef.current);
    itemSearchTimerRef.current = window.setTimeout(async () => {
      if (!lastItemKeywordRef.current) {
        setItemOptions([]);
        return;
      }
      setItemSearching(true);
      try {
        const res = await searchBountyItemDefs(lastItemKeywordRef.current, 20);
        if (!res?.success) return;
        setItemOptions(Array.isArray(res.data?.items) ? res.data!.items : []);
      } finally {
        setItemSearching(false);
      }
    }, 250);
  };

  const showTarget = resolvedTarget ?? null;
  const avatarUrl = resolveAvatarUrl(showTarget?.avatar ?? undefined);
  const titleText = showTarget?.title?.trim() || '';
  const nameText = showTarget?.name?.trim() || '';
  const genderText = showTarget?.gender ?? '-';
  const realmText = showTarget?.realm ?? '-';
  const typeText = showTarget ? typeTextMap[showTarget.type] : '';

  const computeResourceRuntime = (t: Extract<InfoTarget, { type: 'item' }>) => {
    const r = t.resource;
    const collectLimit = r?.collectLimit ?? 0;
    const cdUntilText = r?.cooldownUntil ?? null;
    const cdUntilMs = cdUntilText ? Date.parse(cdUntilText) : NaN;
    const hasCdUntil = Number.isFinite(cdUntilMs) && cdUntilMs > 0;
    const cooldownSec = hasCdUntil
      ? Math.max(0, Math.ceil((cdUntilMs - nowMs) / 1000))
      : (r?.cooldownSec ?? 0);
    const usedCount = hasCdUntil && cooldownSec === 0 ? 0 : (r?.usedCount ?? 0);
    const remaining = hasCdUntil && cooldownSec === 0 ? collectLimit : (r?.remaining ?? 0);
    return { collectLimit, cooldownSec, usedCount, remaining, respawnSec: r?.respawnSec ?? 0 };
  };

  const dropsColumns = [
    { title: '掉落物', dataIndex: 'name', key: 'name', width: 220 },
    { title: '品质', dataIndex: 'quality', key: 'quality', width: 120 },
    { title: '概率', dataIndex: 'chance', key: 'chance', width: 100 },
  ];

  const renderBaseInfo = () => (
    <div className="info-modal-base">
      <div className="info-kv">
        <span className="info-k">称号</span>
        <span className="info-v">{titleText || '-'}</span>
      </div>
      <div className="info-kv">
        <span className="info-k">姓名</span>
        <span className="info-v">{nameText || '-'}</span>
      </div>
      <div className="info-kv">
        <span className="info-k">性别</span>
        <span className="info-v">{genderText}</span>
      </div>
      <div className="info-kv">
        <span className="info-k">境界</span>
        <span className="info-v">{realmText}</span>
      </div>
    </div>
  );

  const renderNpcTabs = (t: Extract<InfoTarget, { type: 'npc' }>) => (
    <Tabs
      size="small"
      items={[
        { key: 'info', label: '信息', children: renderBaseInfo() },
        { key: 'desc', label: '描述', children: <div className="info-modal-text">{t.desc || '暂无描述'}</div> },
        t.drops && t.drops.length > 0
          ? {
              key: 'drops',
              label: '掉落',
              children: (
                <Table
                  size="small"
                  rowKey={(row) => row.name}
                  columns={dropsColumns}
                  dataSource={t.drops}
                  pagination={false}
                />
              ),
            }
          : null,
      ].filter(Boolean) as NonNullable<Parameters<typeof Tabs>[0]['items']>}
    />
  );

  const renderMonsterTabs = (t: Extract<InfoTarget, { type: 'monster' }>) => (
    <Tabs
      size="small"
      items={[
        { key: 'info', label: '信息', children: renderBaseInfo() },
        {
          key: 'stats',
          label: '属性',
          children: (
            <div className="info-modal-grid">
              {(t.stats ?? []).map((s) => (
                <div key={s.label} className="info-kv">
                  <span className="info-k">{s.label}</span>
                  <span className="info-v">{s.value}</span>
                </div>
              ))}
              {(t.stats ?? []).length === 0 ? <div className="info-modal-empty">暂无属性</div> : null}
            </div>
          ),
        },
        {
          key: 'drops',
          label: '掉落',
          children: (
            <Table
              size="small"
              rowKey={(row) => row.name}
              columns={dropsColumns}
              dataSource={t.drops ?? []}
              pagination={false}
            />
          ),
        },
      ]}
    />
  );

  const renderPlayerTabs = (t: Extract<InfoTarget, { type: 'player' }>) => (
    <Tabs
      size="small"
      items={[
        { key: 'info', label: '信息', children: renderBaseInfo() },
        {
          key: 'equip',
          label: '装备',
          children: (
            <div className="info-modal-grid">
              {(t.equipment ?? []).map((e) => (
                <div key={e.slot} className="info-kv">
                  <span className="info-k">{e.slot}</span>
                  <span className="info-v">{e.name}（{e.quality}）</span>
                </div>
              ))}
              {(t.equipment ?? []).length === 0 ? <div className="info-modal-empty">暂无装备</div> : null}
            </div>
          ),
        },
        {
          key: 'tech',
          label: '功法',
          children: (
            <Table
              size="small"
              rowKey={(row) => `${row.name}-${row.level}-${row.type}`}
              columns={[
                { title: '功法', dataIndex: 'name', key: 'name' },
                { title: '等级', dataIndex: 'level', key: 'level', width: 90 },
                { title: '类型', dataIndex: 'type', key: 'type', width: 120 },
              ]}
              dataSource={t.techniques ?? []}
              pagination={false}
            />
          ),
        },
      ]}
    />
  );

  const renderItemTabs = (t: Extract<InfoTarget, { type: 'item' }>) => (
    <Tabs
      size="small"
      items={
        [
          { key: 'info', label: '信息', children: renderBaseInfo() },
          t.object_kind === 'board'
            ? {
                key: 'board',
                label: '榜单',
                children: (
                  <div className="info-modal-board">
                    <Tabs
                      size="small"
                      activeKey={boardTabKey}
                      onChange={(k) => {
                        const next = (k === 'player' || k === 'publish' ? k : 'daily') as 'daily' | 'player' | 'publish';
                        setBoardTabKey(next);
                        if (next === 'daily' || next === 'player') {
                          setBoardPool(next);
                          fetchBoard(next);
                        }
                      }}
                      items={[
                        {
                          key: 'daily',
                          label: '每日悬赏',
                          children: (
                            <Table
                              size="small"
                              rowKey={(row) => String(row.id)}
                              loading={boardLoading}
                              dataSource={boardRows}
                              pagination={false}
                              columns={[
                                { title: '悬赏', dataIndex: 'title', key: 'title', ellipsis: true },
                                {
                                  title: '奖励',
                                  key: 'reward',
                                  width: 160,
                                  render: (_v: unknown, row: BountyBoardRowDto) => {
                                    const parts: string[] = [];
                                    if (row.spiritStonesReward > 0) parts.push(`灵石${row.spiritStonesReward}`);
                                    if (row.silverReward > 0) parts.push(`银两${row.silverReward}`);
                                    return parts.length > 0 ? parts.join(' / ') : '-';
                                  },
                                },
                                {
                                  title: '接取规则',
                                  dataIndex: 'claimPolicy',
                                  key: 'claimPolicy',
                                  width: 120,
                                  render: (v: BountyBoardRowDto['claimPolicy']) =>
                                    v === 'unique' ? '唯一' : v === 'limited' ? '限次' : '不限',
                                },
                                {
                                  title: '已接取',
                                  dataIndex: 'claimedCount',
                                  key: 'claimedCount',
                                  width: 110,
                                  align: 'right',
                                  render: (_v: unknown, row: BountyBoardRowDto) =>
                                    row.claimPolicy === 'limited' && row.maxClaims > 0 ? `${row.claimedCount}/${row.maxClaims}` : row.claimedCount,
                                },
                                {
                                  title: '操作',
                                  key: 'action',
                                  width: 100,
                                  render: (_v: unknown, row: BountyBoardRowDto) => {
                                    const occupiedByTask = !!row.myTaskStatus && row.myTaskStatus !== 'claimed';
                                    const occupiedText =
                                      row.myTaskStatus === 'ongoing'
                                        ? '任务进行中'
                                        : row.myTaskStatus === 'turnin'
                                          ? '可提交'
                                          : row.myTaskStatus === 'claimable'
                                            ? '可领奖'
                                            : '任务已接取';
                                    const disabled =
                                      row.claimedByMe ||
                                      occupiedByTask ||
                                      (row.claimPolicy === 'unique' && row.claimedCount >= 1) ||
                                      (row.claimPolicy === 'limited' && row.maxClaims > 0 && row.claimedCount >= row.maxClaims);
                                    return (
                                      <Button
                                        size="small"
                                        type={disabled ? 'default' : 'primary'}
                                        disabled={disabled || boardClaimingId === row.id}
                                        loading={boardClaimingId === row.id}
                                        title={occupiedByTask ? '你已接取该任务，请先完成并领取奖励后再接取新的悬赏' : undefined}
                                        onClick={async () => {
                                          setBoardClaimingId(row.id);
                                          try {
                                            const res = await claimBounty(row.id);
                                            if (!res?.success) {
                                              message.error(res?.message || '接取失败');
                                              return;
                                            }
                                            message.success('接取成功');
                                            await fetchBoard(boardPool);
                                          } catch (e: unknown) {
                                            message.error(getErrorMessage(e) || '接取失败');
                                          } finally {
                                            setBoardClaimingId(null);
                                          }
                                        }}
                                      >
                                        {row.claimedByMe ? '已接取' : occupiedByTask ? occupiedText : '接取'}
                                      </Button>
                                    );
                                  },
                                },
                              ]}
                              expandable={{
                                expandedRowRender: (row) => (
                                  <div className="info-modal-board-desc">{row.description || '暂无描述'}</div>
                                ),
                                rowExpandable: (row) => !!row.description,
                              }}
                              locale={{ emptyText: boardLoading ? '加载中...' : '暂无悬赏' }}
                            />
                          ),
                        },
                        {
                          key: 'player',
                          label: '玩家悬赏',
                          children: (
                            <Table
                              size="small"
                              rowKey={(row) => String(row.id)}
                              loading={boardLoading}
                              dataSource={boardRows}
                              pagination={false}
                              columns={[
                                { title: '悬赏', dataIndex: 'title', key: 'title', ellipsis: true },
                                {
                                  title: '奖励',
                                  key: 'reward',
                                  width: 160,
                                  render: (_v: unknown, row: BountyBoardRowDto) => {
                                    const parts: string[] = [];
                                    if (row.spiritStonesReward > 0) parts.push(`灵石${row.spiritStonesReward}`);
                                    if (row.silverReward > 0) parts.push(`银两${row.silverReward}`);
                                    return parts.length > 0 ? parts.join(' / ') : '-';
                                  },
                                },
                                {
                                  title: '接取规则',
                                  dataIndex: 'claimPolicy',
                                  key: 'claimPolicy',
                                  width: 120,
                                  render: (v: BountyBoardRowDto['claimPolicy']) =>
                                    v === 'unique' ? '唯一' : v === 'limited' ? '限次' : '不限',
                                },
                                {
                                  title: '已接取',
                                  dataIndex: 'claimedCount',
                                  key: 'claimedCount',
                                  width: 110,
                                  align: 'right',
                                  render: (_v: unknown, row: BountyBoardRowDto) =>
                                    row.claimPolicy === 'limited' && row.maxClaims > 0 ? `${row.claimedCount}/${row.maxClaims}` : row.claimedCount,
                                },
                                {
                                  title: '操作',
                                  key: 'action',
                                  width: 100,
                                  render: (_v: unknown, row: BountyBoardRowDto) => {
                                    const disabled =
                                      row.claimedByMe ||
                                      (row.claimPolicy === 'unique' && row.claimedCount >= 1) ||
                                      (row.claimPolicy === 'limited' && row.maxClaims > 0 && row.claimedCount >= row.maxClaims);
                                    return (
                                      <Button
                                        size="small"
                                        type={row.claimedByMe ? 'default' : 'primary'}
                                        disabled={disabled || boardClaimingId === row.id}
                                        loading={boardClaimingId === row.id}
                                        onClick={async () => {
                                          setBoardClaimingId(row.id);
                                          try {
                                            const res = await claimBounty(row.id);
                                            if (!res?.success) {
                                              message.error(res?.message || '接取失败');
                                              return;
                                            }
                                            message.success('接取成功');
                                            await fetchBoard(boardPool);
                                          } catch (e: unknown) {
                                            message.error(getErrorMessage(e) || '接取失败');
                                          } finally {
                                            setBoardClaimingId(null);
                                          }
                                        }}
                                      >
                                        {row.claimedByMe ? '已接取' : '接取'}
                                      </Button>
                                    );
                                  },
                                },
                              ]}
                              expandable={{
                                expandedRowRender: (row) => (
                                  <div className="info-modal-board-desc">{row.description || '暂无描述'}</div>
                                ),
                                rowExpandable: (row) => !!row.description,
                              }}
                              locale={{ emptyText: boardLoading ? '加载中...' : '暂无悬赏' }}
                            />
                          ),
                        },
                        {
                          key: 'publish',
                          label: '发布悬赏',
                          children: (
                            <Form
                              form={publishForm}
                              layout="vertical"
                              initialValues={{
                                claimPolicy: 'limited',
                                maxClaims: 10,
                                spiritStonesReward: 0,
                                silverReward: 0,
                                requiredItems: [{ qty: 1 }],
                              }}
                              onValuesChange={(_, all) => computePublishFeePreview(all)}
                              onFinish={async (values) => {
                                const taskId = typeof values.taskId === 'string' ? values.taskId.trim() : '';
                                const title = typeof values.title === 'string' ? values.title.trim() : '';
                                const description = typeof values.description === 'string' ? values.description : undefined;
                                const claimPolicy = (typeof values.claimPolicy === 'string' ? values.claimPolicy : 'limited') as 'unique' | 'limited';
                                const maxClaims = Number.isFinite(Number(values.maxClaims)) ? Math.max(1, Math.floor(Number(values.maxClaims))) : undefined;
                                const spiritStonesReward = Number.isFinite(Number(values.spiritStonesReward))
                                  ? Math.max(0, Math.floor(Number(values.spiritStonesReward)))
                                  : 0;
                                const silverReward = Number.isFinite(Number(values.silverReward)) ? Math.max(0, Math.floor(Number(values.silverReward))) : 0;
                                const requiredItemsRaw: unknown = (values as { requiredItems?: unknown })?.requiredItems;
                                const requiredItemsList: unknown[] = Array.isArray(requiredItemsRaw) ? requiredItemsRaw : [];
                                const requiredItems = requiredItemsList
                                  .map((x: unknown) => {
                                    const row = x && typeof x === 'object' ? (x as { itemDefId?: unknown; qty?: unknown }) : {};
                                    const itemDefId = typeof row.itemDefId === 'string' ? row.itemDefId.trim() : '';
                                    const qty = Number.isFinite(Number(row.qty)) ? Math.max(1, Math.floor(Number(row.qty))) : 1;
                                    if (!itemDefId) return null;
                                    return { itemDefId, qty };
                                  })
                                  .filter((x) => !!x) as Array<{ itemDefId: string; qty: number }>;
                                if (!taskId || !title) {
                                  message.error('任务ID和标题不能为空');
                                  return;
                                }
                                if (spiritStonesReward <= 0 && silverReward <= 0) {
                                  message.error('奖励不能都为0');
                                  return;
                                }
                                if (requiredItems.length === 0) {
                                  message.error('请至少添加一种材料');
                                  return;
                                }

                                setPublishLoading(true);
                                try {
                                  const res = await publishBounty({
                                    taskId,
                                    title,
                                    description,
                                    claimPolicy,
                                    maxClaims: claimPolicy === 'limited' ? maxClaims : undefined,
                                    spiritStonesReward,
                                    silverReward,
                                    requiredItems,
                                  });
                                  if (!res?.success) {
                                    message.error(res?.message || '发布失败');
                                    return;
                                  }
                                  message.success('发布成功');
                                  setBoardPool('player');
                                  setBoardTabKey('player');
                                  await fetchBoard('player');
                                  publishForm.resetFields();
                                  setPublishFeePreview({ spiritFee: 0, silverFee: 0, spiritCost: 0, silverCost: 0 });
                                } catch (e: unknown) {
                                  message.error(getErrorMessage(e) || '发布失败');
                                } finally {
                                  setPublishLoading(false);
                                }
                              }}
                            >
                              <Form.Item label="任务ID" name="taskId" rules={[{ required: true, message: '请输入任务ID' }]}>
                                <Input placeholder="例如：task-xxx" />
                              </Form.Item>
                              <Form.Item label="标题" name="title" rules={[{ required: true, message: '请输入标题' }]}>
                                <Input placeholder="例如：收集灵草" />
                              </Form.Item>
                              <Form.Item label="描述" name="description">
                                <Input.TextArea placeholder="可选" autoSize={{ minRows: 2, maxRows: 4 }} />
                              </Form.Item>
                              <Form.Item label="需要提交的材料">
                                <Form.List name="requiredItems">
                                  {(fields, { add, remove }) => (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                      {fields.map((field) => {
                                        const { key, ...restField } = field;
                                        return (
                                          <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                          <Form.Item
                                            key={`itemDefId-${key}`}
                                            {...restField}
                                            name={[field.name, 'itemDefId']}
                                            style={{ flex: 1, marginBottom: 0 }}
                                            rules={[{ required: true, message: '请选择材料' }]}
                                          >
                                            <Select
                                              showSearch
                                              placeholder="输入物品名搜索"
                                              filterOption={false}
                                              onSearch={searchItems}
                                              notFoundContent={itemSearching ? '搜索中...' : '无结果'}
                                              options={itemOptions.map((it) => ({
                                                value: it.id,
                                                label: `${it.name}（${it.id}）`,
                                              }))}
                                            />
                                          </Form.Item>
                                          <Form.Item
                                            key={`qty-${key}`}
                                            {...restField}
                                            name={[field.name, 'qty']}
                                            style={{ width: 140, marginBottom: 0 }}
                                            rules={[{ required: true, message: '数量' }]}
                                          >
                                            <InputNumber min={1} max={999999} style={{ width: '100%' }} />
                                          </Form.Item>
                                          <Button
                                            danger
                                            onClick={() => remove(field.name)}
                                            disabled={fields.length <= 1}
                                            style={{ width: 72 }}
                                          >
                                            删除
                                          </Button>
                                          </div>
                                        );
                                      })}
                                      <Button type="dashed" onClick={() => add({ qty: 1 })}>
                                        添加材料
                                      </Button>
                                    </div>
                                  )}
                                </Form.List>
                              </Form.Item>
                              <Form.Item label="接取规则" name="claimPolicy" rules={[{ required: true, message: '请选择接取规则' }]}>
                                <Select
                                  options={[
                                    { value: 'unique', label: '唯一接取' },
                                    { value: 'limited', label: '限次接取' },
                                  ]}
                                />
                              </Form.Item>
                              <Form.Item noStyle shouldUpdate={(prev, next) => prev.claimPolicy !== next.claimPolicy}>
                                {({ getFieldValue }) =>
                                  getFieldValue('claimPolicy') === 'limited' ? (
                                    <Form.Item label="最大接取次数" name="maxClaims" rules={[{ required: true, message: '请输入最大接取次数' }]}>
                                      <InputNumber min={1} max={9999} style={{ width: '100%' }} />
                                    </Form.Item>
                                  ) : null
                                }
                              </Form.Item>
                              <Form.Item label="灵石奖励（每人）" name="spiritStonesReward">
                                <InputNumber min={0} max={999999999} style={{ width: '100%' }} />
                              </Form.Item>
                              <Form.Item label="银两奖励（每人）" name="silverReward">
                                <InputNumber min={0} max={999999999} style={{ width: '100%' }} />
                              </Form.Item>
                              <div className="info-modal-board-fee">
                                <div className="info-kv">
                                  <span className="info-k">手续费（10%）</span>
                                  <span className="info-v">
                                    {publishFeePreview.spiritFee > 0 ? `灵石${publishFeePreview.spiritFee}` : ''}{' '}
                                    {publishFeePreview.silverFee > 0 ? `银两${publishFeePreview.silverFee}` : ''}
                                    {publishFeePreview.spiritFee <= 0 && publishFeePreview.silverFee <= 0 ? '-' : ''}
                                  </span>
                                </div>
                                <div className="info-kv">
                                  <span className="info-k">总扣款</span>
                                  <span className="info-v">
                                    {publishFeePreview.spiritCost > 0 ? `灵石${publishFeePreview.spiritCost}` : ''}{' '}
                                    {publishFeePreview.silverCost > 0 ? `银两${publishFeePreview.silverCost}` : ''}
                                    {publishFeePreview.spiritCost <= 0 && publishFeePreview.silverCost <= 0 ? '-' : ''}
                                  </span>
                                </div>
                              </div>
                              <Form.Item>
                                <Button type="primary" htmlType="submit" loading={publishLoading} block>
                                  发布
                                </Button>
                              </Form.Item>
                            </Form>
                          ),
                        },
                      ]}
                    />
                  </div>
                ),
              }
            : null,
          t.object_kind === 'resource'
            ? {
                key: 'gather',
                label: '采集',
                children: (() => {
                  const s = computeResourceRuntime(t);
                  return (
                    <div className="info-modal-grid">
                      <div className="info-kv">
                        <span className="info-k">刷新状态</span>
                        <span className="info-v">{s.cooldownSec > 0 ? `刷新倒计时（剩余${s.cooldownSec}秒）` : '可采集'}</span>
                      </div>
                      <div className="info-kv">
                        <span className="info-k">采集次数</span>
                        <span className="info-v">
                          {s.usedCount}/{s.collectLimit}
                        </span>
                      </div>
                      <div className="info-kv">
                        <span className="info-k">剩余可采</span>
                        <span className="info-v">{s.remaining}</span>
                      </div>
                      <div className="info-kv">
                        <span className="info-k">耗尽刷新</span>
                        <span className="info-v">{s.respawnSec ? `${s.respawnSec}秒` : '-'}</span>
                      </div>
                    </div>
                  );
                })(),
              }
            : null,
          t.stats && t.stats.length > 0
            ? {
                key: 'stats',
                label: '属性',
                children: (
                  <div className="info-modal-grid">
                    {(t.stats ?? []).map((s) => (
                      <div key={s.label} className="info-kv">
                        <span className="info-k">{s.label}</span>
                        <span className="info-v">{s.value}</span>
                      </div>
                    ))}
                    {(t.stats ?? []).length === 0 ? <div className="info-modal-empty">暂无属性</div> : null}
                  </div>
                ),
              }
            : null,
          { key: 'desc', label: '描述', children: <div className="info-modal-text">{t.desc || '暂无描述'}</div> },
        ].filter(Boolean) as NonNullable<Parameters<typeof Tabs>[0]['items']>
      }
    />
  );

  const renderTabs = () => {
    if (!showTarget) return null;
    if (showTarget.type === 'npc') return renderNpcTabs(showTarget);
    if (showTarget.type === 'monster') return renderMonsterTabs(showTarget);
    if (showTarget.type === 'player') return renderPlayerTabs(showTarget);
    return renderItemTabs(showTarget);
  };

  const actionsByType: Record<InfoTargetType, InfoActionItem[]> = {
    npc: [
      { key: 'talk', text: '交流' },
      { key: 'buy', text: '购买' },
    ],
    monster: [{ key: 'attack', text: '攻击' }],
    item: [{ key: 'pickup', text: '拾取' }],
    player: [
      { key: 'talk', text: '交流' },
      { key: 'pm', text: '私聊' },
      { key: 'attack', text: '攻击' },
    ],
  };

  const actions =
    showTarget?.type === 'item' && showTarget.object_kind === 'resource'
      ? (() => {
          const s = computeResourceRuntime(showTarget);
          return [
            {
              key: 'gather',
              text: s.cooldownSec > 0 ? `刷新中（${s.cooldownSec}s）` : '采集',
              disabled: s.cooldownSec > 0 || s.remaining <= 0,
            },
          ];
        })()
      : showTarget?.type === 'item' && showTarget.object_kind === 'board'
        ? []
      : showTarget
        ? actionsByType[showTarget.type].map((a) => ({ ...a, disabled: a.disabled ?? false }))
        : [];

  const footer = showTarget ? (
    <div className="info-modal-footer">
      <div className="info-modal-actions">
        {actions.map((a) => (
          <Button key={a.key} disabled={!!a.disabled} onClick={() => onAction?.(a.key, showTarget)}>
            {a.text}
          </Button>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={560}
      className="info-modal"
      destroyOnHidden
      maskClosable
    >
      {showTarget ? (
        <div className="info-modal-shell">
          <div className="info-modal-header">
            <Avatar size={56} src={avatarUrl} icon={<UserOutlined />} />
            <div className="info-modal-header-right">
              <div className="info-modal-name">
                <span className="info-modal-type">{typeText}</span>
                <span className="info-modal-title">{titleText}</span>
                <span className="info-modal-realname">{nameText}</span>
              </div>
              <div className="info-modal-meta">
                <span>性别：{genderText}</span>
                <span className="dot">·</span>
                <span>境界：{realmText}</span>
              </div>
            </div>
          </div>
          <div className="info-modal-body">{loading ? <div className="info-modal-empty">加载中...</div> : renderTabs()}</div>
          {footer}
        </div>
      ) : null}
    </Modal>
  );
};

export default InfoModal;
