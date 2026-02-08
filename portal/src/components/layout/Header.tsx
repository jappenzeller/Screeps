import { FreshnessIndicator } from './FreshnessIndicator';
import { formatNumber } from '../../utils/formatting';

interface HeaderProps {
  title: string;
  gcl?: { level: number; progress: number; progressTotal: number };
  gameTick?: number;
  freshness?: number;
  source?: string;
}

export function Header({ title, gcl, gameTick, freshness, source }: HeaderProps) {
  return (
    <header className="h-12 bg-[#1a1a1a] border-b border-[#333] flex items-center justify-between px-4">
      <h1 className="text-lg font-medium text-[#eee]">{title}</h1>

      <div className="flex items-center gap-6">
        {gcl && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[#888]">GCL</span>
            <span className="text-[#4488ff] font-medium">{gcl.level}</span>
          </div>
        )}

        {gameTick && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[#888]">Tick</span>
            <span className="text-[#eee] font-mono">{formatNumber(gameTick)}</span>
          </div>
        )}

        {freshness !== undefined && (
          <FreshnessIndicator freshness={freshness} source={source} />
        )}
      </div>
    </header>
  );
}
