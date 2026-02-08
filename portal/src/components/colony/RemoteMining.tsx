import type { RemoteMiningExport, RemoteRoomExport } from '../../types/colony';

interface RemoteMiningProps {
  remoteMining: RemoteMiningExport | null;
  loading?: boolean;
  error?: Error | null;
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: '#00ff88',
  NO_MINERS: '#ffcc00',
  HOSTILE: '#ff4444',
  NO_INTEL: '#888888',
  RESERVED_OTHER: '#ff8844',
  OWNED: '#ff4444',
};

export function RemoteMining({ remoteMining, loading, error }: RemoteMiningProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-32 bg-[#222] rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[#331111] border border-[#ff4444] rounded-lg p-4">
        <p className="text-[#ff4444]">Failed to load remote mining data: {error.message}</p>
      </div>
    );
  }

  if (!remoteMining || !remoteMining.targetRooms || remoteMining.targetRooms.length === 0) {
    return (
      <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-6 text-center">
        <p className="text-[#888]">No remote mining configured</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex gap-4 text-sm">
        <span className="text-[#888]">
          Total: <span className="text-[#eee]">{remoteMining.totalMiners}</span> miners,{' '}
          <span className="text-[#eee]">{remoteMining.totalHaulers}</span> haulers,{' '}
          <span className="text-[#eee]">{remoteMining.totalReservers}</span> reservers
        </span>
      </div>

      {/* Remote Room Cards */}
      <div className="space-y-3">
        {remoteMining.targetRooms.map((room) => (
          <RemoteRoomCard key={room.roomName} room={room} />
        ))}
      </div>
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
              <span className="text-[#aa88ff]">
                Reserved by {room.reservation.username} ({room.reservation.ticksToEnd} ticks)
              </span>
            ) : (
              <span className="text-[#ffcc00]">No reservation</span>
            )}
          </div>
        </div>
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
