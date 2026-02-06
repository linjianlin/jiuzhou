import { App, Badge, Button, Empty, Modal, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, EyeOutlined, GiftOutlined, InboxOutlined, MailOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getMailList,
  readMail,
  claimMailAttachments,
  claimAllMailAttachments,
  deleteMail,
  deleteAllMails,
  markAllMailsRead,
} from '../../../../services/api';
import type { MailDto } from '../../../../services/api';
import './index.scss';

interface MailModalProps {
  open: boolean;
  onClose: () => void;
}

const formatTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
};

const MailModal: React.FC<MailModalProps> = ({ open, onClose }) => {
  const { message, modal } = App.useApp();
  const [mails, setMails] = useState<MailDto[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unclaimedCount, setUnclaimedCount] = useState(0);

  // 加载邮件列表
  const loadMails = useCallback(async (options?: { resetActive?: boolean }) => {
    const resetActive = !!options?.resetActive;
    setLoading(true);
    try {
      const res = await getMailList(1, 100);
      if (res.success && res.data) {
        const nextMails = res.data.mails;

        setMails(nextMails);
        setUnreadCount(res.data.unreadCount);
        setUnclaimedCount(res.data.unclaimedCount);

        // 自动选中邮件（支持打开弹窗时重置为首封）
        setActiveId((prev) => {
          if (nextMails.length === 0) return null;
          if (resetActive) return nextMails[0].id;
          if (prev && nextMails.some((m) => m.id === prev)) return prev;
          return nextMails[0].id;
        });
      }
    } catch {
      message.error('加载邮件失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  // 打开时加载
  useEffect(() => {
    if (open) {
      void loadMails({ resetActive: true });
    }
  }, [open, loadMails]);

  const safeActiveId = useMemo(() => {
    if (activeId && mails.some((m) => m.id === activeId)) return activeId;
    return mails[0]?.id ?? null;
  }, [activeId, mails]);

  const activeMail = useMemo(() => mails.find((m) => m.id === safeActiveId) ?? null, [mails, safeActiveId]);

  // 打开邮件（标记已读）
  const openMail = async (id: number) => {
    setActiveId(id);
    const mail = mails.find((m) => m.id === id);
    if (mail && !mail.readAt) {
      try {
        const res = await readMail(id);
        if (res.success) {
          setMails((prev) =>
            prev.map((m) => (m.id === id ? { ...m, readAt: new Date().toISOString() } : m))
          );
          setUnreadCount((c) => Math.max(0, c - 1));
        }
      } catch {
        // 静默失败
      }
    }
  };

  // 领取附件
  const claimAttachments = async (id: number) => {
    const target = mails.find((m) => m.id === id);
    if (!target) return;

    const hasAttachments =
      target.attachSilver > 0 ||
      target.attachSpiritStones > 0 ||
      (target.attachItems && target.attachItems.length > 0);

    if (!hasAttachments) {
      message.info('该邮件没有附件');
      return;
    }
    if (target.claimedAt) {
      message.info('附件已领取');
      return;
    }

    setClaiming(true);
    try {
      const res = await claimMailAttachments(id);
      if (res.success) {
        setMails((prev) =>
          prev.map((m) =>
            m.id === id ? { ...m, claimedAt: new Date().toISOString(), readAt: m.readAt ?? new Date().toISOString() } : m
          )
        );
        setUnclaimedCount((c) => Math.max(0, c - 1));

        // 显示奖励
        const rewards: string[] = [];
        if (res.rewards?.silver) rewards.push(`银两 +${res.rewards.silver}`);
        if (res.rewards?.spiritStones) rewards.push(`灵石 +${res.rewards.spiritStones}`);
        if (res.rewards?.itemIds?.length) rewards.push(`物品 x${res.rewards.itemIds.length}`);
        message.success(`领取成功${rewards.length > 0 ? '：' + rewards.join('，') : ''}`);
      } else {
        message.error(res.message || '领取失败');
      }
    } catch {
      message.error('领取失败');
    } finally {
      setClaiming(false);
    }
  };

  // 一键领取
  const claimAll = async () => {
    if (unclaimedCount === 0) {
      message.info('没有可领取的附件');
      return;
    }

    setClaiming(true);
    try {
      const res = await claimAllMailAttachments();
      if (res.success) {
        await loadMails();
        const rewards: string[] = [];
        if (res.rewards?.silver) rewards.push(`银两 +${res.rewards.silver}`);
        if (res.rewards?.spiritStones) rewards.push(`灵石 +${res.rewards.spiritStones}`);
        if (res.rewards?.itemCount) rewards.push(`物品 x${res.rewards.itemCount}`);
        message.success(`已领取 ${res.claimedCount} 封邮件附件${rewards.length > 0 ? '：' + rewards.join('，') : ''}`);
      } else {
        message.error(res.message || '领取失败');
      }
    } catch {
      message.error('领取失败');
    } finally {
      setClaiming(false);
    }
  };

  // 一键已读
  const markAllRead = async () => {
    if (unreadCount === 0) {
      message.info('没有未读邮件');
      return;
    }

    try {
      const res = await markAllMailsRead();
      if (res.success) {
        setMails((prev) => prev.map((m) => (m.readAt ? m : { ...m, readAt: new Date().toISOString() })));
        setUnreadCount(0);
        message.success(`已读 ${res.readCount} 封邮件`);
      } else {
        message.error(res.message || '操作失败');
      }
    } catch {
      message.error('操作失败');
    }
  };

  // 一键删除
  const deleteAll = () => {
    if (mails.length === 0) {
      message.info('邮箱暂无邮件');
      return;
    }
    modal.confirm({
      title: '一键删除',
      content: '确认删除所有邮件？删除后不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await deleteAllMails(false);
          if (res.success) {
            setMails([]);
            setActiveId(null);
            setUnreadCount(0);
            setUnclaimedCount(0);
            message.success(`已删除 ${res.deletedCount} 封邮件`);
          }
        } catch {
          message.error('删除失败');
        }
      },
    });
  };

  // 删除单封邮件
  const handleDeleteMail = (id: number) => {
    const target = mails.find((m) => m.id === id);
    if (!target) return;

    const hasUnclaimedAttachments =
      !target.claimedAt &&
      (target.attachSilver > 0 ||
        target.attachSpiritStones > 0 ||
        (target.attachItems && target.attachItems.length > 0));

    modal.confirm({
      title: '删除邮件',
      content: hasUnclaimedAttachments
        ? '该邮件有未领取的附件，确认删除？删除后不可恢复。'
        : '确认删除该邮件？删除后不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await deleteMail(id);
          if (res.success) {
            const newMails = mails.filter((m) => m.id !== id);
            setMails(newMails);
            if (activeId === id) {
              setActiveId(newMails[0]?.id ?? null);
            }
            // 更新计数
            if (!target.readAt) setUnreadCount((c) => Math.max(0, c - 1));
            if (hasUnclaimedAttachments) setUnclaimedCount((c) => Math.max(0, c - 1));
            message.success('邮件已删除');
          }
        } catch {
          message.error('删除失败');
        }
      },
    });
  };

  // 判断是否有附件
  const hasAttachments = (mail: MailDto) =>
    mail.attachSilver > 0 || mail.attachSpiritStones > 0 || (mail.attachItems && mail.attachItems.length > 0);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={980}
      className="mail-modal"
      destroyOnHidden
      maskClosable
    >
      <Spin spinning={loading}>
        <div className="mail-modal-shell">
          <div className="mail-modal-left">
            <div className="mail-left-header">
              <div className="mail-left-title">
                <MailOutlined />
                <span>邮箱</span>
                <Badge count={unreadCount} size="small" />
              </div>
              <Space size={8}>
                <Tooltip title="刷新">
                  <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => void loadMails()} />
                </Tooltip>
                <Tooltip title="一键领取">
                  <Button
                    size="small"
                    type="text"
                    icon={<GiftOutlined />}
                    onClick={claimAll}
                    loading={claiming}
                    disabled={unclaimedCount === 0}
                  />
                </Tooltip>
                <Tooltip title="一键已读">
                  <Button
                    size="small"
                    type="text"
                    icon={<EyeOutlined />}
                    onClick={markAllRead}
                    disabled={unreadCount === 0}
                  />
                </Tooltip>
                <Tooltip title="一键删除">
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={deleteAll}
                    disabled={mails.length === 0}
                  />
                </Tooltip>
              </Space>
            </div>
            <div className="mail-list">
              {mails.map((m) => {
                const isActive = m.id === safeActiveId;
                const isUnread = !m.readAt;
                const hasGift = hasAttachments(m);
                const giftClaimed = hasGift && !!m.claimedAt;
                return (
                  <div
                    key={m.id}
                    className={`mail-item ${isActive ? 'is-active' : ''} ${isUnread ? 'is-unread' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => openMail(m.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') openMail(m.id);
                    }}
                  >
                    <div className="mail-item-top">
                      <div className="mail-item-title">
                        {isUnread ? <span className="mail-dot" /> : null}
                        <span className="mail-title-text">{m.title}</span>
                      </div>
                      <div className="mail-item-time">{formatTime(m.createdAt)}</div>
                    </div>
                    <div className="mail-item-meta">
                      <span className="mail-from">{m.senderName}</span>
                      <span className="mail-tags">
                        {hasGift ? (
                          <Tag color={giftClaimed ? 'default' : 'gold'}>{giftClaimed ? '已领取' : '有附件'}</Tag>
                        ) : (
                          <Tag color="default">无附件</Tag>
                        )}
                      </span>
                    </div>
                  </div>
                );
              })}
              {mails.length === 0 && !loading ? (
                <div className="mail-empty">
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无邮件" />
                </div>
              ) : null}
            </div>
          </div>

          <div className="mail-modal-right">
            {activeMail ? (
              <>
                <div className="mail-detail-header">
                  <div className="mail-detail-title">{activeMail.title}</div>
                  <Space size={8}>
                    <Button danger icon={<DeleteOutlined />} onClick={() => handleDeleteMail(activeMail.id)}>
                      删除
                    </Button>
                  </Space>
                </div>

                <div className="mail-detail-meta">
                  <Tag color={activeMail.readAt ? 'default' : 'blue'}>{activeMail.readAt ? '已读' : '未读'}</Tag>
                  <Tag color="default">发件人：{activeMail.senderName}</Tag>
                  <Tag color="default">时间：{formatTime(activeMail.createdAt)}</Tag>
                  {activeMail.expireAt && (
                    <Tag color="orange">过期：{formatTime(activeMail.expireAt)}</Tag>
                  )}
                </div>

                <div className="mail-detail-body">
                  <Typography.Paragraph className="mail-content">{activeMail.content}</Typography.Paragraph>
                </div>

                <div className="mail-detail-footer">
                  <div className="mail-attachments">
                    <div className="mail-attachments-title">
                      <InboxOutlined />
                      <span>附件</span>
                    </div>
                    {hasAttachments(activeMail) ? (
                      <div className="mail-attachments-list">
                        {activeMail.attachSilver > 0 && (
                          <div className="mail-attachment">
                            <span className="mail-attachment-name">银两</span>
                            <span className="mail-attachment-amount">x{activeMail.attachSilver.toLocaleString()}</span>
                          </div>
                        )}
                        {activeMail.attachSpiritStones > 0 && (
                          <div className="mail-attachment">
                            <span className="mail-attachment-name">灵石</span>
                            <span className="mail-attachment-amount">x{activeMail.attachSpiritStones.toLocaleString()}</span>
                          </div>
                        )}
                        {activeMail.attachItems?.map((item, idx) => {
                          const qualityColorMap: Record<string, string> = {
                            '天': 'var(--rarity-tian)',
                            '地': 'var(--rarity-di)',
                            '玄': 'var(--rarity-xuan)',
                            '黄': 'var(--rarity-huang)',
                          };
                          const nameColor = item.quality ? qualityColorMap[item.quality] : undefined;
                          return (
                            <div key={idx} className="mail-attachment">
                              <span className="mail-attachment-name" style={nameColor ? { color: nameColor } : undefined}>
                                {item.item_name || item.item_def_id}
                              </span>
                              <span className="mail-attachment-amount">x{item.qty}</span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="mail-attachments-empty">无附件</div>
                    )}
                  </div>
                  <Button
                    type="primary"
                    icon={<GiftOutlined />}
                    disabled={!hasAttachments(activeMail) || !!activeMail.claimedAt}
                    loading={claiming}
                    onClick={() => claimAttachments(activeMail.id)}
                  >
                    {!hasAttachments(activeMail) ? '无可领取' : activeMail.claimedAt ? '已领取' : '领取附件'}
                  </Button>
                </div>
              </>
            ) : (
              <div className="mail-right-empty">
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择一封邮件" />
              </div>
            )}
          </div>
        </div>
      </Spin>
    </Modal>
  );
};

export default MailModal;
