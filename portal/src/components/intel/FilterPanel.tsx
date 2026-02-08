import type { IntelFilters, MineralConstant, RoomIntel } from '../../types/intel';

interface FilterPanelProps {
  filters: IntelFilters;
  onChange: (filters: IntelFilters) => void;
  stats: {
    totalRooms: number;
    filteredRooms: number;
    ownedRooms: number;
    hostileRooms: number;
  };
}

const ROOM_TYPES: Array<{ value: RoomIntel['roomType']; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'sourceKeeper', label: 'Source Keeper' },
  { value: 'center', label: 'Center' },
  { value: 'highway', label: 'Highway' },
  { value: 'highwayIntersection', label: 'Intersection' },
];

const MINERALS: Array<{ value: MineralConstant | 'any'; label: string; color: string }> = [
  { value: 'any', label: 'Any', color: '#888' },
  { value: 'H', label: 'Hydrogen', color: '#989898' },
  { value: 'O', label: 'Oxygen', color: '#989898' },
  { value: 'U', label: 'Utrium', color: '#50d050' },
  { value: 'L', label: 'Lemergium', color: '#50d0d0' },
  { value: 'K', label: 'Keanium', color: '#a050d0' },
  { value: 'Z', label: 'Zynthium', color: '#ffd850' },
  { value: 'X', label: 'Catalyst', color: '#ff6050' },
];

export function FilterPanel({ filters, onChange, stats }: FilterPanelProps) {
  const toggleRoomType = (type: RoomIntel['roomType']) => {
    const newTypes = new Set(filters.roomTypes);
    if (newTypes.has(type)) {
      newTypes.delete(type);
    } else {
      newTypes.add(type);
    }
    onChange({ ...filters, roomTypes: newTypes });
  };

  const setMineral = (mineral: MineralConstant | 'any' | null) => {
    onChange({ ...filters, mineralFilter: mineral });
  };

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4 space-y-4">
      {/* Stats Summary */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-[#888]">
          Showing <span className="text-[#eee] font-medium">{stats.filteredRooms}</span> of{' '}
          <span className="text-[#888]">{stats.totalRooms}</span> rooms
        </span>
        <div className="flex gap-3 text-xs">
          <span className="text-[#00ff88]">{stats.ownedRooms} owned</span>
          <span className="text-[#ff4444]">{stats.hostileRooms} hostile</span>
        </div>
      </div>

      {/* Room Type Filters */}
      <div>
        <div className="text-xs text-[#888] mb-2 uppercase tracking-wider">Room Types</div>
        <div className="flex flex-wrap gap-2">
          {ROOM_TYPES.map(({ value, label }) => {
            const isActive = filters.roomTypes.has(value);
            return (
              <button
                type="button"
                key={value}
                onClick={() => toggleRoomType(value)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  isActive
                    ? 'bg-[#4488ff33] text-[#4488ff] border border-[#4488ff]'
                    : 'bg-[#222] text-[#888] border border-[#333] hover:border-[#555]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Source Count Filter */}
      <div>
        <div className="text-xs text-[#888] mb-2 uppercase tracking-wider">Sources</div>
        <div className="flex gap-2">
          {[1, 2].map((count) => {
            const isMin = filters.minSources === count;
            return (
              <button
                type="button"
                key={count}
                onClick={() =>
                  onChange({
                    ...filters,
                    minSources: isMin ? 0 : count,
                    maxSources: isMin ? 99 : count,
                  })
                }
                className={`px-3 py-1 text-xs rounded transition-colors ${
                  isMin
                    ? 'bg-[#00ff8833] text-[#00ff88] border border-[#00ff88]'
                    : 'bg-[#222] text-[#888] border border-[#333] hover:border-[#555]'
                }`}
              >
                {count} source{count > 1 ? 's' : ''}
              </button>
            );
          })}
        </div>
      </div>

      {/* Mineral Filter */}
      <div>
        <div className="text-xs text-[#888] mb-2 uppercase tracking-wider">Mineral</div>
        <div className="flex flex-wrap gap-1">
          {MINERALS.map(({ value, label, color }) => {
            const isActive = filters.mineralFilter === value;
            return (
              <button
                type="button"
                key={value}
                onClick={() => setMineral(isActive ? null : value)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  isActive
                    ? 'border'
                    : 'bg-[#222] text-[#888] border border-[#333] hover:border-[#555]'
                }`}
                style={
                  isActive
                    ? { backgroundColor: color + '33', color, borderColor: color }
                    : undefined
                }
                title={label}
              >
                {value === 'any' ? 'Any' : value}
              </button>
            );
          })}
        </div>
      </div>

      {/* Ownership Filters */}
      <div>
        <div className="text-xs text-[#888] mb-2 uppercase tracking-wider">Ownership</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onChange({ ...filters, showOwnedOnly: !filters.showOwnedOnly })}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              filters.showOwnedOnly
                ? 'bg-[#00ff8833] text-[#00ff88] border border-[#00ff88]'
                : 'bg-[#222] text-[#888] border border-[#333] hover:border-[#555]'
            }`}
          >
            My Rooms
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...filters, showHostileOnly: !filters.showHostileOnly })}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              filters.showHostileOnly
                ? 'bg-[#ff444433] text-[#ff4444] border border-[#ff4444]'
                : 'bg-[#222] text-[#888] border border-[#333] hover:border-[#555]'
            }`}
          >
            Hostile
          </button>
        </div>
      </div>

      {/* Overlay Toggles */}
      <div>
        <div className="text-xs text-[#888] mb-2 uppercase tracking-wider">Overlays</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onChange({ ...filters, showCandidates: !filters.showCandidates })}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              filters.showCandidates
                ? 'bg-[#4488ff33] text-[#4488ff] border border-[#4488ff]'
                : 'bg-[#222] text-[#888] border border-[#333] hover:border-[#555]'
            }`}
          >
            Expansion Candidates
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...filters, showEnemyZones: !filters.showEnemyZones })}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              filters.showEnemyZones
                ? 'bg-[#ff444433] text-[#ff4444] border border-[#ff4444]'
                : 'bg-[#222] text-[#888] border border-[#333] hover:border-[#555]'
            }`}
          >
            Enemy Zones
          </button>
        </div>
      </div>

      {/* Reset Button */}
      <button
        type="button"
        onClick={() =>
          onChange({
            roomTypes: new Set(['normal', 'sourceKeeper', 'center', 'highway', 'highwayIntersection']),
            minSources: 0,
            maxSources: 99,
            mineralFilter: null,
            showOwnedOnly: false,
            showHostileOnly: false,
            showCandidates: false,
            showEnemyZones: false,
          })
        }
        className="w-full px-3 py-1.5 text-xs text-[#888] bg-[#222] border border-[#333] rounded hover:border-[#555] hover:text-[#eee] transition-colors"
      >
        Reset Filters
      </button>
    </div>
  );
}
