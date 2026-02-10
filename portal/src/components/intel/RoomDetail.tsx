import { Link } from 'react-router-dom';
import type { RoomIntel, ScoredCandidate } from '../../types/intel';
import { formatFreshness } from '../../utils/formatting';

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
};

export function RoomDetail({ room, candidate, onClose }: RoomDetailProps) {
  if (!room) {
    return (
      <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
        <p className="text-[#888] text-sm">Select a room to view details</p>
      </div>
    );
  }

  const roomType = room.roomType || 'normal';
  const lastScannedAgo = room.lastScanned
    ? Math.floor((Date.now() - room.lastScanned) / 1000)
    : null;
  const myUsername = 'Montblanc0';

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
        {/* Ownership Status - using owner field directly, no isOwned boolean */}
        {room.owner && (
          <div>
            <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Owner</div>
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`px-2 py-1 text-xs rounded ${
                  room.owner === myUsername
                    ? 'bg-[#00ff8833] text-[#00ff88]'
                    : 'bg-[#ff444433] text-[#ff4444]'
                }`}
              >
                {room.owner}
              </span>
              {room.ownerRcl && (
                <span className="text-xs text-[#666]">RCL {room.ownerRcl}</span>
              )}
              {room.owner === myUsername && (
                <Link
                  to={`/colony/${room.roomName}`}
                  className="px-2 py-1 text-xs text-[#4488ff] hover:text-[#66aaff] transition-colors"
                >
                  View Colony →
                </Link>
              )}
            </div>
          </div>
        )}

        {/* Reservation - using reservation object, no isReserved boolean */}
        {room.reservation && (
          <div>
            <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Reserved</div>
            <div className="flex items-center gap-2">
              <span
                className={`px-2 py-1 text-xs rounded ${
                  room.reservation.username === myUsername
                    ? 'bg-[#4488ff33] text-[#4488ff]'
                    : 'bg-[#ffcc0033] text-[#ffcc00]'
                }`}
              >
                {room.reservation.username}
              </span>
              <span className="text-xs text-[#666]">
                {room.reservation.ticksToEnd} ticks
              </span>
            </div>
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

        {/* Mineral - using mineral.type, not mineral.mineralType */}
        {room.mineral && (
          <div>
            <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Mineral</div>
            <div className="flex items-center gap-2">
              <span
                className="px-2 py-1 text-sm font-bold rounded"
                style={{
                  backgroundColor: (MINERAL_COLORS[room.mineral.type] || '#888') + '33',
                  color: MINERAL_COLORS[room.mineral.type] || '#888',
                }}
              >
                {room.mineral.type}
              </span>
              <span className="text-xs text-[#666]">
                ({room.mineral.pos.x}, {room.mineral.pos.y})
              </span>
            </div>
          </div>
        )}

        {/* Terrain */}
        {room.terrain && (
          <div>
            <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Terrain</div>
            <div className="flex gap-3 text-xs">
              <span className="text-[#aaa]">Plains: {room.terrain.plainPercent}%</span>
              <span className="text-[#886622]">Swamp: {room.terrain.swampPercent}%</span>
              <span className="text-[#666]">Wall: {room.terrain.wallPercent}%</span>
            </div>
          </div>
        )}

        {/* Hostiles - room.hostiles is a number, not array */}
        {room.hostiles > 0 && (
          <div>
            <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Hostiles</div>
            <span className="text-[#ff4444]">{room.hostiles} hostile creeps</span>
            {room.hostileDetails && room.hostileDetails.length > 0 && (
              <div className="space-y-1 mt-1">
                {room.hostileDetails.map((h) => (
                  <div key={h.id} className="flex items-center justify-between text-xs">
                    <span className="text-[#ff4444]">{h.owner}</span>
                    <span className="text-[#888]">
                      {h.bodyParts} parts {h.hasCombat ? '⚔' : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Hostile Structures - using hostileStructures, not structures[] */}
        {room.hostileStructures && (room.hostileStructures.towers > 0 || room.hostileStructures.spawns > 0) && (
          <div>
            <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Hostile Structures</div>
            <div className="flex flex-wrap gap-2 text-xs">
              {room.hostileStructures.towers > 0 && (
                <span className="px-2 py-0.5 bg-[#ff444433] text-[#ff4444] rounded">
                  Towers: {room.hostileStructures.towers}
                </span>
              )}
              {room.hostileStructures.spawns > 0 && (
                <span className="px-2 py-0.5 bg-[#ff444433] text-[#ff4444] rounded">
                  Spawns: {room.hostileStructures.spawns}
                </span>
              )}
              {room.hostileStructures.hasTerminal && (
                <span className="px-2 py-0.5 bg-[#ff444433] text-[#ff4444] rounded">
                  Terminal
                </span>
              )}
            </div>
          </div>
        )}

        {/* Invader Core - using invaderCore, not hasInvaderCore */}
        {room.invaderCore && (
          <div className="flex items-center gap-2 text-[#ff4444]">
            <span className="text-lg">⚠</span>
            <span className="text-sm">Invader Core Present</span>
          </div>
        )}

        {/* Distance from Home */}
        {room.distanceFromHome !== undefined && room.distanceFromHome > 0 && (
          <div>
            <div className="text-xs text-[#888] mb-1 uppercase tracking-wider">Distance</div>
            <div className="text-sm text-[#eee]">
              {room.distanceFromHome} rooms from home
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
              {candidate.nearestColony && (
                <div>
                  <span className="text-[#888]">Near: </span>
                  <span className="text-[#eee]">{candidate.nearestColony}</span>
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
