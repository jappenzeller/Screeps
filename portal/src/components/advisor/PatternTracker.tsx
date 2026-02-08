import type { DetectedPattern } from '../../types/analysis';

interface PatternTrackerProps {
  patterns: DetectedPattern[];
}

const SEVERITY_CONFIG: Record<string, { color: string; bg: string; border: string }> = {
  critical: { color: '#ff4444', bg: '#2a0a0a', border: '#ff4444' },
  high: { color: '#ff8844', bg: '#2a1a0a', border: '#ff8844' },
  medium: { color: '#ffcc00', bg: '#2a2a0a', border: '#ffcc00' },
  low: { color: '#4488ff', bg: '#0a1a2a', border: '#4488ff' },
};

const TREND_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  improving: { label: 'Improving', color: '#00ff88', icon: '↗' },
  stable: { label: 'Stable', color: '#888888', icon: '→' },
  declining: { label: 'Declining', color: '#ffcc00', icon: '↘' },
  worsening: { label: 'Worsening', color: '#ff4444', icon: '↓' },
  new: { label: 'NEW', color: '#4488ff', icon: '★' },
  resolved: { label: 'Resolved', color: '#00ff88', icon: '✓' },
};

export function PatternTracker({ patterns }: PatternTrackerProps) {
  if (patterns.length === 0) {
    return (
      <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-6 text-center">
        <p className="text-[#888]">No active patterns detected</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {patterns.map((pattern, index) => (
        <PatternCard key={pattern.id || index} pattern={pattern} />
      ))}
    </div>
  );
}

function PatternCard({ pattern }: { pattern: DetectedPattern }) {
  const severity = SEVERITY_CONFIG[pattern.severity] || SEVERITY_CONFIG.low;
  const trend = pattern.trend ? TREND_CONFIG[pattern.trend] : null;

  return (
    <div
      className="rounded-lg p-3 border"
      style={{
        backgroundColor: severity.bg,
        borderColor: severity.border,
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        {/* Severity badge */}
        <span
          className="text-xs font-bold uppercase"
          style={{ color: severity.color }}
        >
          ⚠️ {pattern.severity}
        </span>

        {/* Pattern ID/type */}
        <span className="text-xs font-mono text-[#888] bg-[#00000033] px-1.5 py-0.5 rounded">
          {pattern.type || pattern.id}
        </span>
      </div>

      {/* Message/description */}
      <p className="text-sm text-[#ccc] mb-2">
        {pattern.message || pattern.description}
      </p>

      {/* Footer */}
      <div className="flex items-center justify-between text-xs">
        {/* Trend */}
        {trend && (
          <span className="flex items-center gap-1" style={{ color: trend.color }}>
            <span>{trend.icon}</span>
            <span>{trend.label}</span>
          </span>
        )}

        {/* Occurrences */}
        {pattern.occurrences && (
          <span className="text-[#888]">
            {pattern.occurrences} occurrences
          </span>
        )}
      </div>
    </div>
  );
}
