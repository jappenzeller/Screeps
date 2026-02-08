import type { OverlayState } from './renderFunctions';
import type { AnalysisSummary } from '../../types/recordings';

interface OverlayPanelProps {
  overlays: OverlayState;
  onToggle: (overlay: keyof OverlayState) => void;
  analysisSummary: AnalysisSummary | null;
  analysisLoading: Record<string, boolean>;
  analysisAvailable: boolean;
}

const OVERLAY_OPTIONS: Array<{
  key: keyof OverlayState;
  label: string;
  requiresAnalysis: boolean;
}> = [
  { key: 'terrain', label: 'Terrain', requiresAnalysis: false },
  { key: 'structures', label: 'Structures', requiresAnalysis: false },
  { key: 'creeps', label: 'Creeps', requiresAnalysis: false },
  { key: 'heatmap', label: 'Heatmap', requiresAnalysis: true },
  { key: 'oscillations', label: 'Oscillations', requiresAnalysis: true },
  { key: 'roads', label: 'Road Suggestions', requiresAnalysis: true },
  { key: 'bottlenecks', label: 'Bottlenecks', requiresAnalysis: true },
  { key: 'stuck', label: 'Stuck Events', requiresAnalysis: true },
];

export function OverlayPanel({
  overlays,
  onToggle,
  analysisSummary,
  analysisLoading,
  analysisAvailable,
}: OverlayPanelProps) {
  return (
    <div className="space-y-4">
      {/* Overlay toggles */}
      <div>
        <h4 className="text-xs text-[#888] uppercase tracking-wider mb-2">Overlays</h4>
        <div className="space-y-1">
          {OVERLAY_OPTIONS.map(({ key, label, requiresAnalysis }) => {
            const isLoading = analysisLoading[key];
            const isDisabled = requiresAnalysis && !analysisAvailable;

            return (
              <label
                key={key}
                className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer hover:bg-[#222] ${
                  isDisabled ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={overlays[key]}
                  onChange={() => !isDisabled && onToggle(key)}
                  disabled={isDisabled}
                  className="w-4 h-4 rounded border-[#333] bg-[#222] text-[#00ff88] focus:ring-[#00ff88] focus:ring-offset-0"
                />
                <span className="text-sm text-[#ccc]">{label}</span>
                {isLoading && (
                  <span className="w-3 h-3 border border-[#4488ff] border-t-transparent rounded-full animate-spin" />
                )}
              </label>
            );
          })}
        </div>
      </div>

      {/* Analysis summary */}
      {analysisSummary && (
        <div>
          <h4 className="text-xs text-[#888] uppercase tracking-wider mb-2">Analysis Summary</h4>
          <div className="bg-[#0a0a0a] rounded p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-[#888]">Snapshots:</span>
              <span className="text-[#eee]">{analysisSummary.snapshotsAnalyzed.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#888]">Unique creeps:</span>
              <span className="text-[#eee]">{analysisSummary.uniqueCreeps}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#888]">Oscillations:</span>
              <span className="text-[#ff8844]">{analysisSummary.totalOscillationEvents}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#888]">Stuck events:</span>
              <span className="text-[#ff4444]">{analysisSummary.totalStuckEvents}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#888]">Road suggestions:</span>
              <span className="text-[#00ff88]">{analysisSummary.roadSuggestions}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#888]">Bottlenecks:</span>
              <span className="text-[#ff4444]">{analysisSummary.bottlenecks}</span>
            </div>
          </div>
        </div>
      )}

      {!analysisSummary && analysisAvailable === false && (
        <div className="text-xs text-[#666] p-2">
          Analysis not available. Click "Analyze" on a recording to generate analysis data.
        </div>
      )}
    </div>
  );
}
