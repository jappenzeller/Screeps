import { apiFetch } from './client';

export interface GclData {
  level: number;
  progress: number;
  progressTotal: number;
}

export interface EmpireResponse {
  live: boolean;
  gameTick: number;
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

export interface ExpansionResponse {
  live: boolean;
  gameTick: number;
  active: ExpansionEntry[];
  queue: ExpansionEntry[];
}

export function fetchEmpire() {
  return apiFetch<EmpireResponse>('/empire');
}

export function fetchExpansion() {
  return apiFetch<ExpansionResponse>('/empire/expansion');
}
