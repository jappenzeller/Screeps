import type { ExpansionEntry } from '../../api/empire';

interface ExpansionPanelProps {
  active: ExpansionEntry[];
  queue: ExpansionEntry[];
  loading?: boolean;
  error?: Error | null;
}

export function ExpansionPanel({ active, queue, loading, error }: ExpansionPanelProps) {
  if (loading) {
    return (
      <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
        <h3 className="text-lg font-medium text-[#eee] mb-3">Expansion</h3>
        <p className="text-[#888] text-sm">Loading expansion data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
        <h3 className="text-lg font-medium text-[#eee] mb-3">Expansion</h3>
        <p className="text-[#ff4444] text-sm">Failed to load: {error.message}</p>
      </div>
    );
  }

  const hasActive = active && active.length > 0;
  const hasQueue = queue && queue.length > 0;

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
      <h3 className="text-lg font-medium text-[#eee] mb-3">Expansion</h3>

      {!hasActive && !hasQueue ? (
        <p className="text-[#888] text-sm">No active expansions or candidates</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Active Expansions */}
          <div>
            <h4 className="text-sm font-medium text-[#888] mb-2 uppercase tracking-wider">
              Active
            </h4>
            {!hasActive ? (
              <p className="text-[#666] text-sm">None</p>
            ) : (
              <div className="space-y-2">
                {active.map((exp) => (
                  <div
                    key={exp.roomName}
                    className="bg-[#222] rounded px-3 py-2 border-l-2 border-[#00ff88]"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[#eee] font-medium">{exp.roomName}</span>
                      <span className="text-xs text-[#00ff88]">{exp.status || exp.phase || 'Active'}</span>
                    </div>
                    {exp.parentRoom && (
                      <div className="text-xs text-[#888] mt-1">
                        from {exp.parentRoom}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Candidates */}
          <div>
            <h4 className="text-sm font-medium text-[#888] mb-2 uppercase tracking-wider">
              Top Candidates
            </h4>
            {!hasQueue ? (
              <p className="text-[#666] text-sm">None</p>
            ) : (
              <div className="space-y-2">
                {queue.slice(0, 3).map((candidate, index) => (
                  <div
                    key={candidate.roomName}
                    className="bg-[#222] rounded px-3 py-2 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[#888] text-xs">#{index + 1}</span>
                      <span className="text-[#eee]">{candidate.roomName}</span>
                    </div>
                    {candidate.score !== undefined && (
                      <span className="text-xs text-[#4488ff]">
                        {candidate.score.toFixed(1)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
