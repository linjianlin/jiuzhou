import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Button, Drawer, Input, Popover, Select, Table, Tabs, Tooltip, type InputRef } from 'antd';
import { BarChartOutlined, CloseOutlined, LineChartOutlined, SendOutlined } from '@ant-design/icons';
import { gameSocket, type CharacterData, type OnlinePlayerDto } from '../../../../services/gameSocket';
import type { InfoTarget } from '../InfoModal';
import { parseBattleLootLine } from '../../shared/battleLoot';
import StatsShell from './StatsShell';
import './index.scss';

type ChatChannel = 'all' | 'world' | 'team' | 'sect' | 'private' | 'battle' | 'system';
type PublicChatChannel = Exclude<ChatChannel, 'all' | 'private'>;
const MAX_MESSAGES_PER_CHANNEL = 200;
const MAX_MESSAGES_ALL = 1200;

interface Message {
  id: string;
  clientId?: string;
  senderTitle: string;
  senderName: string;
  content: string;
  channel: ChatChannel;
  timestamp: number;
  isSelf?: boolean;
  pmTargetId?: string;
  senderCharacterId?: number;
  pmTargetCharacterId?: number;
}

interface MessageBuckets {
  all: Message[];
  world: Message[];
  team: Message[];
  sect: Message[];
  battle: Message[];
  system: Message[];
  privateByTarget: Record<string, Message[]>;
}

interface PrivateTarget {
  id: string;
  name: string;
  title: string;
  characterId?: number;
}

interface DropStatRow {
  itemName: string;
  quantity: number;
}

interface DropReceiverStatRow {
  receiverName: string;
  quantity: number;
  dropCount: number;
  itemKindCount: number;
}

interface DropDetailRow {
  itemName: string;
  quantity: number;
  receiverName: string;
  timestamp: number;
  raw: string;
}

interface OutputStatRow {
  actorName: string;
  damage: number;
  heal: number;
}

interface OutputSkillStatRow {
  skillName: string;
  castCount: number;
  damage: number;
  heal: number;
  critCount: number;
  missCount: number;
  actorCount: number;
}

interface OutputDetailRow {
  round: number;
  actorName: string;
  skillName: string;
  damage: number;
  heal: number;
  critCount: number;
  missCount: number;
  raw: string;
}

interface PieDatum {
  label: string;
  value: number;
}

interface PieSlice {
  label: string;
  value: number;
  color: string;
  percent: number;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const hslColor = (idx: number) => {
  const hue = ((idx * 47) % 360 + 360) % 360;
  return `hsl(${hue} 70% 55%)`;
};

const formatCompactNumber = (v: number) => {
  const n = Math.max(0, Math.floor(Number(v) || 0));
  return String(n);
};

const buildTopPieSlices = (data: PieDatum[], topN = 10): PieSlice[] => {
  const list = (data ?? [])
    .map((x) => ({ label: String(x.label ?? '').trim() || '未知', value: Math.max(0, Number(x.value) || 0) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'zh-Hans-CN'));

  const total = list.reduce((sum, x) => sum + x.value, 0);
  if (total <= 0) return [];

  const kept = list.slice(0, Math.max(1, topN));
  const rest = list.slice(Math.max(1, topN));
  const restValue = rest.reduce((sum, x) => sum + x.value, 0);
  const merged = restValue > 0 ? [...kept, { label: '其他', value: restValue }] : kept;

  return merged.map((x, idx) => ({
    label: x.label,
    value: x.value,
    color: hslColor(idx),
    percent: x.value / total,
  }));
};

const polarToCartesian = (cx: number, cy: number, r: number, angleRad: number) => {
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
};

const wedgePath = (cx: number, cy: number, r: number, startAngleRad: number, endAngleRad: number) => {
  const start = polarToCartesian(cx, cy, r, startAngleRad);
  const end = polarToCartesian(cx, cy, r, endAngleRad);
  const delta = endAngleRad - startAngleRad;
  const largeArcFlag = delta > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y} Z`;
};

const PieChart = ({ title, data }: { title: string; data: PieDatum[] }) => {
  const slices = useMemo(() => buildTopPieSlices(data, 10), [data]);
  const size = 210;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 8;

  const paths = useMemo(() => {
    return slices.reduce(
      (state, slice) => {
        const start = state.cursor;
        const end = start + Math.PI * 2 * clamp(slice.percent, 0, 1);
        return { cursor: end, items: [...state.items, { slice, d: wedgePath(cx, cy, r, start, end) }] };
      },
      { cursor: -Math.PI / 2, items: [] as Array<{ slice: PieSlice; d: string }> },
    ).items;
  }, [cx, cy, r, slices]);

  return (
    <div className="chat-pie-card">
      <div className="chat-pie-title">{title}</div>
      <div className="chat-pie-body">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="chat-pie-svg">
          {paths.map((p) => (
            <path key={p.slice.label} d={p.d} fill={p.slice.color} />
          ))}
        </svg>
        <div className="chat-pie-legend">
          {slices.map((s) => (
            <div key={s.label} className="chat-pie-legend-row" title={`${s.label} ${formatCompactNumber(s.value)}`}>
              <span className="chat-pie-dot" style={{ background: s.color }} />
              <span className="chat-pie-label">{s.label}</span>
              <span className="chat-pie-val">{formatCompactNumber(s.value)}</span>
              <span className="chat-pie-pct">{`${(s.percent * 100).toFixed(1)}%`}</span>
            </div>
          ))}
          {slices.length === 0 ? <div className="chat-pie-empty">暂无数据</div> : null}
        </div>
      </div>
    </div>
  );
};

const makePrivateTargetId = (characterId: number) => `pm-${characterId}`;

const initialMessages: Message[] = [];

const createEmptyMessageBuckets = (): MessageBuckets => ({
  all: [],
  world: [],
  team: [],
  sect: [],
  battle: [],
  system: [],
  privateByTarget: {},
});

const pushWithLimit = <T,>(list: T[], item: T, limit: number): T[] => {
  if (limit <= 0) return [];
  if (list.length < limit) return [...list, item];
  return [...list.slice(list.length - limit + 1), item];
};

const replaceMessageById = (
  list: Message[],
  messageId: string,
  nextMessage: Message,
): { replaced: boolean; list: Message[] } => {
  const idx = list.findIndex((msg) => msg.id === messageId);
  if (idx < 0) return { replaced: false, list };
  const next = list.slice();
  next[idx] = { ...next[idx], ...nextMessage, id: nextMessage.id };
  return { replaced: true, list: next };
};

const isPublicChatChannel = (channel: ChatChannel): channel is PublicChatChannel => {
  return channel === 'world' || channel === 'team' || channel === 'sect' || channel === 'battle' || channel === 'system';
};

const BATTLE_LOOT_PREFIXES = ['【战利分配】', '【斗法所得】'] as const;

const isBattleLootMessage = (content: string): boolean => {
  const line = String(content ?? '').trim();
  if (!line) return false;
  return BATTLE_LOOT_PREFIXES.some((prefix) => line.startsWith(prefix));
};

const shouldIncludeInAllChannel = (message: Message & { channel: PublicChatChannel }): boolean => {
  if (message.channel !== 'battle') return true;
  return isBattleLootMessage(message.content);
};

const appendPublicMessage = (
  buckets: MessageBuckets,
  message: Message & { channel: PublicChatChannel },
): MessageBuckets => {
  const channelList = buckets[message.channel];
  if (channelList.some((msg) => msg.id === message.id)) return buckets;

  const includeInAll = shouldIncludeInAllChannel(message);
  if (includeInAll && buckets.all.some((msg) => msg.id === message.id)) return buckets;

  const nextChannelList = pushWithLimit(channelList, message, MAX_MESSAGES_PER_CHANNEL);
  const nextBuckets = {
    ...buckets,
    [message.channel]: nextChannelList,
  } as MessageBuckets;

  if (!includeInAll) return nextBuckets;
  return {
    ...nextBuckets,
    all: pushWithLimit(buckets.all, message, MAX_MESSAGES_ALL),
  };
};

const appendPrivateMessage = (buckets: MessageBuckets, message: Message): MessageBuckets => {
  const targetId = message.pmTargetId ?? makePrivateTargetId(0);
  const normalizedMessage = { ...message, channel: 'private' as const, pmTargetId: targetId };
  if (buckets.all.some((msg) => msg.id === normalizedMessage.id)) return buckets;

  const currentList = buckets.privateByTarget[targetId] ?? [];
  return {
    ...buckets,
    all: pushWithLimit(buckets.all, normalizedMessage, MAX_MESSAGES_ALL),
    privateByTarget: {
      ...buckets.privateByTarget,
      [targetId]: pushWithLimit(currentList, normalizedMessage, MAX_MESSAGES_PER_CHANNEL),
    },
  };
};

const appendMessage = (buckets: MessageBuckets, message: Message): MessageBuckets => {
  if (message.channel === 'private') return appendPrivateMessage(buckets, message);
  const publicChannel = message.channel;
  if (!isPublicChatChannel(publicChannel)) return buckets;
  return appendPublicMessage(buckets, { ...message, channel: publicChannel });
};

const appendMessages = (buckets: MessageBuckets, messages: Message[]): MessageBuckets => {
  return messages.reduce((acc, message) => appendMessage(acc, message), buckets);
};

const removePrivateTargetMessages = (buckets: MessageBuckets, targetId: string): MessageBuckets => {
  const nextPrivateByTarget = { ...buckets.privateByTarget };
  delete nextPrivateByTarget[targetId];
  return {
    ...buckets,
    all: buckets.all.filter((msg) => !(msg.channel === 'private' && msg.pmTargetId === targetId)),
    privateByTarget: nextPrivateByTarget,
  };
};

const buildInitialMessageBuckets = (list: Message[]): MessageBuckets => {
  if (list.length === 0) return createEmptyMessageBuckets();
  return appendMessages(createEmptyMessageBuckets(), list);
};

const sumByRegex = (line: string, pattern: RegExp): number => {
  let sum = 0;
  for (const matched of line.matchAll(pattern)) {
    sum += Math.max(0, Math.floor(Number(matched[1]) || 0));
  }
  return sum;
};

const countByRegex = (line: string, pattern: RegExp): number => {
  let count = 0;
  for (const _ of line.matchAll(pattern)) {
    count += 1;
  }
  return count;
};

interface ChatPanelProps {
  onSelectPlayer?: (target: InfoTarget) => void;
  isMobile?: boolean;
}

export interface ChatPanelHandle {
  openPrivateChat: (target: Extract<InfoTarget, { type: 'player' }>) => void;
  appendBattleLines: (lines: string[]) => void;
}

const buildInitialPrivateTargets = (list: Message[]): PrivateTarget[] => {
  const map = new Map<string, PrivateTarget>();
  for (const msg of list) {
    if (msg.channel !== 'private') continue;
    const name = msg.senderName?.trim();
    if (!name || name === '系统') continue;
    const id = msg.pmTargetId ?? makePrivateTargetId(0);
    const title = msg.senderTitle?.trim() || '';
    if (!map.has(id)) map.set(id, { id, name, title });
  }
  return Array.from(map.values());
};

const initialMessageBuckets = buildInitialMessageBuckets(initialMessages);
const initialPrivateTargets = buildInitialPrivateTargets(initialMessageBuckets.all);

const ChatPanelBase = forwardRef<ChatPanelHandle, ChatPanelProps>(({ onSelectPlayer, isMobile }, ref) => {
  const [activeChannel, setActiveChannel] = useState<ChatChannel>('all');
  const [inputValue, setInputValue] = useState('');
  const [messageBuckets, setMessageBuckets] = useState<MessageBuckets>(initialMessageBuckets);
  const [character, setCharacter] = useState<CharacterData | null>(gameSocket.getCharacter());
  const [privateTargets, setPrivateTargets] = useState<PrivateTarget[]>(initialPrivateTargets);
  const [activePrivateTargetId, setActivePrivateTargetId] = useState<string>(initialPrivateTargets[0]?.id ?? '');
  const [onlinePlayers, setOnlinePlayers] = useState<OnlinePlayerDto[]>([]);
  const [onlineTotal, setOnlineTotal] = useState(0);
  const [dropStatsOpen, setDropStatsOpen] = useState(false);
  const [outputStatsOpen, setOutputStatsOpen] = useState(false);
  const [dropTabKey, setDropTabKey] = useState<'by_item' | 'by_receiver' | 'details' | 'pie'>('by_item');
  const [dropKeyword, setDropKeyword] = useState('');
  const [dropReceiver, setDropReceiver] = useState<string | undefined>(undefined);
  const [outputTabKey, setOutputTabKey] = useState<'by_actor' | 'by_skill' | 'details' | 'pie'>('by_actor');
  const [outputKeyword, setOutputKeyword] = useState('');
  const [outputActor, setOutputActor] = useState<string | undefined>(undefined);
  const [battleStatsFromTs, setBattleStatsFromTs] = useState(0);
  const [onlineDrawerOpen, setOnlineDrawerOpen] = useState(false);
  const mainMessagesRef = useRef<HTMLDivElement>(null);
  const privateMessagesRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const prevMessageViewKeyRef = useRef('');
  const prevMessageTailIdRef = useRef('');
  const inputRef = useRef<InputRef>(null);
  const myCharacterIdRef = useRef<number | null>(character?.id ?? null);

  useEffect(() => {
    myCharacterIdRef.current = character?.id ?? null;
  }, [character]);

  useEffect(() => {
    gameSocket.connect();
    const unsubscribe = gameSocket.onCharacterUpdate((data) => setCharacter(data));
    const unsubscribeOnline = gameSocket.onOnlinePlayersUpdate((payload) => {
      const list = Array.isArray(payload.players) ? payload.players : [];
      setOnlinePlayers(list);
      setOnlineTotal(Number.isFinite(payload.total) ? payload.total : list.length);
    });
    const unsubscribeChat = gameSocket.onChatMessage((msg) => {
      const myCharacterId = myCharacterIdRef.current;
      const isSelf = myCharacterId != null && msg.senderCharacterId === myCharacterId;
      const now = Date.now();
      const channel: ChatChannel = msg.channel;

      if (channel === 'private') {
        const otherCharacterId = isSelf ? (msg.pmTargetCharacterId ?? 0) : msg.senderCharacterId;
        const pmTargetId = makePrivateTargetId(otherCharacterId);

        setPrivateTargets((prev) => {
          const exist = prev.find((t) => t.id === pmTargetId);
          if (exist) {
            const nextName = (exist.name?.trim() ? exist.name : isSelf ? exist.name : msg.senderName).trim();
            const nextTitle = (exist.title?.trim() ? exist.title : isSelf ? exist.title : msg.senderTitle).trim();
            if (nextName === exist.name && nextTitle === exist.title && exist.characterId === otherCharacterId) return prev;
            return prev.map((t) =>
              t.id === pmTargetId ? { ...t, name: nextName || t.name, title: nextTitle || t.title, characterId: otherCharacterId } : t,
            );
          }
          const name = isSelf ? `玩家${otherCharacterId}` : msg.senderName;
          const title = isSelf ? '' : msg.senderTitle;
          return [...prev, { id: pmTargetId, name, title, characterId: otherCharacterId }];
        });

        setMessageBuckets((prev) => {
          const nextMessage: Message = {
            id: msg.id,
            clientId: msg.clientId,
            senderTitle: msg.senderTitle ?? '',
            senderName: msg.senderName ?? '',
            senderCharacterId: msg.senderCharacterId,
            content: msg.content,
            channel: 'private',
            timestamp: msg.timestamp ?? now,
            isSelf,
            pmTargetId,
            pmTargetCharacterId: msg.pmTargetCharacterId,
          };

          if (isSelf && msg.clientId) {
            const privateList = prev.privateByTarget[pmTargetId] ?? [];
            const privateResult = replaceMessageById(privateList, msg.clientId, nextMessage);
            const allResult = replaceMessageById(prev.all, msg.clientId, nextMessage);
            if (privateResult.replaced || allResult.replaced) {
              const nextPrivateList = privateResult.replaced
                ? privateResult.list
                : privateList.some((item) => item.id === nextMessage.id)
                  ? privateList
                  : pushWithLimit(privateList, nextMessage, MAX_MESSAGES_PER_CHANNEL);
              const nextAll = allResult.replaced
                ? allResult.list
                : prev.all.some((item) => item.id === nextMessage.id)
                  ? prev.all
                  : pushWithLimit(prev.all, nextMessage, MAX_MESSAGES_ALL);
              return {
                ...prev,
                all: nextAll,
                privateByTarget: {
                  ...prev.privateByTarget,
                  [pmTargetId]: nextPrivateList,
                },
              };
            }
          }

          return appendPrivateMessage(prev, nextMessage);
        });

        return;
      }

      if (!isPublicChatChannel(channel)) return;

      setMessageBuckets((prev) => {
        const nextMessage: Message = {
          id: msg.id,
          clientId: msg.clientId,
          senderTitle: msg.senderTitle ?? '',
          senderName: msg.senderName ?? '',
          senderCharacterId: msg.senderCharacterId,
          content: msg.content,
          channel,
          timestamp: msg.timestamp ?? now,
          isSelf,
        };

        if (isSelf && msg.clientId) {
          const includeInAll = shouldIncludeInAllChannel(nextMessage as Message & { channel: PublicChatChannel });
          const channelList = prev[channel];
          const channelResult = replaceMessageById(channelList, msg.clientId, nextMessage);
          const allResult = includeInAll
            ? replaceMessageById(prev.all, msg.clientId, nextMessage)
            : { replaced: false, list: prev.all };
          if (channelResult.replaced || allResult.replaced) {
            const nextChannelList = channelResult.replaced
              ? channelResult.list
              : channelList.some((item) => item.id === nextMessage.id)
                ? channelList
                : pushWithLimit(channelList, nextMessage, MAX_MESSAGES_PER_CHANNEL);
            const nextAll = !includeInAll
              ? prev.all
              : allResult.replaced
                ? allResult.list
                : prev.all.some((item) => item.id === nextMessage.id)
                  ? prev.all
                  : pushWithLimit(prev.all, nextMessage, MAX_MESSAGES_ALL);
            return {
              ...prev,
              all: nextAll,
              [channel]: nextChannelList,
            } as MessageBuckets;
          }
        }

        return appendPublicMessage(prev, nextMessage as Message & { channel: PublicChatChannel });
      });
    });
    const unsubscribeChatError = gameSocket.onChatError((error) => {
      const content = String(error?.message ?? '').trim();
      if (!content) return;
      setMessageBuckets((prev) =>
        appendMessage(prev, {
          id: `sys-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          senderTitle: '',
          senderName: '系统',
          content,
          channel: 'system',
          timestamp: Date.now(),
        }),
      );
    });
    return () => {
      unsubscribe();
      unsubscribeOnline();
      unsubscribeChat();
      unsubscribeChatError();
    };
  }, []);

  useEffect(() => {
    const onAppend = (e: Event) => {
      const ce = e as CustomEvent<{
        channel?: ChatChannel | 'all';
        content?: unknown;
        senderName?: unknown;
        senderTitle?: unknown;
        timestamp?: unknown;
      }>;

      const channel = ce.detail?.channel;
      if (channel !== 'system' && channel !== 'battle') return;
      const content = String(ce.detail?.content ?? '').trim();
      if (!content) return;

      const senderName = String(ce.detail?.senderName ?? '').trim() || '系统';
      const senderTitle = String(ce.detail?.senderTitle ?? '').trim();
      const tsRaw = ce.detail?.timestamp;
      const timestamp = typeof tsRaw === 'number' && Number.isFinite(tsRaw) ? tsRaw : Date.now();

      setMessageBuckets((prev) =>
        appendMessage(prev, {
          id: `sys-${timestamp}-${Math.random().toString(16).slice(2)}`,
          senderTitle,
          senderName,
          content,
          channel,
          timestamp,
        }),
      );
    };

    window.addEventListener('chat:append', onAppend as EventListener);
    return () => window.removeEventListener('chat:append', onAppend as EventListener);
  }, []);

  const openPrivateChat = useCallback((target: Extract<InfoTarget, { type: 'player' }>) => {
    const name = target.name?.trim();
    if (!name) return;
    const characterId = Math.floor(Number(target.id));
    if (!Number.isFinite(characterId) || characterId <= 0) return;
    const id = makePrivateTargetId(characterId);
    const title = target.title?.trim() || '';

    setPrivateTargets((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
      return [...prev, { id, name, title, characterId }];
    });

    setActivePrivateTargetId(id);
    setActiveChannel('private');
    queueMicrotask(() => inputRef.current?.focus?.());
  }, []);

  const appendBattleLines = useCallback((lines: string[]) => {
    const list = (lines ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
    if (list.length === 0) return;
    const now = Date.now();
    const next: Message[] = list.map((content, idx) => ({
      id: `battle-${now}-${idx}-${Math.random().toString(16).slice(2)}`,
      senderTitle: '战况',
      senderName: '系统',
      content,
      channel: 'battle',
      timestamp: now + idx,
    }));
    setMessageBuckets((prev) => appendMessages(prev, next));
  }, []);

  useImperativeHandle(ref, () => ({ openPrivateChat, appendBattleLines }), [appendBattleLines, openPrivateChat]);

  const getDisplayName = (senderTitle: string, senderName: string) => {
    const title = senderTitle?.trim() ?? '';
    const name = senderName?.trim() ?? '';
    if (!title) return name;
    if (!name) return title;
    return `${title} ${name}`;
  };

  const getChannelPrefixText = (channel: ChatChannel) => {
    if (channel === 'world') return '[世界] ';
    if (channel === 'team') return '[队伍] ';
    if (channel === 'sect') return '[宗门] ';
    if (channel === 'private') return '[私聊] ';
    if (channel === 'battle') return '[战况] ';
    if (channel === 'system') return '[系统] ';
    return '';
  };

  const selfDisplayName = getDisplayName(character?.title ?? '', character?.nickname ?? '');

  const buildPlayerTarget = (senderTitle: string, senderName: string, senderCharacterId?: number): InfoTarget => {
    const name = senderName?.trim() || '未知';
    const title = senderTitle?.trim() || '';
    const id = senderCharacterId && senderCharacterId > 0 ? String(senderCharacterId) : `chat-player-${name}`;
    return {
      type: 'player',
      id,
      name,
      title,
      gender: '-',
      realm: '-',
      equipment: [
        { slot: '武器', name: '未鉴定武器', quality: '普通' },
        { slot: '衣甲', name: '未鉴定衣甲', quality: '普通' },
      ],
      techniques: [{ name: '未知功法', level: '-', type: '功法' }],
    };
  };

  const activePrivateTarget = privateTargets.find((t) => t.id === activePrivateTargetId) ?? null;

  const renderMessageContent = useCallback((msg: Message): string => {
    return String(msg.content ?? '');
  }, []);

  const handleRemovePrivateTarget = (targetId: string) => {
    const nextTargets = privateTargets.filter((t) => t.id !== targetId);
    setPrivateTargets(nextTargets);
    if (activePrivateTargetId === targetId) {
      setActivePrivateTargetId(nextTargets[0]?.id ?? '');
    }
    setMessageBuckets((prev) => removePrivateTargetMessages(prev, targetId));
  };

  const handleSend = () => {
    const content = inputValue.trim();
    if (!content) return;

    const actualChannel: ChatChannel = activeChannel === 'all' ? 'world' : activeChannel;
    if (actualChannel === 'system' || actualChannel === 'battle') {
      setMessageBuckets((prev) =>
        appendMessage(prev, {
          id: `sys-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          senderTitle: '',
          senderName: '系统',
          content: actualChannel === 'system' ? '系统频道不允许发言' : '战况频道不允许发言',
          channel: 'system',
          timestamp: Date.now(),
        }),
      );
      setInputValue('');
      return;
    }

    const clientId = `c-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const now = Date.now();
    const baseMessage: Message = {
      id: clientId,
      clientId,
      senderTitle: character?.title ?? '',
      senderName: character?.nickname ?? '我',
      senderCharacterId: character?.id,
      content,
      channel: actualChannel,
      timestamp: now,
      isSelf: true,
    };

    if (!gameSocket.isSocketConnected()) {
      const offlineMessage =
        actualChannel === 'private' && activePrivateTargetId
          ? ({
              ...baseMessage,
              pmTargetId: activePrivateTargetId,
              pmTargetCharacterId: privateTargets.find((t) => t.id === activePrivateTargetId)?.characterId,
            } as Message)
          : baseMessage;
      setMessageBuckets((prev) =>
        appendMessages(prev, [
          offlineMessage,
          {
            id: `sys-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            senderTitle: '',
            senderName: '系统',
            content: '聊天服务未连接',
            channel: 'system',
            timestamp: Date.now(),
          },
        ]),
      );
      setInputValue('');
      return;
    }

    if (actualChannel === 'private') {
      if (!activePrivateTargetId) return;
      const target = privateTargets.find((t) => t.id === activePrivateTargetId) ?? null;
      const pmTargetCharacterId = target?.characterId;
      if (!pmTargetCharacterId) return;

      setMessageBuckets((prev) => appendPrivateMessage(prev, { ...baseMessage, pmTargetId: activePrivateTargetId, pmTargetCharacterId }));
      setInputValue('');
      gameSocket.sendChatMessage({ channel: 'private', content, clientId, pmTargetCharacterId });
      return;
    }

    setMessageBuckets((prev) => appendPublicMessage(prev, baseMessage as Message & { channel: PublicChatChannel }));
    setInputValue('');
    gameSocket.sendChatMessage({ channel: actualChannel, content, clientId });
  };

  const filteredMessages = useMemo(() => {
    if (activeChannel === 'all') return messageBuckets.all;
    if (activeChannel === 'private') {
      return messageBuckets.privateByTarget[activePrivateTargetId] ?? [];
    }
    return messageBuckets[activeChannel];
  }, [activeChannel, activePrivateTargetId, messageBuckets]);

  const getActiveMessagesContainer = useCallback((): HTMLDivElement | null => {
    return activeChannel === 'private' ? privateMessagesRef.current : mainMessagesRef.current;
  }, [activeChannel]);

  const isNearBottom = useCallback((el: HTMLDivElement): boolean => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  }, []);

  const handleMainMessagesScroll = useCallback(() => {
    if (activeChannel === 'private') return;
    const el = mainMessagesRef.current;
    if (!el) return;
    shouldStickToBottomRef.current = isNearBottom(el);
  }, [activeChannel, isNearBottom]);

  const handlePrivateMessagesScroll = useCallback(() => {
    if (activeChannel !== 'private') return;
    const el = privateMessagesRef.current;
    if (!el) return;
    shouldStickToBottomRef.current = isNearBottom(el);
  }, [activeChannel, isNearBottom]);

  const activeMessageViewKey = activeChannel === 'private' ? `private:${activePrivateTargetId}` : activeChannel;
  const activeMessageTailId = filteredMessages[filteredMessages.length - 1]?.id ?? '';

  useEffect(() => {
    const viewChanged = prevMessageViewKeyRef.current !== activeMessageViewKey;
    const tailChanged = prevMessageTailIdRef.current !== activeMessageTailId;
    const shouldScroll = viewChanged || (tailChanged && shouldStickToBottomRef.current);

    prevMessageViewKeyRef.current = activeMessageViewKey;
    prevMessageTailIdRef.current = activeMessageTailId;
    if (!shouldScroll) return;

    const rafId = window.requestAnimationFrame(() => {
      const el = getActiveMessagesContainer();
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      shouldStickToBottomRef.current = true;
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [activeMessageTailId, activeMessageViewKey, getActiveMessagesContainer]);

  const battleMessages = useMemo(() => {
    if (!dropStatsOpen && !outputStatsOpen) return [];
    return messageBuckets.battle
      .filter((m) => (battleStatsFromTs > 0 ? m.timestamp >= battleStatsFromTs : true))
      .map((m) => ({ content: String(m.content ?? '').trim(), timestamp: m.timestamp }))
      .filter((m) => Boolean(m.content));
  }, [battleStatsFromTs, dropStatsOpen, messageBuckets.battle, outputStatsOpen]);

  const dropStats = useMemo(() => {
    const details: DropDetailRow[] = [];
    const byItem = new Map<string, { quantity: number; dropCount: number; receiverQty: Map<string, number> }>();
    const byReceiver = new Map<string, { quantity: number; dropCount: number; itemSet: Set<string> }>();
    let totalQty = 0;
    let totalRecords = 0;

    for (const bm of battleMessages) {
      const line = bm.content;
      const parsed = parseBattleLootLine(line);
      if (!parsed) continue;
      const receiverName = parsed.receiverName || '未知';

      for (const lootItem of parsed.items) {
        const itemName = lootItem.itemName;
        const qty = Math.max(1, Math.floor(Number(lootItem.quantity) || 1));
        if (!itemName) continue;

        details.push({ itemName, quantity: qty, receiverName, timestamp: bm.timestamp, raw: line });

        const receiverKeyForItem = receiverName || '未知';
        const prevItem = byItem.get(itemName) ?? { quantity: 0, dropCount: 0, receiverQty: new Map<string, number>() };
        prevItem.quantity += qty;
        prevItem.dropCount += 1;
        prevItem.receiverQty.set(receiverKeyForItem, (prevItem.receiverQty.get(receiverKeyForItem) ?? 0) + qty);
        byItem.set(itemName, prevItem);

        const receiverKey = receiverName || '未知';
        const prevReceiver = byReceiver.get(receiverKey) ?? { quantity: 0, dropCount: 0, itemSet: new Set<string>() };
        prevReceiver.quantity += qty;
        prevReceiver.dropCount += 1;
        prevReceiver.itemSet.add(itemName);
        byReceiver.set(receiverKey, prevReceiver);

        totalQty += qty;
        totalRecords += 1;
      }
    }

    const byItemRows: Array<DropStatRow & { dropCount: number; receiverName: string; ratio: number }> = Array.from(byItem.entries())
      .map(([itemName, v]) => {
        const receiverPairs = Array.from(v.receiverQty.entries()).sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'),
        );
        const receiverCount = receiverPairs.length;
        const receiverName =
          receiverCount <= 0
            ? '未知'
            : receiverCount <= 3
              ? receiverPairs.map(([name]) => name).join('、')
              : `${receiverPairs
                  .slice(0, 3)
                  .map(([name]) => name)
                  .join('、')} 等${receiverCount}人`;
        return {
          itemName,
          quantity: v.quantity,
          dropCount: v.dropCount,
          receiverName,
          ratio: totalQty > 0 ? v.quantity / totalQty : 0,
        };
      })
      .sort((a, b) => b.quantity - a.quantity || b.dropCount - a.dropCount || a.itemName.localeCompare(b.itemName, 'zh-Hans-CN'));

    const byReceiverRows: DropReceiverStatRow[] = Array.from(byReceiver.entries())
      .map(([receiverName, v]) => ({
        receiverName,
        quantity: v.quantity,
        dropCount: v.dropCount,
        itemKindCount: v.itemSet.size,
      }))
      .sort(
        (a, b) => b.quantity - a.quantity || b.dropCount - a.dropCount || a.receiverName.localeCompare(b.receiverName, 'zh-Hans-CN'),
      );

    details.sort((a, b) => b.timestamp - a.timestamp);

    const receivers = Array.from(byReceiver.keys()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const items = Array.from(byItem.keys()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

    return {
      details,
      byItemRows,
      byReceiverRows,
      receivers,
      items,
      totalQty,
      totalRecords,
      uniqueItemCount: items.length,
      uniqueReceiverCount: receivers.length,
    };
  }, [battleMessages]);

  const outputStats = useMemo(() => {
    const details: OutputDetailRow[] = [];
    const byActor = new Map<
      string,
      { damage: number; heal: number; castCount: number; critCount: number; missCount: number }
    >();
    const bySkill = new Map<
      string,
      { castCount: number; damage: number; heal: number; critCount: number; missCount: number; actorSet: Set<string> }
    >();

    for (const bm of battleMessages) {
      const line = bm.content;
      const actionMatch = /^第(\d+)回合\s+(.+?)\s+施展【(.+?)】/.exec(line);
      if (!actionMatch) continue;

      const round = Math.max(0, Math.floor(Number(actionMatch[1]) || 0));
      const actorName = String(actionMatch[2] ?? '').trim();
      const skillName = String(actionMatch[3] ?? '').trim() || '未知技能';
      if (!actorName) continue;

      const damage = sumByRegex(line, /伤害-(\d+)/g);
      const heal = sumByRegex(line, /治疗\+(\d+)/g);
      const critCount = countByRegex(line, /暴击/g);
      const missCount = countByRegex(line, /未命中/g);

      details.push({ round, actorName, skillName, damage, heal, critCount, missCount, raw: line });

      const prev = byActor.get(actorName) ?? { damage: 0, heal: 0, castCount: 0, critCount: 0, missCount: 0 };
      prev.damage += damage;
      prev.heal += heal;
      prev.castCount += 1;
      prev.critCount += critCount;
      prev.missCount += missCount;
      byActor.set(actorName, prev);

      const prevSkill = bySkill.get(skillName) ?? {
        castCount: 0,
        damage: 0,
        heal: 0,
        critCount: 0,
        missCount: 0,
        actorSet: new Set<string>(),
      };
      prevSkill.castCount += 1;
      prevSkill.damage += damage;
      prevSkill.heal += heal;
      prevSkill.critCount += critCount;
      prevSkill.missCount += missCount;
      prevSkill.actorSet.add(actorName);
      bySkill.set(skillName, prevSkill);
    }

    const byActorRows: Array<OutputStatRow & { castCount: number; critCount: number; missCount: number }> = Array.from(byActor.entries())
      .map(([actorName, v]) => ({
        actorName,
        damage: v.damage,
        heal: v.heal,
        castCount: v.castCount,
        critCount: v.critCount,
        missCount: v.missCount,
      }))
      .sort(
        (a, b) => b.damage - a.damage || b.heal - a.heal || b.castCount - a.castCount || a.actorName.localeCompare(b.actorName, 'zh-Hans-CN'),
      );

    const bySkillRows: OutputSkillStatRow[] = Array.from(bySkill.entries())
      .map(([skillName, v]) => ({
        skillName,
        castCount: v.castCount,
        damage: v.damage,
        heal: v.heal,
        critCount: v.critCount,
        missCount: v.missCount,
        actorCount: v.actorSet.size,
      }))
      .sort(
        (a, b) => b.damage - a.damage || b.heal - a.heal || b.castCount - a.castCount || a.skillName.localeCompare(b.skillName, 'zh-Hans-CN'),
      );

    details.sort((a, b) => b.round - a.round || b.damage - a.damage || b.heal - a.heal);

    const actors = Array.from(byActor.keys()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const skills = Array.from(bySkill.keys()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

    return { details, byActorRows, bySkillRows, actors, skills };
  }, [battleMessages]);

  const channelItems = [
    { key: 'all', label: '综合' },
    { key: 'world', label: '世界' },
    { key: 'team', label: '队伍' },
    { key: 'sect', label: '宗门' },
    { key: 'private', label: '私聊' },
    { key: 'battle', label: '战况' },
    { key: 'system', label: '系统' },
  ];

  const canSend =
    activeChannel === 'private'
      ? Boolean(activePrivateTargetId && activePrivateTarget?.characterId)
      : activeChannel !== 'system' && activeChannel !== 'battle';

  const inputPlaceholder =
    activeChannel === 'private'
      ? activePrivateTarget
        ? activePrivateTarget.characterId
          ? `对 ${getDisplayName(activePrivateTarget.title, activePrivateTarget.name)} 私聊...`
          : `对 ${getDisplayName(activePrivateTarget.title, activePrivateTarget.name)} 私聊（不可发送）`
        : '选择一个私聊对象...'
      : activeChannel === 'battle'
        ? '战况频道不允许发言'
        : activeChannel === 'system'
          ? '系统频道不允许发言'
      : selfDisplayName
        ? `以 ${selfDisplayName} 发言...`
        : '输入消息...';

  const dropDetailsFiltered = useMemo(() => {
    const kw = dropKeyword.trim();
    return dropStats.details.filter((r) => {
      if (dropReceiver && String(r.receiverName || '未知') !== dropReceiver) return false;
      if (!kw) return true;
      return r.itemName.includes(kw) || r.receiverName.includes(kw) || r.raw.includes(kw);
    });
  }, [dropKeyword, dropReceiver, dropStats.details]);

  const outputDetailsFiltered = useMemo(() => {
    const kw = outputKeyword.trim();
    return outputStats.details.filter((r) => {
      if (outputActor && r.actorName !== outputActor) return false;
      if (!kw) return true;
      return r.actorName.includes(kw) || r.skillName.includes(kw) || r.raw.includes(kw);
    });
  }, [outputActor, outputKeyword, outputStats.details]);

  const outputSummary = useMemo(() => {
    let totalDamage = 0;
    let totalHeal = 0;
    let totalCasts = 0;
    let totalCrit = 0;
    let totalMiss = 0;
    for (const r of outputStats.byActorRows) {
      totalDamage += Math.max(0, Math.floor(Number(r.damage) || 0));
      totalHeal += Math.max(0, Math.floor(Number(r.heal) || 0));
      totalCasts += Math.max(0, Math.floor(Number(r.castCount) || 0));
      totalCrit += Math.max(0, Math.floor(Number(r.critCount) || 0));
      totalMiss += Math.max(0, Math.floor(Number(r.missCount) || 0));
    }
    return {
      actorCount: outputStats.actors.length,
      skillCount: outputStats.skills.length,
      castCount: totalCasts,
      totalDamage,
      totalHeal,
      totalCrit,
      totalMiss,
    };
  }, [outputStats.actors.length, outputStats.byActorRows, outputStats.skills.length]);

  const tableScroll = isMobile ? { x: 'max-content' as const } : { y: 380 };
  const tableScrollWithFilters = isMobile ? { x: 'max-content' as const } : { y: 330 };

  const resetBattleStats = useCallback(() => {
    const now = Date.now();
    setBattleStatsFromTs(now);
    setDropKeyword('');
    setDropReceiver(undefined);
    setDropTabKey('by_item');
    setOutputKeyword('');
    setOutputActor(undefined);
    setOutputTabKey('by_actor');
  }, []);

  const dropPieByItem = useMemo(() => {
    return dropStats.byItemRows.map((r) => ({ label: r.itemName, value: r.quantity }));
  }, [dropStats.byItemRows]);

  const dropPieByReceiver = useMemo(() => {
    return dropStats.byReceiverRows.map((r) => ({ label: r.receiverName, value: r.quantity }));
  }, [dropStats.byReceiverRows]);

  const outputPieByActor = useMemo(() => {
    return outputStats.byActorRows.map((r) => ({ label: r.actorName, value: r.damage }));
  }, [outputStats.byActorRows]);

  const outputPieBySkill = useMemo(() => {
    return outputStats.bySkillRows.map((r) => ({ label: r.skillName, value: r.damage }));
  }, [outputStats.bySkillRows]);

  const onlinePopoverContent = useMemo(() => {
    return (
      <div className="chat-online-popover">
        <Table<OnlinePlayerDto>
          size="small"
          pagination={false}
          dataSource={onlinePlayers}
          rowKey={(row) => String(row.id)}
          scroll={isMobile ? undefined : { y: 260 }}
          columns={[
            {
              title: '姓名',
              dataIndex: 'nickname',
              key: 'nickname',
              ellipsis: true,
              render: (_: unknown, record: OnlinePlayerDto) => (
                <div className="chat-online-name">
                  <div className="chat-online-nickname">{record.nickname}</div>
                  {record.title ? <div className="chat-online-title">{record.title}</div> : null}
                </div>
              ),
            },
            { title: '境界', dataIndex: 'realm', key: 'realm', width: isMobile ? 100 : 140, ellipsis: true },
            {
              title: '',
              key: 'action',
              width: 56,
              render: (_: unknown, record: OnlinePlayerDto) => (
                <Button
                  size="small"
                  type="link"
                  onClick={() => {
                    openPrivateChat({
                      type: 'player',
                      id: String(record.id),
                      name: record.nickname,
                      title: record.title,
                    });
                    if (isMobile) setOnlineDrawerOpen(false);
                  }}
                >
                  私聊
                </Button>
              ),
            },
          ]}
          locale={{ emptyText: '暂无在线玩家' }}
        />
      </div>
    );
  }, [onlinePlayers, openPrivateChat, isMobile]);

  return (
    <div className={`chat-panel ${activeChannel === 'private' ? 'is-private' : ''}`}>
      <Tabs
        activeKey={activeChannel}
        onChange={(key) => {
          const nextChannel = key as ChatChannel;
          setActiveChannel(nextChannel);
          if (nextChannel === 'private' && !activePrivateTargetId) {
            setActivePrivateTargetId(privateTargets[0]?.id ?? '');
          }
        }}
        items={channelItems}
        size="small"
        className="chat-tabs"
        tabBarExtraContent={
          <div className="chat-tabs-actions">
            {isMobile ? (
              <>
                <Button
                  type="text"
                  size="small"
                  className="chat-online-button"
                  onClick={() => {
                    gameSocket.requestOnlinePlayers();
                    setOnlineDrawerOpen(true);
                  }}
                >
                  在线 {onlineTotal}
                </Button>
                <Drawer
                  title={`在线玩家 (${onlineTotal})`}
                  placement="bottom"
                  open={onlineDrawerOpen}
                  onClose={() => setOnlineDrawerOpen(false)}
                  height="60vh"
                  className="chat-online-drawer"
                  styles={{ body: { padding: '0 12px 12px' } }}
                >
                  {onlinePopoverContent}
                </Drawer>
              </>
            ) : (
              <Popover
                trigger="click"
                placement="bottomRight"
                content={onlinePopoverContent}
                overlayClassName="chat-online-popover-overlay"
                onOpenChange={(open) => {
                  if (open) gameSocket.requestOnlinePlayers();
                }}
              >
                <Button type="text" size="small" className="chat-online-button">
                  在线 {onlineTotal}
                </Button>
              </Popover>
            )}
            <Tooltip title={isMobile ? '' : '掉落统计'}>
              <Button
                type="text"
                size="small"
                icon={<BarChartOutlined />}
                onClick={() => setDropStatsOpen(true)}
              />
            </Tooltip>
            <Tooltip title={isMobile ? '' : '输出统计'}>
              <Button
                type="text"
                size="small"
                icon={<LineChartOutlined />}
                onClick={() => setOutputStatsOpen(true)}
              />
            </Tooltip>
          </div>
        }
      />

      <StatsShell title="掉落统计" open={dropStatsOpen} onClose={() => setDropStatsOpen(false)} isMobile={isMobile}>
        <div className="chat-stats-shell">
          <div className="chat-stats-top">
            <div className="chat-stats-summary">
              掉落记录 {dropStats.totalRecords} · 物品 {dropStats.uniqueItemCount} · 获得者 {dropStats.uniqueReceiverCount} · 总数量 {dropStats.totalQty}
            </div>
            <Tooltip title={isMobile ? '' : '从现在开始重新统计（不清空聊天记录）'}>
              <Button size="small" onClick={resetBattleStats}>
                清空重新统计
              </Button>
            </Tooltip>
          </div>
          <Tabs
            size="small"
            activeKey={dropTabKey}
            onChange={(k) => setDropTabKey(k as typeof dropTabKey)}
            className="chat-stats-tabs"
            items={[
              {
                key: 'by_item',
                label: '按物品',
                children: (
                  <Table
                    size="small"
                    pagination={false}
                    sticky
                    scroll={tableScroll}
                    dataSource={dropStats.byItemRows.map((r) => ({ ...r, key: r.itemName }))}
                    columns={[
                      { title: '物品', dataIndex: 'itemName', key: 'itemName' },
                      { title: '总数量', dataIndex: 'quantity', key: 'quantity', width: 90, align: 'right' },
                      { title: '次数', dataIndex: 'dropCount', key: 'dropCount', width: 70, align: 'right' },
                      { title: '获得者', dataIndex: 'receiverName', key: 'receiverName', width: 200, ellipsis: true },
                      {
                        title: '占比',
                        dataIndex: 'ratio',
                        key: 'ratio',
                        width: 80,
                        align: 'right',
                        render: (v: number) => `${(Math.max(0, Number(v) || 0) * 100).toFixed(1)}%`,
                      },
                    ]}
                    locale={{ emptyText: '暂无掉落数据（需要战斗掉落记录）' }}
                  />
                ),
              },
              {
                key: 'by_receiver',
                label: '按获得者',
                children: (
                  <Table<DropReceiverStatRow>
                    size="small"
                    pagination={false}
                    sticky
                    scroll={tableScroll}
                    dataSource={dropStats.byReceiverRows.map((r) => ({ ...r, key: r.receiverName }))}
                    columns={[
                      { title: '获得者', dataIndex: 'receiverName', key: 'receiverName' },
                      { title: '总数量', dataIndex: 'quantity', key: 'quantity', width: 90, align: 'right' },
                      { title: '次数', dataIndex: 'dropCount', key: 'dropCount', width: 70, align: 'right' },
                      { title: '物品种类', dataIndex: 'itemKindCount', key: 'itemKindCount', width: 90, align: 'right' },
                    ]}
                    locale={{ emptyText: '暂无掉落数据（需要战斗掉落记录）' }}
                  />
                ),
              },
              {
                key: 'details',
                label: '明细',
                children: (
                  <>
                    <div className="chat-stats-filters">
                      <Select
                        allowClear
                        placeholder="获得者"
                        value={dropReceiver}
                        onChange={(v) => setDropReceiver(v)}
                        options={dropStats.receivers.map((x) => ({ label: x, value: x }))}
                        style={{ width: 160 }}
                      />
                      <Input
                        allowClear
                        placeholder="搜索物品/获得者/原始行..."
                        value={dropKeyword}
                        onChange={(e) => setDropKeyword(e.target.value)}
                      />
                    </div>
                    <Table<DropDetailRow>
                      size="small"
                      pagination={false}
                      sticky
                      scroll={tableScrollWithFilters}
                      dataSource={dropDetailsFiltered.map((r, idx) => ({ ...r, key: `${r.timestamp}-${idx}` }))}
                      columns={[
                        { title: '物品', dataIndex: 'itemName', key: 'itemName' },
                        { title: '数量', dataIndex: 'quantity', key: 'quantity', width: 70, align: 'right' },
                        { title: '获得者', dataIndex: 'receiverName', key: 'receiverName', width: 120, ellipsis: true },
                        {
                          title: '时间',
                          dataIndex: 'timestamp',
                          key: 'timestamp',
                          width: 170,
                          render: (v: number) => (v ? new Date(v).toLocaleString() : '-'),
                        },
                        { title: '原始', dataIndex: 'raw', key: 'raw', ellipsis: true },
                      ]}
                      locale={{ emptyText: '暂无明细' }}
                    />
                  </>
                ),
              },
              {
                key: 'pie',
                label: '饼图',
                children: (
                  <div className="chat-pie-grid">
                    <PieChart title="按物品（数量占比）" data={dropPieByItem} />
                    <PieChart title="按获得者（数量占比）" data={dropPieByReceiver} />
                  </div>
                ),
              },
            ]}
          />
        </div>
      </StatsShell>

      <StatsShell title="输出统计" open={outputStatsOpen} onClose={() => setOutputStatsOpen(false)} isMobile={isMobile}>
        <div className="chat-stats-shell">
          <div className="chat-stats-top">
            <div className="chat-stats-summary">
              角色 {outputSummary.actorCount} · 技能 {outputSummary.skillCount} · 施放 {outputSummary.castCount} · 总伤害 {outputSummary.totalDamage} · 总治疗 {outputSummary.totalHeal} · 暴击 {outputSummary.totalCrit} · 未命中 {outputSummary.totalMiss}
            </div>
            <Tooltip title={isMobile ? '' : '从现在开始重新统计（不清空聊天记录）'}>
              <Button size="small" onClick={resetBattleStats}>
                清空重新统计
              </Button>
            </Tooltip>
          </div>
          <Tabs
            size="small"
            activeKey={outputTabKey}
            onChange={(k) => setOutputTabKey(k as typeof outputTabKey)}
            className="chat-stats-tabs"
            items={[
              {
                key: 'by_actor',
                label: '按角色',
                children: (
                  <Table
                    size="small"
                    pagination={false}
                    sticky
                    scroll={tableScroll}
                    dataSource={outputStats.byActorRows.map((r) => ({ ...r, key: r.actorName }))}
                    columns={[
                      { title: '角色', dataIndex: 'actorName', key: 'actorName' },
                      { title: '施放', dataIndex: 'castCount', key: 'castCount', width: 70, align: 'right' },
                      { title: '总伤害', dataIndex: 'damage', key: 'damage', width: 90, align: 'right' },
                      { title: '总治疗', dataIndex: 'heal', key: 'heal', width: 90, align: 'right' },
                      { title: '暴击', dataIndex: 'critCount', key: 'critCount', width: 70, align: 'right' },
                      { title: '未命中', dataIndex: 'missCount', key: 'missCount', width: 80, align: 'right' },
                    ]}
                    locale={{ emptyText: '暂无输出数据（需要战斗日志记录）' }}
                  />
                ),
              },
              {
                key: 'by_skill',
                label: '按技能',
                children: (
                  <Table<OutputSkillStatRow>
                    size="small"
                    pagination={false}
                    sticky
                    scroll={tableScroll}
                    dataSource={outputStats.bySkillRows.map((r) => ({ ...r, key: r.skillName }))}
                    columns={[
                      { title: '技能', dataIndex: 'skillName', key: 'skillName' },
                      { title: '施放', dataIndex: 'castCount', key: 'castCount', width: 70, align: 'right' },
                      { title: '总伤害', dataIndex: 'damage', key: 'damage', width: 90, align: 'right' },
                      { title: '总治疗', dataIndex: 'heal', key: 'heal', width: 90, align: 'right' },
                      { title: '暴击', dataIndex: 'critCount', key: 'critCount', width: 70, align: 'right' },
                      { title: '未命中', dataIndex: 'missCount', key: 'missCount', width: 80, align: 'right' },
                      { title: '施放者', dataIndex: 'actorCount', key: 'actorCount', width: 80, align: 'right' },
                    ]}
                    locale={{ emptyText: '暂无输出数据（需要战斗日志记录）' }}
                  />
                ),
              },
              {
                key: 'details',
                label: '明细',
                children: (
                  <>
                    <div className="chat-stats-filters">
                      <Select
                        allowClear
                        placeholder="角色"
                        value={outputActor}
                        onChange={(v) => setOutputActor(v)}
                        options={outputStats.actors.map((x) => ({ label: x, value: x }))}
                        style={{ width: 160 }}
                      />
                      <Input
                        allowClear
                        placeholder="搜索角色/技能/原始行..."
                        value={outputKeyword}
                        onChange={(e) => setOutputKeyword(e.target.value)}
                      />
                    </div>
                    <Table<OutputDetailRow>
                      size="small"
                      pagination={false}
                      sticky
                      scroll={tableScrollWithFilters}
                      dataSource={outputDetailsFiltered.map((r, idx) => ({ ...r, key: `${r.round}-${r.actorName}-${r.skillName}-${idx}` }))}
                      columns={[
                        { title: '回合', dataIndex: 'round', key: 'round', width: 70, align: 'right' },
                        { title: '角色', dataIndex: 'actorName', key: 'actorName', width: 120, ellipsis: true },
                        { title: '技能', dataIndex: 'skillName', key: 'skillName', width: 140, ellipsis: true },
                        { title: '伤害', dataIndex: 'damage', key: 'damage', width: 80, align: 'right' },
                        { title: '治疗', dataIndex: 'heal', key: 'heal', width: 80, align: 'right' },
                        { title: '暴击', dataIndex: 'critCount', key: 'critCount', width: 70, align: 'right' },
                        { title: '未命中', dataIndex: 'missCount', key: 'missCount', width: 80, align: 'right' },
                        { title: '原始', dataIndex: 'raw', key: 'raw', ellipsis: true },
                      ]}
                      locale={{ emptyText: '暂无明细' }}
                    />
                  </>
                ),
              },
              {
                key: 'pie',
                label: '饼图',
                children: (
                  <div className="chat-pie-grid">
                    <PieChart title="按角色（伤害占比）" data={outputPieByActor} />
                    <PieChart title="按技能（伤害占比）" data={outputPieBySkill} />
                  </div>
                ),
              },
            ]}
          />
        </div>
      </StatsShell>

      <div className="chat-messages" ref={mainMessagesRef} onScroll={handleMainMessagesScroll}>
        {activeChannel === 'private' ? (
          <div className="chat-private-shell">
            <div className="chat-private-left">
              <div className="chat-private-list">
                {privateTargets.map((t) => {
                  const isActive = t.id === activePrivateTargetId;
                  return (
                    <div
                      key={t.id}
                      className={`chat-private-target ${isActive ? 'active' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setActivePrivateTargetId(t.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') setActivePrivateTargetId(t.id);
                      }}
                    >
                      <div className="chat-private-target-name">{getDisplayName(t.title, t.name)}</div>
                      <Button
                        type="text"
                        size="small"
                        icon={<CloseOutlined />}
                        className="chat-private-target-remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemovePrivateTarget(t.id);
                        }}
                      />
                    </div>
                  );
                })}
                {privateTargets.length === 0 ? <div className="chat-private-empty">暂无私聊对象</div> : null}
              </div>
            </div>

            <div className="chat-private-right">
              <div className="chat-private-messages" ref={privateMessagesRef} onScroll={handlePrivateMessagesScroll}>
                {filteredMessages.map((msg) => (
                  <div key={msg.id} className={`message-item ${msg.isSelf ? 'self' : ''}`}>
                    <span
                      className={`message-sender ${msg.senderName === '系统' ? '' : 'is-clickable'}`}
                      role={msg.senderName === '系统' ? undefined : 'button'}
                      tabIndex={msg.senderName === '系统' ? undefined : 0}
                      onClick={() => {
                        if (msg.senderName === '系统') return;
                        onSelectPlayer?.(buildPlayerTarget(msg.senderTitle, msg.senderName, msg.senderCharacterId));
                      }}
                      onKeyDown={(e) => {
                        if (msg.senderName === '系统') return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          onSelectPlayer?.(buildPlayerTarget(msg.senderTitle, msg.senderName, msg.senderCharacterId));
                        }
                      }}
                    >
                      {getDisplayName(msg.senderTitle, msg.senderName)}:
                    </span>
                    <span className={`message-content ${msg.channel === 'battle' ? 'message-content-battle' : ''}`}>
                      {renderMessageContent(msg)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            {filteredMessages.map((msg) => (
              <div key={msg.id} className={`message-item ${msg.isSelf ? 'self' : ''}`}>
                {activeChannel === 'all' ? <span className="message-channel">{getChannelPrefixText(msg.channel)}</span> : null}
                <span
                  className={`message-sender ${msg.senderName === '系统' ? '' : 'is-clickable'}`}
                  role={msg.senderName === '系统' ? undefined : 'button'}
                  tabIndex={msg.senderName === '系统' ? undefined : 0}
                  onClick={() => {
                    if (msg.senderName === '系统') return;
                    onSelectPlayer?.(buildPlayerTarget(msg.senderTitle, msg.senderName, msg.senderCharacterId));
                  }}
                  onKeyDown={(e) => {
                    if (msg.senderName === '系统') return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      onSelectPlayer?.(buildPlayerTarget(msg.senderTitle, msg.senderName, msg.senderCharacterId));
                    }
                  }}
                >
                  {getDisplayName(msg.senderTitle, msg.senderName)}:
                </span>
                <span className={`message-content ${msg.channel === 'battle' ? 'message-content-battle' : ''}`}>
                  {renderMessageContent(msg)}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="chat-input">
        <Input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onPressEnter={handleSend}
          placeholder={inputPlaceholder}
          disabled={!canSend}
          suffix={
            <SendOutlined 
              onClick={handleSend} 
              style={{ cursor: 'pointer', color: inputValue ? 'var(--text-color)' : 'var(--disabled-color)' }} 
            />
          }
        />
      </div>
    </div>
  );
});

ChatPanelBase.displayName = 'ChatPanel';

const ChatPanel = memo(ChatPanelBase);

export default ChatPanel;
