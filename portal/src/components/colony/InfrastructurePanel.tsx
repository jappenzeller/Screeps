import { formatNumber } from '../../utils/formatting';

interface InfrastructurePanelProps {
  defense: {
    towerCount: number;
    towerEnergyTotal: number;
    towerEnergyCapacity: number;
    safeModeAvailable: number;
    safeModeCooldown: number;
    safeModeActive: number;
  } | null;
  structures: {
    constructionSites: number;
    damagedCount: number;
  } | null;
  loading?: boolean;
  error?: Error | null;
}

export function InfrastructurePanel({ defense, structures, loading, error }: InfrastructurePanelProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 bg-[#222] rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[#331111] border border-[#ff4444] rounded-lg p-4">
        <p className="text-[#ff4444]">Failed to load infrastructure data: {error.message}</p>
      </div>
    );
  }

  const towerEnergyPercent = defense && defense.towerEnergyCapacity > 0
    ? (defense.towerEnergyTotal / defense.towerEnergyCapacity) * 100
    : 0;

  return (
    <div className="space-y-6">
      {/* Defense Overview */}
      <div>
        <h4 className="text-sm font-medium text-[#888] mb-3 uppercase tracking-wider">Defense</h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Towers */}
          <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-3">
            <div className="text-xs text-[#888] mb-1">Towers</div>
            <div className="text-xl font-bold text-[#ff4444]">{defense?.towerCount ?? 0}</div>
            {defense && defense.towerCount > 0 && (
              <div className="mt-2">
                <div className="h-1.5 bg-[#333] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#ff4444]"
                    style={{ width: `${towerEnergyPercent}%` }}
                  />
                </div>
                <div className="text-xs text-[#888] mt-1">
                  {formatNumber(defense.towerEnergyTotal)}/{formatNumber(defense.towerEnergyCapacity)}
                </div>
              </div>
            )}
          </div>

          {/* Safe Mode */}
          <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-3">
            <div className="text-xs text-[#888] mb-1">Safe Mode</div>
            {defense?.safeModeActive ? (
              <div className="text-xl font-bold text-[#00ff88]">ACTIVE</div>
            ) : (
              <div className="text-xl font-bold text-[#eee]">{defense?.safeModeAvailable ?? 0}</div>
            )}
            {defense?.safeModeCooldown && defense.safeModeCooldown > 0 ? (
              <div className="text-xs text-[#ffcc00] mt-1">
                Cooldown: {formatNumber(defense.safeModeCooldown)}
              </div>
            ) : (
              <div className="text-xs text-[#888] mt-1">Available</div>
            )}
          </div>

          {/* Construction Sites */}
          <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-3">
            <div className="text-xs text-[#888] mb-1">Construction</div>
            <div className="text-xl font-bold text-[#ff8844]">
              {structures?.constructionSites ?? 0}
            </div>
            <div className="text-xs text-[#888] mt-1">sites</div>
          </div>

          {/* Damaged Structures */}
          <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-3">
            <div className="text-xs text-[#888] mb-1">Damaged</div>
            <div className={`text-xl font-bold ${(structures?.damagedCount ?? 0) > 0 ? 'text-[#ffcc00]' : 'text-[#00ff88]'}`}>
              {structures?.damagedCount ?? 0}
            </div>
            {(structures?.damagedCount ?? 0) > 0 ? (
              <div className="text-xs text-[#ffcc00] mt-1">⚠️ needs repair</div>
            ) : (
              <div className="text-xs text-[#888] mt-1">structures</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
