import { useRef, useEffect, useState, useCallback } from 'react';
import { fetchPositions } from '../../api/debug';
import { heatmapColor } from '../../utils/recordingConstants';
import type { PositionData, PositionEntry } from '../../types/debug';

const TILE_SIZE = 8;
const GRID_SIZE = 50;
const CANVAS_SIZE = TILE_SIZE * GRID_SIZE; // 400px

const ROLE_ABBREV: Record<string, { label: string; color: string }> = {
  HAR: { label: 'Harvester', color: '#ffff00' },
  HAU: { label: 'Hauler', color: '#ff8800' },
  UPG: { label: 'Upgrader', color: '#8844ff' },
  BUI: { label: 'Builder', color: '#44ff44' },
  DEF: { label: 'Defender', color: '#ff0000' },
  REM: { label: 'Remote', color: '#aaaa00' },
  RMI: { label: 'Remote Miner', color: '#aaaa00' },
  RHA: { label: 'Remote Hauler', color: '#aa6600' },
  SCO: { label: 'Scout', color: '#aaaaaa' },
  LIN: { label: 'Link Filler', color: '#4488ff' },
  RES: { label: 'Reserver', color: '#0088ff' },
  MIN: { label: 'Mineral', color: '#ff44ff' },
  CLA: { label: 'Claimer', color: '#00ffff' },
  BOO: { label: 'Bootstrap', color: '#88ff88' },
};

function buildHeatmap(entries: PositionEntry[]): number[][] {
  const grid = Array.from({ length: GRID_SIZE }, () => new Array(GRID_SIZE).fill(0));
  for (const entry of entries) {
    if (entry.x >= 0 && entry.x < GRID_SIZE && entry.y >= 0 && entry.y < GRID_SIZE) {
      grid[entry.y][entry.x]++;
    }
  }
  return grid;
}

export function PositionViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [positionData, setPositionData] = useState<PositionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<string>('ALL');

  const loadPositions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchPositions();
      if (response.data && response.data.entries && response.data.entries.length > 0) {
        setPositionData(response.data);
      } else {
        setError('Position logging is disabled. Enable it in-game with Memory.settings.logPositions = true');
        setPositionData(null);
      }
    } catch (err) {
      setError(`Failed to load positions: ${err}`);
      setPositionData(null);
    }
    setLoading(false);
  }, []);

  // Load data on mount
  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  // Render canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = CANVAS_SIZE * dpr;
    canvas.height = CANVAS_SIZE * dpr;
    canvas.style.width = `${CANVAS_SIZE}px`;
    canvas.style.height = `${CANVAS_SIZE}px`;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Draw grid lines
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= GRID_SIZE; i++) {
      ctx.beginPath();
      ctx.moveTo(i * TILE_SIZE, 0);
      ctx.lineTo(i * TILE_SIZE, CANVAS_SIZE);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * TILE_SIZE);
      ctx.lineTo(CANVAS_SIZE, i * TILE_SIZE);
      ctx.stroke();
    }

    if (!positionData || !positionData.entries.length) return;

    // Filter entries by role if needed
    const entries = selectedRole === 'ALL'
      ? positionData.entries
      : positionData.entries.filter(e => e.r === selectedRole);

    if (entries.length === 0) return;

    // Build heatmap
    const grid = buildHeatmap(entries);
    const maxVisits = Math.max(...grid.flat());

    if (maxVisits === 0) return;

    // Render heatmap
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (grid[y][x] === 0) continue;
        const normalized = grid[y][x] / maxVisits;

        if (selectedRole !== 'ALL' && ROLE_ABBREV[selectedRole]) {
          // Use role color with varying opacity
          const roleColor = ROLE_ABBREV[selectedRole].color;
          // Convert hex to rgba with opacity based on normalized value
          const r = parseInt(roleColor.slice(1, 3), 16);
          const g = parseInt(roleColor.slice(3, 5), 16);
          const b = parseInt(roleColor.slice(5, 7), 16);
          const opacity = 0.2 + normalized * 0.8;
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
        } else {
          ctx.fillStyle = heatmapColor(normalized);
        }
        ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
  }, [positionData, selectedRole]);

  // Get unique roles from data
  const availableRoles = positionData
    ? [...new Set(positionData.entries.map(e => e.r))].sort()
    : [];

  return (
    <div className="flex flex-col h-full">
      {/* Canvas */}
      <div className="flex-shrink-0 mb-4">
        <canvas
          ref={canvasRef}
          className="border border-[#333] rounded"
          style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
        />
      </div>

      {/* Info */}
      <div className="flex-shrink-0 bg-[#0a0a0a] border border-[#333] rounded p-3 mb-4 text-sm">
        {loading ? (
          <div className="flex items-center gap-2 text-[#888]">
            <span className="w-3 h-3 border border-[#4488ff] border-t-transparent rounded-full animate-spin" />
            <span>Loading positions...</span>
          </div>
        ) : error ? (
          <div className="text-[#ff8844]">{error}</div>
        ) : positionData ? (
          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-[#888]">Room:</span>
              <span className="text-[#eee]">{positionData.room}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#888]">Entries:</span>
              <span className="text-[#eee]">{positionData.entries.length.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#888]">Start tick:</span>
              <span className="text-[#eee]">{positionData.startTick.toLocaleString()}</span>
            </div>
          </div>
        ) : (
          <div className="text-[#666]">No position data available</div>
        )}

        <button
          type="button"
          onClick={loadPositions}
          disabled={loading}
          className="mt-3 w-full px-3 py-1 text-sm bg-[#222] border border-[#444] rounded hover:bg-[#333] disabled:opacity-50 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Role filter */}
      <div className="flex-shrink-0 mb-4">
        <h4 className="text-xs text-[#888] uppercase tracking-wider mb-2">Filter by Role</h4>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setSelectedRole('ALL')}
            className={`px-2 py-1 text-xs rounded border transition-colors ${
              selectedRole === 'ALL'
                ? 'bg-[#4488ff] border-[#4488ff] text-white'
                : 'bg-[#222] border-[#444] text-[#888] hover:bg-[#333]'
            }`}
          >
            All
          </button>
          {availableRoles.map(role => {
            const config = ROLE_ABBREV[role];
            return (
              <button
                key={role}
                type="button"
                onClick={() => setSelectedRole(role)}
                className={`px-2 py-1 text-xs rounded border transition-colors ${
                  selectedRole === role
                    ? 'border-current'
                    : 'bg-[#222] border-[#444] hover:bg-[#333]'
                }`}
                style={{
                  color: config?.color || '#888',
                  borderColor: selectedRole === role ? config?.color || '#888' : undefined,
                  backgroundColor: selectedRole === role ? `${config?.color || '#888'}22` : undefined,
                }}
              >
                {role}
              </button>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="flex-1 overflow-y-auto">
        <h4 className="text-xs text-[#888] uppercase tracking-wider mb-2">Legend</h4>
        <div className="grid grid-cols-2 gap-1 text-xs">
          {Object.entries(ROLE_ABBREV).map(([abbrev, config]) => (
            <div key={abbrev} className="flex items-center gap-2">
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: config.color }}
              />
              <span className="text-[#888]">{abbrev}</span>
              <span className="text-[#666] truncate">{config.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
