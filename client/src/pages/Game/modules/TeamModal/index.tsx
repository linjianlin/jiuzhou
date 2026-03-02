import { App, Badge, Button, Input, Modal, Segmented, Select, Switch, Table, Tag, type TableProps } from 'antd';
import { SearchOutlined, UserOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IMG_COIN as coin01 } from '../../shared/imageAssets';
import { gameSocket, type CharacterData } from '../../../../services/gameSocket';
import {
  applyToTeam,
  createTeam,
  disbandTeam,
  getLobbyTeams,
  getMyTeam,
  getNearbyTeams,
  getReceivedInvitations,
  getTeamApplications,
  handleApplication,
  handleInvitation,
  kickMember,
  leaveTeam,
  transferLeader,
  updateTeamSettings,
  type TeamApplication,
  type TeamEntry,
  type TeamInfo,
  type TeamInvitation,
  type TeamMember,
} from '../../../../services/teamApi';
import { useIsMobile } from '../../shared/responsive';
import { REALM_ORDER } from '../../shared/realm';
import './index.scss';

type TeamPanelKey = 'my' | 'apply' | 'near' | 'lobby';
const teamMenuKeys: TeamPanelKey[] = ['my', 'apply', 'near', 'lobby'];
const LOBBY_SEARCH_DEBOUNCE_MS = 450;

interface TeamModalProps {
  open: boolean;
  onClose: () => void;
  playerName?: string;
}

const realmOptions = REALM_ORDER;

const TeamModal: React.FC<TeamModalProps> = ({ open, onClose, playerName = '我' }) => {
  const { message } = App.useApp();
  const messageRef = useRef(message);
  const [panel, setPanel] = useState<TeamPanelKey>('my');
  const isMobile = useIsMobile();
  const [lobbyQuery, setLobbyQuery] = useState('');
  const lobbyQueryRef = useRef('');

  const [character, setCharacter] = useState<CharacterData | null>(gameSocket.getCharacter());
  const characterId = character?.id ?? null;

  const [teamInfo, setTeamInfo] = useState<TeamInfo | null>(null);
  const [teamRole, setTeamRole] = useState<'leader' | 'member' | null>(null);

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [applications, setApplications] = useState<TeamApplication[]>([]);
  const [invitations, setInvitations] = useState<TeamInvitation[]>([]);
  const [nearbyTeams, setNearbyTeams] = useState<TeamEntry[]>([]);
  const [lobbyTeams, setLobbyTeams] = useState<TeamEntry[]>([]);

  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftGoal, setDraftGoal] = useState<string>('');
  const [draftJoinMinRealm, setDraftJoinMinRealm] = useState<string>('凡人');
  const [draftAutoJoinEnabled, setDraftAutoJoinEnabled] = useState<boolean>(false);
  const [draftAutoJoinMinRealm, setDraftAutoJoinMinRealm] = useState<string>('凡人');
  const [draftTransferLeaderId, setDraftTransferLeaderId] = useState<number | null>(null);

  const inTeam = Boolean(teamInfo?.id);
  const isLeader = useMemo(() => {
    if (!teamInfo || !characterId) return false;
    if (teamRole === 'leader') return true;
    return teamInfo.leaderId === characterId;
  }, [characterId, teamInfo, teamRole]);
  const [applicationsSeenAt, setApplicationsSeenAt] = useState(0);
  const applicationsSeenKey = useMemo(() => {
    if (!characterId || !teamInfo?.id) return null;
    return `team_apps_seen_${characterId}_${teamInfo.id}`;
  }, [characterId, teamInfo?.id]);
  const updateApplicationsSeenAt = useCallback(
    (nextSeenAt: number) => {
      if (!applicationsSeenKey) return;
      setApplicationsSeenAt(nextSeenAt);
      localStorage.setItem(applicationsSeenKey, String(nextSeenAt));
    },
    [applicationsSeenKey],
  );
  const applicationUnread = useMemo(() => {
    if (!isLeader || !inTeam) return 0;
    return applications.filter((a) => (Number(a.time) || 0) > applicationsSeenAt).length;
  }, [applications, applicationsSeenAt, inTeam, isLeader]);

  useEffect(() => {
    messageRef.current = message;
  }, [message]);

  useEffect(() => {
    gameSocket.connect();
    const unsubChar = gameSocket.onCharacterUpdate((c) => setCharacter(c));
    const unsubError = gameSocket.onError((err) => messageRef.current.error(err.message));
    return () => {
      unsubChar();
      unsubError();
    };
  }, []);

  useEffect(() => {
    lobbyQueryRef.current = lobbyQuery.trim();
  }, [lobbyQuery]);

  useEffect(() => {
    if (!teamInfo) {
      setMembers([]);
      return;
    }
    setMembers(teamInfo.members ?? []);
  }, [teamInfo]);

  const menuItems = useMemo(() => {
    const applyLabel =
      applicationUnread > 0 ? (
        <Badge count={applicationUnread} size="small" overflowCount={99}>
          <span>队伍申请</span>
        </Badge>
      ) : (
        '队伍申请'
      );
    return [
      { key: 'my' as const, label: '我的队伍' },
      { key: 'apply' as const, label: applyLabel },
      { key: 'near' as const, label: '附近队伍' },
      { key: 'lobby' as const, label: '队伍大厅' },
    ];
  }, [applicationUnread]);

  const mobileMenuOptions = useMemo(() => {
    const applyLabel =
      applicationUnread > 0 ? (
        <Badge count={applicationUnread} size="small" overflowCount={99}>
          <span>申请</span>
        </Badge>
      ) : (
        '申请'
      );
    return [
      { value: 'my', label: '我的' },
      { value: 'apply', label: applyLabel },
      { value: 'near', label: '附近' },
      { value: 'lobby', label: '大厅' },
    ];
  }, [applicationUnread]);

  const handlePanelChange = useCallback(
    (nextPanel: TeamPanelKey) => {
      if (nextPanel === 'apply' && isLeader && inTeam) {
        const maxTime = applications.reduce((m, a) => Math.max(m, Number(a.time) || 0), 0);
        if (maxTime > 0 && maxTime > applicationsSeenAt) updateApplicationsSeenAt(maxTime);
      }
      setPanel(nextPanel);
    },
    [applications, applicationsSeenAt, inTeam, isLeader, updateApplicationsSeenAt],
  );

  const refreshMyTeam = useCallback(async (cid: number) => {
    try {
      const res = await getMyTeam(cid);
      if (!res.success) {
        void 0;
        setTeamInfo(null);
        setTeamRole(null);
        return;
      }
      setTeamInfo(res.data ?? null);
      if (res.role === 'leader' || res.role === 'member') setTeamRole(res.role);
      else setTeamRole(null);
    } catch {
      void 0;
      setTeamInfo(null);
      setTeamRole(null);
    }
  }, []);

  const refreshApplications = useCallback(async (cid: number, t: TeamInfo | null, leader: boolean) => {
    if (!t?.id || !leader) {
      setApplications([]);
      return;
    }
    try {
      const res = await getTeamApplications(t.id, cid);
      if (!res.success) {
        void 0;
        setApplications([]);
        return;
      }
      setApplications(res.data ?? []);
    } catch {
      void 0;
      setApplications([]);
    }
  }, []);

  const refreshInvitations = useCallback(async (cid: number) => {
    try {
      const res = await getReceivedInvitations(cid);
      if (!res.success) {
        void 0;
        setInvitations([]);
        return;
      }
      setInvitations(res.data ?? []);
    } catch {
      void 0;
      setInvitations([]);
    }
  }, []);

  const refreshNearbyTeams = useCallback(async (cid: number, mapId?: string) => {
    try {
      const res = await getNearbyTeams(cid, mapId);
      if (!res.success) {
        void 0;
        setNearbyTeams([]);
        return;
      }
      setNearbyTeams(res.data ?? []);
    } catch {
      void 0;
      setNearbyTeams([]);
    }
  }, []);

  const refreshLobbyTeams = useCallback(async (cid: number, search?: string) => {
    try {
      const res = await getLobbyTeams(cid, search || undefined, 50);
      if (!res.success) {
        void 0;
        setLobbyTeams([]);
        return;
      }
      setLobbyTeams(res.data ?? []);
    } catch {
      void 0;
      setLobbyTeams([]);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    if (!characterId) return;
    const cid = characterId;
    await refreshMyTeam(cid);
    await refreshInvitations(cid);
    await refreshNearbyTeams(cid, character?.currentMapId);
    await refreshLobbyTeams(cid, lobbyQueryRef.current || undefined);
  }, [character?.currentMapId, characterId, refreshInvitations, refreshLobbyTeams, refreshMyTeam, refreshNearbyTeams]);

  useEffect(() => {
    if (!open) return;
    void refreshAll();
  }, [open, refreshAll]);

  useEffect(() => {
    if (!open || !applicationsSeenKey) {
      setApplicationsSeenAt(0);
      return;
    }
    const raw = localStorage.getItem(applicationsSeenKey);
    const n = Number(raw ?? 0);
    setApplicationsSeenAt(Number.isFinite(n) ? n : 0);
  }, [applicationsSeenKey, open]);

  useEffect(() => {
    if (!open || !characterId) return;
    const t = teamInfo;
    const leader = isLeader;
    void refreshApplications(characterId, t, leader);
  }, [open, characterId, teamInfo, isLeader, refreshApplications]);

  useEffect(() => {
    if (!open || panel !== 'apply' || !isLeader || !inTeam) return;
    const maxTime = applications.reduce((m, a) => Math.max(m, Number(a.time) || 0), 0);
    if (maxTime <= 0) return;
    if (maxTime <= applicationsSeenAt) return;
    updateApplicationsSeenAt(maxTime);
  }, [applications, applicationsSeenAt, inTeam, isLeader, open, panel, updateApplicationsSeenAt]);

  useEffect(() => {
    if (!open || !characterId) return;
    const keyword = lobbyQuery.trim();
    const timer = window.setTimeout(() => {
      void refreshLobbyTeams(characterId, keyword || undefined);
    }, LOBBY_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, characterId, lobbyQuery, refreshLobbyTeams]);

  useEffect(() => {
    if (!open) return;
    const unsub = gameSocket.onTeamUpdate(() => {
      void refreshAll();
    });
    return () => unsub();
  }, [open, refreshAll]);

  const openSettings = () => {
    const t = teamInfo;
    setDraftGoal(String(t?.goal || '').trim());
    setDraftJoinMinRealm(String(t?.joinMinRealm || '凡人'));
    setDraftAutoJoinEnabled(Boolean(t?.autoJoinEnabled));
    setDraftAutoJoinMinRealm(String(t?.autoJoinMinRealm || t?.joinMinRealm || '凡人'));
    setDraftTransferLeaderId(null);
    setSettingsOpen(true);
  };

  const onCreateTeam = async () => {
    if (!characterId) return;
    setLoadingKey('createTeam');
    try {
      const res = await createTeam(characterId, `${playerName}的小队`);
      if (!res.success) {
        void 0;
        return;
      }
      messageRef.current.success(res.message || '队伍创建成功');
      void refreshAll();
      setPanel('my');
    } catch {
      void 0;
    } finally {
      setLoadingKey(null);
    }
  };

  const onLeaveTeam = async () => {
    if (!characterId) return;
    setLoadingKey('leaveTeam');
    try {
      const res = await leaveTeam(characterId);
      if (!res.success) {
        void 0;
        return;
      }
      messageRef.current.success(res.message || '已退出队伍');
      void refreshAll();
      setPanel('my');
    } catch {
      void 0;
    } finally {
      setLoadingKey(null);
    }
  };

  const onDisbandTeam = async () => {
    if (!characterId || !teamInfo?.id) return;
    setLoadingKey('disbandTeam');
    try {
      const res = await disbandTeam(characterId, teamInfo.id);
      if (!res.success) {
        void 0;
        return;
      }
      messageRef.current.success(res.message || '队伍已解散');
      void refreshAll();
      setPanel('my');
    } catch {
      void 0;
    } finally {
      setLoadingKey(null);
    }
  };

  const requestJoin = async (t: TeamEntry) => {
    if (!characterId || inTeam) return;
    setLoadingKey(`apply-${t.id}`);
    try {
      const res = await applyToTeam(characterId, t.id);
      if (!res.success) {
        void 0;
        return;
      }
      messageRef.current.success(res.message || '申请已提交');
      if (res.autoJoined) {
        void refreshAll();
        setPanel('my');
      }
    } catch {
      void 0;
    } finally {
      setLoadingKey(null);
    }
  };

  const approveApplication = async (applicationId: string, approve: boolean) => {
    if (!characterId) return;
    setLoadingKey(`handleApp-${applicationId}`);
    try {
      const res = await handleApplication(characterId, applicationId, approve);
      if (!res.success) {
        void 0;
        return;
      }
      messageRef.current.success(res.message || '已处理');
      void refreshAll();
    } catch {
      void 0;
    } finally {
      setLoadingKey(null);
    }
  };

  const onHandleInvitation = async (invitationId: string, accept: boolean) => {
    if (!characterId) return;
    setLoadingKey(`handleInvite-${invitationId}`);
    try {
      const res = await handleInvitation(characterId, invitationId, accept);
      if (!res.success) {
        void 0;
        return;
      }
      messageRef.current.success(res.message || '已处理');
      void refreshAll();
      if (accept) setPanel('my');
    } catch {
      void 0;
    } finally {
      setLoadingKey(null);
    }
  };

  const onKickMember = useCallback(
    async (targetCharacterId: number) => {
      if (!characterId || !isLeader) return;
      setLoadingKey(`kick-${targetCharacterId}`);
      try {
        const res = await kickMember(characterId, targetCharacterId);
        if (!res.success) {
          void 0;
          return;
        }
        messageRef.current.success(res.message || '已踢出成员');
        void refreshAll();
      } catch {
        void 0;
      } finally {
        setLoadingKey(null);
      }
    },
    [characterId, isLeader, refreshAll],
  );

  const memberColumns = useMemo<NonNullable<TableProps<TeamMember>['columns']>>(() => {
    const base: NonNullable<TableProps<TeamMember>['columns']> = [
      {
        title: '成员',
        dataIndex: 'name',
        key: 'name',
        render: (_: string, row: TeamMember) => (
          <div className="team-member-cell">
            <span className="team-member-icon">
              <UserOutlined />
            </span>
            <span className="team-member-name">{row.name}</span>
            {row.role === 'leader' ? <Tag color="gold">队长</Tag> : <Tag>队员</Tag>}
            <Tag color={row.online ? 'green' : 'default'}>{row.online ? '在线' : '离线'}</Tag>
          </div>
        ),
      },
      { title: '境界', dataIndex: 'realm', key: 'realm', width: 120 },
    ];

    if (!isLeader) return base;

    return [
      ...base,
      {
        title: '操作',
        key: 'action',
        width: 120,
        render: (_: unknown, row: TeamMember) => (
          <Button
            size="small"
            danger
            disabled={row.role === 'leader'}
            loading={loadingKey === `kick-${row.characterId}`}
            onClick={() => onKickMember(row.characterId)}
          >
            踢出
          </Button>
        ),
      },
    ];
  }, [isLeader, loadingKey, onKickMember]);

  const applySettings = async () => {
    if (!characterId || !teamInfo?.id || !isLeader) return;
    setLoadingKey('settings');
    try {
      const settings = {
        goal: draftGoal.trim() || '组队冒险',
        joinMinRealm: draftJoinMinRealm,
        autoJoinEnabled: draftAutoJoinEnabled,
        autoJoinMinRealm: draftAutoJoinMinRealm,
      };
      const res = await updateTeamSettings(characterId, teamInfo.id, settings);
      if (!res.success) {
        void 0;
        return;
      }

      if (draftTransferLeaderId && Number.isFinite(draftTransferLeaderId)) {
        const tr = await transferLeader(characterId, draftTransferLeaderId);
        if (!tr.success) {
          void 0;
          return;
        }
      }

      messageRef.current.success('设置已更新');
      setSettingsOpen(false);
      void refreshAll();
    } catch {
      void 0;
    } finally {
      setLoadingKey(null);
    }
  };

  const filteredLobbyTeams = useMemo(() => {
    const q = lobbyQuery.trim().toLowerCase();
    const list = lobbyTeams ?? [];
    if (!q) return list;
    return list.filter((t) => `${t.name}${t.leader}${t.goal}${t.minRealm}`.toLowerCase().includes(q));
  }, [lobbyQuery, lobbyTeams]);

  const renderMyTeam = () => (
    <div className="team-pane">
      <div className="team-pane-top">
        <div className="team-title">我的队伍</div>
        <div className="team-pane-actions">
          {inTeam ? (
            <>
              {isLeader ? (
                <Button onClick={openSettings}>
                  队伍设置
                </Button>
              ) : null}
              {isLeader ? (
                <Button danger onClick={onDisbandTeam} loading={loadingKey === 'disbandTeam'}>
                  解散队伍
                </Button>
              ) : null}
              <Button danger onClick={onLeaveTeam} loading={loadingKey === 'leaveTeam'}>
                退出队伍
              </Button>
            </>
          ) : (
            <Button type="primary" onClick={onCreateTeam} loading={loadingKey === 'createTeam'}>
              创建队伍
            </Button>
          )}
        </div>
      </div>
      <div className="team-pane-body">
        {inTeam ? (
          <>
            <div className="team-kv">
              <span className="team-k">队伍名</span>
              <span className="team-v">{teamInfo?.name || '—'}</span>
            </div>
            <div className="team-kv">
              <span className="team-k">目标</span>
              <span className="team-v">{teamInfo?.goal || '—'}</span>
            </div>
            <div className="team-kv">
              <span className="team-k">申请</span>
              <span className="team-v">最低境界：{teamInfo?.joinMinRealm || '—'}</span>
            </div>
            <div className="team-kv">
              <span className="team-k">自动</span>
              <span className="team-v">{teamInfo?.autoJoinEnabled ? `开启（${teamInfo?.autoJoinMinRealm}+）` : '关闭'}</span>
            </div>
            <div className="team-section-title">成员列表</div>
            {isMobile ? (
              <div className="team-mobile-list">
                {members.map((row) => (
                  <div key={row.id} className="team-mobile-card">
                    <div className="team-mobile-card-head">
                      <div className="team-member-cell">
                        <span className="team-member-icon">
                          <UserOutlined />
                        </span>
                        <span className="team-member-name">{row.name}</span>
                      </div>
                      <div className="team-mobile-card-tags">
                        {row.role === 'leader' ? <Tag color="gold">队长</Tag> : <Tag>队员</Tag>}
                        <Tag color={row.online ? 'green' : 'default'}>{row.online ? '在线' : '离线'}</Tag>
                      </div>
                    </div>
                    <div className="team-mobile-meta-line">
                      <span className="team-mobile-meta-item">
                        <span className="team-mobile-meta-k">境界</span>
                        <span className="team-mobile-meta-v">{row.realm || '—'}</span>
                      </span>
                    </div>
                    {isLeader ? (
                      <div className="team-mobile-actions">
                        <Button
                          size="small"
                          danger
                          disabled={row.role === 'leader'}
                          loading={loadingKey === `kick-${row.characterId}`}
                          onClick={() => onKickMember(row.characterId)}
                        >
                          踢出
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <Table
                size="small"
                rowKey={(row) => row.id}
                pagination={false}
                columns={memberColumns}
                dataSource={members}
              />
            )}
            {isMobile && members.length === 0 ? <div className="team-empty">暂无成员</div> : null}
          </>
        ) : (
          <div className="team-empty">暂无队伍，可创建或前往大厅加入</div>
        )}
      </div>

      <Modal
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        footer={null}
        title="队伍设置"
        centered
        width={640}
        className="team-submodal"
        destroyOnHidden
      >
        <div className="team-settings-form">
          <div className="team-settings-row">
            <div className="team-settings-k">队伍目标</div>
            <Input value={draftGoal} onChange={(e) => setDraftGoal(e.target.value)} placeholder="例如：刷秘境 / 打Boss" maxLength={12} />
          </div>
          <div className="team-settings-row">
            <div className="team-settings-k">申请条件</div>
            <Select
              value={draftJoinMinRealm}
              onChange={(v) => setDraftJoinMinRealm(v)}
              options={realmOptions.map((r) => ({ value: r, label: r }))}
            />
          </div>
          <div className="team-settings-row">
            <div className="team-settings-k">自动入队</div>
            <div className="team-settings-inline">
              <Switch checked={draftAutoJoinEnabled} onChange={setDraftAutoJoinEnabled} />
              <Select
                value={draftAutoJoinMinRealm}
                onChange={(v) => setDraftAutoJoinMinRealm(v)}
                disabled={!draftAutoJoinEnabled}
                options={realmOptions.map((r) => ({ value: r, label: `${r}+` }))}
              />
            </div>
          </div>
          <div className="team-settings-row">
            <div className="team-settings-k">转让队长</div>
            <Select
              value={draftTransferLeaderId ?? undefined}
              onChange={(v) => setDraftTransferLeaderId(v ?? null)}
              placeholder="选择队员"
              allowClear
              options={members
                .filter((m) => m.role === 'member')
                .map((m) => ({ value: m.characterId, label: `${m.name}（${m.realm}）` }))}
            />
          </div>
          <div className="team-settings-actions">
            <Button onClick={() => setSettingsOpen(false)}>取消</Button>
            <Button type="primary" onClick={applySettings} disabled={!inTeam || !isLeader} loading={loadingKey === 'settings'}>
              保存
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );

  const renderApplications = () => (
    <div className="team-pane">
      <div className="team-pane-top">
        <div className="team-title">队伍申请</div>
        <div className="team-subtitle">查看入队申请与收到的邀请</div>
      </div>
      <div className="team-pane-body">
        {isLeader && inTeam ? (
          <>
            <div className="team-section-title">入队申请</div>
            {isMobile ? (
              <div className="team-mobile-list">
                {applications.map((row) => (
                  <div key={row.id} className="team-mobile-card">
                    <div className="team-mobile-card-head">
                      <div className="team-mobile-card-title">{row.name}</div>
                      <Tag>{row.realm || '—'}</Tag>
                    </div>
                    <div className="team-mobile-message">{String(row.message || '无留言')}</div>
                    <div className="team-mobile-actions">
                      <Button
                        size="small"
                        type="primary"
                        onClick={() => approveApplication(row.id, true)}
                        loading={loadingKey === `handleApp-${row.id}`}
                      >
                        通过
                      </Button>
                      <Button size="small" onClick={() => approveApplication(row.id, false)} loading={loadingKey === `handleApp-${row.id}`}>
                        拒绝
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Table
                size="small"
                rowKey={(row) => row.id}
                pagination={false}
                columns={[
                  { title: '玩家', dataIndex: 'name', key: 'name', width: 140 },
                  { title: '境界', dataIndex: 'realm', key: 'realm', width: 160 },
                  {
                    title: '留言',
                    dataIndex: 'message',
                    key: 'message',
                    render: (v: string | null) => String(v || '—'),
                  },
                  {
                    title: '操作',
                    key: 'action',
                    width: 180,
                    render: (_: unknown, row: TeamApplication) => (
                      <div className="team-actions">
                        <Button
                          size="small"
                          type="primary"
                          onClick={() => approveApplication(row.id, true)}
                          loading={loadingKey === `handleApp-${row.id}`}
                        >
                          通过
                        </Button>
                        <Button size="small" onClick={() => approveApplication(row.id, false)} loading={loadingKey === `handleApp-${row.id}`}>
                          拒绝
                        </Button>
                      </div>
                    ),
                  },
                ]}
                dataSource={applications}
              />
            )}
            {applications.length === 0 ? <div className="team-empty">暂无申请</div> : null}
          </>
        ) : null}

        <div className="team-section-title">收到邀请</div>
        {isMobile ? (
          <div className="team-mobile-list">
            {invitations.map((row) => (
              <div key={row.id} className="team-mobile-card">
                <div className="team-mobile-card-head">
                  <div className="team-mobile-card-title">{row.teamName}</div>
                </div>
                <div className="team-mobile-meta-line">
                  <span className="team-mobile-meta-item">
                    <span className="team-mobile-meta-k">邀请者</span>
                    <span className="team-mobile-meta-v">{row.inviterName || '—'}</span>
                  </span>
                  <span className="team-mobile-meta-item">
                    <span className="team-mobile-meta-k">目标</span>
                    <span className="team-mobile-meta-v">{row.goal || '—'}</span>
                  </span>
                </div>
                <div className="team-mobile-message">{String(row.message || '无留言')}</div>
                <div className="team-mobile-actions">
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => onHandleInvitation(row.id, true)}
                    disabled={inTeam}
                    loading={loadingKey === `handleInvite-${row.id}`}
                  >
                    接受
                  </Button>
                  <Button size="small" onClick={() => onHandleInvitation(row.id, false)} loading={loadingKey === `handleInvite-${row.id}`}>
                    拒绝
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => row.id}
            pagination={false}
            columns={[
              { title: '队伍', dataIndex: 'teamName', key: 'teamName', width: 160 },
              { title: '邀请者', dataIndex: 'inviterName', key: 'inviterName', width: 140 },
              { title: '目标', dataIndex: 'goal', key: 'goal' },
              {
                title: '留言',
                dataIndex: 'message',
                key: 'message',
                render: (v: string | null) => String(v || '—'),
              },
              {
                title: '操作',
                key: 'action',
                width: 180,
                render: (_: unknown, row: TeamInvitation) => (
                  <div className="team-actions">
                    <Button
                      size="small"
                      type="primary"
                      onClick={() => onHandleInvitation(row.id, true)}
                      disabled={inTeam}
                      loading={loadingKey === `handleInvite-${row.id}`}
                    >
                      接受
                    </Button>
                    <Button size="small" onClick={() => onHandleInvitation(row.id, false)} loading={loadingKey === `handleInvite-${row.id}`}>
                      拒绝
                    </Button>
                  </div>
                ),
              },
            ]}
            dataSource={invitations}
          />
        )}
        {invitations.length === 0 ? <div className="team-empty">暂无邀请</div> : null}
      </div>
    </div>
  );

  const renderNearby = () => (
    <div className="team-pane">
      <div className="team-pane-top">
        <div className="team-title">附近队伍</div>
        <div className="team-subtitle">查看你附近的队伍并申请加入</div>
      </div>
      <div className="team-pane-body">
        {isMobile ? (
          <div className="team-mobile-list">
            {nearbyTeams.map((row) => (
              <div key={row.id} className="team-mobile-card">
                <div className="team-mobile-card-head">
                  <div className="team-mobile-card-title">{row.name || '未命名队伍'}</div>
                  <Tag>{`${row.members}/${row.cap}`}</Tag>
                </div>
                <div className="team-mobile-meta-line">
                  <span className="team-mobile-meta-item">
                    <span className="team-mobile-meta-k">队长</span>
                    <span className="team-mobile-meta-v">{row.leader || '—'}</span>
                  </span>
                  <span className="team-mobile-meta-item">
                    <span className="team-mobile-meta-k">目标</span>
                    <span className="team-mobile-meta-v">{row.goal || '—'}</span>
                  </span>
                  <span className="team-mobile-meta-item">
                    <span className="team-mobile-meta-k">距离</span>
                    <span className="team-mobile-meta-v">{row.distance || '—'}</span>
                  </span>
                </div>
                <div className="team-mobile-actions">
                  <Button size="small" type="primary" onClick={() => requestJoin(row)} disabled={inTeam} loading={loadingKey === `apply-${row.id}`}>
                    申请加入
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => row.id}
            pagination={false}
            columns={[
              { title: '队伍', dataIndex: 'name', key: 'name', width: 160 },
              { title: '队长', dataIndex: 'leader', key: 'leader', width: 120 },
              { title: '人数', key: 'members', width: 120, render: (_: unknown, row: TeamEntry) => `${row.members}/${row.cap}` },
              { title: '目标', dataIndex: 'goal', key: 'goal' },
              { title: '距离', dataIndex: 'distance', key: 'distance', width: 110 },
              {
                title: '操作',
                key: 'action',
                width: 130,
                render: (_: unknown, row: TeamEntry) => (
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => requestJoin(row)}
                    disabled={inTeam}
                    loading={loadingKey === `apply-${row.id}`}
                  >
                    申请加入
                  </Button>
                ),
              },
            ]}
            dataSource={nearbyTeams}
          />
        )}
        {nearbyTeams.length === 0 ? <div className="team-empty">附近暂无队伍</div> : null}
      </div>
    </div>
  );

  const renderLobby = () => (
    <div className="team-pane">
      <div className="team-pane-top">
        <div className="team-top-row">
          <div className="team-title">队伍大厅</div>
          <div className="team-pane-actions">
            <Button type="primary" onClick={onCreateTeam} disabled={inTeam} loading={loadingKey === 'createTeam'}>
              创建队伍
            </Button>
          </div>
        </div>
        <div className="team-filters">
          <Input
            value={lobbyQuery}
            onChange={(e) => setLobbyQuery(e.target.value)}
            placeholder="搜索队伍/队长/目标/境界"
            allowClear
            suffix={<SearchOutlined />}
          />
        </div>
      </div>
      <div className="team-pane-body">
        {isMobile ? (
          <div className="team-mobile-list">
            {filteredLobbyTeams.map((row) => (
              <div key={row.id} className="team-mobile-card">
                <div className="team-mobile-card-head">
                  <div className="team-mobile-card-title">{row.name || '未命名队伍'}</div>
                  <Tag>{`${row.members}/${row.cap}`}</Tag>
                </div>
                <div className="team-mobile-meta-line">
                  <span className="team-mobile-meta-item">
                    <span className="team-mobile-meta-k">队长</span>
                    <span className="team-mobile-meta-v">{row.leader || '—'}</span>
                  </span>
                  <span className="team-mobile-meta-item">
                    <span className="team-mobile-meta-k">目标</span>
                    <span className="team-mobile-meta-v">{row.goal || '—'}</span>
                  </span>
                  <span className="team-mobile-meta-item">
                    <span className="team-mobile-meta-k">最低境界</span>
                    <span className="team-mobile-meta-v">{row.minRealm || '—'}</span>
                  </span>
                </div>
                <div className="team-mobile-actions">
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => requestJoin(row)}
                    disabled={inTeam || row.members >= row.cap}
                    loading={loadingKey === `apply-${row.id}`}
                  >
                    申请加入
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => row.id}
            pagination={false}
            columns={[
              { title: '队伍', dataIndex: 'name', key: 'name', width: 170 },
              { title: '队长', dataIndex: 'leader', key: 'leader', width: 120 },
              { title: '人数', key: 'members', width: 120, render: (_: unknown, row: TeamEntry) => `${row.members}/${row.cap}` },
              { title: '目标', dataIndex: 'goal', key: 'goal' },
              { title: '最低境界', dataIndex: 'minRealm', key: 'minRealm', width: 120 },
              {
                title: '操作',
                key: 'action',
                width: 120,
                render: (_: unknown, row: TeamEntry) => (
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => requestJoin(row)}
                    disabled={inTeam || row.members >= row.cap}
                    loading={loadingKey === `apply-${row.id}`}
                  >
                    申请加入
                  </Button>
                ),
              },
            ]}
            dataSource={filteredLobbyTeams}
          />
        )}
        {filteredLobbyTeams.length === 0 ? <div className="team-empty">暂无匹配队伍</div> : null}
      </div>
    </div>
  );

  const panelContent = () => {
    if (panel === 'my') return renderMyTeam();
    if (panel === 'apply') return renderApplications();
    if (panel === 'near') return renderNearby();
    return renderLobby();
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={1080}
      className="team-modal"
      destroyOnHidden
      maskClosable
      afterOpenChange={(visible) => {
        if (!visible) return;
        setPanel('my');
        setLobbyQuery('');
      }}
    >
      <div className="team-modal-shell">
        <div className="team-left">
          <div className="team-left-title">
            <img className="team-left-icon" src={coin01} alt="组队" />
            <div className="team-left-name">组队</div>
          </div>
          {isMobile ? (
            <div className="team-left-segmented-wrap">
              <Segmented
                className="team-left-segmented"
                value={panel}
                options={mobileMenuOptions}
                onChange={(value) => {
                  if (typeof value !== 'string') return;
                  if (!teamMenuKeys.includes(value as TeamPanelKey)) return;
                  handlePanelChange(value as TeamPanelKey);
                }}
              />
            </div>
          ) : (
            <div className="team-left-list">
              {menuItems.map((it) => (
                <Button
                  key={it.key}
                  type={panel === it.key ? 'primary' : 'default'}
                  className="team-left-item"
                  onClick={() => handlePanelChange(it.key)}
                >
                  {it.label}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="team-right">{panelContent()}</div>
      </div>
    </Modal>
  );
};

export default TeamModal;
