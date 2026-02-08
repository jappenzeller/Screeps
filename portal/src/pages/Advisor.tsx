import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Header } from '../components/layout/Header';
import { ColonySelector } from '../components/advisor/ColonySelector';
import { SummaryBar } from '../components/advisor/SummaryBar';
import { RecommendationCard } from '../components/advisor/RecommendationCard';
import { SignalTimeline } from '../components/advisor/SignalTimeline';
import { EventList } from '../components/advisor/EventList';
import { TrendSummary } from '../components/advisor/TrendSummary';
import { ObservationFeed } from '../components/advisor/ObservationFeed';
import { PatternTracker } from '../components/advisor/PatternTracker';
import { useApi } from '../hooks/useApi';
import { fetchColonies } from '../api/colonies';
import {
  fetchRecommendations,
  fetchSignals,
  fetchSignalEvents,
  fetchObservations,
  fetchPatterns,
  submitFeedback,
} from '../api/analysis';
import type { ColoniesResponse } from '../api/colonies';
import type {
  Recommendation,
  SignalResponse,
  SignalEventResponse,
  ObservationResponse,
  PatternResponse,
} from '../types/analysis';
import { POLL_INTERVALS } from '../utils/constants';

type StatusFilter = 'all' | 'pending' | 'applied' | 'dismissed';
type SortOption = 'priority' | 'newest' | 'oldest';

export function Advisor() {
  const [searchParams] = useSearchParams();
  const [selectedRoom, setSelectedRoom] = useState<string>('');
  const [signalHours, setSignalHours] = useState(24);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [sortBy, setSortBy] = useState<SortOption>('priority');
  const [feedbackOverrides, setFeedbackOverrides] = useState<Record<string, string>>({});

  // Fetch colonies
  const { data: coloniesData } = useApi<ColoniesResponse>(
    () => fetchColonies(),
    [],
    { pollInterval: POLL_INTERVALS.COLONIES }
  );

  const colonies = useMemo(
    () => coloniesData?.colonies.map((c) => c.roomName) ?? [],
    [coloniesData]
  );

  // Set default room when colonies load or URL param changes
  useEffect(() => {
    if (colonies.length > 0 && !selectedRoom) {
      const roomFromUrl = searchParams.get('room');
      if (roomFromUrl && colonies.includes(roomFromUrl)) {
        setSelectedRoom(roomFromUrl);
      } else {
        setSelectedRoom(colonies[0]);
      }
    }
  }, [colonies, selectedRoom, searchParams]);

  // Fetch analysis data for selected room
  const isAllRooms = selectedRoom === 'all';

  const { data: recsData, refetch: refetchRecs } = useApi<Recommendation[]>(
    () => (selectedRoom && !isAllRooms ? fetchRecommendations(selectedRoom) : Promise.resolve({ data: [], meta: {} as any })),
    [selectedRoom],
    { pollInterval: POLL_INTERVALS.ANALYSIS, enabled: !!selectedRoom && !isAllRooms }
  );

  const { data: signalsData } = useApi<SignalResponse>(
    () => (selectedRoom && !isAllRooms ? fetchSignals(selectedRoom, signalHours) : Promise.resolve({ data: null as unknown as SignalResponse, meta: {} as any })),
    [selectedRoom, signalHours],
    { pollInterval: POLL_INTERVALS.ANALYSIS, enabled: !!selectedRoom && !isAllRooms }
  );

  const { data: eventsData } = useApi<SignalEventResponse>(
    () => (selectedRoom && !isAllRooms ? fetchSignalEvents(selectedRoom, signalHours) : Promise.resolve({ data: null as unknown as SignalEventResponse, meta: {} as any })),
    [selectedRoom, signalHours],
    { pollInterval: POLL_INTERVALS.ANALYSIS, enabled: !!selectedRoom && !isAllRooms }
  );

  const { data: observationsData } = useApi<ObservationResponse>(
    () => (selectedRoom && !isAllRooms ? fetchObservations(selectedRoom, 10) : Promise.resolve({ data: null as unknown as ObservationResponse, meta: {} as any })),
    [selectedRoom],
    { pollInterval: POLL_INTERVALS.ANALYSIS, enabled: !!selectedRoom && !isAllRooms }
  );

  const { data: patternsData } = useApi<PatternResponse>(
    () => (selectedRoom && !isAllRooms ? fetchPatterns(selectedRoom) : Promise.resolve({ data: null as unknown as PatternResponse, meta: {} as any })),
    [selectedRoom],
    { pollInterval: POLL_INTERVALS.ANALYSIS, enabled: !!selectedRoom && !isAllRooms }
  );

  // Extract data with defaults
  const recommendations = recsData ?? [];
  const signals = signalsData?.events ?? [];
  const trends = signalsData?.trends ?? {};
  const events = eventsData?.events ?? [];
  const observations = observationsData?.observations ?? [];
  const patterns = patternsData?.patterns ?? [];

  // Calculate recommendation counts per room for the colony selector
  const recCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const rec of recommendations) {
      if (rec.status === 'pending') {
        counts[rec.roomName] = (counts[rec.roomName] || 0) + 1;
      }
    }
    return counts;
  }, [recommendations]);

  const criticalCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const rec of recommendations) {
      if (rec.status === 'pending' && rec.priority === 1) {
        counts[rec.roomName] = (counts[rec.roomName] || 0) + 1;
      }
    }
    return counts;
  }, [recommendations]);

  // Filter and sort recommendations
  const filteredRecs = useMemo(() => {
    let recs = [...recommendations];

    // Apply status filter
    if (statusFilter !== 'all') {
      recs = recs.filter((r) => {
        const effectiveStatus = feedbackOverrides[r.id] || r.status;
        return effectiveStatus === statusFilter;
      });
    }

    // Apply sort
    recs.sort((a, b) => {
      if (sortBy === 'priority') {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return b.createdAt - a.createdAt;
      }
      if (sortBy === 'newest') {
        return b.createdAt - a.createdAt;
      }
      return a.createdAt - b.createdAt;
    });

    return recs;
  }, [recommendations, statusFilter, sortBy, feedbackOverrides]);

  // Last analysis time from most recent observation
  const lastAnalysisTime = observations.length > 0 ? observations[0].timestamp : undefined;

  // Feedback handler
  const handleFeedback = async (recId: string, action: string) => {
    // Optimistic update
    setFeedbackOverrides((prev) => ({ ...prev, [recId]: action }));

    try {
      await submitFeedback(selectedRoom, recId, { action: action as any });
      // Refetch to get updated data
      refetchRecs();
    } catch {
      // Revert on failure
      setFeedbackOverrides((prev) => {
        const next = { ...prev };
        delete next[recId];
        return next;
      });
    }
  };

  if (!selectedRoom) {
    return (
      <div className="flex flex-col h-full">
        <Header title="AI Advisor" />
        <div className="flex-1 flex items-center justify-center bg-[#111]">
          <div className="w-8 h-8 border-2 border-[#4488ff] border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="AI Advisor" />

      <div className="flex-1 overflow-auto bg-[#111]">
        <div className="p-6 space-y-6">
          {/* Colony Selector */}
          <ColonySelector
            colonies={colonies}
            selected={selectedRoom}
            onSelect={setSelectedRoom}
            recCounts={recCounts}
            criticalCounts={criticalCounts}
          />

          {isAllRooms ? (
            <div className="text-center py-12 text-[#888]">
              Select a specific colony to view analysis
            </div>
          ) : (
            <>
              {/* Summary Bar */}
              <SummaryBar
                recommendations={recommendations}
                events={events}
                lastAnalysisTime={lastAnalysisTime}
                signalHours={signalHours}
              />

              {/* Two-column layout: Recommendations + Signals */}
              <div className="grid grid-cols-1 lg:grid-cols-[55%_45%] gap-6">
                {/* Recommendations column */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-[#888] uppercase tracking-wider">
                      Recommendations
                    </h3>
                    <div className="flex items-center gap-4">
                      {/* Status filter */}
                      <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                        className="bg-[#222] text-[#ccc] text-xs px-2 py-1 rounded border border-[#333]"
                      >
                        <option value="all">All</option>
                        <option value="pending">Pending</option>
                        <option value="applied">Applied</option>
                        <option value="dismissed">Dismissed</option>
                      </select>

                      {/* Sort */}
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as SortOption)}
                        className="bg-[#222] text-[#ccc] text-xs px-2 py-1 rounded border border-[#333]"
                      >
                        <option value="priority">Priority</option>
                        <option value="newest">Newest</option>
                        <option value="oldest">Oldest</option>
                      </select>
                    </div>
                  </div>

                  <div className="text-xs text-[#666]">
                    Showing {filteredRecs.length} of {recommendations.length} recommendations
                  </div>

                  {filteredRecs.length === 0 ? (
                    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-6 text-center">
                      <p className="text-[#888]">No recommendations for {selectedRoom}</p>
                      <p className="text-[#666] text-sm mt-1">
                        The analysis engine runs hourly — check back soon
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {filteredRecs.map((rec) => (
                        <RecommendationCard
                          key={rec.id}
                          rec={rec}
                          onFeedback={handleFeedback}
                          feedbackOverride={feedbackOverrides[rec.id]}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Signals column */}
                <div className="space-y-4">
                  <h3 className="text-sm font-medium text-[#888] uppercase tracking-wider">
                    Signals & Events
                  </h3>

                  {/* Signal Timeline */}
                  <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
                    <SignalTimeline
                      events={signals}
                      hours={signalHours}
                      onHoursChange={setSignalHours}
                    />
                  </div>

                  {/* Trend Summary */}
                  <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
                    <h4 className="text-xs text-[#888] uppercase tracking-wider mb-3">Trends</h4>
                    <TrendSummary trends={trends} />
                  </div>

                  {/* Event List */}
                  <div className="bg-[#1a1a1a] border border-[#333] rounded-lg p-4">
                    <h4 className="text-xs text-[#888] uppercase tracking-wider mb-3">Recent Events</h4>
                    <EventList events={events} maxItems={10} />
                  </div>
                </div>
              </div>

              {/* Observation Feed */}
              <div>
                <h3 className="text-sm font-medium text-[#888] uppercase tracking-wider mb-4">
                  Observations
                </h3>
                <ObservationFeed observations={observations} />
              </div>

              {/* Pattern Tracker */}
              <div>
                <h3 className="text-sm font-medium text-[#888] uppercase tracking-wider mb-4">
                  Detected Patterns
                </h3>
                <PatternTracker patterns={patterns} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
