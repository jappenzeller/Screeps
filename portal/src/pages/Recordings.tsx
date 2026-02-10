import { useState, useEffect, useRef, useCallback } from 'react';
import { Header } from '../components/layout/Header';
import { RoomCanvas } from '../components/recordings/RoomCanvas';
import { PlaybackControls } from '../components/recordings/PlaybackControls';
import { RecordingList } from '../components/recordings/RecordingList';
import { OverlayPanel } from '../components/recordings/OverlayPanel';
import { InfoPanel } from '../components/recordings/InfoPanel';
import { usePlayback } from '../components/recordings/usePlayback';
import { useSnapshotCache } from '../components/recordings/useSnapshotCache';
import type { AnalysisData, OverlayState } from '../components/recordings/renderFunctions';
import { useApi } from '../hooks/useApi';
import {
  fetchRecordings,
  fetchSnapshotIndex,
  fetchTerrain,
  fetchAnalysisSummary,
  fetchAnalysisData,
  triggerAnalysis,
} from '../api/recordings';
import type {
  Recording,
  Snapshot,
  AnalysisSummary,
  AnalysisType,
  HeatmapData,
  OscillationData,
  StuckData,
  RoadData,
  BottleneckData,
} from '../types/recordings';

export function Recordings() {
  const { state, dispatch, getCurrentTick, getPreviousTick } = usePlayback();
  const snapshotCache = useSnapshotCache(state.recordingId);

  // Recording and terrain state
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);
  const [terrain, setTerrain] = useState<string | null>(null);
  const [loadingTerrain, setLoadingTerrain] = useState(false);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);

  // Analysis state
  const [analysisSummary, setAnalysisSummary] = useState<AnalysisSummary | null>(null);
  const [analysisData, setAnalysisData] = useState<AnalysisData>({});
  const [analysisLoading, setAnalysisLoading] = useState<Record<string, boolean>>({});

  // Current and previous snapshots
  const [currentSnapshot, setCurrentSnapshot] = useState<Snapshot | null>(null);
  const [previousSnapshot, setPreviousSnapshot] = useState<Snapshot | null>(null);

  // Playback animation
  const lastFrameTimeRef = useRef(0);
  const animationRef = useRef<number>(0);

  // Fetch recordings list
  const { data: recordingsData, loading: recordingsLoading } = useApi<Recording[]>(
    () => fetchRecordings(),
    []
  );
  const recordings = recordingsData ?? [];

  // Load recording when selected
  const loadRecording = useCallback(async (recording: Recording) => {
    setSelectedRecording(recording);
    setTerrain(null);
    setAnalysisSummary(null);
    setAnalysisData({});
    snapshotCache.clear();
    dispatch({ type: 'CLEAR_RECORDING' });

    // Load terrain (fetchTerrain now extracts the encoded string)
    setLoadingTerrain(true);
    try {
      const terrainResponse = await fetchTerrain(recording.recordingId);
      setTerrain(terrainResponse.data);
    } catch (e) {
      console.error('Failed to load terrain', e);
    }
    setLoadingTerrain(false);

    // Load snapshot index
    setLoadingSnapshots(true);
    try {
      const indexResponse = await fetchSnapshotIndex(recording.recordingId);
      const ticks = indexResponse.data.ticks || [];
      dispatch({ type: 'SET_RECORDING', recordingId: recording.recordingId, tickList: ticks });

      // Prefetch first batch
      if (ticks.length > 0) {
        await snapshotCache.prefetch(0, ticks);
        const firstSnapshot = snapshotCache.get(ticks[0]);
        setCurrentSnapshot(firstSnapshot);
      }
    } catch (e) {
      console.error('Failed to load snapshot index', e);
    }
    setLoadingSnapshots(false);

    // Load analysis summary (non-blocking)
    try {
      const summaryResponse = await fetchAnalysisSummary(recording.recordingId);
      setAnalysisSummary(summaryResponse.data);
    } catch {
      // Analysis may not exist
    }
  }, [dispatch, snapshotCache]);

  // Update current snapshot when playback index changes
  useEffect(() => {
    const currentTick = getCurrentTick();
    const prevTick = getPreviousTick();

    if (currentTick !== null) {
      const snapshot = snapshotCache.get(currentTick);
      setCurrentSnapshot(snapshot);

      // Prefetch ahead
      snapshotCache.prefetch(state.playbackIndex, state.tickList);
    }

    if (prevTick !== null) {
      const snapshot = snapshotCache.get(prevTick);
      setPreviousSnapshot(snapshot);
    } else {
      setPreviousSnapshot(null);
    }
  }, [state.playbackIndex, state.tickList, getCurrentTick, getPreviousTick, snapshotCache]);

  // Playback animation loop
  useEffect(() => {
    if (!state.playing) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      return;
    }

    const frameInterval = 1000 / state.fps;

    const tick = (timestamp: number) => {
      if (timestamp - lastFrameTimeRef.current >= frameInterval) {
        dispatch({ type: 'NEXT_FRAME' });
        lastFrameTimeRef.current = timestamp;
      }
      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [state.playing, state.fps, dispatch]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_PLAY' });
          break;
        case 'ArrowLeft':
          e.preventDefault();
          dispatch({ type: 'PREV_FRAME' });
          break;
        case 'ArrowRight':
          e.preventDefault();
          dispatch({ type: 'NEXT_FRAME' });
          break;
        case 'Home':
          e.preventDefault();
          dispatch({ type: 'FIRST_FRAME' });
          break;
        case 'End':
          e.preventDefault();
          dispatch({ type: 'LAST_FRAME' });
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dispatch]);

  // Load analysis data when overlay is toggled on
  const handleOverlayToggle = useCallback(async (overlay: keyof OverlayState) => {
    dispatch({ type: 'TOGGLE_OVERLAY', overlay });

    // Check if we need to load analysis data
    const analysisOverlays: Record<string, AnalysisType> = {
      heatmap: 'heatmap',
      oscillations: 'oscillations',
      stuck: 'stuck',
      roads: 'roads',
      bottlenecks: 'bottlenecks',
    };

    const analysisType = analysisOverlays[overlay];
    if (!analysisType || !state.recordingId) return;

    // If toggling on and data not loaded, fetch it
    const analysisKey = overlay as keyof AnalysisData;
    if (!state.overlays[overlay] && !analysisData[analysisKey]) {
      setAnalysisLoading((prev) => ({ ...prev, [overlay]: true }));
      try {
        const response = await fetchAnalysisData(state.recordingId, analysisType);
        setAnalysisData((prev) => ({
          ...prev,
          [overlay]: response.data as HeatmapData | OscillationData | StuckData | RoadData | BottleneckData,
        }));
      } catch (e) {
        console.error(`Failed to load ${analysisType} data`, e);
      }
      setAnalysisLoading((prev) => ({ ...prev, [overlay]: false }));
    }
  }, [dispatch, state.recordingId, state.overlays, analysisData]);

  // Trigger analysis
  const handleAnalyze = useCallback(async (recording: Recording) => {
    try {
      await triggerAnalysis(recording.recordingId);
      // Could refetch recording list to update status
    } catch (e) {
      console.error('Failed to trigger analysis', e);
    }
  }, []);

  // Mouse handlers for canvas
  const handleMouseDown = (e: React.MouseEvent) => {
    dispatch({ type: 'PAN_START', x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    dispatch({ type: 'PAN_MOVE', x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => {
    dispatch({ type: 'PAN_END' });
  };

  const handleMouseLeave = () => {
    dispatch({ type: 'PAN_END' });
    dispatch({ type: 'SET_HOVER', tile: null });
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const centerX = e.clientX - rect.left;
    const centerY = e.clientY - rect.top;
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    dispatch({ type: 'ZOOM_AT', delta, centerX, centerY });
  };

  const handleDoubleClick = () => {
    dispatch({ type: 'RESET_VIEWPORT' });
  };

  const handleHoverChange = (tile: { x: number; y: number } | null) => {
    dispatch({ type: 'SET_HOVER', tile });
  };

  const currentTick = getCurrentTick();
  const isLoading = loadingTerrain || loadingSnapshots;

  return (
    <div className="flex flex-col h-full">
      <Header title="Recordings" />

      <div className="flex-1 flex overflow-hidden bg-[#111]">
        {/* Left sidebar */}
        <div className="w-72 flex-shrink-0 border-r border-[#333] flex flex-col overflow-hidden">
          {/* Recording list */}
          <div className="flex-1 overflow-y-auto p-4">
            <h3 className="text-sm font-medium text-[#888] uppercase tracking-wider mb-3">
              Recordings
            </h3>
            <RecordingList
              recordings={recordings}
              selectedId={state.recordingId}
              loading={recordingsLoading}
              onSelect={loadRecording}
              onAnalyze={handleAnalyze}
            />
          </div>

          {/* Overlay panel */}
          {selectedRecording && (
            <div className="border-t border-[#333] p-4 overflow-y-auto">
              <OverlayPanel
                overlays={state.overlays}
                onToggle={handleOverlayToggle}
                analysisSummary={analysisSummary}
                analysisLoading={analysisLoading}
                analysisAvailable={!!analysisSummary}
              />
            </div>
          )}
        </div>

        {/* Main content area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Canvas area */}
          <div className="flex-1 relative overflow-hidden">
            {!selectedRecording && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-[#888]">Select a recording from the list to begin playback</p>
              </div>
            )}

            {selectedRecording && isLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#111]">
                <div className="text-center">
                  <div className="w-8 h-8 border-2 border-[#4488ff] border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-[#888]">
                    {loadingTerrain ? 'Loading terrain...' : 'Loading snapshots...'}
                  </p>
                </div>
              </div>
            )}

            {selectedRecording && !isLoading && (
              <>
                <RoomCanvas
                  terrain={terrain}
                  snapshot={currentSnapshot}
                  previousSnapshot={previousSnapshot}
                  zoom={state.zoom}
                  panX={state.panX}
                  panY={state.panY}
                  hoverTile={state.hoverTile}
                  overlays={state.overlays}
                  analysis={analysisData}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseLeave}
                  onWheel={handleWheel}
                  onDoubleClick={handleDoubleClick}
                  onHoverChange={handleHoverChange}
                />

                <InfoPanel
                  room={selectedRecording.room}
                  currentTick={currentTick}
                  snapshot={currentSnapshot}
                  playbackIndex={state.playbackIndex}
                  totalFrames={state.tickList.length}
                />
              </>
            )}
          </div>

          {/* Playback controls */}
          {selectedRecording && (
            <PlaybackControls
              playing={state.playing}
              playbackIndex={state.playbackIndex}
              totalFrames={state.tickList.length}
              currentTick={currentTick}
              fps={state.fps}
              onTogglePlay={() => dispatch({ type: 'TOGGLE_PLAY' })}
              onFirstFrame={() => dispatch({ type: 'FIRST_FRAME' })}
              onPrevFrame={() => dispatch({ type: 'PREV_FRAME' })}
              onNextFrame={() => dispatch({ type: 'NEXT_FRAME' })}
              onLastFrame={() => dispatch({ type: 'LAST_FRAME' })}
              onSeek={(index) => dispatch({ type: 'SET_INDEX', index })}
              onFpsChange={(fps) => dispatch({ type: 'SET_FPS', fps })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
