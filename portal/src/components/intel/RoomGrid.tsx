import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import type { RoomIntel, ScoredCandidate, EnemyZone, IntelFilters } from '../../types/intel';
import {
  coordsToRoomName,
  getRoomBounds,
  gridToCoords,
  expandBounds,
  getRoomType,
} from '../../utils/roomCoords';

interface RoomGridProps {
  rooms: Record<string, RoomIntel>;
  colonies: string[];
  candidates: ScoredCandidate[];
  enemies: EnemyZone[];
  filters: IntelFilters;
  selectedRoom: string | null;
  onSelectRoom: (roomName: string | null) => void;
}

const ROOM_COLORS: Record<string, string> = {
  normal: '#222222',
  sourceKeeper: '#332200',
  center: '#002233',
  highway: '#1a1a1a',
  highwayIntersection: '#151515',
  owned: '#003300',
  hostile: '#330000',
  reserved: '#002244',
  hostileReserved: '#442200',
};

const MINERAL_COLORS: Record<string, string> = {
  H: '#989898',
  O: '#989898',
  U: '#50d050',
  L: '#50d0d0',
  K: '#a050d0',
  Z: '#ffd850',
  X: '#ff6050',
};

const CELL_SIZE = 20;
const CELL_GAP = 1; // 1px gap between cells for grid lines
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const DRAG_THRESHOLD = 4; // px before mousedown counts as drag
const FIT_ZOOM_CAP = 1.5; // max zoom for auto-fit

export function RoomGrid({
  rooms,
  colonies,
  candidates,
  enemies,
  filters,
  selectedRoom,
  onSelectRoom,
}: RoomGridProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // View state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoveredRoom, setHoveredRoom] = useState<string | null>(null);

  // Drag state as refs to avoid re-render during drag
  const isDraggingRef = useRef(false);
  const didDragRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const dragStartPanRef = useRef({ x: 0, y: 0 });

  // Track whether we've done initial centering
  const hasCenteredRef = useRef(false);

  // ===== MEMOIZED DERIVED DATA =====

  const bounds = useMemo(() => {
    const allRoomNames = [...Object.keys(rooms), ...colonies];
    const base = getRoomBounds(allRoomNames);
    return base ? expandBounds(base, 2) : null;
  }, [rooms, colonies]);

  const coloniesSet = useMemo(() => new Set(colonies), [colonies]);

  const filteredRooms = useMemo(() => {
    if (!bounds) return {};
    const result: Record<string, RoomIntel> = {};
    const myUsername = 'Montblanc0';
    for (const [name, room] of Object.entries(rooms)) {
      const roomType = room.roomType || 'normal';
      if (!filters.roomTypes.has(roomType)) continue;
      if (room.sources.length < filters.minSources) continue;
      if (room.sources.length > filters.maxSources) continue;
      if (filters.mineralFilter && filters.mineralFilter !== 'any') {
        // API uses mineral.type, not mineral.mineralType
        if (!room.mineral || room.mineral.type !== filters.mineralFilter) continue;
      }
      // API uses owner field directly, no isOwned boolean
      if (filters.showOwnedOnly && room.owner !== myUsername) continue;
      if (filters.showHostileOnly && (!room.owner || room.owner === myUsername)) continue;
      result[name] = room;
    }
    return result;
  }, [rooms, bounds, filters]);

  const candidateLookup = useMemo(() => {
    const map: Record<string, ScoredCandidate> = {};
    for (const c of candidates) {
      map[c.roomName] = c;
    }
    return map;
  }, [candidates]);

  const enemyRoomsSet = useMemo(() => {
    const set = new Set<string>();
    for (const zone of enemies) {
      for (const room of zone.rooms) {
        set.add(room);
      }
    }
    return set;
  }, [enemies]);

  // ===== COORDINATE CONVERSION =====

  const screenToRoom = useCallback(
    (screenX: number, screenY: number): string | null => {
      if (!bounds || !canvasRef.current) return null;
      const rect = canvasRef.current.getBoundingClientRect();
      const canvasX = screenX - rect.left;
      const canvasY = screenY - rect.top;
      const worldX = (canvasX - pan.x) / (CELL_SIZE * zoom);
      const worldY = (canvasY - pan.y) / (CELL_SIZE * zoom);
      const gx = Math.floor(worldX);
      const gy = Math.floor(worldY);
      const gridWidth = bounds.maxX - bounds.minX + 1;
      const gridHeight = bounds.maxY - bounds.minY + 1;
      if (gx < 0 || gy < 0 || gx >= gridWidth || gy >= gridHeight) return null;
      const coords = gridToCoords(gx, gy, bounds);
      return coordsToRoomName(coords);
    },
    [bounds, pan, zoom]
  );

  // ===== DRAWING =====

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !bounds) return;

    const width = canvas.width;
    const height = canvas.height;
    const gridWidth = bounds.maxX - bounds.minX + 1;
    const gridHeight = bounds.maxY - bounds.minY + 1;

    // Clear
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, width, height);

    // Calculate visible range (viewport culling)
    const startGX = Math.max(0, Math.floor(-pan.x / (CELL_SIZE * zoom)));
    const startGY = Math.max(0, Math.floor(-pan.y / (CELL_SIZE * zoom)));
    const endGX = Math.min(gridWidth, Math.ceil((width - pan.x) / (CELL_SIZE * zoom)));
    const endGY = Math.min(gridHeight, Math.ceil((height - pan.y) / (CELL_SIZE * zoom)));

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    // Draw visible cells
    for (let gy = startGY; gy < endGY; gy++) {
      for (let gx = startGX; gx < endGX; gx++) {
        const coords = gridToCoords(gx, gy, bounds);
        const roomName = coordsToRoomName(coords);
        const room = filteredRooms[roomName];
        const isColony = coloniesSet.has(roomName);

        const x = gx * CELL_SIZE;
        const y = gy * CELL_SIZE;
        const cellInner = CELL_SIZE - CELL_GAP;

        // --- Background ---
        if (!room && !isColony) {
          // Not in filtered set: dark empty cell
          ctx.fillStyle = '#141414';
          ctx.fillRect(x, y, cellInner, cellInner);
        } else {
          // Determine color
          const roomType = room?.roomType || getRoomType(roomName);
          let bgColor = ROOM_COLORS[roomType] || ROOM_COLORS.normal;

          if (room) {
            // API uses owner field directly, no isOwned boolean
            if (room.owner) {
              bgColor = room.owner === 'Montblanc0' ? ROOM_COLORS.owned : ROOM_COLORS.hostile;
            } else if (room.reservation) {
              bgColor = room.reservation.username === 'Montblanc0' ? ROOM_COLORS.reserved : ROOM_COLORS.hostileReserved;
            }
          }
          if (isColony) {
            bgColor = '#004400';
          }

          // Enemy zone overlay
          if (filters.showEnemyZones && enemyRoomsSet.has(roomName)) {
            bgColor = '#440000';
          }

          ctx.fillStyle = bgColor;
          ctx.fillRect(x, y, cellInner, cellInner);

          // --- Source dots ---
          if (room && room.sources) {
            ctx.fillStyle = '#ffcc00';
            const sourceCount = room.sources.length;
            for (let i = 0; i < sourceCount; i++) {
              const sx = x + 4 + i * 5;
              const sy = y + 4;
              ctx.beginPath();
              ctx.arc(sx, sy, 2, 0, Math.PI * 2);
              ctx.fill();
            }
          }

          // --- Mineral dot ---
          // API uses mineral.type, not mineral.mineralType
          if (room && room.mineral && room.mineral.type) {
            const mColor = MINERAL_COLORS[room.mineral.type] || '#888';
            ctx.fillStyle = mColor;
            ctx.beginPath();
            ctx.arc(x + cellInner - 4, y + cellInner - 4, 3, 0, Math.PI * 2);
            ctx.fill();
          }

          // --- Colony star ---
          if (isColony) {
            ctx.fillStyle = '#00ff88';
            ctx.font = 'bold 10px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('★', x + cellInner / 2, y + cellInner / 2);
          }

          // --- Candidate overlay ---
          if (filters.showCandidates && candidateLookup[roomName]) {
            const candidate = candidateLookup[roomName];
            // Higher score = more opaque highlight
            const alpha = Math.min(candidate.score / 100, 1) * 0.5;
            ctx.fillStyle = `rgba(68, 136, 255, ${alpha})`;
            ctx.fillRect(x + 1, y + 1, cellInner - 2, cellInner - 2);
            ctx.strokeStyle = '#4488ff';
            ctx.lineWidth = 1 / zoom;
            ctx.strokeRect(x + 1, y + 1, cellInner - 2, cellInner - 2);
          }
        }

        // --- Selection / hover highlight (always, even for empty cells) ---
        if (roomName === selectedRoom) {
          ctx.strokeStyle = '#00ff88';
          ctx.lineWidth = 2 / zoom;
          ctx.strokeRect(x + 1, y + 1, cellInner - 2, cellInner - 2);
        } else if (roomName === hoveredRoom) {
          ctx.strokeStyle = '#4488ff';
          ctx.lineWidth = 1 / zoom;
          ctx.strokeRect(x + 1, y + 1, cellInner - 2, cellInner - 2);
        }
      }
    }

    // --- Room labels at high zoom ---
    // At zoom >= 2, CELL_SIZE * zoom >= 40px, enough for small text
    if (zoom >= 2) {
      ctx.fillStyle = '#aaaaaa';
      ctx.font = '5px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';

      for (let gy = startGY; gy < endGY; gy++) {
        for (let gx = startGX; gx < endGX; gx++) {
          const coords = gridToCoords(gx, gy, bounds);
          const roomName = coordsToRoomName(coords);
          const x = gx * CELL_SIZE;
          const y = gy * CELL_SIZE;
          ctx.fillText(roomName, x + (CELL_SIZE - CELL_GAP) / 2, y + CELL_SIZE - CELL_GAP - 1);
        }
      }
    }

    ctx.restore();

    // --- HUD (drawn in screen space, not world space) ---
    if (hoveredRoom) {
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(8, height - 32, 120, 24);
      ctx.fillStyle = '#eeeeee';
      ctx.font = '12px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(hoveredRoom, 14, height - 20);
    }

    ctx.fillStyle = '#555';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(zoom * 100)}%`, width - 8, height - 8);
  }, [bounds, pan, zoom, filteredRooms, candidateLookup, enemyRoomsSet, coloniesSet, filters, selectedRoom, hoveredRoom]);

  // ===== FIT VIEW =====

  const fitView = useCallback(() => {
    if (!bounds || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const gridWidth = bounds.maxX - bounds.minX + 1;
    const gridHeight = bounds.maxY - bounds.minY + 1;

    const padFraction = 0.85;
    const zoomX = (canvas.width * padFraction) / (gridWidth * CELL_SIZE);
    const zoomY = (canvas.height * padFraction) / (gridHeight * CELL_SIZE);
    const newZoom = Math.max(MIN_ZOOM, Math.min(FIT_ZOOM_CAP, Math.min(zoomX, zoomY)));

    const totalWidth = gridWidth * CELL_SIZE * newZoom;
    const totalHeight = gridHeight * CELL_SIZE * newZoom;

    setPan({
      x: (canvas.width - totalWidth) / 2,
      y: (canvas.height - totalHeight) / 2,
    });
    setZoom(newZoom);
  }, [bounds]);

  // ===== EFFECTS =====

  // Resize canvas
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      draw();
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [draw]);

  // Redraw on state change
  useEffect(() => {
    draw();
  }, [draw]);

  // Auto-fit on first data load only
  useEffect(() => {
    if (hasCenteredRef.current || !bounds || !canvasRef.current) return;
    if (Object.keys(rooms).length === 0) return;

    hasCenteredRef.current = true;
    fitView();
  }, [bounds, rooms, fitView]);

  // ===== MOUSE HANDLERS =====

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    isDraggingRef.current = true;
    didDragRef.current = false;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    dragStartPanRef.current = { x: pan.x, y: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDraggingRef.current) {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        didDragRef.current = true;
      }
      setPan({
        x: dragStartPanRef.current.x + dx,
        y: dragStartPanRef.current.y + dy,
      });
    } else {
      const roomName = screenToRoom(e.clientX, e.clientY);
      setHoveredRoom(roomName);
    }
  }, [screenToRoom]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;

    // If we didn't actually drag, treat as click
    if (!didDragRef.current && e.button === 0) {
      const roomName = screenToRoom(e.clientX, e.clientY);
      onSelectRoom(roomName === selectedRoom ? null : roomName);
    }
  }, [screenToRoom, selectedRoom, onSelectRoom]);

  const handleMouseLeave = useCallback(() => {
    isDraggingRef.current = false;
    setHoveredRoom(null);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * delta));
    const scale = newZoom / zoom;

    setPan(prev => ({
      x: mouseX - (mouseX - prev.x) * scale,
      y: mouseY - (mouseY - prev.y) * scale,
    }));
    setZoom(newZoom);
  }, [zoom]);

  // ===== RENDER =====

  if (!bounds) {
    return (
      <div className="flex items-center justify-center h-full bg-[#111] text-[#888]">
        No room data available
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full relative">
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
      />

      {/* Controls overlay */}
      <div className="absolute top-2 right-2 flex gap-1">
        <button
          type="button"
          onClick={() => setZoom(z => Math.min(MAX_ZOOM, z * 1.25))}
          className="w-8 h-8 bg-[#1a1a1a] border border-[#333] rounded text-[#888] hover:text-[#eee] hover:border-[#555]"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setZoom(z => Math.max(MIN_ZOOM, z * 0.8))}
          className="w-8 h-8 bg-[#1a1a1a] border border-[#333] rounded text-[#888] hover:text-[#eee] hover:border-[#555]"
        >
          −
        </button>
        <button
          type="button"
          onClick={fitView}
          className="px-2 h-8 bg-[#1a1a1a] border border-[#333] rounded text-[#888] hover:text-[#eee] hover:border-[#555] text-xs"
        >
          Fit
        </button>
      </div>
    </div>
  );
}
