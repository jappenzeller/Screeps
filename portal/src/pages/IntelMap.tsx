import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Header } from '../components/layout/Header';
import { FilterPanel } from '../components/intel/FilterPanel';
import { RoomDetail } from '../components/intel/RoomDetail';
import { RoomGrid } from '../components/intel/RoomGrid';
import { useApi } from '../hooks/useApi';
import { fetchAllIntel, fetchCandidates, fetchEnemies } from '../api/intel';
import { fetchColonies } from '../api/colonies';
import type { IntelResponse, CandidateResponse, EnemyResponse, IntelFilters, RoomIntel } from '../types/intel';
import type { ColoniesResponse } from '../api/colonies';
import { POLL_INTERVALS } from '../utils/constants';
import { getRoomType } from '../utils/roomCoords';

const DEFAULT_FILTERS: IntelFilters = {
  roomTypes: new Set(['normal', 'sourceKeeper', 'center', 'highway', 'highwayIntersection']),
  minSources: 0,
  maxSources: 99,
  mineralFilter: null,
  showOwnedOnly: false,
  showHostileOnly: false,
  showCandidates: false,
  showEnemyZones: false,
};

export function IntelMap() {
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState<IntelFilters>(DEFAULT_FILTERS);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);

  // Handle focus query parameter
  useEffect(() => {
    const focusRoom = searchParams.get('focus');
    if (focusRoom) {
      setSelectedRoom(focusRoom);
    }
  }, [searchParams]);

  // Fetch intel data
  const {
    data: intelData,
    loading: intelLoading,
    error: intelError,
  } = useApi<IntelResponse>(() => fetchAllIntel(), [], { pollInterval: POLL_INTERVALS.ANALYSIS });

  // Fetch colonies for colony list
  const { data: coloniesData } = useApi<ColoniesResponse>(
    () => fetchColonies(),
    [],
    { pollInterval: POLL_INTERVALS.COLONIES }
  );

  // Fetch expansion candidates (only when overlay is enabled)
  const { data: candidatesData } = useApi<CandidateResponse>(
    () => fetchCandidates(),
    [],
    { pollInterval: POLL_INTERVALS.ANALYSIS, enabled: filters.showCandidates }
  );

  // Fetch enemy zones (only when overlay is enabled)
  const { data: enemiesData } = useApi<EnemyResponse>(
    () => fetchEnemies(),
    [],
    { pollInterval: POLL_INTERVALS.ANALYSIS, enabled: filters.showEnemyZones }
  );

  // Extract data
  const rooms = intelData?.rooms ?? {};
  const colonies = coloniesData?.colonies.map((c) => c.roomName) ?? [];
  const candidates = candidatesData?.candidates ?? [];
  const enemies = enemiesData?.enemies ?? [];

  // Calculate filter stats
  const stats = useMemo(() => {
    const totalRooms = Object.keys(rooms).length;
    let filteredRooms = 0;
    let ownedRooms = 0;
    let hostileRooms = 0;

    for (const room of Object.values(rooms)) {
      const roomType = room.roomType || getRoomType(room.roomName);

      // Apply same filters as RoomGrid
      if (!filters.roomTypes.has(roomType)) continue;
      if (room.sources.length < filters.minSources) continue;
      if (room.sources.length > filters.maxSources) continue;
      if (filters.mineralFilter && filters.mineralFilter !== 'any') {
        if (!room.mineral || room.mineral.mineralType !== filters.mineralFilter) continue;
      }
      if (filters.showOwnedOnly && room.owner !== 'Montblanc0') continue;
      if (filters.showHostileOnly && (!room.isOwned || room.owner === 'Montblanc0')) continue;

      filteredRooms++;
      if (room.owner === 'Montblanc0') ownedRooms++;
      if (room.isOwned && room.owner !== 'Montblanc0') hostileRooms++;
    }

    return { totalRooms, filteredRooms, ownedRooms, hostileRooms };
  }, [rooms, filters]);

  // Get selected room details
  const selectedRoomData: RoomIntel | null = selectedRoom ? rooms[selectedRoom] ?? null : null;
  const selectedCandidate = selectedRoom
    ? candidates.find((c) => c.roomName === selectedRoom) ?? null
    : null;

  return (
    <div className="flex flex-col h-full">
      <Header title="Intel Map" />

      <div className="flex-1 flex bg-[#111] overflow-hidden">
        {/* Left Panel - Filters */}
        <div className="w-72 flex-shrink-0 p-4 border-r border-[#333] overflow-y-auto">
          <h3 className="text-sm font-medium text-[#888] mb-3 uppercase tracking-wider">Filters</h3>
          <FilterPanel filters={filters} onChange={setFilters} stats={stats} />
        </div>

        {/* Center - Map Canvas */}
        <div className="flex-1 relative">
          {intelLoading && Object.keys(rooms).length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#111]">
              <div className="w-8 h-8 border-2 border-[#4488ff] border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {intelError && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#111]">
              <div className="text-center">
                <p className="text-[#ff4444] mb-2">Failed to load intel data</p>
                <p className="text-[#888] text-sm">{intelError.message}</p>
              </div>
            </div>
          )}

          {!intelError && Object.keys(rooms).length > 0 && (
            <RoomGrid
              rooms={rooms}
              colonies={colonies}
              candidates={candidates}
              enemies={enemies}
              filters={filters}
              selectedRoom={selectedRoom}
              onSelectRoom={setSelectedRoom}
            />
          )}

          {!intelLoading && !intelError && Object.keys(rooms).length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#111]">
              <div className="text-center">
                <p className="text-[#888] mb-2">No intel data available</p>
                <p className="text-[#666] text-sm">
                  Run scouts to collect room data
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Right Panel - Room Details */}
        <div className="w-80 flex-shrink-0 p-4 border-l border-[#333] overflow-y-auto">
          <h3 className="text-sm font-medium text-[#888] mb-3 uppercase tracking-wider">
            Room Details
          </h3>
          <RoomDetail
            room={selectedRoomData}
            candidate={selectedCandidate}
            onClose={() => setSelectedRoom(null)}
          />

          {/* Legend */}
          <div className="mt-6">
            <h3 className="text-sm font-medium text-[#888] mb-3 uppercase tracking-wider">Legend</h3>
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 rounded" style={{ backgroundColor: '#004400' }} />
                <span className="text-[#888]">My Colony</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 rounded" style={{ backgroundColor: '#003300' }} />
                <span className="text-[#888]">My Room</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 rounded" style={{ backgroundColor: '#330000' }} />
                <span className="text-[#888]">Hostile Room</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 rounded" style={{ backgroundColor: '#002244' }} />
                <span className="text-[#888]">My Reserved</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 rounded" style={{ backgroundColor: '#332200' }} />
                <span className="text-[#888]">Source Keeper</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 rounded" style={{ backgroundColor: '#1a1a1a' }} />
                <span className="text-[#888]">Highway</span>
              </div>
              <div className="flex items-center gap-2 mt-3">
                <span className="w-2 h-2 rounded-full bg-[#ffcc00]" />
                <span className="text-[#888]">Source</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#50d050]" />
                <span className="text-[#888]">Mineral</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#00ff88]">★</span>
                <span className="text-[#888]">Colony</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
