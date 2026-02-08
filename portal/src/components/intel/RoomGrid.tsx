import { useRef, useEffect, useCallback, useState } from 'react';
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

// Room colors by type
const ROOM_COLORS: Record<string, string> = {
  normal: '#222222',
  sourceKeeper: '#332200',
  center: '#002233',
  highway: '#1a1a1a',
  highwayIntersection: '#111111',
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
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

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
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hoveredRoom, setHoveredRoom] = useState<string | null>(null);

  // Calculate grid bounds from all known rooms plus colonies
  const allRoomNames = [...Object.keys(rooms), ...colonies];
  const baseBounds = getRoomBounds(allRoomNames);
  const bounds = baseBounds ? expandBounds(baseBounds, 2) : null;

  // Filter rooms based on current filters
  const filteredRooms = useCallback(() => {
    if (!bounds) return {};

    const result: Record<string, RoomIntel> = {};
    for (const [name, room] of Object.entries(rooms)) {
      const roomType = room.roomType || getRoomType(name);

      // Room type filter
      if (!filters.roomTypes.has(roomType)) continue;

      // Source count filter
      if (room.sources.length < filters.minSources) continue;
      if (room.sources.length > filters.maxSources) continue;

      // Mineral filter
      if (filters.mineralFilter && filters.mineralFilter !== 'any') {
        if (!room.mineral || room.mineral.mineralType !== filters.mineralFilter) continue;
      }

      // Ownership filters
      if (filters.showOwnedOnly && room.owner !== 'Montblanc0') continue;
      if (filters.showHostileOnly && (!room.isOwned || room.owner === 'Montblanc0')) continue;

      result[name] = room;
    }
    return result;
  }, [rooms, bounds, filters]);

  // Get candidate scores as a map for quick lookup
  const candidateMap = useCallback(() => {
    const map: Record<string, ScoredCandidate> = {};
    for (const c of candidates) {
      map[c.roomName] = c;
    }
    return map;
  }, [candidates]);

  // Get enemy rooms as a set
  const enemyRoomsSet = useCallback(() => {
    const set = new Set<string>();
    for (const zone of enemies) {
      for (const room of zone.rooms) {
        set.add(room);
      }
    }
    return set;
  }, [enemies]);

  // Convert screen coordinates to room name
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

      if (gx < 0 || gy < 0) return null;
      if (gx > bounds.maxX - bounds.minX) return null;
      if (gy > bounds.maxY - bounds.minY) return null;

      const coords = gridToCoords(gx, gy, bounds);
      return coordsToRoomName(coords);
    },
    [bounds, pan, zoom]
  );

  // Draw the canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !bounds) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, width, height);

    const filtered = filteredRooms();
    const candidatesLookup = candidateMap();
    const enemyRooms = enemyRoomsSet();

    const gridWidth = bounds.maxX - bounds.minX + 1;
    const gridHeight = bounds.maxY - bounds.minY + 1;

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    // Draw grid cells
    for (let gy = 0; gy < gridHeight; gy++) {
      for (let gx = 0; gx < gridWidth; gx++) {
        const coords = gridToCoords(gx, gy, bounds);
        const roomName = coordsToRoomName(coords);
        const room = filtered[roomName];
        const roomType = room?.roomType || getRoomType(roomName);

        const x = gx * CELL_SIZE;
        const y = gy * CELL_SIZE;

        // Determine cell color
        let bgColor = ROOM_COLORS[roomType] || ROOM_COLORS.normal;

        if (room) {
          if (room.isOwned) {
            bgColor = room.owner === 'Montblanc0' ? ROOM_COLORS.owned : ROOM_COLORS.hostile;
          } else if (room.isReserved) {
            bgColor = room.reservedBy === 'Montblanc0' ? ROOM_COLORS.reserved : ROOM_COLORS.hostileReserved;
          }
        }

        // Check if it's a colony
        const isColony = colonies.includes(roomName);
        if (isColony) {
          bgColor = '#004400';
        }

        // Draw cell background
        ctx.fillStyle = bgColor;
        ctx.fillRect(x + 0.5, y + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);

        // Draw candidate overlay
        if (filters.showCandidates && candidatesLookup[roomName]) {
          const candidate = candidatesLookup[roomName];
          const alpha = Math.min(candidate.score / 100, 1) * 0.5;
          ctx.fillStyle = `rgba(68, 136, 255, ${alpha})`;
          ctx.fillRect(x + 0.5, y + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
        }

        // Draw enemy zone overlay
        if (filters.showEnemyZones && enemyRooms.has(roomName)) {
          ctx.fillStyle = 'rgba(255, 68, 68, 0.3)';
          ctx.fillRect(x + 0.5, y + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
        }

        // Draw source indicators (small yellow dots)
        if (room && room.sources.length > 0 && zoom >= 0.5) {
          ctx.fillStyle = '#ffcc00';
          const sourceSize = Math.max(2, 3 * zoom);
          for (let i = 0; i < room.sources.length; i++) {
            const sx = x + 4 + i * 6;
            const sy = y + CELL_SIZE - 5;
            ctx.beginPath();
            ctx.arc(sx, sy, sourceSize / zoom, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Draw mineral indicator
        if (room?.mineral && zoom >= 0.5) {
          const mineralColor = MINERAL_COLORS[room.mineral.mineralType] || '#888';
          ctx.fillStyle = mineralColor;
          const mineralSize = Math.max(2, 4 * zoom);
          ctx.beginPath();
          ctx.arc(x + CELL_SIZE - 5, y + CELL_SIZE - 5, mineralSize / zoom, 0, Math.PI * 2);
          ctx.fill();
        }

        // Draw colony marker
        if (isColony) {
          ctx.fillStyle = '#00ff88';
          ctx.font = `bold ${Math.max(8, 10 * zoom)}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('★', x + CELL_SIZE / 2, y + CELL_SIZE / 2);
        }

        // Draw selection/hover highlight
        if (roomName === selectedRoom) {
          ctx.strokeStyle = '#00ff88';
          ctx.lineWidth = 2 / zoom;
          ctx.strokeRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        } else if (roomName === hoveredRoom) {
          ctx.strokeStyle = '#4488ff';
          ctx.lineWidth = 1 / zoom;
          ctx.strokeRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        }
      }
    }

    // Draw room labels when zoomed in enough
    if (zoom >= 1.5) {
      ctx.fillStyle = '#888888';
      ctx.font = `${Math.max(6, 8 * zoom)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      for (let gy = 0; gy < gridHeight; gy++) {
        for (let gx = 0; gx < gridWidth; gx++) {
          const coords = gridToCoords(gx, gy, bounds);
          const roomName = coordsToRoomName(coords);
          const x = gx * CELL_SIZE;
          const y = gy * CELL_SIZE;
          ctx.fillText(roomName, x + CELL_SIZE / 2, y + 2);
        }
      }
    }

    ctx.restore();

    // Draw hovered room name in corner
    if (hoveredRoom) {
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(10, height - 30, 100, 24);
      ctx.fillStyle = '#eee';
      ctx.font = '12px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(hoveredRoom, 16, height - 18);
    }

    // Draw zoom level
    ctx.fillStyle = '#666';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(zoom * 100)}%`, width - 10, height - 10);
  }, [bounds, pan, zoom, filteredRooms, candidateMap, enemyRoomsSet, colonies, filters, selectedRoom, hoveredRoom]);

  // Handle resize
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

  // Redraw when dependencies change
  useEffect(() => {
    draw();
  }, [draw]);

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    } else {
      const roomName = screenToRoom(e.clientX, e.clientY);
      setHoveredRoom(roomName);
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (isDragging) {
      setIsDragging(false);
    } else if (e.button === 0) {
      const roomName = screenToRoom(e.clientX, e.clientY);
      onSelectRoom(roomName === selectedRoom ? null : roomName);
    }
  };

  const handleMouseLeave = () => {
    setIsDragging(false);
    setHoveredRoom(null);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();

    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * delta));

    // Zoom towards mouse position
    const scale = newZoom / zoom;
    setPan({
      x: mouseX - (mouseX - pan.x) * scale,
      y: mouseY - (mouseY - pan.y) * scale,
    });
    setZoom(newZoom);
  };

  // Center view on colonies
  const centerOnColonies = useCallback(() => {
    if (!bounds || !canvasRef.current || colonies.length === 0) return;

    const colonyBounds = getRoomBounds(colonies);
    if (!colonyBounds) return;

    const centerX = (colonyBounds.minX + colonyBounds.maxX) / 2 - bounds.minX;
    const centerY = (colonyBounds.minY + colonyBounds.maxY) / 2 - bounds.minY;

    const canvas = canvasRef.current;
    const newZoom = 1;
    setPan({
      x: canvas.width / 2 - centerX * CELL_SIZE * newZoom - CELL_SIZE / 2,
      y: canvas.height / 2 - centerY * CELL_SIZE * newZoom - CELL_SIZE / 2,
    });
    setZoom(newZoom);
  }, [bounds, colonies]);

  // Center on load
  useEffect(() => {
    centerOnColonies();
  }, [centerOnColonies]);

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
          onClick={() => setZoom(Math.min(MAX_ZOOM, zoom * 1.25))}
          className="w-8 h-8 bg-[#1a1a1a] border border-[#333] rounded text-[#888] hover:text-[#eee] hover:border-[#555]"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setZoom(Math.max(MIN_ZOOM, zoom * 0.8))}
          className="w-8 h-8 bg-[#1a1a1a] border border-[#333] rounded text-[#888] hover:text-[#eee] hover:border-[#555]"
        >
          −
        </button>
        <button
          type="button"
          onClick={centerOnColonies}
          className="px-2 h-8 bg-[#1a1a1a] border border-[#333] rounded text-[#888] hover:text-[#eee] hover:border-[#555] text-xs"
        >
          Center
        </button>
      </div>
    </div>
  );
}
