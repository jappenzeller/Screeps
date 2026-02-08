import { useApi } from '../hooks/useApi';
import { fetchColonies } from '../api/colonies';
import type { ColoniesResponse } from '../api/colonies';
import { fetchEmpire, fetchExpansion } from '../api/empire';
import type { EmpireResponse, ExpansionResponse } from '../api/empire';
import { POLL_INTERVALS } from '../utils/constants';
import { formatNumber } from '../utils/formatting';
import { Header } from '../components/layout/Header';
import { GclProgress } from '../components/empire/GclProgress';
import { ColonyCard } from '../components/empire/ColonyCard';
import { ExpansionPanel } from '../components/empire/ExpansionPanel';

export function EmpireOverview() {
  const {
    data: coloniesData,
    meta: coloniesMeta,
    loading: coloniesLoading,
    error: coloniesError,
  } = useApi<ColoniesResponse>(fetchColonies, [], { pollInterval: POLL_INTERVALS.COLONIES });

  const {
    data: empireData,
    loading: empireLoading,
  } = useApi<EmpireResponse>(fetchEmpire, [], { pollInterval: POLL_INTERVALS.EMPIRE });

  const {
    data: expansionData,
    loading: expansionLoading,
    error: expansionError,
  } = useApi<ExpansionResponse>(fetchExpansion, [], { pollInterval: POLL_INTERVALS.EMPIRE });

  const colonies = coloniesData?.colonies || [];
  const totalCreeps = colonies.reduce((sum, c) => sum + c.creepCount, 0);

  return (
    <div className="flex flex-col h-full">
      <Header
        title="Empire Overview"
        gcl={empireData?.gcl}
        gameTick={coloniesMeta?.gameTick || empireData?.gameTick}
        freshness={coloniesMeta?.freshness}
        source={coloniesMeta?.source}
      />

      <div className="flex-1 overflow-auto p-6 bg-[#111]">
        {/* Empire Status Bar */}
        <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-center">
            {/* GCL Progress */}
            <div className="md:col-span-2">
              {empireLoading ? (
                <div className="text-[#888]">Loading GCL...</div>
              ) : empireData?.gcl ? (
                <GclProgress
                  level={empireData.gcl.level}
                  progress={empireData.gcl.progress}
                  progressTotal={empireData.gcl.progressTotal}
                />
              ) : (
                <div className="text-[#888]">GCL data unavailable</div>
              )}
            </div>

            {/* Stats */}
            <div className="text-center">
              <div className="text-2xl font-bold text-[#eee]">{colonies.length}</div>
              <div className="text-sm text-[#888]">Colonies</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-[#eee]">{formatNumber(totalCreeps)}</div>
              <div className="text-sm text-[#888]">Total Creeps</div>
            </div>
          </div>

          {empireData?.state && (
            <div className="mt-3 pt-3 border-t border-[#333] text-sm">
              <span className="text-[#888]">Empire State: </span>
              <span className="text-[#00ff88]">{empireData.state}</span>
            </div>
          )}
        </div>

        {/* Colony Cards Grid */}
        {coloniesLoading ? (
          <div className="text-center py-8 text-[#888]">Loading colonies...</div>
        ) : coloniesError ? (
          <div className="text-center py-8 text-[#ff4444]">
            Failed to load colonies: {coloniesError.message}
          </div>
        ) : colonies.length === 0 ? (
          <div className="text-center py-8 text-[#888]">No colonies found</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-6">
            {colonies.map((colony) => (
              <ColonyCard
                key={colony.roomName}
                colony={colony}
                freshness={coloniesMeta?.freshness}
              />
            ))}
          </div>
        )}

        {/* Expansion Panel */}
        <ExpansionPanel
          active={expansionData?.active || []}
          queue={expansionData?.queue || []}
          loading={expansionLoading}
          error={expansionError}
        />
      </div>
    </div>
  );
}
