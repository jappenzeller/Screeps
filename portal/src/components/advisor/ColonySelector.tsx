interface ColonySelectorProps {
  colonies: string[];
  selected: string;
  onSelect: (room: string) => void;
  recCounts?: Record<string, number>;
  criticalCounts?: Record<string, number>;
}

export function ColonySelector({
  colonies,
  selected,
  onSelect,
  recCounts = {},
  criticalCounts = {},
}: ColonySelectorProps) {
  return (
    <div className="flex gap-1 overflow-x-auto pb-2 border-b border-[#333]">
      {colonies.map((room) => {
        const isActive = room === selected;
        const pendingCount = recCounts[room] || 0;
        const criticalCount = criticalCounts[room] || 0;

        return (
          <button
            type="button"
            key={room}
            onClick={() => onSelect(room)}
            className={`px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-[2px] flex items-center gap-2 ${
              isActive
                ? 'text-[#00ff88] border-[#00ff88]'
                : 'text-[#888] border-transparent hover:text-[#eee]'
            }`}
          >
            {room}
            {pendingCount > 0 && (
              <span
                className={`px-1.5 py-0.5 text-xs rounded-full ${
                  criticalCount > 0
                    ? 'bg-[#ff444433] text-[#ff4444]'
                    : 'bg-[#ffcc0033] text-[#ffcc00]'
                }`}
              >
                {pendingCount}
              </span>
            )}
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => onSelect('all')}
        className={`px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-[2px] ${
          selected === 'all'
            ? 'text-[#00ff88] border-[#00ff88]'
            : 'text-[#888] border-transparent hover:text-[#eee]'
        }`}
      >
        All
      </button>
    </div>
  );
}
