import { App, Button, Modal, Progress, Tag } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { IMG_COIN as coin01 } from '../../shared/imageAssets';
import { activateMonthCardItem, claimMonthCardReward, getInventoryItems, getMonthCardStatus } from '../../../../services/api';
import './index.scss';

interface MonthCardModalProps {
  open: boolean;
  onClose: () => void;
}

type DailyReward = {
  id: string;
  name: string;
  icon: string;
  amount: number;
  type: 'spiritStone' | 'item';
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const monthCardId = 'monthcard-001';
const monthCardItemDefId = 'cons-monthcard-001';

const MonthCardModal: React.FC<MonthCardModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getMonthCardStatus>>['data'] | null>(null);
  const [monthCardItem, setMonthCardItem] = useState<{ instanceId: number; qty: number } | null>(null);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getMonthCardStatus(monthCardId);
      if (!res.success || !res.data) {
        setStatus(null);
        void 0;
        return;
      }
      setStatus(res.data);
    } catch {
      setStatus(null);
      void 0;
    } finally {
      setLoading(false);
    }
  }, [message]);

  const refreshMonthCardItem = useCallback(async () => {
    try {
      const res = await getInventoryItems('bag', 1, 200);
      const items = res.data?.items || [];

      let pickedId = 0;
      let totalQty = 0;
      for (const it of items) {
        if (it.item_def_id !== monthCardItemDefId) continue;
        totalQty += Number(it.qty) || 0;
        if (!pickedId) pickedId = Number(it.id) || 0;
      }

      if (pickedId && totalQty > 0) {
        setMonthCardItem({ instanceId: pickedId, qty: totalQty });
      } else {
        setMonthCardItem(null);
      }
    } catch {
      setMonthCardItem(null);
    }
  }, []);

  const dailyRewards = useMemo<DailyReward[]>(() => {
    const amount = status?.dailySpiritStones ?? 100;
    return [{ id: 'sr', name: '灵石', icon: coin01, amount, type: 'spiritStone' }];
  }, [status?.dailySpiritStones]);

  const active = Boolean(status?.active);
  const daysLeft = status?.daysLeft ?? 0;
  const canClaim = Boolean(status?.canClaim);
  const today = status?.today ?? '';
  const lastClaimDate = status?.lastClaimDate ?? '';
  const isExpired = useMemo(() => {
    if (!status?.expireAt) return false;
    const ts = Date.parse(status.expireAt);
    if (!Number.isFinite(ts)) return false;
    return ts <= Date.now();
  }, [status?.expireAt]);

  const progressPercent = useMemo(() => {
    if (!active) return 0;
    const total = Math.max(1, status?.durationDays ?? 30);
    const used = clamp(total - daysLeft, 0, total);
    return (used / total) * 100;
  }, [active, daysLeft, status?.durationDays]);

  const doUseItem = useCallback(async () => {
    if (acting) return;
    if (!monthCardItem?.instanceId) {
      message.error('背包中没有月卡道具');
      return;
    }
    setActing(true);
    try {
      const res = await activateMonthCardItem({ monthCardId, itemInstanceId: monthCardItem.instanceId });
      if (!res.success) {
        void 0;
        return;
      }
      message.success('使用成功');
      await refreshStatus();
      await refreshMonthCardItem();
    } catch {
      void 0;
    } finally {
      setActing(false);
    }
  }, [acting, message, monthCardItem?.instanceId, refreshMonthCardItem, refreshStatus]);

  const claim = useCallback(async () => {
    if (acting) return;
    if (!canClaim) return;
    setActing(true);
    try {
      const res = await claimMonthCardReward(monthCardId);
      if (!res.success) {
        void 0;
        return;
      }
      message.success(`领取成功 +${res.data?.rewardSpiritStones ?? 0} 灵石`);
      await refreshStatus();
    } catch {
      void 0;
    } finally {
      setActing(false);
    }
  }, [acting, canClaim, message, refreshStatus]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={760}
      className="monthcard-modal"
      destroyOnHidden
      maskClosable
      afterOpenChange={(visible) => {
        if (!visible) {
          setStatus(null);
          setMonthCardItem(null);
          return;
        }
        void refreshStatus();
        void refreshMonthCardItem();
      }}
    >
      <div className="monthcard-shell">
        <div className="monthcard-header">
          <div className="monthcard-title">月卡</div>
        </div>

        <div className="monthcard-body">
          <div className="monthcard-hero">
            <div className="monthcard-hero-left">
              <div className="monthcard-hero-name">{status?.name || '修行月卡'}</div>
              <div className="monthcard-hero-desc">{status?.description || '有效期30天，每日可领取100灵石。'}</div>
              <div className="monthcard-hero-tags">
                {active ? <Tag color="green">已解锁</Tag> : <Tag color="default">未解锁</Tag>}
                {active ? <Tag color="blue">剩余 {daysLeft} 天</Tag> : null}
                {!active && isExpired ? <Tag color="red">已到期</Tag> : null}
              </div>
            </div>
            <div className="monthcard-hero-right">
              <div className="monthcard-progress-title">进度</div>
              <Progress percent={progressPercent} showInfo={false} strokeColor="var(--primary-color)" />
              <div className="monthcard-progress-meta">{active ? `已使用 ${Math.round(progressPercent)}%` : '未激活'}</div>
              {monthCardItem?.instanceId ? (
                <Button type="primary" onClick={doUseItem} disabled={acting || loading}>
                  {active ? '使用续期' : '使用'}
                </Button>
              ) : (
                <Button type="primary" disabled>
                  无月卡道具
                </Button>
              )}
              <div className="monthcard-progress-meta">
                背包月卡道具：{monthCardItem?.qty ? `${monthCardItem.qty} 个` : '0 个'}
              </div>
            </div>
          </div>

          <div className="monthcard-section">
            <div className="monthcard-section-title">每日奖励</div>
            <div className="monthcard-reward-grid">
              {dailyRewards.map((r) => (
                <div key={r.id} className="monthcard-reward">
                  <img className="monthcard-reward-icon" src={r.icon} alt={r.name} />
                  <div className="monthcard-reward-name">{r.name}</div>
                  <div className="monthcard-reward-amount">x{r.amount}</div>
                </div>
              ))}
            </div>
            <div className="monthcard-claim-row">
              <div className="monthcard-claim-meta">
                <div className="monthcard-claim-k">今日领取</div>
                <div className="monthcard-claim-v">
                  {active ? (today === lastClaimDate ? '已领取' : '未领取') : '未解锁'}
                </div>
              </div>
              <Button type="primary" disabled={!canClaim || acting || loading} loading={acting && canClaim} onClick={claim}>
                {today === lastClaimDate ? '已领取' : '领取奖励'}
              </Button>
            </div>
          </div>

          {!active ? (
            <div className="monthcard-tip">
              月卡未解锁：背包有月卡道具时可点击“使用”激活。
            </div>
          ) : isExpired ? (
            <div className="monthcard-tip">
              月卡已到期：背包有月卡道具时可点击“使用续期”叠加天数。
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
};

export default MonthCardModal;
