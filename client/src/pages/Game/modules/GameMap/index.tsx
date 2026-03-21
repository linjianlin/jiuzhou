import { Button } from 'antd';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MapRoom } from '../../../../services/api';
import { useMapDetailSnapshot } from '../../shared/useMapDetailSnapshot';
import './index.scss';

interface GameMapProps {
  currentMapId: string;
  currentRoomId: string;
  trackedRoomIds?: string[];
  headerAction?: {
    label: string;
    disabled?: boolean;
    onClick: () => void;
  };
  onMove: (next: { mapId: string; roomId: string }) => void;
}

type RoomNode = {
  id: string;
  name: string;
  description?: string;
  x: number;
  y: number;
  connections: Array<{ targetRoomId: string; targetMapId?: string }>;
};
const normalizeRooms = (rooms: MapRoom[]): RoomNode[] => {
  const withPos = rooms.map((r, idx) => {
    const x = typeof r.position?.x === 'number' ? r.position.x : idx;
    const y = typeof r.position?.y === 'number' ? r.position.y : 0;
    const connections = (Array.isArray(r.connections) ? r.connections : [])
      .map((c) => ({
        targetRoomId: typeof c?.target_room_id === 'string' ? c.target_room_id : '',
        targetMapId: typeof c?.target_map_id === 'string' ? c.target_map_id : undefined,
      }))
      .filter((c) => Boolean(c.targetRoomId));
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      x,
      y,
      connections,
    } satisfies RoomNode;
  });

  return withPos.filter((r) => typeof r.id === 'string' && r.id.length > 0);
};

const GameMap: React.FC<GameMapProps> = ({
  currentMapId,
  currentRoomId,
  trackedRoomIds,
  headerAction,
  onMove,
}) => {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [contentSize, setContentSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);
  const [lines, setLines] = useState<Array<{ key: string; x1: number; y1: number; x2: number; y2: number }>>([]);
  const [moving, setMoving] = useState(false);
  const { snapshot, loading } = useMapDetailSnapshot(currentMapId);
  const mapName = snapshot?.mapName ?? '';
  const rooms = useMemo(() => normalizeRooms(snapshot?.rooms ?? []), [snapshot]);

  const setNodeRef = (id: string) => (el: HTMLDivElement | null) => {
    nodeRefs.current[id] = el;
  };

  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);

  const effectiveRoomId = useMemo(() => {
    if (roomById.has(currentRoomId)) return currentRoomId;
    return rooms[0]?.id ?? '';
  }, [currentRoomId, roomById, rooms]);

  useEffect(() => {
    if (!effectiveRoomId) return;
    if (effectiveRoomId === currentRoomId) return;
    onMove({ mapId: currentMapId, roomId: effectiveRoomId });
  }, [currentMapId, currentRoomId, effectiveRoomId, onMove]);

  const currentRoom = roomById.get(effectiveRoomId) ?? null;
  const trackedSet = useMemo(() => new Set(trackedRoomIds ?? []), [trackedRoomIds]);

  const grid = useMemo(() => {
    if (rooms.length === 0) return { cols: 1, rows: 1, minX: 0, minY: 0 };
    let minX = rooms[0].x;
    let maxX = rooms[0].x;
    let minY = rooms[0].y;
    let maxY = rooms[0].y;
    for (const r of rooms) {
      minX = Math.min(minX, r.x);
      maxX = Math.max(maxX, r.x);
      minY = Math.min(minY, r.y);
      maxY = Math.max(maxY, r.y);
    }
    return { cols: maxX - minX + 1, rows: maxY - minY + 1, minX, minY };
  }, [rooms]);

  const connections = useMemo(() => {
    const edges: Array<{ fromId: string; toId: string }> = [];
    const added = new Set<string>();
    for (const r of rooms) {
      for (const c of r.connections) {
        if (c.targetMapId && c.targetMapId !== currentMapId) continue;
        if (!roomById.has(c.targetRoomId)) continue;
        const a = r.id < c.targetRoomId ? r.id : c.targetRoomId;
        const b = r.id < c.targetRoomId ? c.targetRoomId : r.id;
        const key = `${a}@@${b}`;
        if (added.has(key)) continue;
        added.add(key);
        edges.push({ fromId: a, toId: b });
      }
    }
    return edges;
  }, [currentMapId, roomById, rooms]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const nodes = nodesRef.current;
    if (!canvas) return;

    const update = () => {
      if (!nodes) return;

      if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return;

      const width = nodes.offsetWidth;
      const height = nodes.offsetHeight;
      if (width === 0 || height === 0) return;
      setContentSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));

      const padding = 16;
      const availableW = Math.max(0, canvas.clientWidth - padding);
      const availableH = Math.max(0, canvas.clientHeight - padding);
      const nextScaleRaw = width > 0 && height > 0 ? Math.min(availableW / width, availableH / height) : 1;
      const nextScale = Math.max(0.2, Math.min(nextScaleRaw, 2));

      setScale((prev) => (Math.abs(prev - nextScale) < 0.001 ? prev : nextScale));

      const centers: Record<string, { x: number; y: number }> = {};
      for (const room of rooms) {
        const el = nodeRefs.current[room.id];
        if (!el) continue;
        centers[room.id] = {
          x: el.offsetLeft + el.offsetWidth / 2,
          y: el.offsetTop + el.offsetHeight / 2,
        };
      }

      setLines(
        connections
          .map(({ fromId, toId }) => {
            const ca = centers[fromId];
            const cb = centers[toId];
            if (!ca || !cb) return null;
            return { key: `${fromId}-${toId}`, x1: ca.x, y1: ca.y, x2: cb.x, y2: cb.y };
          })
          .filter((x): x is { key: string; x1: number; y1: number; x2: number; y2: number } => Boolean(x)),
      );
    };

    update();

    const ro = new ResizeObserver(() => {
      update();
    });
    ro.observe(canvas);
    if (nodes) ro.observe(nodes);

    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      ro.disconnect();
    };
  }, [connections, effectiveRoomId, rooms]);

  const canMoveTo = (targetRoomId: string): boolean => {
    if (!currentRoom) return false;
    if (targetRoomId === currentRoom.id) return false;
    const direct = currentRoom.connections.some((c) => c.targetRoomId === targetRoomId);
    const reverse = roomById.get(targetRoomId)?.connections?.some((c) => c.targetRoomId === currentRoom.id) ?? false;
    return direct || reverse;
  };

  const handleRoomClick = (room: RoomNode) => {
    const targetRoomId = room.id;
    if (moving) return;
    if (!currentRoom) return;
    if (targetRoomId === currentRoom.id) return;
    if (!canMoveTo(targetRoomId)) return;

    setMoving(true);
    window.setTimeout(() => {
      const direct = currentRoom.connections.find((c) => c.targetRoomId === targetRoomId);
      const nextMapId = direct?.targetMapId ?? currentMapId;
      const nextRoomId = direct ? direct.targetRoomId : targetRoomId;
      onMove({ mapId: nextMapId, roomId: nextRoomId });
      setMoving(false);
    }, 180);
  };

  const shownMapName = mapName || (loading ? '同步中...' : '未知地图');

  return (
    <div className="game-map">
      <div className="map-header">
        <div className="map-header-left">
          <div className="map-room-name">{loading ? '加载中...' : currentRoom?.name ?? '未知房间'}</div>
          {currentRoom?.description ? <div className="map-room-desc">{currentRoom.description}</div> : null}
          {headerAction ? (
            <Button
              className="map-header-action"
              type="primary"
              size="small"
              disabled={headerAction.disabled}
              onClick={headerAction.onClick}
            >
              {headerAction.label}
            </Button>
          ) : null}
        </div>
        <div className="map-header-right">{shownMapName}</div>
      </div>

      <div ref={canvasRef} className="map-canvas">
        <div ref={contentRef} className="map-content" style={{ transform: `scale(${scale})` }}>
          <svg
            className="map-connections"
            width="100%"
            height="100%"
            viewBox={`0 0 ${contentSize.width} ${contentSize.height}`}
            preserveAspectRatio="none"
          >
            {lines.map((l) => (
              <line
                key={l.key}
                x1={l.x1}
                y1={l.y1}
                x2={l.x2}
                y2={l.y2}
                stroke="var(--border-color)"
                strokeWidth="2"
                strokeLinecap="round"
              />
            ))}
          </svg>

          <div
            ref={nodesRef}
            className="map-nodes"
            style={
              {
                '--map-cols': grid.cols,
                '--map-rows': grid.rows,
              } as CSSProperties
            }
          >
            {rooms.map((room) => (
              <div
                key={room.id}
                ref={setNodeRef(room.id)}
                className={`room-node ${room.id === effectiveRoomId ? 'current' : ''} ${
                  room.id !== effectiveRoomId && !canMoveTo(room.id) ? 'blocked' : ''
                } ${trackedSet.has(room.id) ? 'tracked' : ''}`}
                style={{
                  gridColumn: room.x - grid.minX + 1,
                  gridRow: room.y - grid.minY + 1,
                }}
                onClick={() => handleRoomClick(room)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') handleRoomClick(room);
                }}
              >
                <div className="room-node-name">{room.name}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default GameMap;
