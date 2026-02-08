import type { TrendInfo } from '../../types/analysis';

interface TrendSummaryProps {
  trends: Record<string, TrendInfo>;
}

// Metrics where increasing is good
const POSITIVE_METRICS = ['energyStored', 'creepCount', 'cpuBucket', 'storageEnergy'];
// Metrics where decreasing is good
const NEGATIVE_METRICS = ['hostileCount', 'damagedStructures'];

const METRIC_LABELS: Record<string, string> = {
  energyStored: 'Energy',
  storageEnergy: 'Storage',
  creepCount: 'Creeps',
  cpuBucket: 'CPU Bucket',
  cpuUsed: 'CPU Used',
  hostileCount: 'Hostiles',
  controllerProgress: 'RCL Progress',
  damagedStructures: 'Damaged',
};

export function TrendSummary({ trends }: TrendSummaryProps) {
  const entries = Object.entries(trends).filter(([, info]) => info.delta !== 0);

  if (entries.length === 0) {
    return (
      <div className="text-xs text-[#888]">
        No significant trends detected
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-3">
      {entries.map(([metric, info]) => {
        const label = METRIC_LABELS[metric] || metric;
        const isPositive = info.trend === 'increasing';
        const isNegative = info.trend === 'decreasing';

        // Determine if this trend is "good" or "bad"
        let isGood = false;
        if (POSITIVE_METRICS.includes(metric)) {
          isGood = isPositive;
        } else if (NEGATIVE_METRICS.includes(metric)) {
          isGood = isNegative;
        } else {
          // Neutral metrics - just show direction
          isGood = isPositive;
        }

        const color = isGood ? '#00ff88' : '#ff4444';
        const arrow = isPositive ? '↑' : '↓';
        const sign = info.percentChange > 0 ? '+' : '';

        return (
          <span
            key={metric}
            className="inline-flex items-center gap-1 px-2 py-1 bg-[#222] rounded text-xs"
          >
            <span className="text-[#888]">{label}:</span>
            <span style={{ color }}>
              {arrow} {sign}{info.percentChange.toFixed(1)}%
            </span>
          </span>
        );
      })}
    </div>
  );
}
