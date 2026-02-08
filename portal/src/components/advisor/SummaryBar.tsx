import type { Recommendation, SignalEvent } from '../../types/analysis';
import { formatFreshness } from '../../utils/formatting';

interface SummaryBarProps {
  recommendations: Recommendation[];
  events: SignalEvent[];
  lastAnalysisTime?: number;
  signalHours: number;
}

export function SummaryBar({
  recommendations,
  events,
  lastAnalysisTime,
  signalHours,
}: SummaryBarProps) {
  // Count recommendations by priority (only pending ones)
  const pending = recommendations.filter((r) => r.status === 'pending');
  const critical = pending.filter((r) => r.priority === 1).length;
  const high = pending.filter((r) => r.priority === 2).length;
  const totalPending = pending.length;

  // Calculate time since last analysis
  const lastAnalysisAgo = lastAnalysisTime
    ? Math.floor((Date.now() - lastAnalysisTime) / 1000)
    : null;

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg px-4 py-2 flex items-center gap-4 text-sm flex-wrap">
      {/* Recommendation counts */}
      <div className="flex items-center gap-3">
        {critical > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#ff4444]" />
            <span className="text-[#ff4444]">{critical} critical</span>
          </span>
        )}
        {high > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#ff8844]" />
            <span className="text-[#ff8844]">{high} high</span>
          </span>
        )}
        <span className="text-[#888]">
          {totalPending} pending total
        </span>
      </div>

      <span className="text-[#333]">|</span>

      {/* Event count */}
      <span className="text-[#888]">
        {events.length} events ({signalHours}h)
      </span>

      <span className="text-[#333]">|</span>

      {/* Last analysis time */}
      <span className="text-[#888]">
        Last analysis:{' '}
        {lastAnalysisAgo !== null ? (
          <span className="text-[#eee]">{formatFreshness(lastAnalysisAgo)}</span>
        ) : (
          <span className="text-[#666]">unknown</span>
        )}
      </span>
    </div>
  );
}
