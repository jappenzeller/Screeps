import { formatFreshness, freshnessColor } from '../../utils/formatting';

interface FreshnessIndicatorProps {
  freshness: number;
  source?: string;
  size?: 'sm' | 'md';
}

export function FreshnessIndicator({ freshness, source, size = 'md' }: FreshnessIndicatorProps) {
  const color = freshnessColor(freshness);
  const dotSize = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';

  return (
    <div className="flex items-center gap-1.5 group" title={source ? `Source: ${source}` : undefined}>
      <span
        className={`${dotSize} rounded-full`}
        style={{ backgroundColor: color }}
      />
      <span className={`${textSize} text-[#888]`}>
        {formatFreshness(freshness)}
      </span>
    </div>
  );
}
