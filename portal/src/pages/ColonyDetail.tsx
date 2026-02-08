import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { fetchColony } from '../api/colonies';
import type { ColonyDetail as ColonyDetailType } from '../types/colony';
import { POLL_INTERVALS } from '../utils/constants';
import { formatNumber } from '../utils/formatting';
import { Header } from '../components/layout/Header';
import { FreshnessIndicator } from '../components/layout/FreshnessIndicator';
import { CreepRoster } from '../components/colony/CreepRoster';
import { EconomyPanel } from '../components/colony/EconomyPanel';
import { RemoteMining } from '../components/colony/RemoteMining';
import { InfrastructurePanel } from '../components/colony/InfrastructurePanel';
import { MetricsPanel } from '../components/metrics/MetricsPanel';

type TabType = 'economy' | 'creeps' | 'remotes' | 'metrics' | 'infrastructure';

export function ColonyDetail() {
  const { roomName } = useParams<{ roomName: string }>();
  const [activeTab, setActiveTab] = useState<TabType>('economy');

  const {
    data: colony,
    meta,
    loading,
    error,
  } = useApi<ColonyDetailType>(
    () => fetchColony(roomName!),
    [roomName],
    { pollInterval: POLL_INTERVALS.COLONY_DETAIL, enabled: !!roomName }
  );

  if (!roomName) {
    return (
      <div className="flex flex-col h-full">
        <Header title="Colony" />
        <div className="flex-1 flex items-center justify-center bg-[#111]">
          <p className="text-[#888]">No room specified</p>
        </div>
      </div>
    );
  }

  if (loading && !colony) {
    return (
      <div className="flex flex-col h-full">
        <Header title={`Colony: ${roomName}`} />
        <div className="flex-1 flex items-center justify-center bg-[#111]">
          <div className="w-8 h-8 border-2 border-[#4488ff] border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (error && !colony) {
    return (
      <div className="flex flex-col h-full">
        <Header title={`Colony: ${roomName}`} />
        <div className="flex-1 flex items-center justify-center bg-[#111]">
          <div className="text-center">
            <p className="text-[#ff4444] mb-2">Failed to load colony data</p>
            <p className="text-[#888] text-sm">{error.message}</p>
          </div>
        </div>
      </div>
    );
  }

  const rclPercent = colony?.rclProgressTotal
    ? (colony.rclProgress / colony.rclProgressTotal) * 100
    : 0;

  const isMaxRcl = colony?.rcl === 8;

  return (
    <div className="flex flex-col h-full">
      <Header
        title={roomName}
        gcl={undefined}
        gameTick={meta?.gameTick}
        freshness={meta?.freshness}
        source={meta?.source}
      />

      <div className="flex-1 overflow-auto p-6 bg-[#111]">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold text-[#eee]">{roomName}</h1>
            <span className="px-3 py-1 bg-[#4488ff33] text-[#4488ff] rounded-full text-sm font-medium">
              RCL {colony?.rcl ?? '?'}
            </span>
            {colony?.phase && (
              <span className="px-3 py-1 bg-[#00ff8833] text-[#00ff88] rounded-full text-sm">
                {colony.phase}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            {/* Cross-page navigation */}
            <Link
              to={`/intel?focus=${roomName}`}
              className="text-sm text-[#4488ff] hover:text-[#66aaff] transition-colors"
            >
              View on Map →
            </Link>
            <Link
              to={`/advisor?room=${roomName}`}
              className="text-sm text-[#aa88ff] hover:text-[#ccaaff] transition-colors"
            >
              AI Analysis →
            </Link>
            {meta?.freshness !== undefined && (
              <FreshnessIndicator freshness={meta.freshness} source={meta.source} />
            )}
          </div>
        </div>

        {/* Overview Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <OverviewCard
            title="Energy"
            primary={formatNumber(colony?.energy?.stored ?? 0)}
            secondary={`${colony?.energy?.available ?? 0}/${colony?.energy?.capacity ?? 0}`}
            trend={colony?.economy?.storageTrend}
            barValue={colony?.energy?.stored ?? 0}
            barMax={500000}
            barColor="#00ff88"
          />
          <OverviewCard
            title="Creeps"
            primary={String(colony?.creeps?.total ?? 0)}
            secondary={getTopRoles(colony?.creeps?.byRole ?? {})}
          />
          <ThreatCard
            hostileCount={colony?.threats?.hostileCount ?? 0}
            hostileDPS={colony?.threats?.hostileDPS ?? 0}
            towerCount={colony?.defense?.towerCount ?? 0}
          />
          <SpawnCard spawns={colony?.structureDetails?.spawns ?? null} />
        </div>

        {/* RCL Progress */}
        <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold text-[#4488ff]">RCL {colony?.rcl ?? '?'}</span>
              {isMaxRcl && <span className="text-sm text-[#00ff88]">MAX</span>}
            </div>
            {!isMaxRcl && (
              <span className="text-sm text-[#888]">
                {formatNumber(colony?.rclProgress ?? 0)} / {formatNumber(colony?.rclProgressTotal ?? 0)} ({rclPercent.toFixed(1)}%)
              </span>
            )}
          </div>
          {!isMaxRcl && (
            <div className="h-3 bg-[#333] rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[#4488ff] to-[#2266cc] transition-all duration-300"
                style={{ width: `${rclPercent}%` }}
              />
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-[#333]">
          {(['economy', 'creeps', 'remotes', 'metrics', 'infrastructure'] as TabType[]).map((tab) => (
            <button
              type="button"
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? 'text-[#00ff88] border-[#00ff88]'
                  : 'text-[#888] border-transparent hover:text-[#eee]'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="min-h-[400px]">
          {activeTab === 'economy' && (
            <EconomyPanel
              economy={colony?.economy ?? null}
              links={colony?.structureDetails?.links ?? null}
              containers={colony?.structureDetails?.containers ?? null}
              spawns={colony?.structureDetails?.spawns ?? null}
              loading={loading && !colony}
            />
          )}
          {activeTab === 'creeps' && (
            <CreepRoster
              creeps={colony?.creeps?.details ?? null}
              byRole={colony?.creeps?.byRole ?? {}}
              loading={loading && !colony}
            />
          )}
          {activeTab === 'remotes' && (
            <RemoteMining roomName={roomName} />
          )}
          {activeTab === 'metrics' && (
            <MetricsPanel roomName={roomName} rcl={colony?.rcl ?? 1} />
          )}
          {activeTab === 'infrastructure' && (
            <InfrastructurePanel
              defense={colony?.defense ?? null}
              structures={colony?.structures ?? null}
              loading={loading && !colony}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function getTopRoles(byRole: Record<string, number>): string {
  const sorted = Object.entries(byRole)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  if (sorted.length === 0) return 'None';

  return sorted
    .map(([role, count]) => `${count} ${role.slice(0, 4)}`)
    .join(' · ');
}

interface OverviewCardProps {
  title: string;
  primary: string;
  secondary?: string;
  trend?: 'rising' | 'falling' | 'stable';
  barValue?: number;
  barMax?: number;
  barColor?: string;
}

function OverviewCard({ title, primary, secondary, trend, barValue, barMax, barColor }: OverviewCardProps) {
  const trendIcon = trend === 'rising' ? '↑' : trend === 'falling' ? '↓' : trend ? '→' : null;
  const trendColor = trend === 'rising' ? '#00ff88' : trend === 'falling' ? '#ff4444' : '#888';

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
      <div className="text-xs text-[#888] mb-1">{title}</div>
      <div className="flex items-center gap-2">
        <span className="text-2xl font-bold text-[#eee]">{primary}</span>
        {trendIcon && (
          <span style={{ color: trendColor }} className="text-lg">{trendIcon}</span>
        )}
      </div>
      {secondary && <div className="text-xs text-[#888] mt-1">{secondary}</div>}
      {barValue !== undefined && barMax && (
        <div className="h-1.5 bg-[#333] rounded-full overflow-hidden mt-2">
          <div
            className="h-full transition-all"
            style={{
              width: `${Math.min((barValue / barMax) * 100, 100)}%`,
              backgroundColor: barColor ?? '#00ff88',
            }}
          />
        </div>
      )}
    </div>
  );
}

function ThreatCard({
  hostileCount,
  hostileDPS,
  towerCount,
}: {
  hostileCount: number;
  hostileDPS: number;
  towerCount: number;
}) {
  const isSafe = hostileCount === 0;

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
      <div className="text-xs text-[#888] mb-1">Threats</div>
      {isSafe ? (
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[#00ff88]" />
          <span className="text-xl font-bold text-[#00ff88]">SAFE</span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[#ff4444]" />
          <span className="text-xl font-bold text-[#ff4444]">{hostileCount}</span>
        </div>
      )}
      <div className="text-xs text-[#888] mt-1">
        {isSafe ? `${towerCount} towers` : `${hostileDPS} DPS · ${towerCount} towers`}
      </div>
    </div>
  );
}

function SpawnCard({ spawns }: { spawns: Array<{ name: string; spawning: string | null; energy: number }> | null }) {
  const activeSpawn = spawns?.find((s) => s.spawning);

  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
      <div className="text-xs text-[#888] mb-1">Spawns</div>
      {activeSpawn ? (
        <>
          <div className="text-lg font-bold text-[#ffcc00] truncate">{activeSpawn.spawning}</div>
          <div className="text-xs text-[#888] mt-1">@ {activeSpawn.name}</div>
        </>
      ) : (
        <>
          <div className="text-xl font-bold text-[#666]">Idle</div>
          <div className="text-xs text-[#888] mt-1">
            {spawns?.length ?? 0} spawn{(spawns?.length ?? 0) !== 1 ? 's' : ''}
          </div>
        </>
      )}
    </div>
  );
}
