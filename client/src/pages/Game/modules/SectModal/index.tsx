import { App, Button, Input, Modal, Table, Tabs, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import coin01 from '../../../../assets/images/ui/sh_icon_0006_jinbi_02.png';
import {
  applyToSect,
  buyFromSectShop,
  createSect as createSectApi,
  donateToSect,
  getSectShop,
  getMySect,
  leaveSect as leaveSectApi,
  searchSects,
  type SectInfoDto,
  type SectShopItemDto,
  upgradeSectBuilding,
  type SectApplicationDto,
  getSectApplications,
  handleSectApplication,
} from '../../../../services/api';
import './index.scss';

type SectJoinState = 'none' | 'pending' | 'joined';

type SectItem = {
  id: string;
  name: string;
  level: number;
  leader: string;
  members: number;
  memberCap: number;
  notice: string;
};

type SectMember = {
  id: string;
  name: string;
  role: '宗主' | '长老' | '护法' | '弟子';
  realm: string;
  contribution: number;
  online: boolean;
};

type SectBuilding = {
  id: string;
  buildingType: string;
  name: string;
  level: number;
  desc: string;
  effect: string;
  requirement: {
    upgradable: boolean;
    maxLevel: number;
    nextLevel: number | null;
    funds: number | null;
    buildPoints: number | null;
    reason: string | null;
  };
  canAfford: boolean;
  fundsGap: number;
  buildPointsGap: number;
};

type SectTabKey = 'members' | 'buildings' | 'shop' | 'activity' | 'manage';

interface SectModalProps {
  open: boolean;
  onClose: () => void;
  spiritStones?: number;
  playerName?: string;
}

const parseNonNegativeInteger = (raw: string): number | null => {
  const value = raw.trim();
  if (!value) return 0;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) return null;
  return n;
};

const SectModal: React.FC<SectModalProps> = ({ open, onClose, spiritStones = 0, playerName = '我' }) => {
  const { message } = App.useApp();
  const createCost = 1000;
  const canAffordCreate = spiritStones >= createCost;

  const [joinState, setJoinState] = useState<SectJoinState>('none');
  const [activeSectId, setActiveSectId] = useState<string>('');

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createNotice, setCreateNotice] = useState('');
  const [donateOpen, setDonateOpen] = useState(false);
  const [donateSpiritStonesInput, setDonateSpiritStonesInput] = useState('');

  const [tab, setTab] = useState<SectTabKey>('members');

  const [listLoading, setListLoading] = useState(false);
  const [actionLoadingKey, setActionLoadingKey] = useState<string | null>(null);
  const [sects, setSects] = useState<SectItem[]>([]);
  const [mySectInfo, setMySectInfo] = useState<SectInfoDto | null>(null);
  const [applications, setApplications] = useState<SectApplicationDto[]>([]);
  const [applicationsLoading, setApplicationsLoading] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [shopItems, setShopItems] = useState<SectShopItemDto[]>([]);
  const [shopLoading, setShopLoading] = useState(false);

  const closeDonateModal = useCallback(() => {
    setDonateOpen(false);
    setDonateSpiritStonesInput('');
  }, []);

  const joinedSect = useMemo(() => {
    if (!mySectInfo?.sect) return null;
    const leaderName = mySectInfo.members.find((m) => m.position === 'leader')?.nickname ?? '—';
    return {
      id: mySectInfo.sect.id,
      name: mySectInfo.sect.name,
      level: Number(mySectInfo.sect.level) || 1,
      leader: leaderName,
      members: Number(mySectInfo.sect.member_count) || 0,
      memberCap: Number(mySectInfo.sect.max_members) || 0,
      notice: String(mySectInfo.sect.announcement ?? mySectInfo.sect.description ?? '—'),
      funds: Number(mySectInfo.sect.funds) || 0,
      buildPoints: Number(mySectInfo.sect.build_points) || 0,
      reputation: Number(mySectInfo.sect.reputation) || 0,
    };
  }, [mySectInfo]);

  const members = useMemo((): SectMember[] => {
    const mapRole = (position: 'leader' | 'vice_leader' | 'elder' | 'elite' | 'disciple'): SectMember['role'] => {
      if (position === 'leader') return '宗主';
      if (position === 'vice_leader') return '长老';
      if (position === 'elder') return '长老';
      if (position === 'elite') return '护法';
      return '弟子';
    };

    return (mySectInfo?.members ?? []).map((m) => ({
      id: String(m.characterId),
      name: m.nickname,
      role: mapRole(m.position),
      realm: m.realm,
      contribution: Number(m.contribution) || 0,
      online: false,
    }));
  }, [mySectInfo]);

  const myMember = useMemo(
    () => mySectInfo?.members.find((m) => m.nickname === playerName) ?? null,
    [mySectInfo, playerName]
  );

  const myContribution = useMemo(() => Number(myMember?.contribution) || 0, [myMember]);

  const canUpgradeBuilding = useMemo(() => {
    if (!myMember) return false;
    return myMember.position === 'leader' || myMember.position === 'vice_leader' || myMember.position === 'elder';
  }, [myMember]);

  const buildings = useMemo((): SectBuilding[] => {
    const metaByType: Record<string, { name: string; desc: string }> = {
      hall: { name: '宗门大殿', desc: '宗门核心建筑，提升成员上限并解锁更多功能。' },
      library: { name: '藏经阁', desc: '存放功法典籍，提高修炼效率。' },
      training_hall: { name: '演武场', desc: '宗门弟子修炼之地，提升修炼收益。' },
      alchemy_room: { name: '炼丹房', desc: '炼制丹药，提供日常补给。' },
      forge_house: { name: '炼器房', desc: '打造灵器法宝，提升装备品质。' },
      spirit_array: { name: '聚灵阵', desc: '汇聚天地灵气，提升修炼速度。' },
      defense_array: { name: '护山大阵', desc: '守护宗门的阵法，提升宗门整体防御。' },
    };

    const effectText = (buildingType: string, level: number): string => {
      if (buildingType === 'hall') {
        const cap = 20 + Math.max(0, level - 1) * 5;
        return `成员上限 ${cap}`;
      }
      if (buildingType === 'training_hall') return `修炼收益 +${2 + Math.max(0, level - 1)}%`;
      if (buildingType === 'library') return `功法学习效率 +${2 + Math.max(0, level - 1)}%`;
      if (buildingType === 'alchemy_room') return `炼丹成功率 +${1 + Math.max(0, level - 1)}%`;
      if (buildingType === 'forge_house') return `炼器成功率 +${1 + Math.max(0, level - 1)}%`;
      if (buildingType === 'spirit_array') return `灵气回复 +${2 + Math.max(0, level - 1)}%`;
      if (buildingType === 'defense_array') return `宗门防御 +${3 + Math.max(0, level - 1)}%`;
      return '—';
    };

    const sectFunds = Number(mySectInfo?.sect.funds) || 0;
    const sectBuildPoints = Number(mySectInfo?.sect.build_points) || 0;

    return (mySectInfo?.buildings ?? []).map((b) => {
      const meta = metaByType[b.building_type] ?? { name: b.building_type, desc: '—' };
      const level = Number(b.level) || 1;
      const requirement = {
        upgradable: Boolean(b.requirement.upgradable),
        maxLevel: Number(b.requirement.maxLevel) || 10,
        nextLevel: b.requirement.nextLevel === null ? null : Number(b.requirement.nextLevel),
        funds: b.requirement.funds === null ? null : Number(b.requirement.funds),
        buildPoints: b.requirement.buildPoints === null ? null : Number(b.requirement.buildPoints),
        reason: b.requirement.reason ?? null,
      };
      const fundsNeed = requirement.funds ?? 0;
      const buildPointsNeed = requirement.buildPoints ?? 0;
      const canAfford = requirement.upgradable && sectFunds >= fundsNeed && sectBuildPoints >= buildPointsNeed;
      const fundsGap = requirement.upgradable ? Math.max(0, fundsNeed - sectFunds) : 0;
      const buildPointsGap = requirement.upgradable ? Math.max(0, buildPointsNeed - sectBuildPoints) : 0;
      return {
        id: String(b.id),
        buildingType: b.building_type,
        name: meta.name,
        level,
        desc: meta.desc,
        effect: effectText(b.building_type, level),
        requirement,
        canAfford,
        fundsGap,
        buildPointsGap,
      };
    });
  }, [mySectInfo]);

  const donateSpiritStonesAmount = useMemo(
    () => parseNonNegativeInteger(donateSpiritStonesInput),
    [donateSpiritStonesInput]
  );
  const donateSummary = useMemo(() => {
    if (donateSpiritStonesAmount === null) {
      return { canSubmit: false, reason: '请输入非负整数', added: 0 };
    }
    if (donateSpiritStonesAmount <= 0) {
      return { canSubmit: false, reason: '至少捐献1灵石', added: 0 };
    }
    if (donateSpiritStonesAmount > spiritStones) {
      return { canSubmit: false, reason: '灵石不足', added: 0 };
    }
    const added = donateSpiritStonesAmount * 10;
    return { canSubmit: true, reason: '', added };
  }, [donateSpiritStonesAmount, spiritStones]);

  const isLeader = myMember?.position === 'leader';

  const reset = () => {
    setJoinState('none');
    setActiveSectId('');
    setCreateOpen(false);
    setCreateName('');
    setCreateNotice('');
    closeDonateModal();
    setTab('members');
    setActionLoadingKey(null);
    setListLoading(false);
    setSects([]);
    setMySectInfo(null);
    setApplications([]);
    setApplicationsLoading(false);
    setHasPermission(false);
    setShopItems([]);
    setShopLoading(false);
  };

  const refreshList = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await searchSects(undefined, 1, 50);
      const list = res.success && res.list ? res.list : [];
      setSects(
        list.map((s) => ({
          id: s.id,
          name: s.name,
          level: Number(s.level) || 1,
          leader: '—',
          members: Number(s.memberCount) || 0,
          memberCap: Number(s.maxMembers) || 0,
          notice: String(s.announcement ?? '—'),
        }))
      );
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '获取宗门列表失败');
      setSects([]);
    } finally {
      setListLoading(false);
    }
  }, [message]);

  const refreshMySect = useCallback(
    async (resetIfNone: boolean) => {
      try {
        const res = await getMySect();
        const data: SectInfoDto | null = res.success ? (res.data ?? null) : null;
        if (data?.sect?.id) {
          setMySectInfo(data);
          setJoinState('joined');
          setActiveSectId(String(data.sect.id));
          return { joined: true, data };
        }

        setMySectInfo(null);
        if (resetIfNone) {
          setJoinState('none');
          setActiveSectId('');
          setTab('members');
        }
        return { joined: false, data: null };
      } catch (error: unknown) {
        const err = error as { message?: string };
        message.error(err.message || '获取我的宗门失败');
        return { joined: false, data: null };
      }
    },
    [message]
  );

  useEffect(() => {
    if (!open) return;
    reset();
    void refreshList();
    void refreshMySect(true);
  }, [open, refreshList, refreshMySect]);

  const applyJoin = useCallback(
    async (sectId: string) => {
      if (!sectId) return;
      setActionLoadingKey(`apply-${sectId}`);
      try {
        const res = await applyToSect(sectId);
        if (!res.success) throw new Error(res.message || '申请失败');
        message.success(res.message || '操作成功');
        await refreshList();
        const my = await refreshMySect(false);
        if (!my.joined) {
          setJoinState('pending');
          setActiveSectId(sectId);
        } else {
          setTab('members');
        }
      } catch (error: unknown) {
        const err = error as { message?: string };
        message.error(err.message || '申请失败');
      } finally {
        setActionLoadingKey(null);
      }
    },
    [message, refreshList, refreshMySect]
  );

  const leaveSectAction = useCallback(async () => {
    setActionLoadingKey('leave');
    try {
      const res = await leaveSectApi();
      if (!res.success) throw new Error(res.message || '退出失败');
      message.success(res.message || '已退出');
      await refreshMySect(true);
      await refreshList();
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '退出宗门失败');
    } finally {
      setActionLoadingKey(null);
    }
  }, [message, refreshList, refreshMySect]);

  const createSectAction = useCallback(async () => {
    const name = createName.trim();
    if (!name) return;
    if (!canAffordCreate) return;
    setActionLoadingKey('create');
    try {
      const res = await createSectApi(name, createNotice.trim() || undefined);
      if (!res.success) throw new Error(res.message || '创建失败');
      message.success(res.message || '创建成功');
      setCreateOpen(false);
      await refreshList();
      await refreshMySect(true);
      setTab('members');
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '创建宗门失败');
    } finally {
      setActionLoadingKey(null);
    }
  }, [canAffordCreate, createName, createNotice, message, refreshList, refreshMySect]);

  const donateAction = useCallback(async () => {
    if (!donateSummary.canSubmit) {
      message.warning(donateSummary.reason || '捐献参数无效');
      return;
    }
    const donateAmount = donateSpiritStonesAmount ?? 0;
    setActionLoadingKey('donate');
    try {
      const res = await donateToSect(donateAmount);
      if (!res.success) throw new Error(res.message || '捐献失败');
      message.success(res.message || '捐献成功');
      closeDonateModal();
      await refreshMySect(false);
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '捐献失败');
    } finally {
      setActionLoadingKey(null);
    }
  }, [closeDonateModal, donateSpiritStonesAmount, donateSummary, message, refreshMySect]);

  const fetchShop = useCallback(async () => {
    setShopLoading(true);
    try {
      const res = await getSectShop();
      if (!res.success) throw new Error(res.message || '获取失败');
      setShopItems(res.data ?? []);
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '获取宗门商店失败');
      setShopItems([]);
    } finally {
      setShopLoading(false);
    }
  }, [message]);

  const buyShopItem = useCallback(
    async (item: SectShopItemDto) => {
      const loadingKey = `shop-buy-${item.id}`;
      setActionLoadingKey(loadingKey);
      try {
        const res = await buyFromSectShop(item.id, 1);
        if (!res.success) throw new Error(res.message || '购买失败');
        message.success(res.message || '购买成功');
        await refreshMySect(false);
        await fetchShop();
      } catch (error: unknown) {
        const err = error as { message?: string };
        message.error(err.message || '购买失败');
      } finally {
        setActionLoadingKey(null);
      }
    },
    [fetchShop, message, refreshMySect]
  );

  // 检查是否有管理权限（宗主、副宗主、长老）
  const checkPermission = useCallback(() => {
    const permitted = myMember?.position === 'leader' || myMember?.position === 'vice_leader' || myMember?.position === 'elder';
    setHasPermission(permitted);
    return permitted;
  }, [myMember]);

  // 获取申请列表
  const fetchApplications = useCallback(async () => {
    if (!checkPermission()) {
      setApplications([]);
      return;
    }
    setApplicationsLoading(true);
    try {
      const res = await getSectApplications();
      if (res.success && res.data) {
        setApplications(res.data);
      } else {
        setApplications([]);
      }
    } catch {
      setApplications([]);
    } finally {
      setApplicationsLoading(false);
    }
  }, [checkPermission]);

  // 处理申请
  const handleAppAction = useCallback(
    async (applicationId: number, approve: boolean) => {
      setActionLoadingKey(`app-${applicationId}`);
      try {
        const res = await handleSectApplication(applicationId, approve);
        if (!res.success) throw new Error(res.message || '操作失败');
        message.success(res.message || '操作成功');
        await fetchApplications();
        await refreshMySect(false);
      } catch (error: unknown) {
        const err = error as { message?: string };
        message.error(err.message || '操作失败');
      } finally {
        setActionLoadingKey(null);
      }
    },
    [message, fetchApplications, refreshMySect]
  );

  // 切换到宗门管理标签页时加载申请列表
  useEffect(() => {
    if (tab === 'manage' && joinState === 'joined') {
      void fetchApplications();
    }
  }, [tab, joinState, fetchApplications]);

  useEffect(() => {
    if (tab === 'shop' && joinState === 'joined') {
      void fetchShop();
    }
  }, [tab, joinState, fetchShop]);

  // 格式化相对时间
  const formatRelativeTime = useCallback((dateString: string) => {
    const now = Date.now();
    const past = new Date(dateString).getTime();
    const diff = now - past;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    return `${days}天前`;
  }, []);

  const renderNoSect = () => (
    <div className="sect-pane">
      <div className="sect-pane-top">
        <div className="sect-top-left">
          <div className="sect-title">宗门列表</div>
          <div className="sect-subtitle">未加入宗门，可申请加入或创建宗门</div>
        </div>
        <div className="sect-top-actions">
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            创建宗门
          </Button>
        </div>
      </div>

      <div className="sect-pane-body">
        <Table
          size="small"
          rowKey={(row) => row.id}
          pagination={false}
          className="sect-table"
          loading={listLoading}
          columns={[
            { title: '宗门', dataIndex: 'name', key: 'name', width: 180 },
            { title: '等级', dataIndex: 'level', key: 'level', width: 80, render: (v: number) => `Lv.${v}` },
            { title: '宗主', dataIndex: 'leader', key: 'leader', width: 120 },
            {
              title: '成员',
              dataIndex: 'members',
              key: 'members',
              width: 120,
              render: (_: number, row: SectItem) => `${row.members}/${row.memberCap}`,
            },
            { title: '宣言', dataIndex: 'notice', key: 'notice' },
            {
              title: '操作',
              key: 'action',
              width: 140,
              render: (_: unknown, row: SectItem) => {
                const isCurrent = activeSectId === row.id;
                const disabled = joinState !== 'none' && !isCurrent;
                const pending = joinState === 'pending' && isCurrent;
                return (
                  <Button
                    type={pending ? 'default' : 'primary'}
                    disabled={disabled || joinState === 'joined'}
                    loading={actionLoadingKey === `apply-${row.id}`}
                    onClick={() => applyJoin(row.id)}
                  >
                    {pending ? '已申请' : '申请加入'}
                  </Button>
                );
              },
            },
          ]}
          dataSource={sects}
        />
      </div>
    </div>
  );

  const renderInfo = () => {
    const s = joinedSect;
    if (!s) return null;
    return (
      <div className="sect-info">
        <div className="sect-card">
          <div className="sect-card-left">
            <div className="sect-card-name">{s.name}</div>
            <div className="sect-card-meta">
              <Tag color="blue">Lv.{s.level}</Tag>
              <Tag color="default">宗主 {s.leader}</Tag>
              <Tag color="default">
                成员 {s.members}/{s.memberCap}
              </Tag>
            </div>
            <div className="sect-card-notice">{s.notice}</div>
          </div>
        </div>
        <div className="sect-grid">
          <div className="sect-stat">
            <div className="sect-stat-k">宗门资金</div>
            <div className="sect-stat-v">{s.funds.toLocaleString()}</div>
          </div>
          <div className="sect-stat">
            <div className="sect-stat-k">宗门贡献</div>
            <div className="sect-stat-v">{s.buildPoints.toLocaleString()}</div>
          </div>
          <div className="sect-stat">
            <div className="sect-stat-k">宗门声望</div>
            <div className="sect-stat-v">{s.reputation.toLocaleString()}</div>
          </div>
          <div className="sect-stat">
            <div className="sect-stat-k">今日捐献</div>
            <div className="sect-stat-v">—</div>
          </div>
        </div>
      </div>
    );
  };

  const renderMembers = () => (
    <div className="sect-panel">
      <div className="sect-panel-title">宗门成员</div>
      <div className="sect-panel-body sect-members-body">
        <Table
          size="small"
          rowKey={(row) => row.id}
          pagination={false}
          className="sect-table"
          columns={[
            {
              title: '成员',
              dataIndex: 'name',
              key: 'name',
              width: 140,
              sorter: (a: SectMember, b: SectMember) => a.name.localeCompare(b.name, 'zh'),
            },
            {
              title: '职位',
              dataIndex: 'role',
              key: 'role',
              width: 100,
              sorter: (a: SectMember, b: SectMember) => {
                const rank: Record<SectMember['role'], number> = { 宗主: 0, 长老: 1, 护法: 2, 弟子: 3 };
                return (rank[a.role] ?? 99) - (rank[b.role] ?? 99);
              },
            },
            {
              title: '境界',
              dataIndex: 'realm',
              key: 'realm',
              width: 120,
              sorter: (a: SectMember, b: SectMember) => a.realm.localeCompare(b.realm, 'zh'),
            },
            {
              title: '贡献',
              dataIndex: 'contribution',
              key: 'contribution',
              width: 120,
              render: (v: number) => v.toLocaleString(),
              sorter: (a: SectMember, b: SectMember) => a.contribution - b.contribution,
            },
            {
              title: '在线',
              dataIndex: 'online',
              key: 'online',
              width: 90,
              render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '在线' : '离线'}</Tag>,
              sorter: (a: SectMember, b: SectMember) => Number(a.online) - Number(b.online),
            },
            ...(isLeader
              ? [
                  {
                    title: '操作',
                    key: 'action',
                    width: 110,
                    render: () => (
                      <Button size="small" type="primary">
                        管理
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
          dataSource={members}
        />
      </div>
      <div className="sect-panel-footer">
        <Button danger onClick={leaveSectAction} loading={actionLoadingKey === 'leave'}>
          退出宗门
        </Button>
      </div>
    </div>
  );

  const renderBuildings = () => (
    <div className="sect-panel">
      <div className="sect-panel-title">宗门建筑</div>
      <div className="sect-panel-body">
        <div className="sect-buildings">
          {buildings.map((b) => {
            const loadingKey = `upgrade-${b.buildingType}`;
            const canTriggerUpgrade = b.requirement.upgradable && canUpgradeBuilding && b.canAfford;
            const missingParts: string[] = [];
            if (b.fundsGap > 0) missingParts.push(`资金 ${b.fundsGap.toLocaleString()}`);
            if (b.buildPointsGap > 0) missingParts.push(`建设点 ${b.buildPointsGap.toLocaleString()}`);
            const requirementStatusText = b.requirement.upgradable
              ? b.canAfford
                ? '资源满足，可进行升级'
                : `资源不足：${missingParts.join('，')}`
              : b.requirement.reason || '暂不可升级';
            const upgradeBtnText = !b.requirement.upgradable
              ? b.requirement.reason || '暂不可升级'
              : !canUpgradeBuilding
                ? '无权限'
                : !b.canAfford
                  ? '资源不足'
                  : '升级';
            return (
              <div key={b.id} className={`sect-building${b.requirement.upgradable ? '' : ' sect-building-disabled'}`}>
                <div className="sect-building-top">
                  <div className="sect-building-name-wrap">
                    <div className="sect-building-name">{b.name}</div>
                    <div className="sect-building-level-path">
                      {b.requirement.nextLevel ? `Lv.${b.level} -> Lv.${b.requirement.nextLevel}` : `Lv.${b.level} / Lv.${b.requirement.maxLevel}`}
                    </div>
                  </div>
                  <Tag color={b.requirement.upgradable ? 'blue' : 'default'}>
                    {b.requirement.upgradable ? '可升级' : b.requirement.reason || '暂不可升级'}
                  </Tag>
                </div>
                <div className="sect-building-desc">{b.desc}</div>
                <div className="sect-building-effect">{b.effect}</div>
                <div className="sect-building-requirements">
                  <div className="sect-building-requirements-title">升级需求</div>
                  {b.requirement.upgradable ? (
                    <div className="sect-building-requirements-grid">
                      <div className={`sect-building-requirement-item${b.fundsGap > 0 ? ' is-lack' : ''}`}>
                        <span>宗门资金</span>
                        <strong>{(b.requirement.funds ?? 0).toLocaleString()}</strong>
                      </div>
                      <div className={`sect-building-requirement-item${b.buildPointsGap > 0 ? ' is-lack' : ''}`}>
                        <span>建设点</span>
                        <strong>{(b.requirement.buildPoints ?? 0).toLocaleString()}</strong>
                      </div>
                    </div>
                  ) : (
                    <div className="sect-building-requirement-locked">{b.requirement.reason || '暂不可升级'}</div>
                  )}
                  <div className={`sect-building-requirements-note${b.requirement.upgradable && !b.canAfford ? ' is-lack' : ''}`}>
                    {requirementStatusText}
                  </div>
                </div>
                <div className="sect-building-actions">
                  <Button
                    className="sect-building-upgrade-btn"
                    size="small"
                    onClick={async () => {
                      if (!canTriggerUpgrade) return;
                      setActionLoadingKey(loadingKey);
                      try {
                        const res = await upgradeSectBuilding(b.buildingType);
                        if (!res.success) throw new Error(res.message || '升级失败');
                        message.success(res.message || '升级成功');
                        await refreshMySect(false);
                      } catch (error: unknown) {
                        const err = error as { message?: string };
                        message.error(err.message || '升级失败');
                      } finally {
                        setActionLoadingKey(null);
                      }
                    }}
                    loading={actionLoadingKey === loadingKey}
                    disabled={!canTriggerUpgrade}
                  >
                    {upgradeBtnText}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  const renderShop = () => (
    <div className="sect-panel">
      <div className="sect-panel-title">宗门商店</div>
      <div className="sect-panel-body">
        <div className="sect-shop-head">
          <div className="sect-shop-head-label">当前贡献</div>
          <div className="sect-shop-head-value">{myContribution.toLocaleString()}</div>
        </div>
        {shopLoading ? (
          <div className="sect-empty">商店加载中...</div>
        ) : shopItems.length === 0 ? (
          <div className="sect-empty">暂无可兑换商品</div>
        ) : (
          <div className="sect-shop-grid">
            {shopItems.map((item) => {
              const affordable = myContribution >= item.costContribution;
              const loadingKey = `shop-buy-${item.id}`;
              const rawDailyLimit = Number(item.limitDaily);
              const dailyLimit = Number.isFinite(rawDailyLimit) ? Math.max(0, Math.floor(rawDailyLimit)) : 0;
              return (
                <div key={item.id} className="sect-shop-card">
                  <div className="sect-shop-card-top">
                    <div className="sect-shop-name">{item.name}</div>
                    <Tag color={affordable ? 'blue' : 'default'}>贡献 {item.costContribution.toLocaleString()}</Tag>
                  </div>
                  <div className="sect-shop-meta">
                    <Tag>数量 x{item.qty}</Tag>
                    {dailyLimit > 0 ? <Tag>每日限购 {dailyLimit}</Tag> : null}
                  </div>
                  <Button
                    type="primary"
                    size="small"
                    loading={actionLoadingKey === loadingKey}
                    disabled={!affordable}
                    onClick={() => {
                      void buyShopItem(item);
                    }}
                  >
                    {affordable ? '兑换' : '贡献不足'}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  const renderActivity = () => (
    <div className="sect-panel">
      <div className="sect-panel-title">宗门活动</div>
      <div className="sect-panel-body">
        <div className="sect-empty">敬请期待</div>
      </div>
    </div>
  );

  const renderManage = () => {
    const renderApplications = () => {
      if (!hasPermission) return null;
      return (
        <div className="sect-manage-section">
          <div className="sect-manage-section-header">
            <div className="sect-manage-section-title">入门申请</div>
            <Button
              size="small"
              loading={applicationsLoading}
              onClick={() => fetchApplications()}
              icon={<span className="sect-refresh-icon">↻</span>}
            >
              刷新
            </Button>
          </div>
          {applications.length === 0 ? (
            <div className="sect-applications-empty">暂无入门申请</div>
          ) : (
            <div className="sect-applications-grid">
              {applications.map((app) => (
                <div key={app.id} className="sect-application-card">
                  <div className="sect-application-header">
                    <div className="sect-application-avatar">
                      <span className="sect-application-avatar-text">{app.nickname.charAt(0)}</span>
                    </div>
                    <div className="sect-application-info">
                      <div className="sect-application-name">{app.nickname}</div>
                      <div className="sect-application-meta">
                        <Tag color="cyan">{app.realm}</Tag>
                        <span className="sect-application-time">{formatRelativeTime(app.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                  {app.message && (
                    <div className="sect-application-message">
                      <span className="sect-application-message-label">申请留言：</span>
                      {app.message}
                    </div>
                  )}
                  <div className="sect-application-actions">
                    <Button
                      size="small"
                      danger
                      loading={actionLoadingKey === `app-${app.id}`}
                      onClick={() => handleAppAction(app.id, false)}
                      disabled={actionLoadingKey !== null}
                    >
                      拒绝
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      loading={actionLoadingKey === `app-${app.id}`}
                      onClick={() => handleAppAction(app.id, true)}
                      disabled={actionLoadingKey !== null}
                    >
                      同意
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    };

    return (
      <div className="sect-panel">
        <div className="sect-panel-title">宗门管理</div>
        <div className="sect-panel-body">
          {renderApplications()}
          <div className="sect-manage-section">
            <div className="sect-manage-section-title">管理功能</div>
            <div className="sect-manage-grid">
              <div className="sect-manage-card">
                <div className="sect-manage-name">宗门捐献</div>
                <div className="sect-manage-desc">仅支持灵石捐献，比例 1 灵石 = 10 贡献。</div>
                <Button
                  type="primary"
                  onClick={() => {
                    setDonateOpen(true);
                  }}
                >
                  立即捐献
                </Button>
              </div>
              <div className="sect-manage-card">
                <div className="sect-manage-name">成员管理</div>
                <div className="sect-manage-desc">任命职位、处理申请、清理成员。</div>
                <Button>打开</Button>
              </div>
              <div className="sect-manage-card">
                <div className="sect-manage-name">公告设置</div>
                <div className="sect-manage-desc">编辑宗门宣言与公告内容。</div>
                <Button>编辑</Button>
              </div>
              <div className="sect-manage-card">
                <div className="sect-manage-name">宗门任务</div>
                <div className="sect-manage-desc">开启宗门任务，提高活跃度。</div>
                <Button>查看</Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderJoined = () => (
    <div className="sect-joined">
      <div className="sect-joined-top">{renderInfo()}</div>
      <div className="sect-joined-tabs">
        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as SectTabKey)}
          items={[
            { key: 'members', label: '宗门成员', children: renderMembers() },
            { key: 'buildings', label: '宗门建筑', children: renderBuildings() },
            { key: 'shop', label: '宗门商店', children: renderShop() },
            { key: 'activity', label: '宗门活动', children: renderActivity() },
            { key: 'manage', label: '宗门管理', children: renderManage() },
          ]}
        />
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={1080}
      className="sect-modal"
      destroyOnHidden
      maskClosable
    >
      <div className="sect-modal-shell">{joinState === 'joined' ? renderJoined() : renderNoSect()}</div>

      <Modal
        open={donateOpen}
        onCancel={closeDonateModal}
        centered
        width={560}
        title="宗门捐献"
        className="sect-submodal"
        destroyOnHidden
        okText="确认捐献"
        cancelText="取消"
        onOk={() => {
          void donateAction();
        }}
        confirmLoading={actionLoadingKey === 'donate'}
        okButtonProps={{ disabled: !donateSummary.canSubmit }}
      >
        <div className="sect-donate">
          <div className="sect-donate-balance">
            <div className="sect-donate-balance-item">
              <div className="sect-donate-balance-k">当前灵石</div>
              <div className="sect-donate-balance-v">{spiritStones.toLocaleString()}</div>
            </div>
          </div>
          <div className="sect-create-field">
            <div className="sect-create-label">捐献灵石</div>
            <Input
              value={donateSpiritStonesInput}
              onChange={(e) => setDonateSpiritStonesInput(e.target.value)}
              inputMode="numeric"
              placeholder="请输入灵石数量"
              maxLength={12}
            />
            <div className="sect-create-balance-text">比例：1 灵石 = 10 贡献（同步增加宗门资金）</div>
          </div>
          <div className="sect-donate-preview">
            <div className="sect-donate-preview-k">预计获得</div>
            <div className="sect-donate-preview-v">
              贡献 +{donateSummary.added.toLocaleString()}，宗门资金 +{donateSummary.added.toLocaleString()}
            </div>
            {donateSummary.canSubmit ? <Tag color="green">可捐献</Tag> : <Tag color="red">{donateSummary.reason}</Tag>}
          </div>
        </div>
      </Modal>

      <Modal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        centered
        width={560}
        title="创建宗门"
        className="sect-submodal"
        destroyOnHidden
        okText="确认创建"
        cancelText="取消"
        onOk={createSectAction}
        confirmLoading={actionLoadingKey === 'create'}
        okButtonProps={{ disabled: !createName.trim() || !canAffordCreate }}
      >
        <div className="sect-create">
          <div className="sect-create-cost">
            <img className="sect-create-cost-icon" src={coin01} alt="灵石" />
            <div className="sect-create-cost-text">创建消耗：{createCost.toLocaleString()} 灵石</div>
          </div>
          <div className="sect-create-balance">
            <div className="sect-create-balance-text">当前灵石：{spiritStones.toLocaleString()}</div>
            {!canAffordCreate ? <Tag color="red">灵石不足</Tag> : <Tag color="green">可创建</Tag>}
          </div>
          <div className="sect-create-field">
            <div className="sect-create-label">宗门名称</div>
            <Input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="请输入宗门名称" maxLength={10} />
          </div>
          <div className="sect-create-field">
            <div className="sect-create-label">宗门宣言</div>
            <Input value={createNotice} onChange={(e) => setCreateNotice(e.target.value)} placeholder="一句话宗门宣言" maxLength={24} />
          </div>
        </div>
      </Modal>
    </Modal>
  );
};

export default SectModal;
