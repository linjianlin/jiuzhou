/**
 * 宗门数据 Hook。
 * 输入：弹窗开关、玩家昵称、当前灵石、状态变更回调。
 * 输出：宗门弹窗的全部状态、派生视图模型和动作函数。
 * 关键约束：
 * 1) 所有网络动作都在此收敛，组件层仅做展示与事件分发。
 * 2) 严格按权限决定可操作性，避免前端越权操作按钮可点。
 */
import { App } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  acceptSectQuest,
  appointSectPosition,
  applyToSect,
  buyFromSectShop,
  cancelSectApplication,
  claimSectQuest,
  createSect as createSectApi,
  disbandSect as disbandSectApi,
  donateToSect,
  getMySect,
  getMySectApplications,
  getSectApplications,
  getSectLogs,
  getSectQuests,
  getSectShop,
  handleSectApplication,
  kickSectMember,
  leaveSect as leaveSectApi,
  searchSects,
  submitSectQuest,
  transferSectLeader,
  type SectInfoDto,
  type SectMemberDto,
  type SectMyApplicationDto,
  updateSectAnnouncement,
  upgradeSectBuilding,
} from '../../../../../services/api';
import {
  APPOINTABLE_POSITION_OPTIONS,
  BUILDING_META_MAP,
  POSITION_LABEL_MAP,
  getBuildingEffectText,
} from '../constants';
import type {
  MemberActionDraft,
  SectBuildingVm,
  SectJoinedSummary,
  SectListItemVm,
  SectMemberVm,
  SectPermissionState,
  SectPanelKey,
  UseSectDataArgs,
  UseSectDataState,
} from '../types';

const CREATE_SECT_COST = 1000;

const parseNonNegativeInteger = (raw: string): number | null => {
  const value = raw.trim();
  if (!value) return 0;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) return null;
  return n;
};

const resolveErrorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === 'object' && error && 'message' in error) {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  return fallback;
};

const buildPermissionState = (member: SectMemberVm | null): SectPermissionState => {
  const position = member?.position;
  const canManageApplications = position === 'leader' || position === 'vice_leader' || position === 'elder';
  return {
    canManageApplications,
    canUpgradeBuilding: canManageApplications,
    canEditAnnouncement: canManageApplications,
    canKickMember: canManageApplications,
    canAppointPosition: position === 'leader' || position === 'vice_leader',
    canTransferLeader: position === 'leader',
    canDisbandSect: position === 'leader',
  };
};

const toMemberVm = (member: SectMemberDto): SectMemberVm => {
  return {
    characterId: Number(member.characterId) || 0,
    nickname: member.nickname,
    realm: member.realm,
    position: member.position,
    positionLabel: POSITION_LABEL_MAP[member.position],
    contribution: Number(member.contribution) || 0,
    weeklyContribution: Number(member.weeklyContribution) || 0,
    joinedAt: member.joinedAt,
    lastOfflineAt: typeof member.lastOfflineAt === 'string' ? member.lastOfflineAt : null,
  };
};

const getAppointDefault = (member: SectMemberVm): MemberActionDraft['appointPosition'] => {
  if (member.position === 'leader') return 'disciple';
  const matched = APPOINTABLE_POSITION_OPTIONS.find((item) => item.value === member.position);
  return matched ? matched.value : 'disciple';
};

export const useSectData = ({ open, spiritStones, playerName, onChanged }: UseSectDataArgs): UseSectDataState => {
  const { message } = App.useApp();

  const [panel, setPanel] = useState<SectPanelKey>('hall');
  const [joinState, setJoinState] = useState<'none' | 'pending' | 'joined'>('none');
  const [activeSectId, setActiveSectId] = useState('');
  const [searchKeyword, setSearchKeyword] = useState('');

  const [listLoading, setListLoading] = useState(false);
  const [myApplicationsLoading, setMyApplicationsLoading] = useState(false);
  const [applicationsLoading, setApplicationsLoading] = useState(false);
  const [shopLoading, setShopLoading] = useState(false);
  const [questsLoading, setQuestsLoading] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [actionLoadingKey, setActionLoadingKey] = useState<string | null>(null);

  const [sects, setSects] = useState<SectListItemVm[]>([]);
  const [myApplications, setMyApplications] = useState<SectMyApplicationDto[]>([]);
  const [applications, setApplications] = useState<UseSectDataState['applications']>([]);
  const [shopItems, setShopItems] = useState<UseSectDataState['shopItems']>([]);
  const [quests, setQuests] = useState<UseSectDataState['quests']>([]);
  const [logs, setLogs] = useState<UseSectDataState['logs']>([]);
  const [mySectInfo, setMySectInfo] = useState<SectInfoDto | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createNotice, setCreateNotice] = useState('');

  const [donateOpen, setDonateOpen] = useState(false);
  const [donateSpiritStonesInput, setDonateSpiritStonesInput] = useState('');

  const [announcementOpen, setAnnouncementOpen] = useState(false);
  const [announcementDraft, setAnnouncementDraft] = useState('');

  const [memberActionOpen, setMemberActionOpen] = useState(false);
  const [memberActionDraft, setMemberActionDraft] = useState<MemberActionDraft>({
    target: null,
    appointPosition: 'disciple',
  });

  const notifyChanged = useCallback(() => {
    onChanged?.();
  }, [onChanged]);

  const canAffordCreate = spiritStones >= CREATE_SECT_COST;

  const joinedSect = useMemo<SectJoinedSummary | null>(() => {
    if (!mySectInfo?.sect) return null;
    const leaderName = mySectInfo.members.find((member) => member.position === 'leader')?.nickname ?? '—';
    return {
      id: mySectInfo.sect.id,
      name: mySectInfo.sect.name,
      level: Number(mySectInfo.sect.level) || 1,
      leader: leaderName,
      members: Number(mySectInfo.sect.member_count) || 0,
      memberCap: Number(mySectInfo.sect.max_members) || 0,
      notice: String(mySectInfo.sect.announcement ?? mySectInfo.sect.description ?? '暂无公告'),
      funds: Number(mySectInfo.sect.funds) || 0,
      buildPoints: Number(mySectInfo.sect.build_points) || 0,
      reputation: Number(mySectInfo.sect.reputation) || 0,
    };
  }, [mySectInfo]);

  const members = useMemo<SectMemberVm[]>(() => {
    return (mySectInfo?.members ?? []).map(toMemberVm);
  }, [mySectInfo]);

  const myMember = useMemo<SectMemberVm | null>(() => {
    const foundByName = members.find((member) => member.nickname === playerName);
    if (foundByName) return foundByName;
    return members[0] ?? null;
  }, [members, playerName]);

  const permissions = useMemo(() => buildPermissionState(myMember), [myMember]);

  const myContribution = useMemo(() => {
    return Number(myMember?.contribution) || 0;
  }, [myMember]);

  const buildings = useMemo<SectBuildingVm[]>(() => {
    const sectFunds = Number(mySectInfo?.sect.funds) || 0;
    const sectBuildPoints = Number(mySectInfo?.sect.build_points) || 0;

    return (mySectInfo?.buildings ?? []).map((building) => {
      const level = Number(building.level) || 1;
      const requirement = {
        upgradable: Boolean(building.requirement.upgradable),
        maxLevel: Number(building.requirement.maxLevel) || 10,
        nextLevel: building.requirement.nextLevel === null ? null : Number(building.requirement.nextLevel),
        funds: building.requirement.funds === null ? null : Number(building.requirement.funds),
        buildPoints: building.requirement.buildPoints === null ? null : Number(building.requirement.buildPoints),
        reason: building.requirement.reason ?? null,
      };

      const fundsNeed = requirement.funds ?? 0;
      const buildPointsNeed = requirement.buildPoints ?? 0;
      const canAfford = requirement.upgradable && sectFunds >= fundsNeed && sectBuildPoints >= buildPointsNeed;
      const fundsGap = requirement.upgradable ? Math.max(0, fundsNeed - sectFunds) : 0;
      const buildPointsGap = requirement.upgradable ? Math.max(0, buildPointsNeed - sectBuildPoints) : 0;
      const meta = BUILDING_META_MAP[building.building_type] ?? { name: building.building_type, desc: '—' };

      return {
        id: Number(building.id),
        buildingType: building.building_type,
        name: meta.name,
        desc: meta.desc,
        effect: getBuildingEffectText(building.building_type, level),
        nextEffect: requirement.nextLevel ? getBuildingEffectText(building.building_type, requirement.nextLevel) : null,
        level,
        requirement,
        canAfford,
        fundsGap,
        buildPointsGap,
      };
    });
  }, [mySectInfo]);

  const donateSpiritStonesAmount = useMemo(() => parseNonNegativeInteger(donateSpiritStonesInput), [donateSpiritStonesInput]);

  const donateSummary = useMemo(() => {
    if (donateSpiritStonesAmount === null) return { canSubmit: false, reason: '请输入非负整数', added: 0 };
    if (donateSpiritStonesAmount <= 0) return { canSubmit: false, reason: '至少捐献1灵石', added: 0 };
    if (donateSpiritStonesAmount > spiritStones) return { canSubmit: false, reason: '灵石不足', added: 0 };
    return { canSubmit: true, reason: '', added: donateSpiritStonesAmount * 10 };
  }, [donateSpiritStonesAmount, spiritStones]);

  const syncJoinState = useCallback(
    (nextSectInfo: SectInfoDto | null, nextMyApplications: SectMyApplicationDto[], resetPanel: boolean) => {
      if (nextSectInfo?.sect?.id) {
        setJoinState('joined');
        setActiveSectId(nextSectInfo.sect.id);
        if (resetPanel) setPanel('overview');
        return;
      }

      if (nextMyApplications.length > 0) {
        setJoinState('pending');
        setActiveSectId(nextMyApplications[0].sectId);
        if (resetPanel) setPanel('hall');
        return;
      }

      setJoinState('none');
      setActiveSectId('');
      if (resetPanel) setPanel('hall');
    },
    []
  );

  const refreshListByKeyword = useCallback(async (keywordRaw: string) => {
    setListLoading(true);
    try {
      const keyword = keywordRaw.trim();
      const res = await searchSects(keyword || undefined, 1, 50);
      const rows = res.success && res.list ? res.list : [];
      setSects(
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          level: Number(row.level) || 1,
          members: Number(row.memberCount) || 0,
          memberCap: Number(row.maxMembers) || 0,
          notice: String(row.announcement ?? '暂无宣言'),
          joinType: row.joinType,
          joinMinRealm: row.joinMinRealm,
        }))
      );
    } catch (error) {
      message.error(resolveErrorMessage(error, '获取宗门列表失败'));
      setSects([]);
    } finally {
      setListLoading(false);
    }
  }, [message]);

  const refreshList = useCallback(async () => {
    await refreshListByKeyword(searchKeyword);
  }, [refreshListByKeyword, searchKeyword]);

  const loadMySectInfo = useCallback(async (): Promise<SectInfoDto | null> => {
    try {
      const res = await getMySect();
      const data = res.success ? (res.data ?? null) : null;
      setMySectInfo(data);
      return data;
    } catch (error) {
      message.error(resolveErrorMessage(error, '获取我的宗门失败'));
      setMySectInfo(null);
      return null;
    }
  }, [message]);

  const loadMyApplications = useCallback(async (): Promise<SectMyApplicationDto[]> => {
    setMyApplicationsLoading(true);
    try {
      const res = await getMySectApplications();
      const data = res.success && res.data ? res.data : [];
      setMyApplications(data);
      return data;
    } catch (error) {
      message.error(resolveErrorMessage(error, '获取我的申请失败'));
      setMyApplications([]);
      return [];
    } finally {
      setMyApplicationsLoading(false);
    }
  }, [message]);

  const refreshMyApplications = useCallback(async () => {
    await loadMyApplications();
  }, [loadMyApplications]);

  const refreshJoinContext = useCallback(
    async (resetPanel: boolean) => {
      const [sectInfo, appList] = await Promise.all([loadMySectInfo(), loadMyApplications()]);
      syncJoinState(sectInfo, appList, resetPanel);
    },
    [loadMyApplications, loadMySectInfo, syncJoinState]
  );

  const fetchApplications = useCallback(async () => {
    if (joinState !== 'joined' || !permissions.canManageApplications) {
      setApplications([]);
      return;
    }
    setApplicationsLoading(true);
    try {
      const res = await getSectApplications();
      setApplications(res.success && res.data ? res.data : []);
    } catch (error) {
      message.error(resolveErrorMessage(error, '获取入门申请失败'));
      setApplications([]);
    } finally {
      setApplicationsLoading(false);
    }
  }, [joinState, message, permissions.canManageApplications]);

  const fetchShop = useCallback(async () => {
    if (joinState !== 'joined') {
      setShopItems([]);
      return;
    }
    setShopLoading(true);
    try {
      const res = await getSectShop();
      setShopItems(res.success && res.data ? res.data : []);
    } catch (error) {
      message.error(resolveErrorMessage(error, '获取宗门商店失败'));
      setShopItems([]);
    } finally {
      setShopLoading(false);
    }
  }, [joinState, message]);

  const fetchQuests = useCallback(async () => {
    if (joinState !== 'joined') {
      setQuests([]);
      return;
    }
    setQuestsLoading(true);
    try {
      const res = await getSectQuests();
      setQuests(res.success && res.data ? res.data : []);
    } catch (error) {
      message.error(resolveErrorMessage(error, '获取宗门任务失败'));
      setQuests([]);
    } finally {
      setQuestsLoading(false);
    }
  }, [joinState, message]);

  const fetchLogs = useCallback(async () => {
    if (joinState !== 'joined') {
      setLogs([]);
      return;
    }
    setLogsLoading(true);
    try {
      const res = await getSectLogs(50);
      setLogs(res.success && res.data ? res.data : []);
    } catch (error) {
      message.error(resolveErrorMessage(error, '获取宗门日志失败'));
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }, [joinState, message]);

  const applyJoin = useCallback(
    async (sectId: string) => {
      if (!sectId || joinState === 'joined') return;
      const loadingKey = `apply-${sectId}`;
      setActionLoadingKey(loadingKey);
      try {
        const res = await applyToSect(sectId);
        if (!res.success) throw new Error(res.message || '申请失败');
        message.success(res.message || '申请成功');
        await Promise.all([refreshList(), refreshJoinContext(false)]);
        notifyChanged();
      } catch (error) {
        message.error(resolveErrorMessage(error, '申请加入失败'));
      } finally {
        setActionLoadingKey(null);
      }
    },
    [joinState, message, notifyChanged, refreshJoinContext, refreshList]
  );

  const cancelMyApplication = useCallback(
    async (applicationId: number) => {
      const loadingKey = `cancel-apply-${applicationId}`;
      setActionLoadingKey(loadingKey);
      try {
        const res = await cancelSectApplication(applicationId);
        if (!res.success) throw new Error(res.message || '取消失败');
        message.success(res.message || '已取消申请');
        await Promise.all([refreshList(), refreshJoinContext(false)]);
        notifyChanged();
      } catch (error) {
        message.error(resolveErrorMessage(error, '取消申请失败'));
      } finally {
        setActionLoadingKey(null);
      }
    },
    [message, notifyChanged, refreshJoinContext, refreshList]
  );

  const leaveSectAction = useCallback(async () => {
    setActionLoadingKey('leave');
    try {
      const res = await leaveSectApi();
      if (!res.success) throw new Error(res.message || '退出失败');
      message.success(res.message || '已退出宗门');
      await Promise.all([refreshList(), refreshJoinContext(true)]);
      notifyChanged();
    } catch (error) {
      message.error(resolveErrorMessage(error, '退出宗门失败'));
    } finally {
      setActionLoadingKey(null);
    }
  }, [message, notifyChanged, refreshJoinContext, refreshList]);

  const createSectAction = useCallback(async () => {
    const name = createName.trim();
    if (!name) {
      message.warning('请输入宗门名称');
      return;
    }
    if (spiritStones < CREATE_SECT_COST) {
      message.warning('灵石不足，无法创建宗门');
      return;
    }

    setActionLoadingKey('create');
    try {
      const res = await createSectApi(name, createNotice.trim() || undefined);
      if (!res.success) throw new Error(res.message || '创建失败');
      message.success(res.message || '创建成功');
      setCreateOpen(false);
      setCreateName('');
      setCreateNotice('');
      await Promise.all([refreshList(), refreshJoinContext(true)]);
      notifyChanged();
    } catch (error) {
      message.error(resolveErrorMessage(error, '创建宗门失败'));
    } finally {
      setActionLoadingKey(null);
    }
  }, [createName, createNotice, message, notifyChanged, refreshJoinContext, refreshList, spiritStones]);

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
      setDonateOpen(false);
      setDonateSpiritStonesInput('');
      await Promise.all([loadMySectInfo(), fetchLogs()]);
      notifyChanged();
    } catch (error) {
      message.error(resolveErrorMessage(error, '捐献失败'));
    } finally {
      setActionLoadingKey(null);
    }
  }, [donateSpiritStonesAmount, donateSummary, fetchLogs, loadMySectInfo, message, notifyChanged]);

  const upgradeBuildingAction = useCallback(
    async (buildingType: string) => {
      const loadingKey = `upgrade-${buildingType}`;
      setActionLoadingKey(loadingKey);
      try {
        const res = await upgradeSectBuilding(buildingType);
        if (!res.success) throw new Error(res.message || '升级失败');
        message.success(res.message || '升级成功');
        await Promise.all([loadMySectInfo(), fetchLogs()]);
      } catch (error) {
        message.error(resolveErrorMessage(error, '升级建筑失败'));
      } finally {
        setActionLoadingKey(null);
      }
    },
    [fetchLogs, loadMySectInfo, message]
  );

  const buyShopItemAction = useCallback(
    async (itemId: string) => {
      const loadingKey = `shop-buy-${itemId}`;
      setActionLoadingKey(loadingKey);
      try {
        const res = await buyFromSectShop(itemId, 1);
        if (!res.success) throw new Error(res.message || '兑换失败');
        message.success(res.message || '兑换成功');
        await Promise.all([fetchShop(), loadMySectInfo()]);
      } catch (error) {
        message.error(resolveErrorMessage(error, '兑换失败'));
      } finally {
        setActionLoadingKey(null);
      }
    },
    [fetchShop, loadMySectInfo, message]
  );

  const acceptQuestAction = useCallback(
    async (questId: string) => {
      const loadingKey = `quest-accept-${questId}`;
      setActionLoadingKey(loadingKey);
      try {
        const res = await acceptSectQuest(questId);
        if (!res.success) throw new Error(res.message || '接取失败');
        message.success(res.message || '接取成功');
        await fetchQuests();
      } catch (error) {
        message.error(resolveErrorMessage(error, '接取任务失败'));
      } finally {
        setActionLoadingKey(null);
      }
    },
    [fetchQuests, message]
  );

  const submitQuestAction = useCallback(
    async (questId: string) => {
      const loadingKey = `quest-submit-${questId}`;
      setActionLoadingKey(loadingKey);
      try {
        const res = await submitSectQuest(questId);
        if (!res.success) throw new Error(res.message || '提交失败');
        message.success(res.message || '提交成功');
        await Promise.all([fetchQuests(), loadMySectInfo()]);
      } catch (error) {
        message.error(resolveErrorMessage(error, '提交任务失败'));
      } finally {
        setActionLoadingKey(null);
      }
    },
    [fetchQuests, loadMySectInfo, message]
  );

  const claimQuestAction = useCallback(
    async (questId: string) => {
      const loadingKey = `quest-claim-${questId}`;
      setActionLoadingKey(loadingKey);
      try {
        const res = await claimSectQuest(questId);
        if (!res.success) throw new Error(res.message || '领取失败');
        message.success(res.message || '领取成功');
        await Promise.all([fetchQuests(), loadMySectInfo()]);
      } catch (error) {
        message.error(resolveErrorMessage(error, '领取任务奖励失败'));
      } finally {
        setActionLoadingKey(null);
      }
    },
    [fetchQuests, loadMySectInfo, message]
  );

  const handleApplicationAction = useCallback(
    async (applicationId: number, approve: boolean) => {
      const loadingKey = `app-${applicationId}`;
      setActionLoadingKey(loadingKey);
      try {
        const res = await handleSectApplication(applicationId, approve);
        if (!res.success) throw new Error(res.message || '处理失败');
        message.success(res.message || '处理成功');
        await Promise.all([fetchApplications(), loadMySectInfo(), fetchLogs()]);
        notifyChanged();
      } catch (error) {
        message.error(resolveErrorMessage(error, '处理入门申请失败'));
      } finally {
        setActionLoadingKey(null);
      }
    },
    [fetchApplications, fetchLogs, loadMySectInfo, message, notifyChanged]
  );

  const updateAnnouncementAction = useCallback(async () => {
    setActionLoadingKey('update-announcement');
    try {
      const res = await updateSectAnnouncement(announcementDraft);
      if (!res.success) throw new Error(res.message || '更新失败');
      message.success(res.message || '公告更新成功');
      setAnnouncementOpen(false);
      await Promise.all([loadMySectInfo(), fetchLogs()]);
    } catch (error) {
      message.error(resolveErrorMessage(error, '更新公告失败'));
    } finally {
      setActionLoadingKey(null);
    }
  }, [announcementDraft, fetchLogs, loadMySectInfo, message]);

  const appointPositionAction = useCallback(
    async (targetId: number, position: MemberActionDraft['appointPosition']) => {
      setActionLoadingKey(`appoint-${targetId}`);
      try {
        const res = await appointSectPosition(targetId, position);
        if (!res.success) throw new Error(res.message || '任命失败');
        message.success(res.message || '任命成功');
        await Promise.all([loadMySectInfo(), fetchLogs()]);
      } catch (error) {
        message.error(resolveErrorMessage(error, '任命职位失败'));
      } finally {
        setActionLoadingKey(null);
      }
    },
    [fetchLogs, loadMySectInfo, message]
  );

  const kickMemberAction = useCallback(
    async (targetId: number) => {
      setActionLoadingKey(`kick-${targetId}`);
      try {
        const res = await kickSectMember(targetId);
        if (!res.success) throw new Error(res.message || '踢出失败');
        message.success(res.message || '已踢出成员');
        setMemberActionOpen(false);
        await Promise.all([loadMySectInfo(), fetchApplications(), fetchLogs()]);
        notifyChanged();
      } catch (error) {
        message.error(resolveErrorMessage(error, '踢出成员失败'));
      } finally {
        setActionLoadingKey(null);
      }
    },
    [fetchApplications, fetchLogs, loadMySectInfo, message, notifyChanged]
  );

  const transferLeaderAction = useCallback(
    async (targetId: number) => {
      setActionLoadingKey(`transfer-${targetId}`);
      try {
        const res = await transferSectLeader(targetId);
        if (!res.success) throw new Error(res.message || '转让失败');
        message.success(res.message || '宗主转让成功');
        setMemberActionOpen(false);
        await Promise.all([loadMySectInfo(), fetchApplications(), fetchLogs()]);
      } catch (error) {
        message.error(resolveErrorMessage(error, '转让宗主失败'));
      } finally {
        setActionLoadingKey(null);
      }
    },
    [fetchApplications, fetchLogs, loadMySectInfo, message]
  );

  const disbandSectAction = useCallback(async () => {
    setActionLoadingKey('disband');
    try {
      const res = await disbandSectApi();
      if (!res.success) throw new Error(res.message || '解散失败');
      message.success(res.message || '宗门已解散');
      await Promise.all([refreshList(), refreshJoinContext(true)]);
      notifyChanged();
    } catch (error) {
      message.error(resolveErrorMessage(error, '解散宗门失败'));
    } finally {
      setActionLoadingKey(null);
    }
  }, [message, notifyChanged, refreshJoinContext, refreshList]);

  const openMemberAction = useCallback((member: SectMemberVm) => {
    setMemberActionDraft({ target: member, appointPosition: getAppointDefault(member) });
    setMemberActionOpen(true);
  }, []);

  useEffect(() => {
    if (!open) {
      setPanel('hall');
      setJoinState('none');
      setActiveSectId('');
      setSearchKeyword('');
      setActionLoadingKey(null);
      setSects([]);
      setMyApplications([]);
      setApplications([]);
      setShopItems([]);
      setQuests([]);
      setLogs([]);
      setMySectInfo(null);
      setCreateOpen(false);
      setCreateName('');
      setCreateNotice('');
      setDonateOpen(false);
      setDonateSpiritStonesInput('');
      setAnnouncementOpen(false);
      setAnnouncementDraft('');
      setMemberActionOpen(false);
      setMemberActionDraft({ target: null, appointPosition: 'disciple' });
      return;
    }

    setSearchKeyword('');
    void Promise.all([refreshListByKeyword(''), refreshJoinContext(true)]);
  }, [open, refreshJoinContext, refreshListByKeyword]);

  useEffect(() => {
    if (!open || joinState !== 'joined') return;
    if (panel === 'shop') {
      void fetchShop();
      return;
    }
    if (panel === 'activity') {
      void fetchQuests();
      return;
    }
    if (panel === 'manage') {
      void fetchApplications();
      return;
    }
    if (panel === 'overview') {
      void fetchLogs();
    }
  }, [fetchApplications, fetchLogs, fetchQuests, fetchShop, joinState, open, panel]);

  return {
    joinState,
    activeSectId,
    panel,
    setPanel,
    searchKeyword,
    setSearchKeyword,
    listLoading,
    myApplicationsLoading,
    applicationsLoading,
    shopLoading,
    questsLoading,
    logsLoading,
    actionLoadingKey,

    sects,
    myApplications,
    applications,
    shopItems,
    quests,
    logs,
    mySectInfo,

    joinedSect,
    members,
    buildings,
    permissions,
    myMember,
    myContribution,

    createOpen,
    createName,
    createNotice,
    createCost: CREATE_SECT_COST,
    canAffordCreate,
    donateOpen,
    donateSpiritStonesInput,
    donateSummary,
    announcementOpen,
    announcementDraft,
    memberActionOpen,
    memberActionDraft,

    setCreateOpen,
    setCreateName,
    setCreateNotice,
    setDonateOpen,
    setDonateSpiritStonesInput,
    setAnnouncementOpen,
    setAnnouncementDraft,
    setMemberActionOpen,
    setMemberActionDraft,

    openMemberAction,
    refreshList,
    refreshMyApplications,
    fetchApplications,
    fetchShop,
    fetchQuests,
    fetchLogs,

    applyJoin,
    cancelMyApplication,
    leaveSectAction,
    createSectAction,
    donateAction,
    upgradeBuildingAction,
    buyShopItemAction,
    acceptQuestAction,
    submitQuestAction,
    claimQuestAction,
    handleApplicationAction,
    updateAnnouncementAction,
    appointPositionAction,
    kickMemberAction,
    transferLeaderAction,
    disbandSectAction,
  };
};
