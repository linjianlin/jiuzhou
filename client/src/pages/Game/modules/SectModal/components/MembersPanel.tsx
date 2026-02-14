/**
 * 宗门成员面板。
 * 输入：成员列表、当前玩家权限、管理操作回调。
 * 输出：成员信息与管理入口（任命/踢出/转让在二级弹窗中处理）。
 * 边界：
 * 1) 无管理权限时不显示“管理”按钮；宗主不可直接通过此面板退出宗门。
 * 2) 在线状态来源于 gameSocket 的在线玩家广播，不新增列，离线成员整行灰化并显示离线时长。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Table, Tag } from 'antd';
import { useIsMobile } from '../../../shared/responsive';
import { gameSocket } from '../../../../../services/gameSocket';
import type { SectMemberVm, SectPermissionState } from '../types';

interface MembersPanelProps {
  members: SectMemberVm[];
  myMember: SectMemberVm | null;
  permissions: SectPermissionState;
  actionLoadingKey: string | null;
  onOpenMemberAction: (member: SectMemberVm) => void;
  onLeaveSect: () => void;
}

/**
 * 将成员加入时间统一格式化为 YYYY.MM.DD。
 * 说明：
 * 1) 优先处理后端常见 ISO 日期字符串，避免时区导致的日期偏移；
 * 2) 其余可解析日期走 Date 兜底；
 * 3) 无法解析时返回原文，便于排查数据问题。
 */
const formatJoinedDate = (raw: string): string => {
  const text = raw.trim();
  const isoPrefix = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoPrefix) {
    return `${isoPrefix[1]}.${isoPrefix[2]}.${isoPrefix[3]}`;
  }

  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return text;

  const pad = (value: number): string => String(value).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return `${year}.${month}.${day}`;
};

const OFFLINE_DURATION_TICK_MS = 60 * 1000;

const formatLastOnlineText = (durationMs: number): string => {
  const safe = Math.max(0, Math.floor(durationMs));
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (safe < minute) return '1分钟前在线';
  if (safe < hour) return `${Math.floor(safe / minute)}分钟前在线`;
  if (safe < day) return `${Math.floor(safe / hour)}小时前在线`;
  return `${Math.floor(safe / day)}天前在线`;
};

const parseDateToTimestamp = (raw: string | null): number | null => {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const MembersPanel: React.FC<MembersPanelProps> = ({
  members,
  myMember,
  permissions,
  actionLoadingKey,
  onOpenMemberAction,
  onLeaveSect,
}) => {
  const isMobile = useIsMobile();
  const canManageMember = permissions.canKickMember || permissions.canAppointPosition || permissions.canTransferLeader;
  const [onlineMemberIds, setOnlineMemberIds] = useState<Set<number>>(new Set());
  const [lastOfflineAtByMemberId, setLastOfflineAtByMemberId] = useState<Record<number, number>>({});
  const [nowTs, setNowTs] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowTs(Date.now());
    }, OFFLINE_DURATION_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setLastOfflineAtByMemberId((prev) => {
      const next = { ...prev };
      let changed = false;
      const memberIdSet = new Set<number>();

      for (const member of members) {
        const memberId = member.characterId;
        memberIdSet.add(memberId);

        const apiTimestamp = parseDateToTimestamp(member.lastOfflineAt);
        if (apiTimestamp === null) continue;

        const currentTimestamp = next[memberId];
        const mergedTimestamp = Number.isFinite(currentTimestamp)
          ? Math.max(currentTimestamp, apiTimestamp)
          : apiTimestamp;
        if (currentTimestamp === mergedTimestamp) continue;
        next[memberId] = mergedTimestamp;
        changed = true;
      }

      for (const key of Object.keys(next)) {
        const memberId = Number(key);
        if (!Number.isFinite(memberId) || memberId <= 0) continue;
        if (memberIdSet.has(memberId)) continue;
        delete next[memberId];
        changed = true;
      }

      return changed ? next : prev;
    });
  }, [members]);

  useEffect(() => {
    let previousOnlineIds = new Set<number>();
    const unsubscribe = gameSocket.onOnlinePlayersUpdate((payload) => {
      const now = Date.now();
      const nextOnlineIds = new Set<number>();
      for (const row of payload.players) {
        const memberId = Math.floor(Number(row.id));
        if (!Number.isFinite(memberId) || memberId <= 0) continue;
        nextOnlineIds.add(memberId);
      }
      setOnlineMemberIds(nextOnlineIds);
      setLastOfflineAtByMemberId((prev) => {
        const next = { ...prev };
        let changed = false;

        // 仅在“在线 -> 离线”切换时刷新最后离线时间。
        for (const memberId of previousOnlineIds) {
          if (nextOnlineIds.has(memberId)) continue;
          if (next[memberId] === now) continue;
          next[memberId] = now;
          changed = true;
        }
        return changed ? next : prev;
      });
      previousOnlineIds = nextOnlineIds;
    });
    return unsubscribe;
  }, []);

  const isMemberOnline = (characterId: number): boolean => {
    return onlineMemberIds.has(characterId);
  };

  const getOnlineText = (characterId: number): string => {
    if (isMemberOnline(characterId)) return '在线';
    const lastOfflineAt = lastOfflineAtByMemberId[characterId];
    if (!Number.isFinite(lastOfflineAt)) return '较早前在线';
    return formatLastOnlineText(nowTs - lastOfflineAt);
  };

  /**
   * 成员列表按在线状态排序：
   * 1) 在线成员始终排在前面；
   * 2) 同为在线或同为离线时保持原顺序，避免界面频繁抖动。
   */
  const orderedMembers = useMemo(() => {
    return members
      .map((member, index) => ({
        member,
        index,
        online: isMemberOnline(member.characterId),
      }))
      .sort((left, right) => {
        if (left.online !== right.online) return left.online ? -1 : 1;
        return left.index - right.index;
      })
      .map((row) => row.member);
  }, [members, onlineMemberIds]);

  if (isMobile) {
    return (
      <div className="sect-pane">
        <div className="sect-pane-top">
          <div className="sect-pane-title-wrap">
            <div className="sect-title">宗门成员</div>
            <div className="sect-subtitle">查看成员贡献与职位，管理操作在成员卡中触发。</div>
          </div>
        </div>

        <div className="sect-pane-body">
          <div className="sect-mobile-list">
            {orderedMembers.map((member) => {
              const isSelf = myMember?.characterId === member.characterId;
              const online = isMemberOnline(member.characterId);
              return (
                <div key={member.characterId} className={`sect-mobile-card${online ? '' : ' is-offline'}`}>
                  <div className="sect-mobile-card-head">
                    <div className="sect-mobile-card-title-wrap">
                      <div className="sect-mobile-card-title">{member.nickname}</div>
                      <div className={`sect-member-online-text${online ? ' is-online' : ''}`}>{getOnlineText(member.characterId)}</div>
                    </div>
                    <Tag color={member.position === 'leader' ? 'gold' : 'blue'}>{member.positionLabel}</Tag>
                  </div>
                  <div className="sect-mobile-meta-line">
                    <span className="sect-mobile-meta-item">
                      <span className="sect-mobile-meta-k">境界</span>
                      <span className="sect-mobile-meta-v">{member.realm}</span>
                    </span>
                    <span className="sect-mobile-meta-item">
                      <span className="sect-mobile-meta-k">贡献</span>
                      <span className="sect-mobile-meta-v">{member.contribution.toLocaleString()}</span>
                    </span>
                    <span className="sect-mobile-meta-item">
                      <span className="sect-mobile-meta-k">周贡献</span>
                      <span className="sect-mobile-meta-v">{member.weeklyContribution.toLocaleString()}</span>
                    </span>
                  </div>
                  {canManageMember ? (
                    <div className="sect-mobile-actions">
                      <Button
                        size="small"
                        onClick={() => {
                          onOpenMemberAction(member);
                        }}
                        disabled={member.position === 'leader' && !permissions.canTransferLeader && !isSelf}
                      >
                        管理
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {myMember?.position !== 'leader' ? (
            <div className="sect-pane-footer">
              <Button danger loading={actionLoadingKey === 'leave'} onClick={onLeaveSect}>
                退出宗门
              </Button>
            </div>
          ) : (
            <div className="sect-tips">宗主不可直接退出宗门，请先转让宗主或解散宗门。</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="sect-pane">
      <div className="sect-pane-top">
        <div className="sect-pane-title-wrap">
          <div className="sect-title">宗门成员</div>
          <div className="sect-subtitle">成员贡献按表格展示，支持职位与成员管理。</div>
        </div>
      </div>

      <div className="sect-pane-body sect-panel-scroll">
        <Table
          size="small"
          rowKey={(row) => row.characterId}
          rowClassName={(row) => (isMemberOnline(row.characterId) ? '' : 'sect-member-row-offline')}
          pagination={false}
          className="sect-table"
          columns={[
            {
              title: '成员',
              dataIndex: 'nickname',
              key: 'nickname',
              width: 180,
              render: (value: string, row: SectMemberVm) => {
                const online = isMemberOnline(row.characterId);
                return (
                  <div className="sect-member-name-wrap">
                    <span className="sect-member-name">{value}</span>
                    <span className={`sect-member-online-text${online ? ' is-online' : ''}`}>{getOnlineText(row.characterId)}</span>
                  </div>
                );
              },
            },
            {
              title: '职位',
              dataIndex: 'positionLabel',
              key: 'positionLabel',
              width: 120,
              render: (value: string, row: SectMemberVm) => <Tag color={row.position === 'leader' ? 'gold' : 'blue'}>{value}</Tag>,
            },
            {
              title: '境界',
              dataIndex: 'realm',
              key: 'realm',
              width: 170,
              render: (value: string) => <span className="sect-realm-cell">{value}</span>,
            },
            {
              title: '贡献',
              dataIndex: 'contribution',
              key: 'contribution',
              width: 120,
              render: (value: number) => value.toLocaleString(),
            },
            {
              title: '周贡献',
              dataIndex: 'weeklyContribution',
              key: 'weeklyContribution',
              width: 120,
              render: (value: number) => value.toLocaleString(),
            },
            {
              title: '加入时间',
              dataIndex: 'joinedAt',
              key: 'joinedAt',
              render: (value: string) => formatJoinedDate(value),
            },
            ...(canManageMember
              ? [
                  {
                    title: '操作',
                    key: 'action',
                    width: 100,
                    render: (_: unknown, row: SectMemberVm) => (
                      <Button size="small" onClick={() => onOpenMemberAction(row)}>
                        管理
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
          dataSource={orderedMembers}
          locale={{ emptyText: '暂无成员数据' }}
        />
      </div>

      <div className="sect-pane-footer">
        {myMember?.position !== 'leader' ? (
          <Button danger loading={actionLoadingKey === 'leave'} onClick={onLeaveSect}>
            退出宗门
          </Button>
        ) : (
          <div className="sect-tips">宗主不可直接退出宗门，请先转让宗主或解散宗门。</div>
        )}
      </div>
    </div>
  );
};

export default MembersPanel;
