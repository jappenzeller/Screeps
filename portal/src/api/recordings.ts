import { apiFetch } from './client';
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

export function fetchRecordings() {
  return apiFetch<Recording[]>('/recordings');
}

export function fetchRecording(id: string) {
  return apiFetch<RecordingDetail>(`/recordings/${id}`);
}

export function fetchSnapshotIndex(id: string) {
  return apiFetch<SnapshotIndex>(`/recordings/${id}/snapshots`);
}

export function fetchSnapshot(id: string, tick: number) {
  return apiFetch<Snapshot>(`/recordings/${id}/snapshots/${tick}`);
}

export function fetchTerrain(id: string) {
  return apiFetch<TerrainData>(`/recordings/${id}/terrain`);
}

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
