import { useState } from 'react';
import type { SignalEvent } from '../../types/analysis';
import { formatFreshness } from '../../utils/formatting';

interface EventListProps {
  events: SignalEvent[];
  maxItems?: number;
}

export const SEVERITY_COLORS: Record<string, string> = {
  info: '#4488ff',
  warning: '#ffcc00',
  alert: '#ff8844',
  critical: '#ff4444',
};

export function EventList({ events, maxItems = 20 }: EventListProps) {
  const [showAll, setShowAll] = useState(false);
  const displayEvents = showAll ? events : events.slice(0, maxItems);
  const hasMore = events.length > maxItems;

  if (events.length === 0) {
    return (
      <div className="text-sm text-[#888] text-center py-4">
        No events in this time period
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {displayEvents.map((event, index) => {
        const eventAgo = Math.floor((Date.now() - event.timestamp) / 1000);
        const severityColor = SEVERITY_COLORS[event.severity] || '#888';

        // Build condition description
        let condition = event.metric;
        if (event.type === 'THRESHOLD' && event.threshold !== undefined) {
          condition = `${event.metric} < ${event.threshold}`;
        } else if (event.type === 'TREND_CHANGE' && event.trend) {
          condition = `${event.metric} ${event.trend}`;
        } else if (event.description) {
          condition = event.description;
        }

        return (
          <div
            key={`${event.timestamp}-${event.metric}-${index}`}
            className="flex items-center gap-2 text-xs py-1.5 border-b border-[#222] last:border-0"
          >
            {/* Severity dot */}
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: severityColor }}
            />

            {/* Severity label */}
            <span
              className="uppercase font-medium w-16 flex-shrink-0"
              style={{ color: severityColor }}
            >
              {event.severity}
            </span>

            {/* Type badge */}
            <span className="px-1.5 py-0.5 bg-[#222] text-[#888] rounded text-[10px] flex-shrink-0">
              {event.type === 'TREND_CHANGE' ? 'TREND' : event.type}
            </span>

            {/* Condition */}
            <span className="text-[#ccc] flex-1 truncate">{condition}</span>

            {/* Value */}
            <span className="text-[#888] flex-shrink-0">
              (value: {typeof event.value === 'number' ? event.value.toLocaleString() : event.value})
            </span>

            {/* Timestamp */}
            <span className="text-[#666] flex-shrink-0 w-16 text-right">
              {formatFreshness(eventAgo)}
            </span>
          </div>
        );
      })}

      {hasMore && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-xs text-[#4488ff] hover:text-[#66aaff] py-2"
        >
          View all {events.length} events
        </button>
      )}
    </div>
  );
}
