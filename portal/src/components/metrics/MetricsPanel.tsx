import { useState } from 'react';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { useApi } from '../../hooks/useApi';
import { fetchMetrics } from '../../api/metrics';
import type { MetricDataPoint } from '../../types/colony';
import { formatNumber } from '../../utils/formatting';

interface MetricsPanelProps {
  roomName: string;
  rcl: number;
}

const TIMERANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '7d', hours: 168 },
];

export function MetricsPanel({ roomName, rcl }: MetricsPanelProps) {
  const [hours, setHours] = useState(24);
  const { data, loading, error } = useApi<MetricDataPoint[]>(
    () => fetchMetrics(roomName, hours).then(r => ({ data: r.data as unknown as MetricDataPoint[], meta: r.meta })),
    [roomName, hours]
  );

  // Handle the actual API response shape - data might be directly an array or have a different structure
  const metrics: MetricDataPoint[] = Array.isArray(data) ? data : [];

  return (
    <div className="space-y-6">
      {/* Timerange Selector */}
      <div className="flex gap-2">
        {TIMERANGES.map((tr) => (
          <button
            type="button"
            key={tr.hours}
            onClick={() => setHours(tr.hours)}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${
              hours === tr.hours
                ? 'bg-[#4488ff] text-white'
                : 'bg-[#222] text-[#888] hover:bg-[#333] hover:text-[#eee]'
            }`}
          >
            {tr.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="w-8 h-8 border-2 border-[#4488ff] border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {error && (
        <div className="bg-[#331111] border border-[#ff4444] rounded-lg p-4">
          <p className="text-[#ff4444]">Failed to load metrics: {error.message}</p>
        </div>
      )}

      {!loading && !error && metrics.length === 0 && (
        <div className="text-center py-12 text-[#888]">
          No metric data available for this timerange
        </div>
      )}

      {!loading && !error && metrics.length > 0 && (
        <div className="space-y-6">
          {/* Energy Chart */}
          <ChartCard title="Energy Over Time">
            <EnergyChart data={metrics} />
          </ChartCard>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Creep Count Chart */}
            <ChartCard title="Creep Count">
              <CreepCountChart data={metrics} />
            </ChartCard>

            {/* CPU Chart */}
            <ChartCard title="CPU Usage">
              <CpuChart data={metrics} />
            </ChartCard>
          </div>

          {/* Controller Progress Chart (only if RCL < 8) */}
          {rcl < 8 && (
            <ChartCard title="Controller Progress">
              <ControllerChart data={metrics} />
            </ChartCard>
          )}
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
      <h4 className="text-sm font-medium text-[#888] mb-4">{title}</h4>
      <div className="h-[250px]">{children}</div>
    </div>
  );
}

function EnergyChart({ data }: { data: MetricDataPoint[] }) {
  const chartData = data.map((d) => ({
    time: d.timestamp,
    storage: d.metrics?.storage_energy ?? 0,
    available: d.metrics?.energy_available ?? 0,
  }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis
          dataKey="time"
          tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          stroke="#888"
          fontSize={11}
        />
        <YAxis stroke="#888" fontSize={11} tickFormatter={(v) => formatNumber(v)} />
        <Tooltip
          contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 4 }}
          labelFormatter={(t) => new Date(t as number).toLocaleString()}
          formatter={(value) => [formatNumber(value as number ?? 0), '']}
        />
        <Line
          type="monotone"
          dataKey="storage"
          stroke="#00ff88"
          dot={false}
          strokeWidth={2}
          isAnimationActive={false}
          name="storage"
        />
        <Line
          type="monotone"
          dataKey="available"
          stroke="#00ff8866"
          dot={false}
          strokeWidth={1}
          strokeDasharray="4 4"
          isAnimationActive={false}
          name="available"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function CreepCountChart({ data }: { data: MetricDataPoint[] }) {
  const chartData = data.map((d) => ({
    time: d.timestamp,
    count: d.metrics?.creep_count ?? 0,
  }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis
          dataKey="time"
          tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          stroke="#888"
          fontSize={11}
        />
        <YAxis stroke="#888" fontSize={11} />
        <Tooltip
          contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 4 }}
          labelFormatter={(t) => new Date(t as number).toLocaleString()}
          formatter={(value) => [value ?? 0, 'Creeps']}
        />
        <Line
          type="monotone"
          dataKey="count"
          stroke="#eee"
          dot={false}
          strokeWidth={2}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function CpuChart({ data }: { data: MetricDataPoint[] }) {
  const chartData = data.map((d) => ({
    time: d.timestamp,
    cpu: d.metrics?.cpu_used ?? 0,
    bucket: d.metrics?.cpu_bucket ?? 0,
  }));

  const hasBucketData = chartData.some((d) => d.bucket > 0);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis
          dataKey="time"
          tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          stroke="#888"
          fontSize={11}
        />
        <YAxis stroke="#888" fontSize={11} yAxisId="left" />
        {hasBucketData && <YAxis stroke="#888" fontSize={11} yAxisId="right" orientation="right" />}
        <Tooltip
          contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 4 }}
          labelFormatter={(t) => new Date(t as number).toLocaleString()}
          formatter={(value) => [((value as number) ?? 0).toFixed(2), '']}
        />
        <ReferenceLine y={20} yAxisId="left" stroke="#ff4444" strokeDasharray="3 3" />
        <Line
          type="monotone"
          dataKey="cpu"
          stroke="#ffcc00"
          dot={false}
          strokeWidth={2}
          isAnimationActive={false}
          yAxisId="left"
          name="cpu"
        />
        {hasBucketData && (
          <Line
            type="monotone"
            dataKey="bucket"
            stroke="#4488ff"
            dot={false}
            strokeWidth={1}
            strokeDasharray="4 4"
            isAnimationActive={false}
            yAxisId="right"
            name="bucket"
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

function ControllerChart({ data }: { data: MetricDataPoint[] }) {
  const chartData = data.map((d) => ({
    time: d.timestamp,
    progress: d.metrics?.controller_progress ?? 0,
    total: d.metrics?.controller_progress_total ?? 0,
  }));

  const maxTotal = Math.max(...chartData.map((d) => d.total));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis
          dataKey="time"
          tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          stroke="#888"
          fontSize={11}
        />
        <YAxis stroke="#888" fontSize={11} tickFormatter={(v) => formatNumber(v)} />
        <Tooltip
          contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 4 }}
          labelFormatter={(t) => new Date(t as number).toLocaleString()}
          formatter={(value) => [formatNumber((value as number) ?? 0), 'Progress']}
        />
        {maxTotal > 0 && (
          <ReferenceLine y={maxTotal} stroke="#4488ff" strokeDasharray="3 3" label={{ value: 'Target', fill: '#4488ff', fontSize: 11 }} />
        )}
        <Area
          type="monotone"
          dataKey="progress"
          stroke="#4488ff"
          fill="#4488ff33"
          dot={false}
          strokeWidth={2}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
