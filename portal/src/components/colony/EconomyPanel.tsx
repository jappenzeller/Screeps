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

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  CRITICAL: { bg: '#ff444433', text: '#ff4444' },
  STRUGGLING: { bg: '#ff884433', text: '#ff8844' },
  STABLE: { bg: '#ffcc0033', text: '#ffcc00' },
  THRIVING: { bg: '#00ff8833', text: '#00ff88' },
  SURPLUS: { bg: '#4488ff33', text: '#4488ff' },
};

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

  const statusConfig = economy?.status ? STATUS_COLORS[economy.status] : null;
  const netFlowPositive = (economy?.netFlow ?? 0) >= 0;

  return (
    <div className="space-y-6">
      {/* Economy Summary */}
      <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-4 mb-4">
          {/* Status Badge */}
          {economy?.status && statusConfig && (
            <span
              className="px-3 py-1 rounded-full text-sm font-medium"
              style={{ backgroundColor: statusConfig.bg, color: statusConfig.text }}
            >
              {economy.status}
            </span>
          )}
          {/* Health Score */}
          {economy?.healthScore !== undefined && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#888]">Health:</span>
              <span className="text-lg font-bold text-[#eee]">{economy.healthScore}</span>
              <span className="text-xs text-[#888]">/ 100</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          {/* Total Income */}
          <div>
            <div className="text-xs text-[#888] mb-1">Total Income</div>
            <div className="text-lg font-bold text-[#00ff88]">
              +{(economy?.totalIncome ?? 0).toFixed(2)}
              <span className="text-xs text-[#888] ml-1">e/tick</span>
            </div>
          </div>

          {/* Total Burn */}
          <div>
            <div className="text-xs text-[#888] mb-1">Total Burn</div>
            <div className="text-lg font-bold text-[#ff4444]">
              -{(economy?.totalBurn ?? 0).toFixed(2)}
              <span className="text-xs text-[#888] ml-1">e/tick</span>
            </div>
          </div>

          {/* Net Flow */}
          <div>
            <div className="text-xs text-[#888] mb-1">Net Flow</div>
            <div
              className="text-lg font-bold"
              style={{ color: netFlowPositive ? '#00ff88' : '#ff4444' }}
            >
              {netFlowPositive ? '+' : ''}{(economy?.netFlow ?? 0).toFixed(2)}
              <span className="text-xs text-[#888] ml-1">e/tick</span>
            </div>
          </div>

          {/* Runway */}
          <div>
            <div className="text-xs text-[#888] mb-1">Runway</div>
            <div className="text-lg font-bold text-[#eee]">
              {economy?.runway === -1 || economy?.runway === undefined
                ? '∞'
                : formatNumber(economy.runway)}
              {economy?.runway !== -1 && economy?.runway !== undefined && (
                <span className="text-xs text-[#888] ml-1">ticks</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Rate Metrics */}
      <div>
        <h4 className="text-sm font-medium text-[#888] mb-3 uppercase tracking-wider">Energy Rates (per tick)</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <RateCard label="Harvest (Local)" value={economy?.harvestIncome ?? 0} color="#00ff88" isIncome />
          <RateCard label="Harvest (Remote)" value={economy?.remoteIncome ?? 0} color="#00ff88" isIncome />
          <RateCard label="Upgrade" value={economy?.upgradeBurn ?? 0} color="#8844ff" />
          <RateCard label="Build" value={economy?.buildBurn ?? 0} color="#ffcc00" />
          <RateCard label="Spawn" value={economy?.spawnBurn ?? 0} color="#4488ff" />
          <RateCard label="Towers" value={economy?.towerBurn ?? 0} color="#ff4444" />
        </div>
      </div>

      {/* Storage Card */}
      <div>
        <h4 className="text-sm font-medium text-[#888] mb-3 uppercase tracking-wider">Storage</h4>
        <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-2xl font-bold text-[#00ff88]">
              {formatNumber(economy?.stored ?? 0)}
            </span>
            <span className="text-sm text-[#888]">
              {economy?.available ?? 0} / {economy?.capacity ?? 0} spawn energy
            </span>
          </div>
          <div className="h-2 bg-[#333] rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-[#00ff88] to-[#00cc66] transition-all"
              style={{ width: `${Math.min(((economy?.stored ?? 0) / 500000) * 100, 100)}%` }}
            />
          </div>
          <div className="text-xs text-[#666] mt-1">
            {(((economy?.stored ?? 0) / 500000) * 100).toFixed(1)}% of max storage (500K)
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

function RateCard({
  label,
  value,
  color,
  isIncome = false,
}: {
  label: string;
  value: number;
  color: string;
  isIncome?: boolean;
}) {
  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-3">
      <div className="text-xs text-[#888] mb-1">{label}</div>
      <div className="text-xl font-bold" style={{ color }}>
        {isIncome && value > 0 ? '+' : ''}{value.toFixed(2)}
        <span className="text-xs text-[#888] ml-1">e/tick</span>
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
