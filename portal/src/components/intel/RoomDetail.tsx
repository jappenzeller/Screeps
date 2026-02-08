import { Link } from 'react-router-dom';
import type { RoomIntel, ScoredCandidate } from '../../types/intel';
import { formatFreshness } from '../../utils/formatting';
import { getRoomType } from '../../utils/roomCoords';

interface RoomDetailProps {
  room: RoomIntel | null;
  candidate: ScoredCandidate | null;
  onClose: () => void;
}

const MINERAL_COLORS: Record<string, string> = {
  H: '#989898',
  O: '#989898',
  U: '#50d050',
  L: '#50d0d0',
  K: '#a050d0',
  Z: '#ffd850',
  X: '#ff6050',
};

const ROOM_TYPE_LABELS: Record<string, string> = {
  normal: 'Normal',
  sourceKeeper: 'Source Keeper',
  center: 'Center',
  highway: 'Highway',
  highwayIntersection: 'Intersection',
};

export function RoomDetail({ room, candidate, onClose }: RoomDetailProps) {
  if (!room) {
    return (
      <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
        <p className="text-[#888] text-sm">Select a room to view details</p>
      </div>
    );
  }

  const roomType = room.roomType || getRoomType(room.roomName);
  const lastScannedAgo = room.lastScanned
    ? Math.floor((Date.now() - room.lastScanned) / 1000)
    : null;

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#333] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-bold text-[#eee]">{room.roomName}</h3>
          <span className="px-2 py-0.5 text-xs rounded bg-[#222] text-[#888]">
            {ROOM_TYPE_LABELS[roomType] || roomType}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[#888] hover:text-[#eee] transition-colors"
        >
          ✕
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Ownership Status */}
        {(room.isOwned || room.isReserved) && (
          <div className="flex items-center gap-2 flex-wrap">
            {room.isOwned && (
              <span
                className={`px-2 py-1 text-xs rounded ${
                  room.owner === 'Montblanc0'
                    ? 'bg-[#00ff8833] text-[#00ff88]'
                    : 'bg-[#ff444433] text-[#ff4444]'
                }`}
              >
                Owned: {room.owner}
              </span>
            )}
            {room.isReserved && (
              <span
                className={`px-2 py-1 text-xs rounded ${
                  room.reservedBy === 'Montblanc0'
                    ? 'bg-[#4488ff33] text-[#4488ff]'
                    : 'bg-[#ffcc0033] text-[#ffcc00]'
                }`}
              >
                Reserved: {room.reservedBy}
              </span>
            )}
            {room.isOwned && room.owner === 'Montblanc0' && (
              <Link
                to={`/colony/${room.roomName}`}
                className="px-2 py-1 text-xs text-[#4488ff] hover:text-[#66aaff] transition-colors"
              >
                View Colony →
              </Link>
            )}
          </div>
        )}

        {/* Controller Info */}
        {room.controller && (
          <div>
            <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Controller</div>
            <div className="flex items-center gap-3">
              <span className="text-lg font-bold text-[#4488ff]">RCL {room.controller.level}</span>
              {room.controller.safeMode && (
                <span className="text-xs text-[#00ff88]">Safe Mode Active</span>
              )}
            </div>
            {room.controller.reservation && (
              <div className="text-xs text-[#888] mt-1">
                Reserved by {room.controller.reservation.username} ({room.controller.reservation.ticksToEnd} ticks)
              </div>
            )}
          </div>
        )}

        {/* Sources */}
        <div>
          <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Sources</div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-[#ffcc00]">{room.sources.length}</span>
            <span className="text-sm text-[#888]">
              ({room.sources.length * 3000} energy/regen)
            </span>
          </div>
          {room.sources.length > 0 && (
            <div className="text-xs text-[#666] mt-1">
              {room.sources.map((s, i) => (
                <span key={s.id}>
                  {i > 0 && ' · '}
                  ({s.pos.x}, {s.pos.y})
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Mineral */}
        {room.mineral && (
          <div>
            <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Mineral</div>
            <div className="flex items-center gap-2">
              <span
                className="px-2 py-1 text-sm font-bold rounded"
                style={{
                  backgroundColor: (MINERAL_COLORS[room.mineral.mineralType] || '#888') + '33',
                  color: MINERAL_COLORS[room.mineral.mineralType] || '#888',
                }}
              >
                {room.mineral.mineralType}
              </span>
              <span className="text-xs text-[#666]">
                ({room.mineral.pos.x}, {room.mineral.pos.y})
              </span>
            </div>
          </div>
        )}

        {/* Hostiles */}
        {room.hostiles && room.hostiles.length > 0 && (
          <div>
            <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Hostiles</div>
            <div className="space-y-1">
              {room.hostiles.map((h) => (
                <div key={h.owner} className="flex items-center justify-between text-sm">
                  <span className="text-[#ff4444]">{h.owner}</span>
                  <span className="text-[#888]">{h.count} creeps</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Structures */}
        {room.structures && room.structures.length > 0 && (
          <div>
            <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Structures</div>
            <div className="flex flex-wrap gap-1">
              {room.structures.map((s) => (
                <span
                  key={s.type}
                  className="px-2 py-0.5 text-xs bg-[#222] text-[#888] rounded"
                >
                  {s.type}: {s.count}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Invader Core */}
        {room.hasInvaderCore && (
          <div className="flex items-center gap-2 text-[#ff4444]">
            <span className="text-lg">⚠</span>
            <span className="text-sm">Invader Core Present</span>
          </div>
        )}

        {/* Distance to Colony */}
        {room.nearestColony && (
          <div>
            <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Nearest Colony</div>
            <div className="text-sm text-[#eee]">
              {room.nearestColony}{' '}
              <span className="text-[#888]">({room.distanceToColony} rooms away)</span>
            </div>
          </div>
        )}

        {/* Expansion Candidate Score */}
        {candidate && (
          <div className="border-t border-[#333] pt-4 mt-4">
            <div className="text-xs text-[#4488ff] mb-2 uppercase tracking-wider">
              Expansion Candidate
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-[#888]">Score: </span>
                <span className="text-[#4488ff] font-bold">{candidate.score.toFixed(1)}</span>
              </div>
              <div>
                <span className="text-[#888]">Threats: </span>
                <span className={candidate.threats > 0 ? 'text-[#ff4444]' : 'text-[#00ff88]'}>
                  {candidate.threats}
                </span>
              </div>
              {candidate.swampRatio !== undefined && (
                <div>
                  <span className="text-[#888]">Swamp: </span>
                  <span className="text-[#eee]">{Math.round(candidate.swampRatio * 100)}%</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Last Scanned */}
        {lastScannedAgo !== null && (
          <div className="text-xs text-[#666] pt-2 border-t border-[#333]">
            Last scanned: {formatFreshness(lastScannedAgo)}
          </div>
        )}
      </div>
    </div>
  );
}
