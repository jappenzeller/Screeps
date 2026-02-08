import { apiFetch } from './client';

export interface MetricDataPoint {
  timestamp: number;
  tick: number;
  [key: string]: number | string;
}

export function fetchMetrics(room: string, hours: number = 24) {
  return apiFetch<MetricDataPoint[]>(`/metrics/${room}?hours=${hours}`);
}
