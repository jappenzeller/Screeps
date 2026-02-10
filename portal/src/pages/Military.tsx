import { useState, useMemo } from 'react';
import { Header } from '../components/layout/Header';
import { useApi } from '../hooks/useApi';
import { fetchMilitaryStatus, fetchCampaign } from '../api/military';
import { POLL_INTERVALS } from '../utils/constants';
import type { MilitaryStatus, CampaignSummary, CampaignDetail, CampaignPhase, CampaignEvent } from '../types/military';

// Phase colors for visual distinction
const PHASE_COLORS: Record<CampaignPhase, string> = {
  PLANNING: '#888888',
  SCOUTING: '#4488ff',
  ATTACKING: '#ff4444',
  WAITING_SAFE_MODE: '#ffcc00',
  WAITING_COOLDOWN: '#ff8800',
  TOWER_DRAINING: '#ff6600',
  CLAIMING: '#aa88ff',
  SECURING: '#00cc66',
  COMPLETE: '#00ff88',
  ABORTED: '#666666',
  PAUSED: '#888888',
};

// Progress bar component
function ProgressBar({ value, max, color = '#4488ff', label }: { value: number; max: number; color?: string; label?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-[#333] rounded overflow-hidden">
        <div
          className="h-full rounded transition-all duration-300"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      {label && <span className="text-xs text-[#888] min-w-[40px] text-right">{label}</span>}
    </div>
  );
}

// Campaign card component
function CampaignCard({
  campaign,
  selected,
  onClick
}: {
  campaign: CampaignSummary;
  selected: boolean;
  onClick: () => void;
}) {
  const phaseColor = PHASE_COLORS[campaign.state] || '#888888';
  const isActive = !['COMPLETE', 'ABORTED', 'PAUSED'].includes(campaign.state);

  return (
    <div
      className={`p-4 rounded border cursor-pointer transition-all ${
        selected
          ? 'bg-[#222] border-[#00ff88]'
          : 'bg-[#1a1a1a] border-[#333] hover:border-[#444]'
      }`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg font-medium text-[#eee]">{campaign.targetRoom}</span>
          {isActive && (
            <span className="w-2 h-2 rounded-full bg-[#ff4444] animate-pulse" />
          )}
        </div>
        <span
          className="text-xs px-2 py-0.5 rounded font-medium"
          style={{ backgroundColor: phaseColor + '33', color: phaseColor }}
        >
          {campaign.state}
        </span>
      </div>

      <div className="text-sm text-[#888] mb-2">
        vs {campaign.targetOwner} ({campaign.type})
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-[#666]">RCL:</span>{' '}
          <span className="text-[#4488ff]">{campaign.currentRCL ?? '?'}</span>
        </div>
        <div>
          <span className="text-[#666]">Attacks:</span>{' '}
          <span className="text-[#00ff88]">{campaign.attackCount}</span>
        </div>
        {campaign.stats && (
          <>
            <div>
              <span className="text-[#666]">Spawned:</span>{' '}
              <span className="text-[#eee]">{campaign.stats.totalSpawned}</span>
            </div>
            <div>
              <span className="text-[#666]">Lost:</span>{' '}
              <span className="text-[#ff4444]">{campaign.stats.totalLost}</span>
            </div>
          </>
        )}
      </div>

      {campaign.safeModeActive && (
        <div className="mt-2 text-xs text-[#ffcc00] bg-[#ffcc0022] px-2 py-1 rounded">
          Safe Mode Active
        </div>
      )}

      {campaign.towerDrainNeeded && (
        <div className="mt-2 text-xs text-[#ff6600] bg-[#ff660022] px-2 py-1 rounded">
          Tower Drain Needed
        </div>
      )}

      {campaign.conquestPhase && (
        <div className="mt-2 text-xs text-[#aa88ff] bg-[#aa88ff22] px-2 py-1 rounded">
          Conquest: {campaign.conquestPhase}
        </div>
      )}
    </div>
  );
}

// Campaign detail panel
function CampaignDetailPanel({ campaignId }: { campaignId: string }) {
  const { data: campaign, loading, error, meta } = useApi<CampaignDetail>(
    () => fetchCampaign(campaignId),
    [campaignId],
    { pollInterval: POLL_INTERVALS.MILITARY }
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#888]">
        Loading campaign details...
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div className="flex items-center justify-center h-64 text-[#ff4444]">
        {error?.message || 'Failed to load campaign'}
      </div>
    );
  }

  const attack = campaign.controllerAttack;
  const conquest = campaign.conquest;
  const stats = attack?.stats;

  // Calculate progress metrics
  const lossRate = stats && stats.totalSpawned > 0
    ? ((stats.totalLost / stats.totalSpawned) * 100).toFixed(1)
    : '0.0';

  const ticksSinceLastAttack = attack?.lastAttackTick
    ? (meta?.gameTick || 0) - attack.lastAttackTick
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-medium text-[#eee]">{campaign.targetRoom}</h2>
          <p className="text-sm text-[#888]">vs {campaign.targetOwner}</p>
        </div>
        <span
          className="text-sm px-3 py-1 rounded font-medium"
          style={{
            backgroundColor: (PHASE_COLORS[campaign.state] || '#888') + '33',
            color: PHASE_COLORS[campaign.state] || '#888'
          }}
        >
          {campaign.state}
        </span>
      </div>

      {/* Attack Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#222] p-3 rounded">
          <div className="text-xs text-[#666] uppercase mb-1">Target RCL</div>
          <div className="text-2xl font-bold text-[#4488ff]">{attack?.currentTargetRCL ?? '?'}</div>
        </div>
        <div className="bg-[#222] p-3 rounded">
          <div className="text-xs text-[#666] uppercase mb-1">Attacks Landed</div>
          <div className="text-2xl font-bold text-[#00ff88]">{attack?.attackCount ?? 0}</div>
        </div>
        <div className="bg-[#222] p-3 rounded">
          <div className="text-xs text-[#666] uppercase mb-1">Timer (ticks)</div>
          <div className="text-2xl font-bold text-[#ffcc00]">
            {attack?.currentTicksToDowngrade?.toLocaleString() ?? '?'}
          </div>
        </div>
        <div className="bg-[#222] p-3 rounded">
          <div className="text-xs text-[#666] uppercase mb-1">Est. Cycles Left</div>
          <div className="text-2xl font-bold text-[#ff8800]">{attack?.estimatedCyclesRemaining ?? '?'}</div>
        </div>
      </div>

      {/* Progress Bars */}
      {attack && stats && stats.campaignStartTimer > 0 && (
        <div className="bg-[#222] p-4 rounded">
          <div className="text-sm text-[#888] mb-3">Downgrade Progress</div>
          <ProgressBar
            value={stats.campaignStartTimer - (attack.currentTicksToDowngrade || 0)}
            max={stats.campaignStartTimer}
            color="#00ff88"
            label={`${Math.round(((stats.campaignStartTimer - (attack.currentTicksToDowngrade || 0)) / stats.campaignStartTimer) * 100)}%`}
          />
          <div className="text-xs text-[#666] mt-2">
            Started at RCL {stats.campaignStartRCL} with {stats.campaignStartTimer.toLocaleString()} ticks
          </div>
        </div>
      )}

      {/* Spawn Stats */}
      {stats && (
        <div className="bg-[#222] p-4 rounded">
          <div className="text-sm text-[#888] mb-3">Spawn Statistics</div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-[#666]">Spawned:</span>{' '}
              <span className="text-[#eee] font-medium">{stats.totalSpawned}</span>
            </div>
            <div>
              <span className="text-[#666]">Lost:</span>{' '}
              <span className="text-[#ff4444] font-medium">{stats.totalLost}</span>
            </div>
            <div>
              <span className="text-[#666]">Loss Rate:</span>{' '}
              <span className={`font-medium ${parseFloat(lossRate) > 30 ? 'text-[#ff4444]' : 'text-[#eee]'}`}>
                {lossRate}%
              </span>
            </div>
            <div>
              <span className="text-[#666]">Energy Spent:</span>{' '}
              <span className="text-[#ffcc00] font-medium">{stats.totalEnergySpent.toLocaleString()}</span>
            </div>
          </div>
          {stats.rclDowngrades.length > 0 && (
            <div className="mt-3 text-xs text-[#00ff88]">
              RCL Downgrades: {stats.rclDowngrades.length}
            </div>
          )}
          {stats.safeModeActivations > 0 && (
            <div className="mt-1 text-xs text-[#ffcc00]">
              Safe Mode Activations: {stats.safeModeActivations}
            </div>
          )}
        </div>
      )}

      {/* Attack Timing */}
      {attack && (
        <div className="bg-[#222] p-4 rounded">
          <div className="text-sm text-[#888] mb-3">Attack Timing</div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-[#666]">Last Attack:</span>{' '}
              <span className="text-[#eee]">
                {ticksSinceLastAttack !== null ? `${ticksSinceLastAttack} ticks ago` : 'Never'}
              </span>
            </div>
            <div>
              <span className="text-[#666]">Next Attack:</span>{' '}
              <span className="text-[#4488ff]">
                {attack.upgradeBlockedUntil > (meta?.gameTick || 0)
                  ? `in ${attack.upgradeBlockedUntil - (meta?.gameTick || 0)} ticks`
                  : 'Ready'}
              </span>
            </div>
          </div>
          {attack.safeModeActive && (
            <div className="mt-3 p-2 bg-[#ffcc0022] rounded text-sm text-[#ffcc00]">
              Safe Mode ends in {attack.safeModeEndsAt - (meta?.gameTick || 0)} ticks
            </div>
          )}
        </div>
      )}

      {/* Conquest State */}
      {conquest && (
        <div className="bg-[#222] p-4 rounded">
          <div className="text-sm text-[#888] mb-3">Conquest Progress</div>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-[#666]">Phase:</span>{' '}
              <span className="text-[#aa88ff] font-medium">{conquest.phase}</span>
            </div>
            <div>
              <span className="text-[#666]">Structures Left:</span>{' '}
              <span className="text-[#eee]">{conquest.structuresRemaining}</span>
            </div>
            <div>
              <span className="text-[#666]">Demolishers:</span>{' '}
              <span className="text-[#cc0000]">{conquest.demolishersActive}</span>
            </div>
            <div>
              <span className="text-[#666]">Spawns Cleared:</span>{' '}
              <span className={conquest.spawnsCleared ? 'text-[#00ff88]' : 'text-[#ff4444]'}>
                {conquest.spawnsCleared ? 'Yes' : 'No'}
              </span>
            </div>
            <div>
              <span className="text-[#666]">Towers Cleared:</span>{' '}
              <span className={conquest.towersCleared ? 'text-[#00ff88]' : 'text-[#ff4444]'}>
                {conquest.towersCleared ? 'Yes' : 'No'}
              </span>
            </div>
            {conquest.enemyClaimersDetected && (
              <div className="text-[#ff4444]">
                Enemy Claimers Detected!
              </div>
            )}
          </div>
        </div>
      )}

      {/* Event Log */}
      {campaign.eventLog && campaign.eventLog.length > 0 && (
        <div className="bg-[#222] p-4 rounded">
          <div className="text-sm text-[#888] mb-3">Recent Events</div>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {[...campaign.eventLog].reverse().map((event, idx) => (
              <EventLogEntry key={`${event.tick}-${idx}`} event={event} currentTick={meta?.gameTick || 0} />
            ))}
          </div>
        </div>
      )}

      {/* Counter-Intel Alerts */}
      {campaign.counterIntel?.alerts && campaign.counterIntel.alerts.length > 0 && (
        <div className="bg-[#222] p-4 rounded">
          <div className="text-sm text-[#888] mb-3">Counter-Intelligence</div>
          <div className="space-y-2">
            {campaign.counterIntel.alerts.slice(-5).reverse().map((alert, idx) => (
              <div
                key={idx}
                className={`text-xs p-2 rounded ${
                  alert.severity === 'CRITICAL' ? 'bg-[#ff444433] text-[#ff4444]' :
                  alert.severity === 'HIGH' ? 'bg-[#ff880033] text-[#ff8800]' :
                  alert.severity === 'MEDIUM' ? 'bg-[#ffcc0033] text-[#ffcc00]' :
                  'bg-[#88888833] text-[#888888]'
                }`}
              >
                [{alert.severity}] {alert.type}: {alert.detail}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Event log entry component
function EventLogEntry({ event, currentTick }: { event: CampaignEvent; currentTick: number }) {
  const age = currentTick - event.tick;
  const ageStr = age < 1000 ? `${age}t` : age < 100000 ? `${(age / 1000).toFixed(1)}k` : `${(age / 100000).toFixed(1)}M`;

  const typeColors: Record<string, string> = {
    CAMPAIGN_CREATED: '#4488ff',
    STATE_CHANGE: '#888888',
    ATTACK_LANDED: '#00ff88',
    CREEP_LOST: '#ff4444',
    RCL_DOWNGRADE: '#ffcc00',
    SAFE_MODE: '#ff8800',
    CAMPAIGN_COMPLETE: '#00ff88',
    CAMPAIGN_ABORTED: '#666666',
  };

  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="text-[#666] min-w-[50px] text-right">{ageStr} ago</span>
      <span
        className="min-w-[100px] font-medium"
        style={{ color: typeColors[event.type] || '#888888' }}
      >
        {event.type}
      </span>
      <span className="text-[#ccc] flex-1">{event.detail}</span>
    </div>
  );
}

// No campaigns placeholder
function NoCampaigns() {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-[#666]">
      <div className="text-4xl mb-4">&#9872;</div>
      <div className="text-lg mb-2">No Active Campaigns</div>
      <div className="text-sm text-center max-w-md">
        Use the console command <code className="text-[#00ff88]">military.attack("ROOM")</code> to start a campaign.
      </div>
    </div>
  );
}

// Main Military page component
export function Military() {
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);

  const { data: military, loading, error, meta } = useApi<MilitaryStatus>(
    fetchMilitaryStatus,
    [],
    { pollInterval: POLL_INTERVALS.MILITARY }
  );

  // Auto-select first campaign if none selected
  const campaigns = useMemo(() => military?.campaigns || [], [military]);

  // Auto-select the first active campaign
  useMemo(() => {
    if (!selectedCampaignId && campaigns.length > 0) {
      // Prefer active campaigns
      const active = campaigns.find(c => !['COMPLETE', 'ABORTED'].includes(c.state));
      setSelectedCampaignId(active?.id || campaigns[0].id);
    }
  }, [campaigns, selectedCampaignId]);

  const postureColor = military?.posture === 'OFFENSIVE' ? '#ff4444' :
                       military?.posture === 'ALERT' ? '#ffcc00' :
                       '#00ff88';

  return (
    <div className="flex flex-col h-full">
      <Header
        title="Military Operations"
        gameTick={meta?.gameTick}
        freshness={meta?.freshness}
        source={meta?.source}
      />

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden bg-[#111]">
        {/* Campaign List (left panel) */}
        <div className="lg:w-80 border-b lg:border-b-0 lg:border-r border-[#333] p-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-[#888] uppercase tracking-wider">
              Campaigns
            </h3>
            <span
              className="text-xs px-2 py-0.5 rounded font-medium"
              style={{ backgroundColor: postureColor + '33', color: postureColor }}
            >
              {military?.posture || 'PEACEFUL'}
            </span>
          </div>

          {loading ? (
            <div className="text-sm text-[#666]">Loading...</div>
          ) : error ? (
            <div className="text-sm text-[#ff4444]">{error.message}</div>
          ) : campaigns.length === 0 ? (
            <div className="text-sm text-[#666]">No campaigns</div>
          ) : (
            <div className="space-y-3">
              {campaigns.map(campaign => (
                <CampaignCard
                  key={campaign.id}
                  campaign={campaign}
                  selected={campaign.id === selectedCampaignId}
                  onClick={() => setSelectedCampaignId(campaign.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Campaign Detail (right panel) */}
        <div className="flex-1 p-4 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-64 text-[#888]">
              Loading military status...
            </div>
          ) : campaigns.length === 0 ? (
            <NoCampaigns />
          ) : selectedCampaignId ? (
            <CampaignDetailPanel campaignId={selectedCampaignId} />
          ) : (
            <div className="flex items-center justify-center h-64 text-[#666]">
              Select a campaign to view details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
