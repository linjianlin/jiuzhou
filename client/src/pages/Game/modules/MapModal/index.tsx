import { Button, Input, Modal, Select, Table, Tabs, Tag } from 'antd';
import { LeftOutlined, SearchOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { IMG_MAP_01 as map01, IMG_MAP_02 as map02, IMG_MAP_03 as map03, IMG_MAP_04 as map04, IMG_MAP_05 as map05, IMG_MAP_06 as map06 } from '../../shared/imageAssets';
import {
  type DungeonDefLite,
  type DungeonPreviewResponse,
  getDungeonList,
  getDungeonPreview,
  getEnabledMaps,
  getInfoTargetDetail,
  getMapDetail,
  getRoomObjects,
  SILENT_API_REQUEST_CONFIG,
} from '../../../../services/api';
import { useIsMobile } from '../../shared/responsive';
import { getRealmRankFromLiteral as getRealmRank, normalizeRealmText } from '../../shared/realm';
import WaveDetailPanel from './WaveDetailPanel';
import './index.scss';

type MapCategory = 'world' | 'dungeon' | 'event';

type MapDrop = { name: string; quality: string; from: string };

type MapMonster = { id: string; name: string };

type MonsterDrop = { name: string; quality: string; chance: string };

type MapEntry = {
  id: string;
  category: MapCategory;
  name: string;
  tag: string;
  realm: string;
  image: string;
  desc: string;
  staminaCost?: number;
  npcs: string[];
  monsters: string[];
  drops: MapDrop[];
  dungeonStages?: NonNullable<DungeonPreviewResponse['data']>['stages'];
  dungeonEntry?: NonNullable<DungeonPreviewResponse['data']>['entry'];
};

type DungeonDifficultyOption = {
  value: number;
  label: string;
};

const categoryLabels: Record<MapCategory, string> = {
  world: '大世界',
  dungeon: '秘境',
  event: '活动',
};

const fallbackImages = [map01, map02, map03, map04, map05, map06];

const dungeonTypeLabels: Record<string, string> = {
  material: '材料秘境',
  equipment: '装备秘境',
  trial: '试炼秘境',
  challenge: '挑战秘境',
  event: '活动秘境',
};

const DUNGEON_DIFFICULTY_CANDIDATES = [1, 2, 3] as const;

const dungeonDifficultyFallbackLabels: Record<number, string> = {
  1: '普通',
  2: '困难',
  3: '噩梦',
};
const getDungeonDetailCacheKey = (dungeonId: string, rank: number): string => `${dungeonId}@@${rank}`;

interface MapModalProps {
  open: boolean;
  onClose: () => void;
  initialCategory?: MapCategory;
  dungeonNoStaminaCostEnabled?: boolean;
  onEnter?: (target: { mapId: string; roomId: string }) => void;
  onEnterDungeon?: (target: { dungeonId: string; rank: number }) => void;
}

const MapModal: React.FC<MapModalProps> = ({
  open,
  onClose,
  initialCategory,
  dungeonNoStaminaCostEnabled = false,
  onEnter,
  onEnterDungeon,
}) => {
  const [category, setCategory] = useState<MapCategory>(initialCategory ?? 'world');
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string>('');
  const [mapEntries, setMapEntries] = useState<MapEntry[]>([]);
  const [detailById, setDetailById] = useState<
    Record<
      string,
      Pick<MapEntry, 'npcs' | 'monsters' | 'drops' | 'dungeonStages' | 'dungeonEntry'> & {
        startRoomId: string;
        monsterObjs?: MapMonster[];
        monsterDropsById?: Record<string, MonsterDrop[]>;
      }
    >
  >({});
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showMobileDetail, setShowMobileDetail] = useState(false);
  const isMobile = useIsMobile();
  const [dungeonRankById, setDungeonRankById] = useState<Record<string, number>>({});
  const [dungeonDifficultyOptionsById, setDungeonDifficultyOptionsById] = useState<Record<string, DungeonDifficultyOption[]>>({});
  const [dungeonDifficultyLoadingById, setDungeonDifficultyLoadingById] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (open) setShowMobileDetail(false);
  }, [open]);

  useEffect(() => {
    if (open) return;
    // 关闭时同步清理当前打开周期的列表与选中态，避免下次打开先用旧列表触发一轮详情请求。
    setMapEntries([]);
    setActiveId('');
    setListLoading(false);
    setDetailById({});
    setDetailLoading(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setListLoading(true);
    Promise.all([
      getEnabledMaps(SILENT_API_REQUEST_CONFIG),
      getDungeonList(undefined, SILENT_API_REQUEST_CONFIG).catch(() => ({ success: false } as { success: boolean; data?: { dungeons: DungeonDefLite[] } })),
    ])
      .then(([mapRes, dungeonRes]) => {
        if (cancelled) return;
        const mapList = mapRes?.success && mapRes.data?.maps ? mapRes.data.maps : [];
        const dungeonList = dungeonRes?.success && dungeonRes.data?.dungeons ? dungeonRes.data.dungeons : [];

        const mapEntries: MapEntry[] = mapList.map((m, idx) => {
          const mapType = (m.map_type ?? '').toLowerCase();
          const category: MapCategory = mapType === 'dungeon' || mapType === 'instance' ? 'dungeon' : 'world';
          const tag = (m.region || (typeof m.req_realm_min === 'string' ? m.req_realm_min.trim() : '') || mapType || '地图').toString();
          const image =
            typeof m.background_image === 'string' && /^https?:\/\//.test(m.background_image)
              ? m.background_image
              : fallbackImages[idx % fallbackImages.length];
          const realm = normalizeRealmText(m.req_realm_min);
          return {
            id: m.id,
            category,
            name: m.name,
            tag,
            realm,
            image,
            desc: m.description ?? '',
            npcs: [],
            monsters: [],
            drops: [],
          };
        });

        const dungeonEntries: MapEntry[] = dungeonList.map((d: DungeonDefLite, idx: number) => {
          const tag = dungeonTypeLabels[d.type] || d.category || '秘境';
          const image =
            typeof d.background === 'string' && /^https?:\/\//.test(d.background)
              ? d.background
              : fallbackImages[(idx + mapEntries.length) % fallbackImages.length];
          return {
            id: d.id,
            category: 'dungeon',
            name: d.name,
            tag,
            realm: normalizeRealmText(d.recommended_realm || d.min_realm),
            image,
            desc: d.description ?? '',
            staminaCost: d.stamina_cost,
            npcs: [],
            monsters: [],
            drops: [],
          };
        });

        setMapEntries([...mapEntries, ...dungeonEntries]);
      })
      .catch(() => {
        if (cancelled) return;
        setMapEntries([]);
      })
      .finally(() => {
        if (cancelled) return;
        setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = mapEntries.filter((m) => m.category === category);
    const searched = q
      ? list.filter((m) => `${m.name}${m.tag}`.toLowerCase().includes(q))
      : list;
    return [...searched].sort((a, b) => getRealmRank(a.realm) - getRealmRank(b.realm));
  }, [category, mapEntries, query]);

  const safeActiveId = useMemo(() => {
    if (activeId && filtered.some((m) => m.id === activeId)) return activeId;
    return filtered[0]?.id ?? '';
  }, [activeId, filtered]);

  const activeMap = useMemo(() => filtered.find((m) => m.id === safeActiveId) ?? null, [filtered, safeActiveId]);

  const activeDungeonRank = useMemo(() => {
    if (!activeMap || activeMap.category !== 'dungeon') return 1;
    const rank = dungeonRankById[activeMap.id];
    if (typeof rank === 'number' && Number.isFinite(rank) && rank > 0) return Math.floor(rank);
    return 1;
  }, [activeMap, dungeonRankById]);

  const activeDetailKey = useMemo(() => {
    if (!activeMap) return '';
    return activeMap.category === 'dungeon' ? getDungeonDetailCacheKey(activeMap.id, activeDungeonRank) : activeMap.id;
  }, [activeDungeonRank, activeMap]);

  useEffect(() => {
    if (!open || !activeMap || activeMap.category !== 'dungeon') return;
    if (dungeonDifficultyOptionsById[activeMap.id]) return;
    let cancelled = false;
    const dungeonId = activeMap.id;
    setDungeonDifficultyLoadingById((prev) => ({ ...prev, [dungeonId]: true }));
    const loadOptions = async () => {
      try {
        const optionByRank = new Map<number, DungeonDifficultyOption>();
        for (const rank of DUNGEON_DIFFICULTY_CANDIDATES) {
          const res = await getDungeonPreview(dungeonId, rank, SILENT_API_REQUEST_CONFIG).catch(() => null);
          const difficulty = res?.success ? (res.data?.difficulty ?? null) : null;
          if (!difficulty) continue;
          const parsedRank =
            typeof difficulty.difficulty_rank === 'number' && Number.isFinite(difficulty.difficulty_rank)
              ? Math.floor(difficulty.difficulty_rank)
              : rank;
          if (parsedRank <= 0 || optionByRank.has(parsedRank)) continue;
          const name =
            typeof difficulty.name === 'string' && difficulty.name.trim()
              ? difficulty.name.trim()
              : dungeonDifficultyFallbackLabels[parsedRank] || `难度${parsedRank}`;
          optionByRank.set(parsedRank, { value: parsedRank, label: name });
        }
        if (cancelled) return;
        const options = Array.from(optionByRank.values()).sort((a, b) => a.value - b.value);
        const normalizedOptions =
          options.length > 0 ? options : [{ value: 1, label: dungeonDifficultyFallbackLabels[1] || '普通' }];
        setDungeonDifficultyOptionsById((prev) => ({ ...prev, [dungeonId]: normalizedOptions }));
        setDungeonRankById((prev) => {
          const currentRank = prev[dungeonId];
          if (typeof currentRank === 'number' && normalizedOptions.some((opt) => opt.value === currentRank)) {
            return prev;
          }
          return { ...prev, [dungeonId]: normalizedOptions[0].value };
        });
      } finally {
        if (cancelled) return;
        setDungeonDifficultyLoadingById((prev) => ({ ...prev, [dungeonId]: false }));
      }
    };
    void loadOptions();
    return () => {
      cancelled = true;
    };
  }, [activeMap, dungeonDifficultyOptionsById, open]);

  useEffect(() => {
    if (!open) return;
    if (!safeActiveId) return;
    const entry = filtered.find((m) => m.id === safeActiveId) ?? null;
    const isDungeon = entry?.category === 'dungeon';
    const detailKey = isDungeon ? getDungeonDetailCacheKey(safeActiveId, activeDungeonRank) : safeActiveId;
    if (detailById[detailKey]) return;
    let cancelled = false;
    setDetailLoading(true);

    if (isDungeon) {
      getDungeonPreview(safeActiveId, activeDungeonRank, SILENT_API_REQUEST_CONFIG)
        .then((detailRes) => {
          if (cancelled) return;
          const monsters = detailRes?.success && detailRes.data?.monsters ? detailRes.data.monsters : [];
          const drops = detailRes?.success && detailRes.data?.drops ? detailRes.data.drops : [];
          const dungeonStages = detailRes?.success && detailRes.data?.stages ? detailRes.data.stages : [];
          const dungeonEntry = detailRes?.success ? (detailRes.data?.entry ?? null) : null;
          setDetailById((prev) => ({
            ...prev,
            [detailKey]: {
              npcs: [],
              monsters: monsters.map((m) => m.name).filter(Boolean),
              monsterObjs: monsters.map((m) => ({ id: m.id, name: m.name })).filter((m) => m.id && m.name),
              drops: drops.map((d) => ({ name: d.name, quality: d.quality || '普通', from: d.from || '奖励' })),
              dungeonStages,
              dungeonEntry,
              startRoomId: '',
            },
          }));
        })
        .catch(() => {
          if (cancelled) return;
          setDetailById((prev) => ({
            ...prev,
            [detailKey]: { npcs: [], monsters: [], drops: [], dungeonStages: [], dungeonEntry: null, startRoomId: '' },
          }));
        })
        .finally(() => {
          if (cancelled) return;
          setDetailLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

    getMapDetail(safeActiveId, SILENT_API_REQUEST_CONFIG)
      .then(async (detailRes) => {
        if (cancelled) return;

        const rooms = detailRes?.success && detailRes.data?.rooms ? detailRes.data.rooms : [];
        const mapObj = (detailRes?.success ? (detailRes.data?.map as Record<string, unknown> | undefined) : undefined) ?? undefined;
        const reviveRoomId = typeof mapObj?.revive_room_id === 'string' ? mapObj.revive_room_id : '';
        const startRoomId =
          reviveRoomId && rooms.some((r) => r?.id === reviveRoomId) ? reviveRoomId : rooms[0]?.id ? rooms[0].id : '';
        if (rooms.length === 0) {
          setDetailById((prev) => ({
            ...prev,
            [safeActiveId]: { npcs: [], monsters: [], drops: [], dungeonStages: [], dungeonEntry: null, startRoomId },
          }));
          return;
        }

        const objectsByRoom = await Promise.all(
          rooms.map((r) =>
            getRoomObjects(safeActiveId, r.id, SILENT_API_REQUEST_CONFIG)
              .then((res) => (res?.success && res.data?.objects ? res.data.objects : []))
              .catch(() => []),
          ),
        );

        if (cancelled) return;

        const npcNames = new Set<string>();
        const monstersById = new Map<string, string>();
        const drops: MapDrop[] = [];
        const dropKey = new Set<string>();

        for (let i = 0; i < rooms.length; i += 1) {
          const roomName = rooms[i]?.name || rooms[i]?.id || '房间';
          const objs = objectsByRoom[i] ?? [];
          for (const o of objs) {
            if (o?.type === 'npc') npcNames.add(o.name);
            if (o?.type === 'monster') {
              if (o.id && o.name) monstersById.set(o.id, o.name);
            }
            if (o?.type === 'item') {
              const k = `${o.name}@@${roomName}`;
              if (dropKey.has(k)) continue;
              dropKey.add(k);
              drops.push({ name: o.name, quality: '普通', from: roomName });
            }
          }
        }

        const monsterObjs = Array.from(monstersById.entries())
          .map(([id, name]) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

        const monsterDropsByIdEntries = await Promise.all(
          monsterObjs.map(async (m) => {
            const infoRes = await getInfoTargetDetail('monster', m.id, SILENT_API_REQUEST_CONFIG).catch(() => null);
            const target = infoRes?.success ? infoRes.data?.target ?? null : null;
            if (!target || target.type !== 'monster') return [m.id, []] as const;
            const drops = (target.drops ?? []).map((d) => ({
              name: d.name,
              quality: d.quality && d.quality.trim() ? d.quality : '普通',
              chance: d.chance && d.chance.trim() ? d.chance : '-',
            }));
            return [m.id, drops] as const;
          }),
        );

        const monsterDropsById: Record<string, MonsterDrop[]> = Object.fromEntries(monsterDropsByIdEntries);

        setDetailById((prev) => ({
          ...prev,
          [safeActiveId]: {
            npcs: Array.from(npcNames),
            monsters: monsterObjs.map((m) => m.name),
            monsterObjs,
            monsterDropsById,
            drops,
            dungeonStages: [],
            dungeonEntry: null,
            startRoomId,
          },
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setDetailById((prev) => ({
          ...prev,
          [safeActiveId]: { npcs: [], monsters: [], drops: [], dungeonStages: [], dungeonEntry: null, startRoomId: '' },
        }));
      })
      .finally(() => {
        if (cancelled) return;
        setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeDungeonRank, detailById, filtered, open, safeActiveId]);

  const mergedActiveMap = useMemo(() => {
    if (!activeMap) return null;
    const d = detailById[activeDetailKey];
    if (!d) return activeMap;
    return { ...activeMap, ...d };
  }, [activeDetailKey, activeMap, detailById]);

  const activeDetail = useMemo(() => {
    if (!activeDetailKey) return null;
    return detailById[activeDetailKey] ?? null;
  }, [activeDetailKey, detailById]);

  useEffect(() => {
    if (open) setShowMobileDetail(false);
  }, [open]);

  const activeRealmText = useMemo(() => normalizeRealmText(mergedActiveMap?.realm), [mergedActiveMap?.realm]);
  const activeDungeonDifficultyOptions = useMemo(() => {
    if (!activeMap || activeMap.category !== 'dungeon') return [] as DungeonDifficultyOption[];
    return dungeonDifficultyOptionsById[activeMap.id] ?? [{ value: 1, label: dungeonDifficultyFallbackLabels[1] || '普通' }];
  }, [activeMap, dungeonDifficultyOptionsById]);
  const activeDungeonDifficultyLoading = useMemo(() => {
    if (!activeMap || activeMap.category !== 'dungeon') return false;
    return dungeonDifficultyLoadingById[activeMap.id] === true;
  }, [activeMap, dungeonDifficultyLoadingById]);
  const activeDungeonDifficultyText = useMemo(() => {
    if (!activeMap || activeMap.category !== 'dungeon') return '';
    const matched = activeDungeonDifficultyOptions.find((opt) => opt.value === activeDungeonRank);
    return matched?.label ?? '';
  }, [activeDungeonDifficultyOptions, activeDungeonRank, activeMap]);

  const monsterRows = useMemo(() => {
    if (!mergedActiveMap) return [] as MapMonster[];
    if (activeDetail?.monsterObjs) return activeDetail.monsterObjs;
    return (mergedActiveMap.monsters ?? []).map((name) => ({ id: name, name }));
  }, [activeDetail, mergedActiveMap]);
  const dropRows = useMemo(() => mergedActiveMap?.drops ?? [], [mergedActiveMap]);
  const monsterDropRows = useMemo(() => {
    if (!mergedActiveMap) return [];
    if (mergedActiveMap.category === 'dungeon') return [];
    const monsters = activeDetail?.monsterObjs ?? [];
    const byId = activeDetail?.monsterDropsById ?? {};
    const rows: Array<{ key: string; monster: string; name: string; quality: string; chance: string }> = [];
    for (const m of monsters) {
      const drops = byId[m.id] ?? [];
      for (let i = 0; i < drops.length; i += 1) {
        const dp = drops[i];
        rows.push({
          key: `${m.id}-${dp.name}-${dp.chance}-${i}`,
          monster: m.name,
          name: dp.name,
          quality: dp.quality,
          chance: dp.chance,
        });
      }
    }
    return rows;
  }, [activeDetail, mergedActiveMap]);
  const dungeonWaveStages = useMemo(() => {
    if (!mergedActiveMap || mergedActiveMap.category !== 'dungeon') {
      return [] as NonNullable<DungeonPreviewResponse['data']>['stages'];
    }
    return mergedActiveMap.dungeonStages ?? [];
  }, [mergedActiveMap]);
  const totalWaveCount = useMemo(
    () => dungeonWaveStages.reduce((total, stage) => total + (stage.waves?.length ?? 0), 0),
    [dungeonWaveStages],
  );
  const dungeonEntryText = useMemo(() => {
    if (!mergedActiveMap || mergedActiveMap.category !== 'dungeon') return '';
    const entry = mergedActiveMap.dungeonEntry ?? null;
    if (!entry) return '';
    const daily = entry.daily_limit > 0 ? `${entry.daily_remaining}/${entry.daily_limit}` : '不限';
    const weekly = entry.weekly_limit > 0 ? `${entry.weekly_remaining}/${entry.weekly_limit}` : '不限';
    return `剩余次数 今日:${daily} 本周:${weekly}`;
  }, [mergedActiveMap]);
  const dungeonStaminaCostText = useMemo(() => {
    if (!mergedActiveMap || mergedActiveMap.category !== 'dungeon') return '';
    const staminaCost = Math.max(0, Math.floor(Number(mergedActiveMap.staminaCost) || 0));
    return `体力消耗 ${staminaCost}`;
  }, [mergedActiveMap]);
  const dungeonNoStaminaCostTip = useMemo(() => {
    if (!mergedActiveMap || mergedActiveMap.category !== 'dungeon') return '';
    if (!dungeonNoStaminaCostEnabled) return '';
    return '当前已开启秘境免体力模式：进入后不消耗体力，但不会获得任何收益。';
  }, [dungeonNoStaminaCostEnabled, mergedActiveMap]);
  const shouldShowNpcSection = useMemo(() => {
    if (!mergedActiveMap) return false;
    return (detailLoading && !activeDetail) || mergedActiveMap.npcs.length > 0;
  }, [activeDetail, detailLoading, mergedActiveMap]);
  const shouldShowMonsterSection = useMemo(() => {
    if (!mergedActiveMap) return false;
    return (detailLoading && !activeDetail) || mergedActiveMap.monsters.length > 0;
  }, [activeDetail, detailLoading, mergedActiveMap]);
  const shouldShowWaveSection = useMemo(() => {
    if (!mergedActiveMap || mergedActiveMap.category !== 'dungeon') return false;
    return (detailLoading && !activeDetail) || totalWaveCount > 0;
  }, [activeDetail, detailLoading, mergedActiveMap, totalWaveCount]);

  const monsterColumns = useMemo(
    () => [{ title: '怪物', dataIndex: 'name', key: 'name' }],
    [],
  );

  const dropColumns = useMemo(
    () => [
      { title: '物品', dataIndex: 'name', key: 'name' },
      {
        title: '品质',
        dataIndex: 'quality',
        key: 'quality',
        width: 90,
        render: (v: string) => <Tag className="map-modal-quality-tag">{v}</Tag>,
      },
      { title: '来源', dataIndex: 'from', key: 'from' },
    ],
    [],
  );

  const monsterDropColumns = useMemo(
    () => [
      { title: '怪物', dataIndex: 'monster', key: 'monster', width: 130 },
      { title: '物品', dataIndex: 'name', key: 'name' },
      {
        title: '品质',
        dataIndex: 'quality',
        key: 'quality',
        width: 90,
        render: (v: string) => <Tag className="map-modal-quality-tag">{v}</Tag>,
      },
      { title: '概率/权重', dataIndex: 'chance', key: 'chance', width: 110 },
    ],
    [],
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={980}
      className="map-modal"
      destroyOnHidden
      maskClosable
      afterOpenChange={(visible) => {
        if (!visible) return;
        if (initialCategory && initialCategory !== category) {
          setCategory(initialCategory);
          setQuery('');
          setActiveId('');
          return;
        }
        if (activeId && filtered.some((m) => m.id === activeId)) return;
        setActiveId(filtered[0]?.id ?? '');
      }}
    >
      <div className="map-modal-shell">
        <div className={`map-modal-left ${showMobileDetail ? 'mobile-hidden' : ''}`}>
          <div className="map-modal-left-top">
            <Tabs
              size="small"
              activeKey={category}
              onChange={(k) => setCategory(k as MapCategory)}
              items={(Object.keys(categoryLabels) as MapCategory[]).map((key) => ({
                key,
                label: categoryLabels[key],
              }))}
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索地图..."
              allowClear
              prefix={<SearchOutlined />}
              size="middle"
            />
          </div>

          <div className="map-modal-list">
            {listLoading ? <div className="map-modal-empty">加载中...</div> : null}
            {!listLoading
              ? filtered.map((m) => (
                  <div
                    key={m.id}
                    className={`map-modal-item ${m.id === safeActiveId ? 'is-active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setActiveId(m.id);
                      setShowMobileDetail(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        setActiveId(m.id);
                        setShowMobileDetail(true);
                      }
                    }}
                  >
                    <div className="map-modal-item-name">{m.name}</div>
                    <div className="map-modal-item-meta">
                      <Tag className="map-modal-item-tag" color="blue">
                        {m.tag}
                      </Tag>
                      <div className="map-modal-item-level">{m.realm}</div>
                    </div>
                  </div>
                ))
              : null}
            {!listLoading && filtered.length === 0 ? <div className="map-modal-empty">暂无地图</div> : null}
          </div>
        </div>

        <div className={`map-modal-right ${showMobileDetail ? 'mobile-visible' : ''}`}>
          {mergedActiveMap ? (
            <>
              <div className="map-modal-mobile-back" onClick={() => setShowMobileDetail(false)}>
                <LeftOutlined /> 返回列表
              </div>
              <div className="map-modal-hero">
                <img className="map-modal-hero-img" src={mergedActiveMap.image} alt={mergedActiveMap.name} />
                <div className="map-modal-hero-overlay">
                  <div className="map-modal-hero-name">{mergedActiveMap.name}</div>
                  <div className="map-modal-hero-tags">
                    <Tag color="blue">{mergedActiveMap.tag}</Tag>
                    <Tag color="default">{activeRealmText}</Tag>
                    {mergedActiveMap.category === 'dungeon' && activeDungeonDifficultyText ? (
                      <Tag color="gold">{activeDungeonDifficultyText}</Tag>
                    ) : null}
                    {mergedActiveMap.category === 'dungeon' && dungeonEntryText ? <Tag color="orange">{dungeonEntryText}</Tag> : null}
                    {mergedActiveMap.category === 'dungeon' && dungeonStaminaCostText ? <Tag color="cyan">{dungeonStaminaCostText}</Tag> : null}
                  </div>
                  {dungeonNoStaminaCostTip ? <div className="map-modal-hero-tip">{dungeonNoStaminaCostTip}</div> : null}
                </div>
              </div>

              <div className="map-modal-detail">
                {mergedActiveMap.category === 'dungeon' ? (
                  <div className="map-modal-section">
                    <div className="map-modal-section-title">挑战难度</div>
                    <div className="map-modal-difficulty-row">
                      <div className="map-modal-difficulty-label">预览与进入将使用当前难度</div>
                      <Select
                        className="map-modal-difficulty-select"
                        value={activeDungeonRank}
                        options={activeDungeonDifficultyOptions}
                        loading={activeDungeonDifficultyLoading}
                        onChange={(value) => {
                          const nextRank = Number(value);
                          if (!Number.isFinite(nextRank) || nextRank <= 0) return;
                          setDungeonRankById((prev) => ({ ...prev, [mergedActiveMap.id]: Math.floor(nextRank) }));
                        }}
                      />
                    </div>
                  </div>
                ) : null}
                <div className="map-modal-section">
                  <div className="map-modal-section-title">{mergedActiveMap.category === 'dungeon' ? '秘境描述' : '地图描述'}</div>
                  <div className="map-modal-section-text">{mergedActiveMap.desc || '暂无描述'}</div>
                </div>

                {shouldShowNpcSection ? (
                  <div className="map-modal-section">
                    <div className="map-modal-section-title">存在的 NPC</div>
                    <div className="map-modal-section-text">
                      {detailLoading && !activeDetail ? '加载中...' : mergedActiveMap.npcs.join('、')}
                    </div>
                  </div>
                ) : null}

                {shouldShowMonsterSection ? (
                  <div className="map-modal-section">
                    <div className="map-modal-section-title">怪物列表</div>
                    <div className="map-modal-table">
                      <Table
                        size="small"
                        rowKey={(row) => row.id}
                        columns={monsterColumns}
                        dataSource={monsterRows}
                        pagination={false}
                        locale={{ emptyText: detailLoading && !activeDetail ? '加载中...' : '暂无怪物' }}
                      />
                    </div>
                  </div>
                ) : null}

                {mergedActiveMap.category !== 'dungeon' ? (
                  <div className="map-modal-section">
                    <div className="map-modal-section-title">怪物掉落详情</div>
                    <div className="map-modal-table">
                      {isMobile ? (
                        <div className="map-modal-mobile-list">
                          {(() => {
                            const groups: Record<string, typeof monsterDropRows> = {};
                            for (const row of monsterDropRows) {
                              if (!groups[row.monster]) groups[row.monster] = [];
                              groups[row.monster].push(row);
                            }
                            const monsterNames = Object.keys(groups);
                            if (monsterNames.length === 0) {
                              return (
                                <div className="map-modal-empty">
                                  {detailLoading && !activeDetail
                                    ? '加载中...'
                                    : monsterRows.length > 0
                                      ? '暂无怪物掉落'
                                      : '暂无怪物'}
                                </div>
                              );
                            }
                            return monsterNames.map((monsterName) => (
                              <div key={monsterName} className="map-modal-mobile-group">
                                <div className="map-modal-mobile-group-title">{monsterName}</div>
                                <div className="map-modal-mobile-group-content">
                                  {groups[monsterName].map((row) => (
                                    <div key={row.key} className="map-modal-mobile-row">
                                      <div className="map-modal-mobile-row-main">
                                        <span className="map-modal-mobile-name">{row.name}</span>
                                        <Tag className="map-modal-quality-tag">{row.quality}</Tag>
                                      </div>
                                      <div className="map-modal-mobile-row-sub">概率: {row.chance}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ));
                          })()}
                        </div>
                      ) : (
                        <Table
                          size="small"
                          rowKey={(row) => row.key}
                          columns={monsterDropColumns}
                          dataSource={monsterDropRows}
                          pagination={false}
                          locale={{
                            emptyText: detailLoading && !activeDetail ? '加载中...' : monsterRows.length > 0 ? '暂无怪物掉落' : '暂无怪物',
                          }}
                        />
                      )}
                    </div>
                  </div>
                ) : null}

                {shouldShowWaveSection ? (
                  <div className="map-modal-section">
                    <div className="map-modal-section-title">波次详情（共{totalWaveCount}波）</div>
                    <div className="map-modal-wave-shell">
                      <WaveDetailPanel stages={dungeonWaveStages} loading={detailLoading && !activeDetail} />
                    </div>
                  </div>
                ) : null}

                {mergedActiveMap.category !== 'dungeon' ? (
                  <div className="map-modal-section">
                    <div className="map-modal-section-title">掉落列表</div>
                    <div className="map-modal-table">
                      <Table
                        size="small"
                        rowKey={(row) => `${row.name}-${row.from}`}
                        columns={dropColumns}
                        dataSource={dropRows}
                        pagination={false}
                        locale={{ emptyText: detailLoading && !activeDetail ? '加载中...' : '暂无掉落' }}
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="map-modal-actions">
                <Button
                  type="primary"
                  onClick={async () => {
                    if (mergedActiveMap.category === 'dungeon') {
                      onEnterDungeon?.({ dungeonId: mergedActiveMap.id, rank: activeDungeonRank });
                      onClose();
                      return;
                    }
                    const startRoomId = activeDetail?.startRoomId;
                    if (startRoomId) {
                      onEnter?.({ mapId: mergedActiveMap.id, roomId: startRoomId });
                      onClose();
                      return;
                    }
                    setDetailLoading(true);
                    try {
                      const detailRes = await getMapDetail(mergedActiveMap.id);
                      const rooms = detailRes?.success && detailRes.data?.rooms ? detailRes.data.rooms : [];
                      const mapObj = (detailRes?.success ? (detailRes.data?.map as Record<string, unknown> | undefined) : undefined) ?? undefined;
                      const reviveRoomId = typeof mapObj?.revive_room_id === 'string' ? mapObj.revive_room_id : '';
                      const roomId =
                        reviveRoomId && rooms.some((r) => r?.id === reviveRoomId) ? reviveRoomId : rooms[0]?.id ? rooms[0].id : '';
                      if (roomId) {
                        setDetailById((prev) => ({
                          ...prev,
                          [mergedActiveMap.id]: {
                            npcs: [],
                            monsters: [],
                            drops: [],
                            dungeonStages: [],
                            dungeonEntry: null,
                            startRoomId: roomId,
                          },
                        }));
                        onEnter?.({ mapId: mergedActiveMap.id, roomId });
                        onClose();
                      }
                    } finally {
                      setDetailLoading(false);
                    }
                  }}
                >
                  {mergedActiveMap.category === 'dungeon' ? '进入秘境' : '进入'}
                </Button>
              </div>
            </>
          ) : (
            <div className="map-modal-empty">请选择地图</div>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default MapModal;
