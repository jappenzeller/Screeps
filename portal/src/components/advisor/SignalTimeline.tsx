import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import type { SignalEvent } from '../../types/analysis';

interface SignalTimelineProps {
  events: SignalEvent[];
  hours: number;
  onHoursChange: (hours: number) => void;
}

const TIMERANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '7d', hours: 168 },
];

const SEVERITY_Y: Record<string, number> = {
  info: 1,
  warning: 2,
  alert: 3,
  critical: 4,
};

const SEVERITY_LABELS: Record<number, string> = {
  1: 'info',
  2: 'warning',
  3: 'alert',
  4: 'critical',
};

const TYPE_COLORS: Record<string, string> = {
  THRESHOLD: '#ffcc00',
  ANOMALY: '#ff4444',
  TREND_CHANGE: '#4488ff',
};

interface ChartDataPoint {
  time: number;
  severity: number;
  type: string;
  metric: string;
  value: number;
  threshold?: number;
  description?: string;
}

export function SignalTimeline({ events, hours, onHoursChange }: SignalTimelineProps) {
  const chartData: ChartDataPoint[] = events.map((e) => ({
    time: e.timestamp,
    severity: SEVERITY_Y[e.severity] || 1,
    type: e.type,
    metric: e.metric,
    value: e.value,
    threshold: e.threshold,
    description: e.description,
  }));

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartDataPoint }> }) => {
    if (!active || !payload || payload.length === 0) return null;

    const data = payload[0].payload;
    return (
      <div className="bg-[#1a1a1a] border border-[#333] rounded p-2 text-xs">
        <div className="font-bold text-[#eee]">{data.type}</div>
        <div className="text-[#888]">{data.metric}</div>
        <div className="text-[#ccc]">Value: {data.value}</div>
        {data.threshold !== undefined && (
          <div className="text-[#ccc]">Threshold: {data.threshold}</div>
        )}
        {data.description && (
          <div className="text-[#888] mt-1">{data.description}</div>
        )}
        <div className="text-[#666] mt-1">
          {new Date(data.time).toLocaleString()}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {/* Timerange selector */}
      <div className="flex gap-2">
        {TIMERANGES.map((tr) => (
          <button
            type="button"
            key={tr.hours}
            onClick={() => onHoursChange(tr.hours)}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              hours === tr.hours
                ? 'bg-[#4488ff] text-white'
                : 'bg-[#222] text-[#888] hover:bg-[#333] hover:text-[#eee]'
            }`}
          >
            {tr.label}
          </button>
        ))}
      </div>

      {/* Chart */}
      {chartData.length > 0 ? (
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 60 }}>
              <XAxis
                dataKey="time"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t) =>
                  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                }
                stroke="#888"
                fontSize={10}
              />
              <YAxis
                dataKey="severity"
                type="number"
                domain={[0.5, 4.5]}
                ticks={[1, 2, 3, 4]}
                tickFormatter={(v) => SEVERITY_LABELS[v] || ''}
                stroke="#888"
                fontSize={10}
              />
              <Tooltip content={<CustomTooltip />} />
              <Scatter data={chartData}>
                {chartData.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={TYPE_COLORS[entry.type] || '#888'}
                  />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="h-[200px] flex items-center justify-center bg-[#0a1a0a] border border-[#00ff8833] rounded-lg">
          <div className="text-center">
            <span className="text-[#00ff88] text-lg">✓</span>
            <p className="text-sm text-[#888] mt-1">No signal events in the past {hours}h</p>
            <p className="text-xs text-[#666]">Colony is operating within normal parameters</p>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex gap-4 text-xs text-[#888]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#ffcc00]" />
          Threshold
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#ff4444]" />
          Anomaly
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#4488ff]" />
          Trend Change
        </span>
      </div>
    </div>
  );
}
