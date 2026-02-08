import { Link } from 'react-router-dom';
import type { ColonySummary } from '../../api/colonies';
import { formatNumber } from '../../utils/formatting';
import { FreshnessIndicator } from '../layout/FreshnessIndicator';

interface ColonyCardProps {
  colony: ColonySummary;
  freshness?: number;
}

export function ColonyCard({ colony, freshness }: ColonyCardProps) {
  const rclPercent = colony.rclProgressTotal > 0
    ? (colony.rclProgress / colony.rclProgressTotal) * 100
    : 0;

  const energyPercent = colony.energyCapacity
    ? (colony.energy / colony.energyCapacity) * 100
    : 0;

  // Get top 3 roles by count
  const topRoles = Object.entries(colony.creepsByRole)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  const threatColor = colony.threats?.hostile ? '#ff4444' : '#00ff88';
  const threatLabel = colony.threats?.hostile
    ? `${colony.threats.hostileCount || 0} hostile`
    : 'Safe';

  return (
    <Link
      to={`/colony/${colony.roomName}`}
      className="block bg-[#1a1a1a] border border-[#333] rounded-lg p-4 hover:border-[#00ff88] transition-colors"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-bold text-[#eee]">{colony.roomName}</h3>
        {freshness !== undefined && (
          <FreshnessIndicator freshness={freshness} size="sm" />
        )}
      </div>

      {/* RCL Progress */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-sm mb-1">
          <span className="text-[#888]">RCL</span>
          <span className="text-[#4488ff] font-medium">{colony.rcl}</span>
        </div>
        <div className="h-1.5 bg-[#333] rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-[#4488ff] to-[#66aaff]"
            style={{ width: `${rclPercent}%` }}
          />
        </div>
      </div>

      {/* Energy */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-sm mb-1">
          <span className="text-[#888]">Energy</span>
          <span className="text-[#00ff88]">{formatNumber(colony.energy)}</span>
        </div>
        <div className="h-1.5 bg-[#333] rounded-full overflow-hidden">
          <div
            className="h-full bg-[#00ff88]"
            style={{ width: `${Math.min(energyPercent, 100)}%` }}
          />
        </div>
      </div>

      {/* Creeps */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-sm mb-1">
          <span className="text-[#888]">Creeps</span>
          <span className="text-[#eee]">{colony.creepCount}</span>
        </div>
        {topRoles.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {topRoles.map(([role, count]) => (
              <span
                key={role}
                className="text-xs bg-[#222] text-[#888] px-1.5 py-0.5 rounded"
              >
                {role}: {count}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Footer: Threat + Spawn Status */}
      <div className="flex items-center justify-between text-sm pt-2 border-t border-[#333]">
        <div className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: threatColor }}
          />
          <span style={{ color: threatColor }}>{threatLabel}</span>
        </div>
        <span className="text-[#888]">
          {colony.spawning ? `Spawning: ${colony.spawning.role}` : 'Idle'}
        </span>
      </div>
    </Link>
  );
}
