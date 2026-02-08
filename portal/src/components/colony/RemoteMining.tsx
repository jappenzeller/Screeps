import { useApi } from '../../hooks/useApi';
import { fetchColonyRemotes } from '../../api/colonies';
import type { RemotesResponse, RemoteRoomExport, AdjacentRoomInfo } from '../../types/colony';
import { POLL_INTERVALS } from '../../utils/constants';
import { FreshnessIndicator } from '../layout/FreshnessIndicator';

interface RemoteMiningProps {
  roomName: string;
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: '#00ff88',
  NO_MINERS: '#ffcc00',
  HOSTILE: '#ff4444',
  NO_INTEL: '#888888',
  RESERVED_OTHER: '#ff8844',
  OWNED: '#ff4444',
};

export function RemoteMining({ roomName }: RemoteMiningProps) {
  const {
    data,
    meta,
    loading,
    error,
  } = useApi<RemotesResponse>(
    () => fetchColonyRemotes(roomName),
    [roomName],
    { pollInterval: POLL_INTERVALS.COLONY_DETAIL, enabled: !!roomName }
  );

  if (loading && !data) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-32 bg-[#222] rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="bg-[#331111] border border-[#ff4444] rounded-lg p-4">
        <p className="text-[#ff4444]">Failed to load remote mining data: {error.message}</p>
      </div>
    );
  }

  const remoteMining = data?.remoteMining;
  const adjacentRooms = data?.adjacentRooms;
  const hasRemotes = remoteMining?.targetRooms && remoteMining.targetRooms.length > 0;

  return (
    <div className="space-y-6">
      {/* Header with freshness */}
      {meta?.freshness !== undefined && (
        <div className="flex justify-end">
          <FreshnessIndicator freshness={meta.freshness} source={meta.source} size="sm" />
        </div>
      )}

      {/* Active Remote Mining */}
      {hasRemotes ? (
        <>
          {/* Summary */}
          <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
            <div className="flex flex-wrap gap-6 text-sm">
              <div>
                <span className="text-[#888]">Miners: </span>
                <span className="text-lg font-bold text-[#00ff88]">{remoteMining!.totalMiners}</span>
              </div>
              <div>
                <span className="text-[#888]">Haulers: </span>
                <span className="text-lg font-bold text-[#ff8800]">{remoteMining!.totalHaulers}</span>
              </div>
              <div>
                <span className="text-[#888]">Reservers: </span>
                <span className="text-lg font-bold text-[#aa88ff]">{remoteMining!.totalReservers}</span>
              </div>
              <div>
                <span className="text-[#888]">Remote Rooms: </span>
                <span className="text-lg font-bold text-[#4488ff]">{remoteMining!.targetRooms!.length}</span>
              </div>
            </div>
          </div>

          {/* Remote Room Cards */}
          <div>
            <h4 className="text-sm font-medium text-[#888] mb-3 uppercase tracking-wider">Active Remote Rooms</h4>
            <div className="space-y-3">
              {remoteMining!.targetRooms!.map((room) => (
                <RemoteRoomCard key={room.roomName} room={room} />
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-6 text-center">
          <p className="text-[#888]">No remote mining configured</p>
        </div>
      )}

      {/* Adjacent Rooms (potential remotes) */}
      {adjacentRooms && adjacentRooms.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-[#888] mb-3 uppercase tracking-wider">Adjacent Rooms</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {adjacentRooms.map((room) => (
              <AdjacentRoomCard key={room.roomName} room={room} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RemoteRoomCard({ room }: { room: RemoteRoomExport }) {
  const statusColor = STATUS_COLORS[room.status] ?? '#888888';

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-[#eee]">{room.roomName}</span>
          <span className="text-xs text-[#888]">{room.sources} source{room.sources !== 1 ? 's' : ''}</span>
        </div>
        <span
          className="px-2 py-0.5 rounded text-xs font-medium"
          style={{ backgroundColor: statusColor + '33', color: statusColor }}
        >
          {room.status.replace('_', ' ')}
        </span>
      </div>

      {/* Creep Info */}
      <div className="space-y-2 text-sm">
        {/* Miners */}
        <div className="flex items-start gap-2">
          <span className="text-[#888] w-16">Miners:</span>
          <div className="flex-1">
            {room.miners.length === 0 ? (
              <span className="text-[#666]">None</span>
            ) : (
              <div className="flex flex-wrap gap-2">
                {room.miners.map((m) => (
                  <CreepBadge
                    key={m.name}
                    name={m.name}
                    ttl={m.ticksToLive}
                    spawning={m.spawning}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Haulers */}
        <div className="flex items-start gap-2">
          <span className="text-[#888] w-16">Haulers:</span>
          <div className="flex-1">
            {room.haulers.length === 0 ? (
              <span className="text-[#666]">None</span>
            ) : (
              <div className="flex flex-wrap gap-2">
                {room.haulers.map((h) => (
                  <CreepBadge
                    key={h.name}
                    name={h.name}
                    ttl={h.ticksToLive}
                    spawning={h.spawning}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Reserver */}
        <div className="flex items-start gap-2">
          <span className="text-[#888] w-16">Reserver:</span>
          <div className="flex-1">
            {room.reserver ? (
              <CreepBadge
                name={room.reserver.name}
                ttl={room.reserver.ticksToLive}
                spawning={room.reserver.spawning}
              />
            ) : room.reservation ? (
              <div className="flex items-center gap-2">
                <span className="text-[#aa88ff]">
                  Reserved by {room.reservation.username}
                </span>
                <span className="text-xs text-[#888]">({room.reservation.ticksToEnd} ticks)</span>
              </div>
            ) : (
              <span className="text-[#ffcc00]">No reservation</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AdjacentRoomCard({ room }: { room: AdjacentRoomInfo }) {
  const isValidTarget = room.isValidRemoteTarget;
  const hasHostiles = room.hostiles > 0;
  const isOwned = !!room.owner;
  const isReservedByOther = room.reservation && room.reservation.username !== 'Montblanc0';

  let statusText = 'Available';
  let statusColor = '#00ff88';

  if (isOwned) {
    statusText = `Owned: ${room.owner}`;
    statusColor = '#ff4444';
  } else if (room.hasKeepers) {
    statusText = 'Source Keepers';
    statusColor = '#ff8844';
  } else if (isReservedByOther) {
    statusText = `Reserved: ${room.reservation!.username}`;
    statusColor = '#ffcc00';
  } else if (hasHostiles) {
    statusText = `Hostiles: ${room.hostiles}`;
    statusColor = '#ff4444';
  } else if (room.hasInvaderCore) {
    statusText = 'Invader Core';
    statusColor = '#ff4444';
  } else if (!isValidTarget) {
    statusText = 'Not viable';
    statusColor = '#888888';
  }

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-bold text-[#eee]">{room.roomName}</span>
          <span className="text-xs px-1.5 py-0.5 bg-[#222] rounded text-[#888]">{room.direction}</span>
        </div>
        <span className="text-xs" style={{ color: statusColor }}>
          {statusText}
        </span>
      </div>

      <div className="flex items-center gap-4 text-xs text-[#888]">
        <span className="text-[#ffcc00]">{room.sources} source{room.sources !== 1 ? 's' : ''}</span>
        {room.reservation && room.reservation.username === 'Montblanc0' && (
          <span className="text-[#aa88ff]">Reserved ({room.reservation.ticksToEnd})</span>
        )}
        {room.lastScanAge > 0 && (
          <span>Scanned {Math.floor(room.lastScanAge / 60)}m ago</span>
        )}
      </div>
    </div>
  );
}

function CreepBadge({ name, ttl, spawning }: { name: string; ttl: number; spawning?: boolean }) {
  const ttlColor = ttl > 500 ? '#00ff88' : ttl > 200 ? '#ffcc00' : '#ff4444';
  const shortName = name.length > 12 ? name.slice(0, 10) + '...' : name;

  return (
    <span className="inline-flex items-center gap-1 bg-[#222] px-2 py-0.5 rounded text-xs">
      <span className="text-[#ccc]" title={name}>{shortName}</span>
      {spawning ? (
        <span className="text-[#ffcc00]">spawning</span>
      ) : (
        <span style={{ color: ttlColor }}>TTL:{ttl}</span>
      )}
    </span>
  );
}
