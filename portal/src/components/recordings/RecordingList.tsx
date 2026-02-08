import type { Recording } from '../../types/recordings';
import { formatFreshness } from '../../utils/formatting';

interface RecordingListProps {
  recordings: Recording[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (recording: Recording) => void;
  onAnalyze: (recording: Recording) => void;
}

const STATUS_CONFIG: Record<string, { color: string; bg: string; label: string }> = {
  active: { color: '#00ff88', bg: '#00ff8833', label: 'ACTIVE' },
  complete: { color: '#4488ff', bg: '#4488ff33', label: 'COMPLETE' },
  paused: { color: '#ffcc00', bg: '#ffcc0033', label: 'PAUSED' },
};

export function RecordingList({
  recordings,
  selectedId,
  loading,
  onSelect,
  onAnalyze,
}: RecordingListProps) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-28 bg-[#222] rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (recordings.length === 0) {
    return (
      <div className="text-center py-8 text-[#888]">
        <p>No recordings found</p>
        <p className="text-xs text-[#666] mt-1">
          Start a recording in-game to see it here
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {recordings.map((recording) => {
        const isSelected = recording.recordingId === selectedId;
        const status = STATUS_CONFIG[recording.status] || STATUS_CONFIG.complete;
        const createdAgo = recording.createdAt
          ? Math.floor((Date.now() - new Date(recording.createdAt).getTime()) / 1000)
          : null;

        return (
          <button
            type="button"
            key={recording.recordingId}
            onClick={() => onSelect(recording)}
            className={`w-full text-left p-3 rounded-lg border transition-colors ${
              isSelected
                ? 'bg-[#1a2a1a] border-[#00ff88] border-l-4'
                : 'bg-[#1a1a1a] border-[#333] hover:border-[#555]'
            }`}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold text-[#eee]">{recording.room}</span>
              <span
                className="px-2 py-0.5 text-xs rounded"
                style={{ backgroundColor: status.bg, color: status.color }}
              >
                {status.label}
              </span>
            </div>

            {/* Tick range */}
            <div className="text-xs text-[#888] mb-1">
              Ticks: {recording.startTick?.toLocaleString() ?? '?'} →{' '}
              {recording.endTick?.toLocaleString() ?? '?'}
            </div>

            {/* Stats */}
            <div className="text-xs text-[#888] mb-2">
              Snapshots: {recording.snapshotCount?.toLocaleString() ?? '?'}
            </div>

            {/* Created time */}
            {createdAgo !== null && (
              <div className="text-xs text-[#666] mb-2">
                Created: {formatFreshness(createdAgo)}
              </div>
            )}

            {/* Analysis status & actions */}
            <div className="flex items-center justify-between">
              {recording.analysisStatus === 'complete' ? (
                <span className="text-xs text-[#4488ff]">Analyzed ✓</span>
              ) : recording.analysisStatus === 'in_progress' ? (
                <span className="text-xs text-[#ffcc00]">Analyzing...</span>
              ) : (
                <span className="text-xs text-[#666]">Not analyzed</span>
              )}

              {recording.analysisStatus !== 'complete' &&
                recording.analysisStatus !== 'in_progress' && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAnalyze(recording);
                    }}
                    className="px-2 py-1 text-xs bg-[#4488ff33] text-[#4488ff] rounded hover:bg-[#4488ff44] transition-colors"
                  >
                    Analyze
                  </button>
                )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
