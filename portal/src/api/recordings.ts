import { apiFetch } from './client';
import type { ApiMeta } from './client';
import type {
  Recording,
  RecordingDetail,
  SnapshotIndex,
  Snapshot,
  TerrainData,
  AnalysisSummary,
  AnalysisType,
  HeatmapData,
  OscillationData,
  StuckData,
  RoadData,
  BottleneckData,
} from '../types/recordings';

// --- Recordings List ---
interface RawRecordingsResponse {
  recordings: Recording[];
  count: number;
}

export async function fetchRecordings(): Promise<{ data: Recording[]; meta: ApiMeta }> {
  const raw = await apiFetch<RawRecordingsResponse | Recording[]>('/recordings');

  // Handle bare array response
  if (Array.isArray(raw.data)) {
    return { data: raw.data, meta: raw.meta };
  }

  // Handle { recordings: [...] } response
  if (raw.data && typeof raw.data === 'object' && 'recordings' in raw.data) {
    return {
      data: Array.isArray(raw.data.recordings) ? raw.data.recordings : [],
      meta: raw.meta,
    };
  }

  return { data: [], meta: raw.meta };
}

// --- Single Recording ---
export function fetchRecording(id: string) {
  return apiFetch<RecordingDetail>(`/recordings/${id}`);
}

// --- Snapshot Index (API returns bare array of tick numbers) ---
export async function fetchSnapshotIndex(id: string): Promise<{ data: SnapshotIndex; meta: ApiMeta }> {
  const raw = await apiFetch<number[] | SnapshotIndex>(`/recordings/${id}/snapshots`);

  // API returns bare array of tick numbers
  if (Array.isArray(raw.data)) {
    const ticks = (raw.data as number[]).sort((a, b) => a - b);
    return {
      data: { ticks, count: ticks.length },
      meta: raw.meta,
    };
  }

  // If it already has the expected shape
  if (raw.data && typeof raw.data === 'object' && 'ticks' in raw.data) {
    return raw as { data: SnapshotIndex; meta: ApiMeta };
  }

  // Fallback
  return { data: { ticks: [], count: 0 }, meta: raw.meta };
}

// --- Snapshot ---
export function fetchSnapshot(id: string, tick: number) {
  return apiFetch<Snapshot>(`/recordings/${id}/snapshots/${tick}`);
}

// --- Terrain (API returns { room, encoded, capturedAt }, we extract encoded string) ---
export async function fetchTerrain(id: string): Promise<{ data: string; meta: ApiMeta }> {
  const raw = await apiFetch<TerrainData | string>(`/recordings/${id}/terrain`);

  // If already a string (unlikely but handle it)
  if (typeof raw.data === 'string') {
    return raw as { data: string; meta: ApiMeta };
  }

  // Extract encoded terrain string from response object
  if (raw.data && typeof raw.data === 'object') {
    const obj = raw.data as TerrainData;
    return {
      data: obj.encoded || '',
      meta: raw.meta,
    };
  }

  return { data: '', meta: raw.meta };
}

// --- Analysis ---
export function fetchAnalysisSummary(id: string) {
  return apiFetch<AnalysisSummary>(`/recordings/${id}/analysis`);
}

export function fetchAnalysisData(id: string, type: AnalysisType) {
  return apiFetch<HeatmapData | OscillationData | StuckData | RoadData | BottleneckData>(
    `/recordings/${id}/analysis/${type}`
  );
}

export function triggerAnalysis(id: string) {
  return apiFetch<{ success: boolean }>(`/recordings/${id}/analyze`, { method: 'POST' });
}
