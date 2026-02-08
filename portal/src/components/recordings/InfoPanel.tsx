import type { Snapshot } from '../../types/recordings';

interface InfoPanelProps {
  room: string | null;
  currentTick: number | null;
  snapshot: Snapshot | null;
  playbackIndex: number;
  totalFrames: number;
}

export function InfoPanel({
  room,
  currentTick,
  snapshot,
  playbackIndex,
  totalFrames,
}: InfoPanelProps) {
  const creepCount = snapshot?.creeps?.length ?? 0;
  const structureCount = snapshot?.structures?.length ?? 0;

  return (
    <div className="absolute top-2 right-2 bg-[#1a1a1aee] border border-[#333] rounded-lg p-3 text-xs min-w-[140px]">
      <h4 className="text-[#888] mb-2 font-medium">Recording Info</h4>
      <div className="space-y-1">
        <div className="flex justify-between">
          <span className="text-[#888]">Room:</span>
          <span className="text-[#eee]">{room || '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#888]">Tick:</span>
          <span className="text-[#eee]">{currentTick?.toLocaleString() ?? '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#888]">Creeps:</span>
          <span className="text-[#eee]">{creepCount}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#888]">Structures:</span>
          <span className="text-[#eee]">{structureCount}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#888]">Frame:</span>
          <span className="text-[#eee]">
            {playbackIndex + 1} / {totalFrames}
          </span>
        </div>
      </div>
    </div>
  );
}
