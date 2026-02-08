import { useState } from 'react';
import type { Recommendation } from '../../types/analysis';
import { formatFreshness } from '../../utils/formatting';

interface RecommendationCardProps {
  rec: Recommendation;
  onFeedback: (recId: string, action: string) => void;
  feedbackLoading?: boolean;
  feedbackOverride?: string;
}

const PRIORITY_CONFIG: Record<number, { label: string; color: string; bg: string }> = {
  1: { label: 'CRITICAL', color: '#ff4444', bg: '#ff444433' },
  2: { label: 'HIGH', color: '#ff8844', bg: '#ff884433' },
  3: { label: 'MEDIUM', color: '#ffcc00', bg: '#ffcc0033' },
  4: { label: 'LOW', color: '#4488ff', bg: '#4488ff33' },
  5: { label: 'INFO', color: '#888888', bg: '#88888833' },
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  applied: { label: 'Applied', color: '#00ff88', bg: '#00ff8833' },
  dismissed: { label: 'Dismissed', color: '#888888', bg: '#88888833' },
  stale: { label: 'Stale', color: '#ffcc00', bg: '#ffcc0033' },
  resolved_helpful: { label: 'Helpful', color: '#00ff88', bg: '#00ff8833' },
  resolved_unhelpful: { label: 'Not Helpful', color: '#888888', bg: '#88888833' },
};

export function RecommendationCard({
  rec,
  onFeedback,
  feedbackLoading,
  feedbackOverride,
}: RecommendationCardProps) {
  const [showEvidence, setShowEvidence] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const priority = PRIORITY_CONFIG[rec.priority] || PRIORITY_CONFIG[5];
  const effectiveStatus = feedbackOverride || rec.status;
  const statusConfig = effectiveStatus !== 'pending' ? STATUS_CONFIG[effectiveStatus] : null;
  const createdAgo = Math.floor((Date.now() - rec.createdAt) / 1000);

  // Description handling - show first 4 lines collapsed
  const descriptionLines = rec.description.split('\n');
  const isLongDescription = descriptionLines.length > 4;
  const displayDescription = expanded ? rec.description : descriptionLines.slice(0, 4).join('\n');

  const hasEvidence = rec.evidence && rec.evidence.trim().length > 0;
  const hasCodeContext = rec.codeFile && (rec.currentCode || rec.suggestedFix);

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#333] flex items-center gap-3 flex-wrap">
        {/* Priority badge */}
        <span
          className="px-2 py-0.5 text-xs font-bold rounded"
          style={{ backgroundColor: priority.bg, color: priority.color }}
        >
          {priority.label}
        </span>

        {/* Category */}
        <span className="text-xs text-[#888]">{rec.category}</span>

        {/* Pattern type */}
        {rec.patternType && (
          <span className="text-xs text-[#666] font-mono">{rec.patternType}</span>
        )}

        {/* Status badge (if not pending) */}
        {statusConfig && (
          <span
            className="px-2 py-0.5 text-xs rounded ml-auto"
            style={{ backgroundColor: statusConfig.bg, color: statusConfig.color }}
          >
            {statusConfig.label}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="p-4 space-y-3">
        {/* Title */}
        {rec.title && (
          <h4 className="font-bold text-[#eee]">{rec.title}</h4>
        )}

        {/* Description */}
        <div className="text-sm text-[#ccc] whitespace-pre-wrap">
          {displayDescription}
          {isLongDescription && !expanded && '...'}
        </div>
        {isLongDescription && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-[#4488ff] hover:text-[#66aaff]"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}

        {/* Evidence section */}
        {hasEvidence && (
          <div className="border-t border-[#333] pt-3">
            <button
              type="button"
              onClick={() => setShowEvidence(!showEvidence)}
              className="text-xs text-[#888] hover:text-[#eee] flex items-center gap-1"
            >
              <span>{showEvidence ? '▼' : '▶'}</span>
              Evidence
            </button>
            {showEvidence && (
              <div className="mt-2 p-3 bg-[#0a0a0a] rounded text-xs text-[#888] font-mono whitespace-pre-wrap">
                {rec.evidence}
              </div>
            )}
          </div>
        )}

        {/* Code context section */}
        {hasCodeContext && (
          <div className="border-t border-[#333] pt-3">
            <button
              type="button"
              onClick={() => setShowCode(!showCode)}
              className="text-xs text-[#888] hover:text-[#eee] flex items-center gap-1"
            >
              <span>{showCode ? '▼' : '▶'}</span>
              Code Context
              <span className="text-[#666] ml-2">{rec.codeFile}</span>
            </button>
            {showCode && (
              <div className="mt-2 space-y-2">
                {rec.currentCode && (
                  <div>
                    <div className="text-xs text-[#666] mb-1">Current:</div>
                    <pre className="p-3 bg-[#0a0a0a] rounded text-xs text-[#ccc] font-mono overflow-x-auto">
                      {rec.currentCode}
                    </pre>
                  </div>
                )}
                {rec.suggestedFix && (
                  <div>
                    <div className="text-xs text-[#00ff88] mb-1">Suggested:</div>
                    <pre className="p-3 bg-[#0a1a0a] border border-[#00ff8833] rounded text-xs text-[#ccc] font-mono overflow-x-auto">
                      {rec.suggestedFix}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Timestamp */}
        <div className="text-xs text-[#666]">
          Created {formatFreshness(createdAgo)}
        </div>

        {/* Feedback buttons */}
        {effectiveStatus === 'pending' && (
          <div className="flex gap-2 pt-2 border-t border-[#333]">
            <button
              type="button"
              onClick={() => onFeedback(rec.id, 'applied')}
              disabled={feedbackLoading}
              className="px-3 py-1.5 text-xs rounded border border-[#00ff88] text-[#00ff88] hover:bg-[#00ff8822] disabled:opacity-50 transition-colors"
            >
              ✓ Applied
            </button>
            <button
              type="button"
              onClick={() => onFeedback(rec.id, 'helpful')}
              disabled={feedbackLoading}
              className="px-3 py-1.5 text-xs rounded border border-[#4488ff] text-[#4488ff] hover:bg-[#4488ff22] disabled:opacity-50 transition-colors"
            >
              👍 Helpful
            </button>
            <button
              type="button"
              onClick={() => onFeedback(rec.id, 'unhelpful')}
              disabled={feedbackLoading}
              className="px-3 py-1.5 text-xs rounded border border-[#888] text-[#888] hover:bg-[#88888822] disabled:opacity-50 transition-colors"
            >
              👎 Not Helpful
            </button>
            <button
              type="button"
              onClick={() => onFeedback(rec.id, 'dismissed')}
              disabled={feedbackLoading}
              className="px-3 py-1.5 text-xs rounded border border-[#333] text-[#666] hover:bg-[#33333322] disabled:opacity-50 transition-colors"
            >
              ✕ Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
