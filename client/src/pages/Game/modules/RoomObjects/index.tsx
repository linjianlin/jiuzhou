import { useEffect, useMemo, useRef, useState } from 'react';
import { Tag } from 'antd';
import type { InfoTarget } from '../InfoModal';
import { getGameTime, getRoomObjects, type GameTimeSnapshotDto } from '../../../../services/api';
import './index.scss';

interface RoomObjectsProps {
  mapId: string;
  roomId: string;
  onSelect?: (target: InfoTarget) => void;
}

type RoomObjectType = InfoTarget['type'];
type RoomObject = InfoTarget & { task_marker?: '!' | '?'; task_tracked?: boolean };

const typeLabel: Record<RoomObjectType, { text: string; color: string }> = {
  npc: { text: 'NPC', color: 'blue' },
  monster: { text: '妖兽', color: 'red' },
  item: { text: '物品', color: 'gold' },
  player: { text: '玩家', color: 'green' },
};

const typeOrder: Record<RoomObjectType, number> = { npc: 0, monster: 1, item: 2, player: 3 };

const calcShichen = (hour: number): string => {
  const h = Math.floor(hour);
  if (h === 23 || (h >= 0 && h < 1)) return '子时';
  if (h >= 1 && h < 3) return '丑时';
  if (h >= 3 && h < 5) return '寅时';
  if (h >= 5 && h < 7) return '卯时';
  if (h >= 7 && h < 9) return '辰时';
  if (h >= 9 && h < 11) return '巳时';
  if (h >= 11 && h < 13) return '午时';
  if (h >= 13 && h < 15) return '未时';
  if (h >= 15 && h < 17) return '申时';
  if (h >= 17 && h < 19) return '酉时';
  if (h >= 19 && h < 21) return '戌时';
  return '亥时';
};

const formatGameTime = (
  sync: Pick<GameTimeSnapshotDto, 'era_name' | 'base_year' | 'weather' | 'scale' | 'server_now_ms' | 'game_elapsed_ms'>,
  nowMs: number,
): { left: string; center: string; right: string } => {
  const elapsedMs = sync.game_elapsed_ms + Math.max(0, nowMs - sync.server_now_ms) * Math.max(1, sync.scale || 1);
  const totalSec = Math.floor(elapsedMs / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const totalHour = Math.floor(totalMin / 60);
  const hour = ((totalHour % 24) + 24) % 24;
  const totalDay = Math.floor(totalHour / 24);
  const day = ((totalDay % 30) + 30) % 30 + 1;
  const totalMonth = Math.floor(totalDay / 30);
  const month = ((totalMonth % 12) + 12) % 12 + 1;
  const yearAdd = Math.floor(totalMonth / 12);
  const year = sync.base_year + yearAdd;

  return {
    left: `${sync.era_name}${year}年`,
    center: `${month}月${day}日`,
    right: `${calcShichen(hour)} ${sync.weather}`,
  };
};

const getSeasonDesc = (month: number): string => {
  const m = Math.floor(Number(month) || 0);
  if (m >= 3 && m <= 5) return '春意盎然，万物复苏';
  if (m >= 6 && m <= 8) return '暑气渐盛，蝉鸣阵阵';
  if (m >= 9 && m <= 11) return '秋风送爽，落叶纷飞';
  return '寒意渐浓，天地肃然';
};

const getWeatherDesc = (weather: string): string => {
  const w = String(weather || '').trim();
  if (w === '晴') return '天气晴朗，万里无云';
  if (w === '阴') return '云层低垂，天色微暗';
  if (w === '雨') return '细雨绵绵，地面湿滑';
  if (w === '雾') return '雾气弥漫，视线受阻';
  if (w === '雪') return '瑞雪纷飞，银装素裹';
  if (w === '雷') return '雷声滚滚，风雨欲来';
  return w ? `天气变化：${w}` : '天气莫测，难以言明';
};

const appendSystemChat = (content: string) => {
  const text = String(content || '').trim();
  if (!text) return;
  window.dispatchEvent(
    new CustomEvent('chat:append', {
      detail: {
        channel: 'system',
        content: text,
        senderName: '系统',
        senderTitle: '',
        timestamp: Date.now(),
      },
    }),
  );
};

const RoomObjects: React.FC<RoomObjectsProps> = ({ mapId, roomId, onSelect }) => {
  const [objects, setObjects] = useState<RoomObject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [gameTime, setGameTime] = useState<GameTimeSnapshotDto | null>(null);
  const lastAnnouncedRef = useRef<{ dateKey: string; weather: string } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchTime = () => {
      getGameTime()
        .then((res) => {
          if (cancelled) return;
          if (!res?.success || !res.data) return;
          const next = res.data;
          const nextWeather = String(next.weather || '').trim();
          const dateKey = `${next.year}-${next.month}-${next.day}`;
          const last = lastAnnouncedRef.current;
          if (!last) {
            lastAnnouncedRef.current = { dateKey, weather: nextWeather };
          } else if (dateKey !== last.dateKey) {
            lastAnnouncedRef.current = { dateKey, weather: nextWeather };
            appendSystemChat(
              `进入了${next.month}月${next.day}日，${getSeasonDesc(next.month)}。${getWeatherDesc(nextWeather)}（${nextWeather || '未知'}）`,
            );
          } else {
            lastAnnouncedRef.current = { dateKey, weather: nextWeather };
          }
          setGameTime(res.data);
        })
        .catch(() => {
          if (cancelled) return;
        });
    };

    fetchTime();
    const timer = window.setInterval(fetchTime, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchObjects = () => {
      if (cancelled) return;
      setLoading(true);
      setError('');
      getRoomObjects(mapId, roomId)
        .then((res) => {
          if (cancelled) return;
          if (!res?.success || !res.data) {
            setObjects([]);
            setError(res?.message || '获取房间对象失败');
            return;
          }
          setObjects((res.data.objects ?? []) as unknown as RoomObject[]);
        })
        .catch((e) => {
          if (cancelled) return;
          setObjects([]);
          setError(e?.message || '网络错误');
        })
        .finally(() => {
          if (cancelled) return;
          setLoading(false);
        });
    };

    fetchObjects();
    const handleRefresh = () => fetchObjects();
    window.addEventListener('room:objects:changed', handleRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener('room:objects:changed', handleRefresh);
    };
  }, [mapId, roomId]);

  const renderResourceStatus = (obj: RoomObject) => {
    if (obj.type !== 'item' || obj.object_kind !== 'resource' || !obj.resource) return null;

    const cdUntilText = obj.resource.cooldownUntil ?? null;
    const cdUntilMs = cdUntilText ? Date.parse(cdUntilText) : NaN;
    const hasCdUntil = Number.isFinite(cdUntilMs) && cdUntilMs > 0;
    const cooldownSec = hasCdUntil
      ? Math.max(0, Math.ceil((cdUntilMs - nowMs) / 1000))
      : (obj.resource.cooldownSec ?? 0);

    if (cooldownSec > 0) {
      return <div className="room-objects-item-sub">刷新倒计时：{cooldownSec}秒</div>;
    }

    const usedCount = hasCdUntil ? 0 : (obj.resource.usedCount ?? 0);
    const collectLimit = obj.resource.collectLimit ?? 0;
    const remaining = hasCdUntil ? collectLimit : (obj.resource.remaining ?? 0);
    return (
      <div className="room-objects-item-sub">
        采集次数：{usedCount}/{collectLimit}（剩余{remaining}）
      </div>
    );
  };

  const sortedObjects = useMemo(
    () =>
      objects
        .map((obj, index) => ({ obj, index }))
        .sort((a, b) => typeOrder[a.obj.type] - typeOrder[b.obj.type] || a.index - b.index)
        .map((x) => x.obj),
    [objects],
  );

  const timeText = useMemo(() => {
    if (!gameTime) {
      return { left: '末法纪元', center: '', right: '' };
    }
    return formatGameTime(gameTime, nowMs);
  }, [gameTime, nowMs]);

  return (
    <div className="room-objects">
      <div className="room-objects-header">
        <div className="room-objects-time">
          <span className="room-objects-time-left">{timeText.left}</span>
          <span className="room-objects-time-center">{timeText.center}</span>
          <span className="room-objects-time-right">{timeText.right}</span>
        </div>
      </div>

      <div className="room-objects-list">
        {loading ? (
          <div className="room-objects-empty">加载中...</div>
        ) : error ? (
          <div className="room-objects-empty">{error}</div>
        ) : sortedObjects.length > 0 ? (
          sortedObjects.map((obj) => (
            <div
              key={obj.id}
              className={`room-objects-item ${obj.task_tracked ? 'task-tracked' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect?.(obj)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelect?.(obj);
              }}
            >
              <div className="room-objects-item-left">
                <div className="room-objects-item-name">
                  {obj.task_marker ? (
                    <span className={`room-objects-task-marker ${obj.task_marker === '?' ? 'turnin' : 'available'}`}>
                      {obj.task_marker}
                    </span>
                  ) : null}
                  <span className="room-objects-item-name-text">{obj.name}</span>
                </div>
                {renderResourceStatus(obj)}
              </div>
              <Tag className="room-objects-item-tag" color={typeLabel[obj.type].color}>
                {typeLabel[obj.type].text}
              </Tag>
            </div>
          ))
        ) : (
          <div className="room-objects-empty">当前房间没有可交互对象</div>
        )}
      </div>
    </div>
  );
};

export default RoomObjects;
