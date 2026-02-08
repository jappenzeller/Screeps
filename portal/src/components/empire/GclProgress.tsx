import { formatNumber, formatPercent } from '../../utils/formatting';

interface GclProgressProps {
  level: number;
  progress: number;
  progressTotal: number;
}

export function GclProgress({ level, progress, progressTotal }: GclProgressProps) {
  const percent = progressTotal > 0 ? (progress / progressTotal) * 100 : 0;

  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <span className="text-[#888] text-sm">GCL</span>
        <span className="text-2xl font-bold text-[#4488ff]">{level}</span>
      </div>
      <div className="flex-1">
        <div className="h-2 bg-[#333] rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-[#4488ff] to-[#66aaff] transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="flex justify-between mt-1 text-xs text-[#888]">
          <span>{formatNumber(progress)}</span>
          <span>{formatPercent(progress, progressTotal)}</span>
          <span>{formatNumber(progressTotal)}</span>
        </div>
      </div>
    </div>
  );
}
