import { apiFetch } from './client';

export interface GclData {
  level: number;
  progress: number;
  progressTotal: number;
}

// Note: source, freshness, gameTick are stripped by apiFetch and put in meta
export interface EmpireResponse {
  live: boolean;
  timestamp: number;
  shard: string;
  gcl?: GclData;
  state?: string;
  cpu?: {
    used: number;
    limit: number;
    bucket: number;
  };
}

export interface ExpansionEntry {
  roomName: string;
  status?: string;
  parentRoom?: string;
  score?: number;
  phase?: string;
}

// Note: source, freshness, gameTick are stripped by apiFetch and put in meta
export interface ExpansionResponse {
  live: boolean;
  active: ExpansionEntry[];
  queue: ExpansionEntry[];
}

export function fetchEmpire() {
  return apiFetch<EmpireResponse>('/empire');
}

export function fetchExpansion() {
  return apiFetch<ExpansionResponse>('/empire/expansion');
}
