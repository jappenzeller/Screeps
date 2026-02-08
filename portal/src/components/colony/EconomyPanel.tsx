import type { ColonyEconomyMetrics, LinkDetail, ContainerDetail, SpawnDetail } from '../../types/colony';
import { formatNumber } from '../../utils/formatting';

interface EconomyPanelProps {
  economy: ColonyEconomyMetrics | null;
  links: LinkDetail[] | null;
  containers: ContainerDetail[] | null;
  spawns: SpawnDetail[] | null;
  loading?: boolean;
  error?: Error | null;
}

export function EconomyPanel({ economy, links, containers, spawns, loading, error }: EconomyPanelProps) {
  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-20 bg-[#222] rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[#331111] border border-[#ff4444] rounded-lg p-4">
        <p className="text-[#ff4444]">Failed to load economy data: {error.message}</p>
      </div>
    );
  }

  const trendIcon = economy?.storageTrend === 'rising' ? '↑' : economy?.storageTrend === 'falling' ? '↓' : '→';
  const trendColor = economy?.storageTrend === 'rising' ? '#00ff88' : economy?.storageTrend === 'falling' ? '#ff4444' : '#888';

  return (
    <div className="space-y-6">
      {/* Rate Metrics */}
      <div>
        <h4 className="text-sm font-medium text-[#888] mb-3 uppercase tracking-wider">Energy Rates (per tick)</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <RateCard label="Harvest" value={economy?.harvestRate ?? 0} color="#00ff88" />
          <RateCard label="Upgrade" value={economy?.upgradeRate ?? 0} color="#4488ff" />
          <RateCard label="Build" value={economy?.buildRate ?? 0} color="#ff8844" />
          <RateCard label="Repair" value={economy?.repairRate ?? 0} color="#ffcc00" />
          <RateCard label="Spawn" value={economy?.spawnRate ?? 0} color="#aa88ff" />
          <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-3">
            <div className="text-xs text-[#888] mb-1">Storage</div>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold text-[#eee]">
                {formatNumber(economy?.storageLevel ?? 0)}
              </span>
              <span style={{ color: trendColor }} className="text-lg">
                {trendIcon}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Links */}
      {links && links.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-[#888] mb-3 uppercase tracking-wider">Links</h4>
          <div className="space-y-2">
            {links.map((link) => (
              <LinkRow key={link.id} link={link} />
            ))}
          </div>
        </div>
      )}

      {/* Containers */}
      {containers && containers.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-[#888] mb-3 uppercase tracking-wider">Containers</h4>
          <div className="space-y-2">
            {containers.map((container) => (
              <ContainerRow key={container.id} container={container} />
            ))}
          </div>
        </div>
      )}

      {/* Spawns */}
      {spawns && spawns.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-[#888] mb-3 uppercase tracking-wider">Spawns</h4>
          <div className="space-y-2">
            {spawns.map((spawn) => (
              <SpawnRow key={spawn.name} spawn={spawn} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RateCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-3">
      <div className="text-xs text-[#888] mb-1">{label}</div>
      <div className="text-xl font-bold" style={{ color }}>
        {value.toFixed(1)}
      </div>
    </div>
  );
}

function LinkRow({ link }: { link: LinkDetail }) {
  const energyPercent = link.energyCapacity > 0 ? (link.energy / link.energyCapacity) * 100 : 0;
  const typeLabel = link.type === 'source' ? 'Source Link'
    : link.type === 'controller' ? 'Controller Link'
    : link.type === 'storage' ? 'Storage Link'
    : 'Link';

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded px-3 py-2 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-[#eee]">{typeLabel}</span>
        <span className="text-xs text-[#888]">({link.pos.x}, {link.pos.y})</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="w-24 h-1.5 bg-[#333] rounded-full overflow-hidden">
          <div
            className="h-full bg-[#88ccff]"
            style={{ width: `${energyPercent}%` }}
          />
        </div>
        <span className="text-xs text-[#888] w-20 text-right">
          {link.energy}/{link.energyCapacity}
        </span>
        {link.cooldown > 0 && (
          <span className="text-xs text-[#ffcc00]">cd: {link.cooldown}</span>
        )}
      </div>
    </div>
  );
}

function ContainerRow({ container }: { container: ContainerDetail }) {
  const energyPercent = 2000 > 0 ? (container.energy / 2000) * 100 : 0;
  const hitsPercent = container.hitsMax > 0 ? (container.hits / container.hitsMax) * 100 : 100;
  const hitsColor = hitsPercent > 50 ? '#00ff88' : hitsPercent > 25 ? '#ffcc00' : '#ff4444';

  const label = container.nearSource ? 'Source Container'
    : container.nearController ? 'Controller Container'
    : 'Container';

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded px-3 py-2 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-[#eee]">{label}</span>
        <span className="text-xs text-[#888]">({container.pos.x}, {container.pos.y})</span>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-16 h-1.5 bg-[#333] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#ffcc00]"
              style={{ width: `${energyPercent}%` }}
            />
          </div>
          <span className="text-xs text-[#888]">{formatNumber(container.energy)}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs" style={{ color: hitsColor }}>
            {formatNumber(container.hits)}/{formatNumber(container.hitsMax)}
          </span>
          {hitsPercent < 50 && <span className="text-[#ffcc00]">⚠️</span>}
        </div>
      </div>
    </div>
  );
}

function SpawnRow({ spawn }: { spawn: SpawnDetail }) {
  const energyPercent = 300 > 0 ? (spawn.energy / 300) * 100 : 0;

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded px-3 py-2 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-[#ffcc00]">{spawn.name}</span>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-16 h-1.5 bg-[#333] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#ffcc00]"
              style={{ width: `${energyPercent}%` }}
            />
          </div>
          <span className="text-xs text-[#888]">{spawn.energy}/300</span>
        </div>
        {spawn.spawning ? (
          <span className="text-xs text-[#00ff88]">Spawning: {spawn.spawning}</span>
        ) : (
          <span className="text-xs text-[#666]">Idle</span>
        )}
      </div>
    </div>
  );
}
