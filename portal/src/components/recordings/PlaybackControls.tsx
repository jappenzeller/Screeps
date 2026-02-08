interface PlaybackControlsProps {
  playing: boolean;
  playbackIndex: number;
  totalFrames: number;
  currentTick: number | null;
  fps: number;
  onTogglePlay: () => void;
  onFirstFrame: () => void;
  onPrevFrame: () => void;
  onNextFrame: () => void;
  onLastFrame: () => void;
  onSeek: (index: number) => void;
  onFpsChange: (fps: number) => void;
}

export function PlaybackControls({
  playing,
  playbackIndex,
  totalFrames,
  currentTick,
  fps,
  onTogglePlay,
  onFirstFrame,
  onPrevFrame,
  onNextFrame,
  onLastFrame,
  onSeek,
  onFpsChange,
}: PlaybackControlsProps) {
  return (
    <div className="bg-[#1a1a1a] border-t border-[#333] px-4 py-3">
      <div className="flex items-center gap-4">
        {/* Transport controls */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onFirstFrame}
            className="w-8 h-8 flex items-center justify-center bg-[#222] border border-[#333] rounded hover:bg-[#333] text-[#888] hover:text-[#eee] transition-colors"
            title="First frame (Home)"
          >
            |◀
          </button>
          <button
            type="button"
            onClick={onPrevFrame}
            className="w-8 h-8 flex items-center justify-center bg-[#222] border border-[#333] rounded hover:bg-[#333] text-[#888] hover:text-[#eee] transition-colors"
            title="Previous frame (←)"
          >
            ◀
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            className={`w-10 h-8 flex items-center justify-center border rounded transition-colors ${
              playing
                ? 'bg-[#00ff8833] border-[#00ff88] text-[#00ff88]'
                : 'bg-[#222] border-[#333] text-[#888] hover:bg-[#333] hover:text-[#eee]'
            }`}
            title="Play/Pause (Space)"
          >
            {playing ? '⏸' : '▶'}
          </button>
          <button
            type="button"
            onClick={onNextFrame}
            className="w-8 h-8 flex items-center justify-center bg-[#222] border border-[#333] rounded hover:bg-[#333] text-[#888] hover:text-[#eee] transition-colors"
            title="Next frame (→)"
          >
            ▶
          </button>
          <button
            type="button"
            onClick={onLastFrame}
            className="w-8 h-8 flex items-center justify-center bg-[#222] border border-[#333] rounded hover:bg-[#333] text-[#888] hover:text-[#eee] transition-colors"
            title="Last frame (End)"
          >
            ▶|
          </button>
        </div>

        {/* Scrubber */}
        <div className="flex-1 flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={Math.max(0, totalFrames - 1)}
            value={playbackIndex}
            onChange={(e) => onSeek(parseInt(e.target.value, 10))}
            className="flex-1 h-2 bg-[#333] rounded-lg appearance-none cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none
              [&::-webkit-slider-thumb]:w-4
              [&::-webkit-slider-thumb]:h-4
              [&::-webkit-slider-thumb]:rounded-full
              [&::-webkit-slider-thumb]:bg-[#00ff88]
              [&::-webkit-slider-thumb]:cursor-pointer"
          />
        </div>

        {/* Tick info */}
        <div className="text-xs text-[#888] min-w-[180px]">
          <span className="text-[#eee]">
            Tick: {currentTick?.toLocaleString() ?? '—'}
          </span>
          <span className="ml-3">
            Frame: {playbackIndex + 1} / {totalFrames}
          </span>
        </div>

        {/* Speed control */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#888]">Speed:</span>
          <input
            type="range"
            min={1}
            max={30}
            value={fps}
            onChange={(e) => onFpsChange(parseInt(e.target.value, 10))}
            className="w-20 h-2 bg-[#333] rounded-lg appearance-none cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none
              [&::-webkit-slider-thumb]:w-3
              [&::-webkit-slider-thumb]:h-3
              [&::-webkit-slider-thumb]:rounded-full
              [&::-webkit-slider-thumb]:bg-[#4488ff]
              [&::-webkit-slider-thumb]:cursor-pointer"
          />
          <span className="text-xs text-[#eee] w-12">{fps} fps</span>
        </div>
      </div>
    </div>
  );
}
