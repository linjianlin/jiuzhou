import { App, Button, Modal, Progress } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gameSocket, type CharacterData } from '../../../../services/gameSocket';
import {
  arenaMatch,
  getArenaRecords,
  getArenaStatus,
  type ArenaRecordDto,
  type ArenaStatusDto,
} from '../../../../services/api';
import './index.scss';

interface ArenaModalProps {
  open: boolean;
  onClose: () => void;
  character: CharacterData | null;
  onStartBattle?: (battleId: string) => void;
}

type ArenaTab = 'match' | 'record' | 'rule';
const ARENA_MATCH_RANGE_TEXT = '±50 → ±100 → ±200 → ±400';

const ARENA_RULE_MATCH_ITEMS = [
  '系统根据你的积分自动匹配对手',
  '优先匹配积分接近的对手（±50）',
  `若无合适对手，逐步扩大范围（${ARENA_MATCH_RANGE_TEXT}）`,
  '积分差距越小，被匹配概率越高',
];

interface ArenaRuleSection {
  heading: string;
  details: string[];
}

const ARENA_RULE_SECTIONS: ArenaRuleSection[] = [
  { heading: '1）今日挑战次数上限：20 次', details: [] },
  { heading: '2）匹配机制：', details: ARENA_RULE_MATCH_ITEMS },
  { heading: '3）积分变化：', details: ['胜利 +10 分', '失败 -5 分（最低 0 分）'] },
  { heading: '4）战斗规则：', details: ['战斗中治疗效果会有一定压制'] },
];

const calcPower = (c: CharacterData | null): number => {
  if (!c) return 0;
  const atk = (Number(c.wugong) || 0) + (Number(c.fagong) || 0);
  const def = (Number(c.wufang) || 0) + (Number(c.fafang) || 0);
  const hp = Number(c.maxQixue) || 0;
  const mp = Number(c.maxLingqi) || 0;
  const spd = Number(c.sudu) || 0;
  const extra = Number(c.shuxingShuzhi) || 0;
  const base = atk * 2 + def * 1.4 + (hp + mp) / 16 + spd * 8 + extra * 5;
  return Math.max(1, Math.round(base));
};

const formatArenaRecordTime = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const formatScoreDelta = (delta: number) => (delta > 0 ? `+${delta}` : String(delta));

const renderResultTag = (result: ArenaRecordDto['result']) => {
  if (result === 'win') return <span className="ar-result is-win">胜利</span>;
  if (result === 'lose') return <span className="ar-result is-lose">失败</span>;
  return <span className="ar-result is-draw">平局</span>;
};

const ArenaModal: React.FC<ArenaModalProps> = ({ open, onClose, character, onStartBattle }) => {
  const { message } = App.useApp();
  const [tab, setTab] = useState<ArenaTab>('match');
  const [matching, setMatching] = useState(false);
  const [matchProgress, setMatchProgress] = useState(0);
  const matchTimerRef = useRef<number | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const isMatchingRef = useRef<boolean>(false);

  const selfPower = useMemo(() => calcPower(character), [character]);
  const selfName = character?.nickname || '我';
  const selfRealm = character?.realm || '凡人';

  const [status, setStatus] = useState<ArenaStatusDto | null>(null);
  const [records, setRecords] = useState<ArenaRecordDto[]>([]);
  const score = status?.score ?? 1000;
  const winCount = status?.winCount ?? 0;
  const loseCount = status?.loseCount ?? 0;
  const todayChallengeText = status ? `${status.todayUsed}/${status.todayLimit}` : '--';
  const todayRemainingText = status ? String(status.todayRemaining) : '--';

  const refreshStatus = useCallback(async () => {
    try {
      const res = await getArenaStatus();
      if (!res.success) {
        setStatus(null);
        return;
      }
      setStatus(res.data ?? null);
    } catch (e) {
      setStatus(null);
    }
  }, []);

  const refreshRecords = useCallback(async () => {
    try {
      const res = await getArenaRecords(50);
      if (!res.success) {
        setRecords([]);
        return;
      }
      setRecords(res.data ?? []);
    } catch (e) {
      setRecords([]);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshStatus(), refreshRecords()]);
  }, [refreshRecords, refreshStatus]);

  const clearTimers = useCallback(() => {
    if (matchTimerRef.current) {
      window.clearTimeout(matchTimerRef.current);
      matchTimerRef.current = null;
    }
    if (progressTimerRef.current) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  const stopMatching = useCallback(() => {
    isMatchingRef.current = false;
    clearTimers();
    setMatching(false);
    setMatchProgress(0);
  }, [clearTimers]);

  useEffect(() => {
    const off = gameSocket.onArenaUpdate((payload) => {
      if (!open) return;
      const kind = (payload as { kind?: unknown })?.kind;
      if (kind === 'arena_status') {
        const next = (payload as { status?: unknown })?.status;
        if (next && typeof next === 'object') {
          setStatus(next as ArenaStatusDto);
        }
        return;
      }
      void refreshAll();
    });
    return off;
  }, [open, refreshAll]);

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  const startQuickMatch = useCallback(() => {
    if (matching) return;
    isMatchingRef.current = true;
    setMatching(true);
    setMatchProgress(0);
    if (progressTimerRef.current) window.clearInterval(progressTimerRef.current);
    progressTimerRef.current = window.setInterval(() => {
      setMatchProgress((p) => {
        if (p >= 99) return 99;
        return Math.min(99, p + 6);
      });
    }, 180);
    if (matchTimerRef.current) window.clearTimeout(matchTimerRef.current);
    matchTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await arenaMatch();
          if (!isMatchingRef.current) return;
          if (!res?.success || !res.data?.battleId) {
            stopMatching();
            return;
          }
          stopMatching();
          onClose();
          onStartBattle?.(res.data.battleId);
        } catch (e) {
          if (!isMatchingRef.current) return;
          stopMatching();
        }
      })();
    }, 900);
  }, [matching, onClose, onStartBattle, stopMatching]);

  const tabItems = useMemo(
    () => [
      {
        key: 'match',
        label: '匹配',
        children: (
          <div className="arena-match-layout">
            <div className="arena-self-card">
              <div className="arena-self-head">
                <div className="arena-self-title">我的信息</div>
              </div>

              <div className="arena-self-score">
                <div className="arena-self-score-label">当前积分</div>
                <div className="arena-self-score-value">{score}</div>
              </div>

              <div className="arena-self-metrics">
                <div className="arena-self-metric">
                  <span className="arena-self-metric-label">胜场</span>
                  <span className="arena-self-metric-value is-win">{winCount}</span>
                </div>
                <div className="arena-self-metric">
                  <span className="arena-self-metric-label">负场</span>
                  <span className="arena-self-metric-value is-lose">{loseCount}</span>
                </div>
              </div>

              <div className="arena-self-meta">
                <div className="arena-self-meta-row">
                  <span className="arena-self-meta-key">玩家</span>
                  <span className="arena-self-meta-value is-highlight">{selfName}</span>
                </div>
                <div className="arena-self-meta-row">
                  <span className="arena-self-meta-key">境界</span>
                  <span className="arena-self-meta-value is-highlight">{selfRealm}</span>
                </div>
                <div className="arena-self-meta-row">
                  <span className="arena-self-meta-key">战力</span>
                  <span className="arena-self-meta-value">{selfPower.toLocaleString()}</span>
                </div>
                <div className="arena-self-meta-row">
                  <span className="arena-self-meta-key">今日挑战</span>
                  <span className="arena-self-meta-value">{todayChallengeText}（剩余 {todayRemainingText}）</span>
                </div>
              </div>

              <div className="arena-self-actions">
                {!matching ? (
                  <Button type="primary" size="large" block onClick={startQuickMatch} className="arena-match-btn">
                    一键匹配
                  </Button>
                ) : (
                  <div className="arena-match-active-row">
                    <div className="arena-match-progress-box">
                      <div className="arena-match-progress-text">正在匹配对手...</div>
                      <Progress percent={matchProgress} showInfo={false} strokeColor="var(--primary-color)" size="small" />
                    </div>
                    <Button danger size="large" onClick={stopMatching} className="arena-cancel-btn">
                      取消
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ),
      },
      {
        key: 'record',
        label: '战报',
        children: (
          <div className="arena-record-pane">
            <div className="arena-record-head">
              <div className="arena-record-title">最近战报</div>
              <Button
                size="small"
                type="text"
                className="arena-record-clear-btn"
                disabled={!records.length}
                onClick={() => {
                  setRecords([]);
                  message.success('已清空战报');
                }}
              >
                清空
              </Button>
            </div>
            
            <div className="arena-record-list">
              <div className="arena-record-list-body">
                {records.map((row) => (
                  <div key={row.id} className="arena-record-card">
                    <div className="arena-record-card-head">
                      <div className="arena-record-card-title">{row.opponentName}</div>
                      {renderResultTag(row.result)}
                    </div>
                    <div className="arena-record-card-meta">
                      <div className="arena-record-card-item">
                        <span className="ar-k">时间</span>
                        <span className="ar-v">{formatArenaRecordTime(row.ts)}</span>
                      </div>
                      <div className="arena-record-card-item">
                        <span className="ar-k">境界</span>
                        <span className="ar-v">{row.opponentRealm}</span>
                      </div>
                      <div className="arena-record-card-item">
                        <span className="ar-k">战力</span>
                        <span className="ar-v">{row.opponentPower.toLocaleString()}</span>
                      </div>
                      <div className="arena-record-card-item">
                        <span className="ar-k">积分变化</span>
                        <span className="ar-v">{formatScoreDelta(row.deltaScore)}</span>
                      </div>
                      <div className="arena-record-card-item">
                        <span className="ar-k">当前积分</span>
                        <span className="ar-v">{row.scoreAfter}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {!records.length ? <div className="arena-empty">暂无战报，去匹配挑战吧。</div> : null}
              </div>
            </div>
          </div>
        ),
      },
      {
        key: 'rule',
        label: '规则',
        children: (
          <div className="arena-rule">
            {ARENA_RULE_SECTIONS.map((section) => (
              <div key={section.heading} className="arena-rule-block">
                <div className="arena-rule-heading">{section.heading}</div>
                {section.details.map((detail) => (
                  <div key={`${section.heading}-${detail}`} className="arena-rule-indent">
                    • {detail}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ),
      },
    ],
    [
      matchProgress,
      matching,
      records,
      score,
      selfName,
      selfPower,
      selfRealm,
      startQuickMatch,
      stopMatching,
      winCount,
      loseCount,
      todayChallengeText,
      todayRemainingText,
      message,
    ],
  );

  const activePanel = useMemo(() => tabItems.find((it) => it.key === tab)?.children ?? null, [tab, tabItems]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={480}
      className="arena-modal"
      destroyOnHidden
      maskClosable
      afterOpenChange={(visible) => {
        if (!visible) {
          stopMatching();
          return;
        }
        setTab('match');
        setMatching(false);
        setMatchProgress(0);
        void refreshAll();
      }}
    >
      <div className="arena-shell">
        <div className="arena-head">
          <div className="arena-head-title">竞技场</div>
        </div>
        <div className="arena-tabs">
          {tabItems.map((item) => (
            <div
              key={item.key}
              className={`arena-tab-item ${tab === item.key ? 'is-active' : ''}`}
              onClick={() => setTab(item.key as ArenaTab)}
            >
              <div className="arena-tab-item-text">{item.label}</div>
            </div>
          ))}
        </div>
        <div className="arena-panel">{activePanel}</div>
      </div>
    </Modal>
  );
};

export default ArenaModal;
