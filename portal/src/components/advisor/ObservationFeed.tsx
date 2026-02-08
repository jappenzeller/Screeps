import { useState } from 'react';
import type { ObservationRecord, Observation, ObservedPattern, SignalCorrelation } from '../../types/analysis';
import { formatFreshness } from '../../utils/formatting';

interface ObservationFeedProps {
  observations: ObservationRecord[];
}

const CATEGORY_COLORS: Record<string, string> = {
  economy: '#00ff88',
  defense: '#ff4444',
  expansion: '#aa88ff',
  optimization: '#4488ff',
  spawning: '#ffcc00',
  behavior: '#ff8844',
  population: '#44ffcc',
  infrastructure: '#888888',
  anomaly: '#ff44ff',
};

function getSignificanceLevel(obs: Observation): 'high' | 'medium' | 'low' {
  if (obs.significance) return obs.significance;
  if (typeof obs.confidence === 'number') {
    if (obs.confidence >= 0.7) return 'high';
    if (obs.confidence >= 0.4) return 'medium';
    return 'low';
  }
  return 'medium';
}

export function ObservationFeed({ observations }: ObservationFeedProps) {
  if (observations.length === 0) {
    return (
      <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-6 text-center">
        <p className="text-[#888]">No AI observations available yet</p>
        <p className="text-[#666] text-sm mt-1">
          Observations are generated hourly by the analysis engine
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {observations.map((record) => (
        <ObservationCard key={record.id} record={record} />
      ))}
    </div>
  );
}

function ObservationCard({ record }: { record: ObservationRecord }) {
  const [expanded, setExpanded] = useState(false);

  const recordAgo = Math.floor((Date.now() - record.timestamp) / 1000);
  const obsCount = record.observations?.length || 0;
  const patternCount = record.patterns?.length || 0;
  const correlationCount = record.signalCorrelations?.length || 0;

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg overflow-hidden">
      {/* Collapsed header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 text-left hover:bg-[#222] transition-colors"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            {/* Timestamp */}
            <div className="text-xs text-[#888] mb-1">
              <span className="mr-2">🕐</span>
              {formatFreshness(recordAgo)}
              {record.snapshotTick && (
                <span className="text-[#666] ml-2">(tick {record.snapshotTick.toLocaleString()})</span>
              )}
            </div>

            {/* Summary */}
            <p className="text-sm text-[#ccc]">{record.summary}</p>

            {/* Count badges */}
            <div className="flex gap-2 mt-2">
              {obsCount > 0 && (
                <span className="text-xs text-[#888]">{obsCount} observations</span>
              )}
              {patternCount > 0 && (
                <span className="text-xs text-[#888]">· {patternCount} patterns</span>
              )}
              {correlationCount > 0 && (
                <span className="text-xs text-[#888]">· {correlationCount} signal correlations</span>
              )}
            </div>
          </div>

          {/* Expand indicator */}
          <span className="text-[#666] text-sm flex-shrink-0">
            {expanded ? '▲' : '▼'}
          </span>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-[#333]">
          {/* Observations */}
          {record.observations && record.observations.length > 0 && (
            <div className="pt-4">
              <h5 className="text-xs text-[#888] uppercase tracking-wider mb-2">Observations</h5>
              <div className="space-y-2">
                {record.observations.map((obs, i) => (
                  <ObservationItem key={i} observation={obs} />
                ))}
              </div>
            </div>
          )}

          {/* Patterns */}
          {record.patterns && record.patterns.length > 0 && (
            <div className="pt-4 border-t border-[#333]">
              <h5 className="text-xs text-[#888] uppercase tracking-wider mb-2">Patterns</h5>
              <div className="space-y-2">
                {record.patterns.map((pattern, i) => (
                  <PatternItem key={i} pattern={pattern} />
                ))}
              </div>
            </div>
          )}

          {/* Signal Correlations */}
          {record.signalCorrelations && record.signalCorrelations.length > 0 && (
            <div className="pt-4 border-t border-[#333]">
              <h5 className="text-xs text-[#888] uppercase tracking-wider mb-2">Signal Correlations</h5>
              <div className="space-y-2">
                {record.signalCorrelations.map((corr, i) => (
                  <CorrelationItem key={i} correlation={corr} />
                ))}
              </div>
            </div>
          )}

          {/* Changes from Previous */}
          {record.changesFromPrevious && (
            <div className="pt-4 border-t border-[#333]">
              <h5 className="text-xs text-[#888] uppercase tracking-wider mb-2">Changes from Previous</h5>
              <p className="text-sm text-[#888] italic">{record.changesFromPrevious}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ObservationItem({ observation }: { observation: Observation }) {
  const categoryColor = CATEGORY_COLORS[observation.category] || '#888';
  const significance = getSignificanceLevel(observation);
  const text = observation.observation || observation.summary || observation.details || '';

  return (
    <div className="flex items-start gap-2">
      {/* Significance indicator */}
      <span
        className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
          significance === 'high' ? '' : significance === 'medium' ? 'opacity-60' : 'opacity-30'
        }`}
        style={{ backgroundColor: categoryColor }}
      />

      <div className="flex-1 min-w-0">
        {/* Category + significance */}
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-medium" style={{ color: categoryColor }}>
            {observation.category}
          </span>
          <span className="text-xs text-[#666]">({significance})</span>
        </div>

        {/* Content */}
        <p className="text-sm text-[#ccc]">{text}</p>

        {/* Data points */}
        {observation.dataPoints && observation.dataPoints.length > 0 && (
          <p className="text-xs text-[#666] mt-1">
            Data: {observation.dataPoints.join(', ')}
          </p>
        )}

        {/* Related entities */}
        {observation.relatedEntities && observation.relatedEntities.length > 0 && (
          <p className="text-xs text-[#666] mt-1">
            Entities: {observation.relatedEntities.join(', ')}
          </p>
        )}
      </div>
    </div>
  );
}

function PatternItem({ pattern }: { pattern: ObservedPattern }) {
  const trendColors: Record<string, string> = {
    improving: '#00ff88',
    stable: '#888888',
    declining: '#ffcc00',
    worsening: '#ff4444',
    new: '#4488ff',
    resolved: '#00ff88',
  };

  const trendColor = trendColors[pattern.trend] || '#888';

  return (
    <div className="flex items-start gap-2">
      <span className="text-xs font-mono text-[#888] bg-[#222] px-1.5 py-0.5 rounded flex-shrink-0">
        {pattern.id || 'PATTERN'}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[#ccc]">{pattern.description}</p>
        <div className="flex items-center gap-2 mt-1 text-xs">
          <span style={{ color: trendColor }}>{pattern.trend}</span>
          {pattern.occurrences && (
            <span className="text-[#666]">· {pattern.occurrences} occurrences</span>
          )}
        </div>
      </div>
    </div>
  );
}

function CorrelationItem({ correlation }: { correlation: SignalCorrelation }) {
  const signals = correlation.signals?.join(' ↔ ') || correlation.metric || '';
  const text = correlation.correlation || correlation.observation || correlation.hypothesis || '';

  return (
    <div className="text-sm">
      <span className="text-[#4488ff] font-mono text-xs">{signals}</span>
      {text && <span className="text-[#888]">: {text}</span>}
    </div>
  );
}
