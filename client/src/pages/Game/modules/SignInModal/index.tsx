import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Modal, Typography, Space } from 'antd';
import { LeftOutlined, RightOutlined, CheckCircleFilled, CloseCircleOutlined } from '@ant-design/icons';
import { clsx } from 'clsx';
import dayjs, { Dayjs } from 'dayjs';
import localeData from 'dayjs/plugin/localeData';
import { HolidayUtil, Lunar } from 'lunar-typescript';
import { doSignIn, getSignInOverview, type SignInRecordDto } from '../../../../services/api';
import { gameSocket } from '../../../../services/gameSocket';
import './index.scss';

dayjs.extend(localeData);

interface SignInModalProps {
  open: boolean;
  onClose: () => void;
  onSigned?: () => void;
}

type SignInStore = Record<string, SignInRecordDto>;

const { Title } = Typography;

const SignInModal: React.FC<SignInModalProps> = ({ open, onClose, onSigned }) => {
  const { message } = App.useApp();

  const [viewDate, setViewDate] = useState<Dayjs>(() => dayjs());
  const [loading, setLoading] = useState(false);
  const [overviewMonth, setOverviewMonth] = useState<string>(() => dayjs().format('YYYY-MM'));
  const [signInStore, setSignInStore] = useState<SignInStore>({});
  const [monthSignedCount, setMonthSignedCount] = useState(0);
  const [streakDays, setStreakDays] = useState(0);
  const [signedToday, setSignedToday] = useState(false);
  const [todayKey, setTodayKey] = useState(() => dayjs().format('YYYY-MM-DD'));

  const refreshOverview = useCallback(async (month: string) => {
    setLoading(true);
    try {
      const res = await getSignInOverview(month);
      if (!res.success || !res.data) return;
      setOverviewMonth(res.data.month);
      setSignInStore(res.data.records || {});
      setMonthSignedCount(res.data.monthSignedCount || 0);
      setStreakDays(res.data.streakDays || 0);
      setSignedToday(Boolean(res.data.signedToday));
      setTodayKey(res.data.today || dayjs().format('YYYY-MM-DD'));
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const now = dayjs();
    setViewDate(now);
    refreshOverview(now.format('YYYY-MM'));
  }, [open, refreshOverview]);

  const handleSignIn = async () => {
    if (signedToday) {
      message.info('仙友，今日道法已修');
      return;
    }
    setLoading(true);
    try {
      const res = await doSignIn();
      if (!res.success || !res.data) return;
      message.success(`修道有成，获得灵石 +${res.data.reward}`);
      await refreshOverview(overviewMonth);
      gameSocket.refreshCharacter();
      onSigned?.();
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const changeMonth = (offset: number) => {
    const next = viewDate.clone().add(offset, 'month');
    setViewDate(next);
    refreshOverview(next.format('YYYY-MM'));
  };

  const isCurrentMonth = viewDate.isSame(dayjs(), 'month');

  // 抛弃星期，而是根据当月天数排列流线平铺
  const daysInMonth = viewDate.daysInMonth();
  const daysArray = useMemo(() => {
    return Array.from({ length: daysInMonth }, (_, i) => i + 1);
  }, [daysInMonth]);

  const renderCell = (dayNum: number) => {
    const dDate = viewDate.clone().date(dayNum);
    const dateKey = dDate.format('YYYY-MM-DD');
    const isToday = dateKey === todayKey;
    const isPast = dDate.isBefore(dayjs(), 'day');
    const signed = !!signInStore[dateKey];

    // 调用 lunar-typescript 计算农历与节气
    const lunarDate = Lunar.fromDate(dDate.toDate());
    const lunarDay = lunarDate.getDayInChinese();
    const solarTerm = lunarDate.getJieQi();
    const h = HolidayUtil.getHoliday(dDate.year(), dDate.month() + 1, dDate.date());
    const displayHoliday = h?.getTarget() === h?.getDay() ? h?.getName() : undefined;
    const subText = displayHoliday || solarTerm || lunarDay;

    return (
      <div 
        key={dayNum} 
        className={clsx('signin-cell', {
          'is-signed': signed,
          'is-today': isToday,
          'is-past': isPast && !signed,
          'is-future': !isPast && !isToday
        })}
      >
        {isToday && !signed && <div className="today-badge">今日当修</div>}
        <div className="signin-cell-header">
          <span className="day-number">第{dayNum}天</span>
          <span className="lunar-text">{subText}</span>
        </div>
        <div className="signin-cell-content">
          {signed ? (
            <div className="status-signed">
              <CheckCircleFilled className="status-icon success" />
              <span>已修行</span>
            </div>
          ) : (
            <div className="status-unsigned">
              {isPast ? <CloseCircleOutlined className="status-icon error" /> : null}
              <span>{isPast ? '未修行' : '未签'}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={
        <Space className="signin-modal-title">
          <span>灵台方寸 · 问道签到</span>
        </Space>
      }
      centered
      width={680}
      className="xianxia-signin-modal"
      destroyOnHidden
      maskClosable
    >
      <div className="signin-wrapper">
        <div className="signin-stats-header">
          <div className="stat-item">
            <span className="stat-label">连续修行</span>
            <span className="stat-value highlight">{streakDays}</span>
            <span className="stat-unit">天</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">本月已修行</span>
            <span className="stat-value">{monthSignedCount}</span>
            <span className="stat-unit">天</span>
          </div>
        </div>

        <div className="signin-month-controller">
          <Button type="text" icon={<LeftOutlined />} onClick={() => changeMonth(-1)} />
          <Title level={5} className="month-display" style={{ margin: 0 }}>
            {viewDate.format('YYYY年 MM月')}
          </Title>
          <Button type="text" icon={<RightOutlined />} onClick={() => changeMonth(1)} disabled={isCurrentMonth} />
        </div>

        <div className="signin-grid">
          {daysArray.map((day) => renderCell(day))}
        </div>

        <div className="signin-footer">
          <Button 
            type="primary" 
            size="large" 
            className="btn-xianxia-signin"
            loading={loading} 
            disabled={signedToday || !isCurrentMonth} 
            onClick={handleSignIn}
          >
            {signedToday ? '今日道体已满，明日再修' : '凝神聚气 · 开始修行'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default SignInModal;
