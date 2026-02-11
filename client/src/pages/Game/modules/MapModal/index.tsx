import { Button, Input, Modal, Table, Tabs, Tag } from 'antd';
import { LeftOutlined, SearchOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import map01 from '../../../../assets/images/map/cp_icon_map01.png';
import map02 from '../../../../assets/images/map/cp_icon_map02.png';
import map03 from '../../../../assets/images/map/cp_icon_map03.png';
import map04 from '../../../../assets/images/map/cp_icon_map04.png';
import map05 from '../../../../assets/images/map/cp_icon_map05.png';
import map06 from '../../../../assets/images/map/cp_icon_map06.png';
import {
  type DungeonDefLite,
  type DungeonPreviewResponse,
  getDungeonList,
  getDungeonPreview,
  getEnabledMaps,
  getInfoTargetDetail,
  getMapDetail,
  getRoomObjects,
} from '../../../../services/api';
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
  npcs: string[];
  monsters: string[];
  drops: MapDrop[];
  dungeonStages?: NonNullable<DungeonPreviewResponse['data']>['stages'];
  dungeonEntry?: NonNullable<DungeonPreviewResponse['data']>['entry'];
};

const REALM_ORDER = [
  '凡人',
  '炼精化炁·养气期',
  '炼精化炁·通脉期',
  '炼精化炁·凝炁期',
  '炼炁化神·炼己期',
  '炼炁化神·采药期',
  '炼炁化神·结胎期',
  '炼神返虚·养神期',
  '炼神返虚·还虚期',
  '炼神返虚·合道期',
  '炼虚合道·证道期',
  '炼虚合道·历劫期',
  '炼虚合道·成圣期',
];

const normalizeRealmText = (value: unknown): string => {
  if (typeof value !== 'string') return '凡人';
  const t = value.trim();
  return t ? t : '凡人';
};

const getRealmRank = (realm: string): number => {
  const idx = REALM_ORDER.indexOf(normalizeRealmText(realm));
  return idx >= 0 ? idx : 0;
};

const formatDropProbPercent = (value: number | null | undefined): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  const normalized = Math.max(0, Math.min(1, value));
  const percent = normalized * 100;
  const fixed = Math.abs(percent - Math.round(percent)) < 1e-9 ? percent.toFixed(0) : percent.toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, '') || '0';
  return `${trimmed}%`;
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

interface MapModalProps {
  open: boolean;
  onClose: () => void;
  initialCategory?: MapCategory;
  onEnter?: (target: { mapId: string; roomId: string }) => void;
  onEnterDungeon?: (target: { dungeonId: string; rank: number }) => void;
}

const MapModal: React.FC<MapModalProps> = ({ open, onClose, initialCategory, onEnter, onEnterDungeon }) => {
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
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    if (open) setShowMobileDetail(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setListLoading(true);
    Promise.all([
      getEnabledMaps(),
      getDungeonList().catch(() => ({ success: false } as { success: boolean; data?: { dungeons: DungeonDefLite[] } })),
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

  useEffect(() => {
    if (!open) return;
    if (!safeActiveId) return;
    if (detailById[safeActiveId]) return;
    let cancelled = false;
    setDetailLoading(true);
    const entry = filtered.find((m) => m.id === safeActiveId) ?? null;
    const isDungeon = entry?.category === 'dungeon';

    if (isDungeon) {
      getDungeonPreview(safeActiveId, 1)
        .then((detailRes) => {
          if (cancelled) return;
          const monsters = detailRes?.success && detailRes.data?.monsters ? detailRes.data.monsters : [];
          const drops = detailRes?.success && detailRes.data?.drops ? detailRes.data.drops : [];
          const dungeonStages = detailRes?.success && detailRes.data?.stages ? detailRes.data.stages : [];
          const dungeonEntry = detailRes?.success ? (detailRes.data?.entry ?? null) : null;
          setDetailById((prev) => ({
            ...prev,
            [safeActiveId]: {
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
    }

    getMapDetail(safeActiveId)
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
            getRoomObjects(safeActiveId, r.id)
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
            const infoRes = await getInfoTargetDetail('monster', m.id).catch(() => null);
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
  }, [detailById, filtered, open, safeActiveId]);

  const mergedActiveMap = useMemo(() => {
    if (!activeMap) return null;
    const d = detailById[activeMap.id];
    if (!d) return activeMap;
    return { ...activeMap, ...d };
  }, [activeMap, detailById]);

  useEffect(() => {
    if (open) setShowMobileDetail(false);
  }, [open]);

  const activeRealmText = useMemo(() => normalizeRealmText(mergedActiveMap?.realm), [mergedActiveMap?.realm]);

  const monsterRows = useMemo(() => {
    if (!mergedActiveMap) return [] as MapMonster[];
    const d = detailById[mergedActiveMap.id];
    if (d?.monsterObjs) return d.monsterObjs;
    return (mergedActiveMap.monsters ?? []).map((name) => ({ id: name, name }));
  }, [detailById, mergedActiveMap]);
  const dropRows = useMemo(() => mergedActiveMap?.drops ?? [], [mergedActiveMap]);
  const monsterDropRows = useMemo(() => {
    if (!mergedActiveMap) return [];
    if (mergedActiveMap.category === 'dungeon') return [];
    const d = detailById[mergedActiveMap.id];
    const monsters = d?.monsterObjs ?? [];
    const byId = d?.monsterDropsById ?? {};
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
  }, [detailById, mergedActiveMap]);
  const waveRows = useMemo(() => {
    if (!mergedActiveMap || mergedActiveMap.category !== 'dungeon') return [];
    const stages = mergedActiveMap.dungeonStages ?? [];
    const rows: Array<{
      key: string;
      stage_index: number;
      stage_name: string;
      wave_index: number;
      spawn_delay_sec: number;
      monsters: NonNullable<DungeonPreviewResponse['data']>['stages'][number]['waves'][number]['monsters'];
    }> = [];

    for (const s of stages) {
      const stageName = s.name || `第${s.stage_index}关`;
      for (const w of s.waves ?? []) {
        rows.push({
          key: `${s.id}-${w.wave_index}`,
          stage_index: s.stage_index,
          stage_name: stageName,
          wave_index: w.wave_index,
          spawn_delay_sec: w.spawn_delay_sec,
          monsters: w.monsters ?? [],
        });
      }
    }
    return rows;
  }, [mergedActiveMap]);
  const totalWaveCount = useMemo(() => waveRows.length, [waveRows]);
  const dungeonEntryText = useMemo(() => {
    if (!mergedActiveMap || mergedActiveMap.category !== 'dungeon') return '';
    const entry = mergedActiveMap.dungeonEntry ?? null;
    if (!entry) return '';
    const daily = entry.daily_limit > 0 ? `${entry.daily_remaining}/${entry.daily_limit}` : '不限';
    const weekly = entry.weekly_limit > 0 ? `${entry.weekly_remaining}/${entry.weekly_limit}` : '不限';
    return `剩余次数 今日:${daily} 本周:${weekly}`;
  }, [mergedActiveMap]);
  const shouldShowNpcSection = useMemo(() => {
    if (!mergedActiveMap) return false;
    return (detailLoading && !detailById[mergedActiveMap.id]) || mergedActiveMap.npcs.length > 0;
  }, [detailById, detailLoading, mergedActiveMap]);
  const shouldShowMonsterSection = useMemo(() => {
    if (!mergedActiveMap) return false;
    return (detailLoading && !detailById[mergedActiveMap.id]) || mergedActiveMap.monsters.length > 0;
  }, [detailById, detailLoading, mergedActiveMap]);
  const shouldShowWaveSection = useMemo(() => {
    if (!mergedActiveMap || mergedActiveMap.category !== 'dungeon') return false;
    return (detailLoading && !detailById[mergedActiveMap.id]) || waveRows.length > 0;
  }, [detailById, detailLoading, mergedActiveMap, waveRows.length]);

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

  const waveColumns = useMemo(
    () => [
      { title: '关卡', dataIndex: 'stage_name', key: 'stage_name', width: 120 },
      { title: '波次', dataIndex: 'wave_index', key: 'wave_index', width: 70 },
      {
        title: '怪物（数量×名称）',
        dataIndex: 'monsters',
        key: 'monsters',
        render: (
          monsters: NonNullable<DungeonPreviewResponse['data']>['stages'][number]['waves'][number]['monsters']
        ) => (
          <div>
            {(monsters ?? []).map((m) => (
              <div key={`${m.id}-${m.name}`}>
                {m.count}×{m.name}
                {m.realm ? ` · ${m.realm}` : ''}
              </div>
            ))}
            {(monsters ?? []).length === 0 ? <div>暂无</div> : null}
          </div>
        ),
      },
      {
        title: '怪物掉落预览',
        dataIndex: 'monsters',
        key: 'drop_preview',
        render: (
          monsters: NonNullable<DungeonPreviewResponse['data']>['stages'][number]['waves'][number]['monsters']
        ) => (
          <div>
            {(monsters ?? []).map((m) => (
              <div key={`${m.id}-drops`}>
                <div>{m.name}</div>
                <div>
                  {(m.drop_preview ?? []).map((dp) => {
                    const qty = dp.qty_min === dp.qty_max ? `${dp.qty_min}` : `${dp.qty_min}-${dp.qty_max}`;
                    const rate =
                      dp.mode === 'prob'
                        ? formatDropProbPercent(dp.chance)
                        : dp.weight !== null
                          ? `${dp.weight}`
                          : '-';
                    const rateLabel = dp.mode === 'prob' ? '概率' : '权重';
                    return (
                      <div key={`${m.id}-${dp.item.id}`}>
                        {dp.item.name} ×{qty}（{rateLabel}:{rate}）
                      </div>
                    );
                  })}
                  {(m.drop_preview ?? []).length === 0 ? <div>暂无</div> : null}
                </div>
              </div>
            ))}
            {(monsters ?? []).length === 0 ? <div>暂无</div> : null}
          </div>
        ),
      },
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
                    {mergedActiveMap.category === 'dungeon' && dungeonEntryText ? <Tag color="orange">{dungeonEntryText}</Tag> : null}
                  </div>
                </div>
              </div>

              <div className="map-modal-detail">
                <div className="map-modal-section">
                  <div className="map-modal-section-title">{mergedActiveMap.category === 'dungeon' ? '秘境描述' : '地图描述'}</div>
                  <div className="map-modal-section-text">{mergedActiveMap.desc || '暂无描述'}</div>
                </div>

                {shouldShowNpcSection ? (
                  <div className="map-modal-section">
                    <div className="map-modal-section-title">存在的 NPC</div>
                    <div className="map-modal-section-text">
                      {detailLoading && !detailById[mergedActiveMap.id] ? '加载中...' : mergedActiveMap.npcs.join('、')}
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
                        locale={{ emptyText: detailLoading && !detailById[mergedActiveMap.id] ? '加载中...' : '暂无怪物' }}
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
                                  {detailLoading && !detailById[mergedActiveMap.id]
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
                            emptyText:
                              detailLoading && !detailById[mergedActiveMap.id]
                                ? '加载中...'
                                : monsterRows.length > 0
                                  ? '暂无怪物掉落'
                                  : '暂无怪物',
                          }}
                        />
                      )}
                    </div>
                  </div>
                ) : null}

                {shouldShowWaveSection ? (
                  <div className="map-modal-section">
                    <div className="map-modal-section-title">波次详情（共{totalWaveCount}波）</div>
                    <div className="map-modal-table">
                      <Table
                        size="small"
                        rowKey={(row) => row.key}
                        columns={waveColumns}
                        dataSource={waveRows}
                        pagination={false}
                        locale={{ emptyText: detailLoading && !detailById[mergedActiveMap.id] ? '加载中...' : '暂无波次' }}
                      />
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
                        locale={{ emptyText: detailLoading && !detailById[mergedActiveMap.id] ? '加载中...' : '暂无掉落' }}
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
                      onEnterDungeon?.({ dungeonId: mergedActiveMap.id, rank: 1 });
                      onClose();
                      return;
                    }
                    const startRoomId = detailById[mergedActiveMap.id]?.startRoomId;
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
